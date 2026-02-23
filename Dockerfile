# Playwright Chromium on Node for Railway / Render / Fly.io (version must match package.json)
FROM mcr.microsoft.com/playwright:v1.58.2-noble
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
# Do NOT set ENV PORT here — Railway (and Render/Fly) inject PORT; the app uses process.env.PORT.
EXPOSE 3030
CMD ["node", "src/index.js"]
