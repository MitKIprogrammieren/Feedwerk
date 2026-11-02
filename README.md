# Feedwerk

Selbst gehosteter RSS-Reader im SchichtLohn-Look – läuft auf der Synology, als Home-Assistant-App und im Browser auf Mac und iPhone.

- Ordner, Ungelesen-Zähler, Merkliste, Suche
- **Google-Knopf** bei jedem Artikel – auf Wunsch öffnet schon ein Tipp auf den Artikel die Google-Suche (Einstellungen → Allgemein)
- Design-Einstellungen wie bei SchichtLohn (Stil, Kacheln, Hell/Dunkel, Akzentfarbe, Ecken, Rahmen, Schatten, Deckkraft, Hintergrund, Dichte, Schriftgröße)
- OPML-Import/-Export, automatische Aktualisierung
- Webseiten-Adresse reicht – der Feed wird selbst gefunden

Tasten: `J`/`K` nächster/vorheriger Artikel · `G` Google · `S` merken · `O` Original · `M` gelesen · `R` aktualisieren · `/` suchen

## Synology (Container Manager)

1. Den ganzen Ordner `Feedwerk` auf die Synology kopieren, z. B. nach `docker/feedwerk`.
2. Container Manager → **Projekt** → **Erstellen** → Name `feedwerk`, Pfad `docker/feedwerk`, „Vorhandene docker-compose.yml verwenden“.
3. Fertig: `http://192.168.1.4:8095` – auf dem iPhone in Safari öffnen → Teilen → „Zum Home-Bildschirm“.

Die Daten liegen in `docker/feedwerk/data/feedwerk.json`.

## Home Assistant

**Als eigene App:** Repository `https://github.com/MitKIprogrammieren/Feedwerk` unter Einstellungen → Apps → App-Store → ⋮ → Repositories hinzufügen, dann „Feedwerk“ installieren und „In Seitenleiste anzeigen“ einschalten.
Ohne GitHub: Ordner `feedwerk` per Samba-Freigabe nach `addons/feedwerk` kopieren, im App-Store „Nach Updates suchen“ – erscheint unter „Lokale Apps“.

**Nur anzeigen (läuft auf der Synology):** Einstellungen → Dashboards → Dashboard hinzufügen → **Webseite** → `http://192.168.1.4:8095`.

## Lokal starten

```
cd feedwerk && npm install && npm start
```
