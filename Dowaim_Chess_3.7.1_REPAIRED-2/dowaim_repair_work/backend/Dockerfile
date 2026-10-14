FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server.js preflight.js ./
RUN addgroup -S chess && adduser -S chess -G chess && mkdir -p /app/data && chown -R chess:chess /app
USER chess
EXPOSE 8080
HEALTHCHECK --interval=20s --timeout=5s --retries=5 CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node","server.js"]
