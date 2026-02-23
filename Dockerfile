# Playwright Chromium on Node for Railway / Render / Fly.io (version must match package.json)
FROM mcr.microsoft.com/playwright:v1.58.2-noble
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
EXPOSE 3030
ENV PORT=3030
CMD ["node", "src/index.js"]
