'use strict';
// Feedwerk – kleiner selbst gehosteter RSS-Reader
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { XMLParser } = require('fast-xml-parser');
const sanitizeHtml = require('sanitize-html');

const PORT = parseInt(process.env.PORT || '8095', 10);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
// Als Home-Assistant-App kommen die Optionen aus /data/options.json
let haOpts = {};
try { haOpts = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'options.json'), 'utf8')); } catch {}
const REFRESH_MIN = Math.max(5, parseInt(haOpts.refresh_minutes || process.env.REFRESH_MINUTES || '30', 10));
const MAX_ITEMS_PER_FEED = parseInt(process.env.MAX_ITEMS_PER_FEED || '300', 10);
const DB_FILE = path.join(DATA_DIR, 'feedwerk.json');
const PUBLIC = path.join(__dirname, 'public');
const UA = 'Feedwerk/1.0 (+self-hosted RSS reader)';

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- Speicher ----------
const DEFAULT_SETTINGS = {
  clickAction: 'read',        // read | google | original
  googleWithFeedName: false,  // Feedname mit in die Suche nehmen
  hideRead: true,
  refreshMinutes: REFRESH_MIN,
  design: {},                 // Stil, Kacheln, Farbe … wie bei SchichtLohn
};

let db = { folders: [], feeds: [], items: [], settings: { ...DEFAULT_SETTINGS } };
try {
  if (fs.existsSync(DB_FILE)) {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    db.settings = { ...DEFAULT_SETTINGS, ...(db.settings || {}) };
    db.folders ||= []; db.feeds ||= []; db.items ||= [];
  }
} catch (e) {
  console.error('Datenbank konnte nicht gelesen werden, Sicherung wird angelegt:', e.message);
  try { fs.copyFileSync(DB_FILE, DB_FILE + '.defekt-' + Date.now()); } catch {}
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DB_FILE);
  }, 300);
}
const id = () => crypto.randomBytes(6).toString('hex');
const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);

// ---------- Feeds parsen ----------
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  textNodeName: '#text',
  processEntities: true,
  htmlEntities: true,
  trimValues: true,
});

const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
function txt(x) {
  if (x == null) return '';
  if (typeof x === 'string' || typeof x === 'number') return String(x);
  if (Array.isArray(x)) return txt(x[0]);
  if (typeof x === 'object') return txt(x['#text'] ?? '');
  return '';
}
function atomLink(links, rel = 'alternate') {
  const l = arr(links);
  const hit = l.find((k) => (k['@_rel'] || 'alternate') === rel && (!k['@_type'] || /html/.test(k['@_type'])))
    || l.find((k) => (k['@_rel'] || 'alternate') === rel) || l[0];
  return hit ? (hit['@_href'] || txt(hit)) : '';
}
const clean = (html, base) => sanitizeHtml(html || '', {
  allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'figure', 'figcaption', 'picture', 'source', 'video', 'h1', 'h2']),
  allowedAttributes: {
    a: ['href', 'title'], img: ['src', 'srcset', 'alt', 'title', 'width', 'height'],
    source: ['srcset', 'type'], video: ['src', 'poster', 'controls'], '*': [],
  },
  allowedSchemes: ['http', 'https', 'data'],
  transformTags: {
    a: (tag, attribs) => ({ tagName: 'a', attribs: { ...attribs, href: absolutize(attribs.href, base), target: '_blank', rel: 'noopener noreferrer' } }),
    img: (tag, attribs) => ({ tagName: 'img', attribs: { ...attribs, src: absolutize(attribs.src, base), loading: 'lazy' } }),
  },
  allowedAttributesExtra: undefined,
});
function absolutize(u, base) { try { return u ? new URL(u, base).href : u; } catch { return u; } }
const plain = (html) => sanitizeHtml(html || '', { allowedTags: [], allowedAttributes: {} }).replace(/\s+/g, ' ').trim();

function firstImage(html) { const m = /<img[^>]+src="([^"]+)"/i.exec(html || ''); return m ? m[1] : ''; }

