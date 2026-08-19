FROM node:24-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --ignore-scripts && npm cache clean --force

COPY . .
RUN mkdir -p /app/storage/uploads /app/storage/media /app/storage/tmp /app/storage/backups \
    && chown -R node:node /app/storage

USER node
EXPOSE 3000


HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["npm", "start"]
