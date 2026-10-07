FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server.js agent.js install.sh ./
COPY public ./public
ENV NODE_ENV=production PORT=8060
EXPOSE 8060
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -qO- http://127.0.0.1:${PORT}/healthz >/dev/null || exit 1
CMD ["node","server.js"]