function parseFeed(xml, feedUrl) {
  const doc = parser.parse(xml);
  let title = '', site = '', entries = [];
  if (doc.rss) {
    const ch = doc.rss.channel || {};
    title = txt(ch.title); site = txt(Array.isArray(ch.link) ? ch.link.find((l) => typeof l === 'string') : ch.link);
    entries = arr(ch.item).map((it) => ({
      title: txt(it.title), link: txt(it.link) || (it.guid && /^https?:/.test(txt(it.guid)) ? txt(it.guid) : ''),
      guid: txt(it.guid), date: txt(it.pubDate) || txt(it.date),
      html: txt(it.encoded) || txt(it.description), author: txt(it.creator) || txt(it.author),
      image: it.enclosure && /image/.test(it.enclosure['@_type'] || '') ? it.enclosure['@_url'] : (it.thumbnail?.['@_url'] || it.content?.['@_url'] || ''),
    }));
  } else if (doc.feed) {
    const f = doc.feed;
    title = txt(f.title); site = atomLink(f.link);
    entries = arr(f.entry).map((e) => ({
      title: txt(e.title), link: atomLink(e.link), guid: txt(e.id),
      date: txt(e.published) || txt(e.updated), html: txt(e.content) || txt(e.summary),
      author: txt(e.author?.name), image: e.thumbnail?.['@_url'] || e.group?.thumbnail?.['@_url'] || '',
    }));
  } else if (doc.RDF) {
    const r = doc.RDF;
    title = txt(r.channel?.title); site = txt(r.channel?.link);
    entries = arr(r.item).map((it) => ({
      title: txt(it.title), link: txt(it.link), guid: txt(it['@_about']) || txt(it.link),
      date: txt(it.date), html: txt(it.encoded) || txt(it.description), author: txt(it.creator), image: '',
    }));
  } else {
    throw new Error('Kein RSS- oder Atom-Feed erkannt');
  }
  site = absolutize(site, feedUrl) || feedUrl;
  return { title: title || new URL(feedUrl).hostname, site, entries };
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.8, */*;q=0.5' },
    redirect: 'follow', signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return { text: await res.text(), type: res.headers.get('content-type') || '', url: res.url };
}

// Findet zu einer Webseite den Feed (link rel=alternate)
function discover(html, base) {
  const out = [];
  const re = /<link\b[^>]*>/gi; let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    if (!/rel=["']?alternate/i.test(tag)) continue;
    if (!/(rss|atom)\+xml|application\/feed\+json/i.test(tag)) continue;
    const href = /href=["']([^"']+)["']/i.exec(tag);
    if (href) out.push(absolutize(href[1].replace(/&amp;/g, '&'), base));
  }
  return out;
}

// ---------- MakerWorld (kein RSS – die Seiten liefern ihre Daten als __NEXT_DATA__ mit) ----------
const MW_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const isMakerWorld = (u) => { try { return /(^|\.)makerworld\.com$/i.test(new URL(u).hostname); } catch { return false; } };
function normalizeMakerWorld(u) {
  const x = new URL(u);
  const h = /\/@([^/?#]+)/.exec(x.pathname);
  if (h) return `https://makerworld.com/de/@${h[1]}/upload`;
  if (/\/models\/\d+/.test(x.pathname)) throw new Error('Das ist ein einzelnes Modell – nimm einen Suchbegriff oder den Designer');
  const kw = x.searchParams.get('keyword');
  if (/\/search\//.test(x.pathname) && kw) {
    const out = new URL('https://makerworld.com/de/search/models');
    for (const [k, v] of x.searchParams) out.searchParams.set(k, v);
    if (!out.searchParams.get('orderBy')) out.searchParams.set('orderBy', 'newUploads');
    return out.href;
  }
  throw new Error('Bitte einen MakerWorld-Suchbegriff oder eine Designer-Seite angeben');
}
async function loadMakerWorld(url) {
  url = normalizeMakerWorld(url);
  const res = await fetch(url, {
    headers: { 'User-Agent': MW_UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'de-DE,de;q=0.9,en;q=0.6' },
    redirect: 'follow', signal: AbortSignal.timeout(25000),
  });
  const html = await res.text();
  const m = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error(res.status === 403 || /cloudflare|cf-chl|challenge/i.test(html) ? 'MakerWorld blockt den Abruf gerade (Schutzseite) – es wird später erneut versucht' : 'MakerWorld-Seite konnte nicht gelesen werden (HTTP ' + res.status + ')');
  const pp = JSON.parse(m[1]).props?.pageProps || {};
  const designs = Array.isArray(pp.designs) ? pp.designs : [];
  const user = pp.userInfo;
  const kw = new URL(url).searchParams.get('keyword');
  const title = user ? `MakerWorld: ${user.name || user.handle}` : `MakerWorld: „${kw}“`;
  const fmt = (n) => (Number(n) || 0).toLocaleString('de-DE');
  const entries = designs.filter((d) => d && d.id && !d.nsfw).map((d) => {
    const t = d.titleTranslated || d.title || '';
    const cover = d.cover || d.coverUrl || '';
    const who = d.designCreator?.name || user?.name || '';
    const handle = d.designCreator?.handle || user?.handle || '';
    const link = `https://makerworld.com/de/models/${d.id}${d.slug ? '-' + d.slug : ''}`;
    const body = `${cover ? `<p><img src="${esc(cover)}" alt=""></p>` : ''}`
      + (d.titleTranslated && d.title && d.titleTranslated !== d.title ? `<p><i>${esc(d.title)}</i></p>` : '')
      + `<p>von ${handle ? `<a href="https://makerworld.com/de/@${esc(handle)}/upload">${esc(who)}</a>` : esc(who)} · ♥ ${fmt(d.likeCount)} · ⬇ ${fmt(d.downloadCount)} · Gedruckt ${fmt(d.printCount)}×</p>`
      + (Array.isArray(d.tags) && d.tags.length ? `<p>${d.tags.slice(0, 12).map((x) => '#' + esc(typeof x === 'string' ? x : x.name || '')).join(' ')}</p>` : '');
    return {
      title: t, link, guid: 'mw-' + d.id, date: d.createTime || d.publishTime, html: body, author: who, image: cover,
      mw: { likes: d.likeCount || 0, downloads: d.downloadCount || 0, prints: d.printCount || 0, staff: !!d.isStaffPicked },
    };
  });
  return { url, parsed: { title, site: url, entries } };
}

async function loadFeed(url) {
  if (isMakerWorld(url)) return loadMakerWorld(url);
  let r = await fetchText(url);
  const looksXml = /xml|rss|atom/i.test(r.type) || /^\s*<\?xml|<rss|<feed|<rdf:RDF/i.test(r.text.slice(0, 500));
  if (!looksXml) {
    const found = discover(r.text, r.url);
    if (!found.length) throw new Error('Auf dieser Seite wurde kein Feed gefunden');
    url = found[0];
    r = await fetchText(url);
  }
  return { url, parsed: parseFeed(r.text, r.url) };
}

function favicon(site) { try { return new URL('/favicon.ico', site).href; } catch { return ''; } }

function mergeItems(feed, entries) {
  const known = new Map(db.items.filter((i) => i.feedId === feed.id).map((i) => [i.key, i]));
  let added = 0;
  const now = Date.now();
  for (const e of entries) {
    const key = hash(e.guid || e.link || e.title);
    if (known.has(key)) { if (e.mw) known.get(key).mw = e.mw; continue; }
    let ts = Date.parse(e.date); if (isNaN(ts) || ts > now + 86400000) ts = now;
    const html = clean(e.html, e.link || feed.site);
    db.items.push({
      id: id(), key, feedId: feed.id, title: plain(e.title) || '(ohne Titel)', link: absolutize(e.link, feed.site),
      author: plain(e.author), date: ts, html, summary: plain(e.html).slice(0, 220),
      image: absolutize(e.image, feed.site) || firstImage(html), read: false, saved: false, fetched: now,
      ...(e.mw ? { mw: e.mw } : {}),
    });
    known.set(key, true); added++;
  }
  // Pro Feed nur die neuesten behalten – gemerkte bleiben immer
  const mine = db.items.filter((i) => i.feedId === feed.id).sort((a, b) => b.date - a.date);
  if (mine.length > MAX_ITEMS_PER_FEED) {
    const drop = new Set(mine.slice(MAX_ITEMS_PER_FEED).filter((i) => !i.saved).map((i) => i.id));
    db.items = db.items.filter((i) => !drop.has(i.id));
  }
  return added;
}

async function refreshFeed(feed) {
  try {
    const { parsed } = await loadFeed(feed.url);
    const added = mergeItems(feed, parsed.entries);
    feed.error = null; feed.lastFetch = Date.now();
    if (!feed.site) feed.site = parsed.site;
    return added;
  } catch (e) {
    feed.error = e.message; feed.lastFetch = Date.now();
    return 0;
  }
}

let refreshing = null;
async function refreshAll() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    let added = 0; const queue = [...db.feeds];
    const worker = async () => { while (queue.length) added += await refreshFeed(queue.shift()); };
    await Promise.all(Array.from({ length: 4 }, worker));
    db.lastRefresh = Date.now(); save();
    return added;
  })();
  try { return await refreshing; } finally { refreshing = null; }
}

// ---------- OPML ----------
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function exportOpml() {
  const line = (f) => `      <outline type="rss" text="${esc(f.title)}" title="${esc(f.title)}" xmlUrl="${esc(f.url)}" htmlUrl="${esc(f.site)}"/>`;
  const body = db.folders.map((fo) => `    <outline text="${esc(fo.name)}" title="${esc(fo.name)}">\n${db.feeds.filter((f) => f.folderId === fo.id).map(line).join('\n')}\n    </outline>`);
  db.feeds.filter((f) => !f.folderId).forEach((f) => body.push(line(f).slice(2)));
  return `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n  <head><title>Feedwerk</title><dateCreated>${new Date().toUTCString()}</dateCreated></head>\n  <body>\n${body.join('\n')}\n  </body>\n</opml>\n`;
}
function importOpml(xml) {
  const doc = parser.parse(xml);
  const body = doc.opml?.body; if (!body) throw new Error('Keine gültige OPML-Datei');
  let added = 0;
  const walk = (nodes, folderName) => {
    for (const o of arr(nodes)) {
      const url = o['@_xmlUrl'];
      const name = o['@_title'] || o['@_text'] || '';
      if (url) {
        if (db.feeds.some((f) => f.url === url)) continue;
        let folderId = null;
        if (folderName) {
          let fo = db.folders.find((x) => x.name.toLowerCase() === folderName.toLowerCase());
          if (!fo) { fo = { id: id(), name: folderName }; db.folders.push(fo); }
          folderId = fo.id;
        }
        db.feeds.push({ id: id(), url, title: name || url, site: o['@_htmlUrl'] || '', folderId, added: Date.now() });
        added++;
      } else if (o.outline) walk(o.outline, name || folderName);
    }
  };
  walk(body.outline, null);
  save();
  return added;
}

// ---------- Hilfen für API ----------
function counts() {
  const unread = {};
  let total = 0, saved = 0;
  for (const i of db.items) {
    if (i.saved) saved++;
    if (!i.read) { unread[i.feedId] = (unread[i.feedId] || 0) + 1; total++; }
  }
  return { unread, total, saved };
}
function state() {
  return {
    folders: db.folders, settings: db.settings, lastRefresh: db.lastRefresh || null,
    feeds: db.feeds.map((f) => ({ ...f, icon: favicon(f.site || f.url) })), counts: counts(),
  };
}
// Merkmale aus Release-Namen: Sprache, Kategorie, Qualität
const LANG_DE = /(^|[.\s_\-(])(german|deutsch|ger|dl|ml)(?=[.\s_\-)]|$)/i;
function traits(i) {
  if (i._t) return i._t;
  const t = i.title || '';
  const release = !/\s/.test(t.trim()) && t.split('.').length >= 4;
  const catM = /^\s*\[([^\]]{1,30})\]/.exec(i.summary || '') || /^\s*\[([^\]]{1,30})\]/.exec(t);
  const resM = /(2160p|1080p|720p|576p|480p)/i.exec(t) || (/(^|[.\s_-])(uhd|4k)(?=[.\s_-]|$)/i.test(t) ? ['2160p'] : null);
  const v = {
    lang: release ? (LANG_DE.test(t) ? 'de' : 'en') : (LANG_DE.test(t) ? 'de' : ''),
    cat: catM ? catM[1].trim() : '',
    res: resM ? resM[0].toLowerCase().replace(/^.*?(\d+p)$/, '$1') : '',
  };
  Object.defineProperty(i, '_t', { value: v, enumerable: false, writable: true });
  return v;
}
function applyTraitFilters(list, q, skip) {
  return list.filter((i) => {
    const t = traits(i);
    if (q.lang && skip !== 'lang' && t.lang !== q.lang) return false;
    if (q.cat && skip !== 'cat' && t.cat !== q.cat) return false;
    if (q.res && skip !== 'res' && t.res !== q.res) return false;
    return true;
  });
}
function baseList(q) {
  let list = selectItems(q);
  if (q.view === 'unread') list = list.filter((i) => !i.read);
  if (q.q) { const s = q.q.toLowerCase(); list = list.filter((i) => i.title.toLowerCase().includes(s) || i.summary.toLowerCase().includes(s)); }
  return list;
}
function facets(q) {
  const base = baseList(q);
  const count = (dim) => {
    const m = {};
    for (const i of applyTraitFilters(base, q, dim)) { const v = traits(i)[dim]; if (v) m[v] = (m[v] || 0) + 1; }
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  };
  const res = count('res').sort((a, b) => parseInt(b[0], 10) - parseInt(a[0], 10));
  return { lang: count('lang'), cat: count('cat').slice(0, 10), res };
}

function selectItems(q) {
  let list = db.items;
  if (q.feed) list = list.filter((i) => i.feedId === q.feed);
  else if (q.folder) { const ids = new Set(db.feeds.filter((f) => f.folderId === q.folder).map((f) => f.id)); list = list.filter((i) => ids.has(i.feedId)); }
  if (q.view === 'saved') list = list.filter((i) => i.saved);
  return list;
}

function body(req, limit = 5e6) {
  return new Promise((resolve, reject) => {
    let data = ''; req.setEncoding('utf8');
    req.on('data', (c) => { data += c; if (data.length > limit) { reject(new Error('Zu groß')); req.destroy(); } });
    req.on('end', () => resolve(data)); req.on('error', reject);
  });
}
async function json(req) { const b = await body(req); return b ? JSON.parse(b) : {}; }
function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/manifest+json', '.ico': 'image/x-icon' };

// ---------- Router ----------
async function api(req, res, p, q) {
  const m = req.method;
  const seg = p.split('/').filter(Boolean).slice(1); // nach "api"

  if (seg[0] === 'state' && m === 'GET') return send(res, 200, state());

  if (seg[0] === 'items' && m === 'GET' && !seg[1]) {
    let list = applyTraitFilters(baseList(q), q);
    list = [...list].sort((a, b) => b.date - a.date);
    const off = parseInt(q.offset || '0', 10), lim = Math.min(200, parseInt(q.limit || '60', 10));
    const feedsById = Object.fromEntries(db.feeds.map((f) => [f.id, f]));
    return send(res, 200, {
      total: list.length,
      items: list.slice(off, off + lim).map((it) => { const { html, key, ...i } = it; return { ...i, ...traits(it), feedTitle: feedsById[i.feedId]?.title || '' }; }),
      facets: facets(q),
    });
  }
  if (seg[0] === 'items' && seg[1] && m === 'GET') {
    const it = db.items.find((i) => i.id === seg[1]); if (!it) return send(res, 404, { error: 'Nicht gefunden' });
    const f = db.feeds.find((x) => x.id === it.feedId);
    return send(res, 200, { ...it, feedTitle: f?.title || '' });
  }
  if (seg[0] === 'items' && seg[1] && m === 'PATCH') {
    const it = db.items.find((i) => i.id === seg[1]); if (!it) return send(res, 404, { error: 'Nicht gefunden' });
    const b = await json(req);
    if (typeof b.read === 'boolean') it.read = b.read;
    if (typeof b.saved === 'boolean') it.saved = b.saved;
    save(); return send(res, 200, { ok: true, counts: counts() });
  }
  if (seg[0] === 'mark-read' && m === 'POST') {
    const b = await json(req);
    applyTraitFilters(baseList(b), b).forEach((i) => { i.read = true; });
    save(); return send(res, 200, { ok: true, counts: counts() });
  }

  if (seg[0] === 'feeds' && m === 'POST') {
    const b = await json(req);
    let url = String(b.url || '').trim();
    if (!url) return send(res, 400, { error: 'Bitte eine Adresse eingeben' });
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    try {
      const r = await loadFeed(url);
      if (db.feeds.some((f) => f.url === r.url)) return send(res, 409, { error: 'Diesen Feed hast du schon' });
      const feed = { id: id(), url: r.url, title: b.title || r.parsed.title, site: r.parsed.site, folderId: b.folderId || null, added: Date.now(), lastFetch: Date.now(), error: null };
      db.feeds.push(feed);
      mergeItems(feed, r.parsed.entries);
      save(); return send(res, 200, { ok: true, feed });
    } catch (e) { return send(res, 400, { error: 'Feed konnte nicht geladen werden: ' + e.message }); }
  }
  if (seg[0] === 'feeds' && seg[1] && m === 'PATCH') {
    const f = db.feeds.find((x) => x.id === seg[1]); if (!f) return send(res, 404, { error: 'Nicht gefunden' });
    const b = await json(req);
    if (b.title) f.title = String(b.title).trim();
    if ('folderId' in b) f.folderId = b.folderId || null;
    save(); return send(res, 200, { ok: true });
  }
  if (seg[0] === 'feeds' && seg[1] && m === 'DELETE') {
    db.feeds = db.feeds.filter((x) => x.id !== seg[1]);
    db.items = db.items.filter((i) => i.feedId !== seg[1]);
    save(); return send(res, 200, { ok: true });
  }

  if (seg[0] === 'folders' && m === 'POST') {
    const b = await json(req); const name = String(b.name || '').trim();
    if (!name) return send(res, 400, { error: 'Bitte einen Namen eingeben' });
    const fo = { id: id(), name }; db.folders.push(fo); save(); return send(res, 200, fo);
  }
  if (seg[0] === 'folders' && seg[1] && m === 'PATCH') {
    const fo = db.folders.find((x) => x.id === seg[1]); if (!fo) return send(res, 404, { error: 'Nicht gefunden' });
    const b = await json(req); if (b.name) fo.name = String(b.name).trim(); save(); return send(res, 200, fo);
  }
  if (seg[0] === 'folders' && seg[1] && m === 'DELETE') {
    db.folders = db.folders.filter((x) => x.id !== seg[1]);
    db.feeds.forEach((f) => { if (f.folderId === seg[1]) f.folderId = null; });
    save(); return send(res, 200, { ok: true });
  }

  if (seg[0] === 'refresh' && m === 'POST') {
    const added = await refreshAll(); return send(res, 200, { ok: true, added, state: state() });
  }

  if (seg[0] === 'settings' && m === 'PATCH') {
    const b = await json(req);
    for (const k of Object.keys(DEFAULT_SETTINGS)) if (k in b) db.settings[k] = b[k];
    if (db.settings.refreshMinutes < 5) db.settings.refreshMinutes = 5;
    schedule(); save(); return send(res, 200, db.settings);
  }

  if (seg[0] === 'opml' && m === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/x-opml; charset=utf-8', 'Content-Disposition': 'attachment; filename="feedwerk.opml"' });
    return res.end(exportOpml());
  }
  if (seg[0] === 'opml' && m === 'POST') {
    try {
      const added = importOpml(await body(req));
      refreshAll(); // läuft im Hintergrund
      return send(res, 200, { ok: true, added });
    } catch (e) { return send(res, 400, { error: e.message }); }
  }

  return send(res, 404, { error: 'Unbekannte Anfrage' });
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    // Unter HA-Ingress kommt der Pfad schon ohne Präfix an; alle Links in der Oberfläche sind relativ.
    let p = decodeURIComponent(u.pathname);
    if (p.startsWith('/api/')) return await api(req, res, p, Object.fromEntries(u.searchParams));
    if (p === '/' || p === '') p = '/index.html';
    const file = path.join(PUBLIC, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); return res.end('Nicht gefunden');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: e.message });
  }
});

let timer = null;
function schedule() {
  clearInterval(timer);
  timer = setInterval(() => refreshAll().catch(console.error), db.settings.refreshMinutes * 60000);
}

server.listen(PORT, () => {
  console.log(`Feedwerk läuft auf Port ${PORT}, Daten in ${DATA_DIR}, Aktualisierung alle ${db.settings.refreshMinutes} Min.`);
  schedule();
  setTimeout(() => refreshAll().catch(console.error), 3000);
});
