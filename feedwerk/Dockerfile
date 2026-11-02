FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js ./
COPY public ./public

ENV PORT=8095 \
    DATA_DIR=/data \
    NODE_ENV=production

EXPOSE 8095
CMD ["node", "server.js"]
