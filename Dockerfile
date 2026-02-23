# Playwright Chromium on Node for Railway / Render / Fly.io
FROM mcr.microsoft.com/playwright:v1.49.0-noble
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
EXPOSE 3030
ENV PORT=3030
CMD ["node", "src/index.js"]
