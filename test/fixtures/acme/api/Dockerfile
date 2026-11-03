FROM ghcr.io/acme/base:1.4 AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM deps
COPY . .
CMD ["node", "server.js"]
