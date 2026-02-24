# Terabits Browser Worker

Runs Playwright in a long-lived process. Deploy to **Railway**, **Render**, or **Fly.io** so your Terabits app (on Vercel) can run browser automation (navigate, click, fill, wait, screenshots) without running a browser on Vercel. Uses **sessions** (reuse same browser), **wait** options (so the AI doesn’t panic on slow loads), and **stealth** (playwright-extra + puppeteer-extra-plugin-stealth) to reduce bot detection.

## Endpoints

- **GET /** – Status page (links to /health and /logs).
- **GET /health** – Returns `{ ok: true, service, sessions }`.
- **GET /logs** – Recent request/error log (HTML table) for debugging.
- **POST /run** – Run a sequence of browser steps.
  - Body: `{ "sessionId"?: "...", "steps": [ ... ] }`. Omit `sessionId` to create a new session; include it to reuse the same browser (cookies/state persist). Response always includes `sessionId`.
  - Actions: `navigate` (requires `url`; optional `waitUntil`: `domcontentloaded` | `load` | `networkidle`, default `load`; optional `timeout` ms, default 60000), `snapshot` (screenshot only), `click` (requires `selector`), `fill` (requires `selector`, optional `value`), `wait` (optional `delay` ms, optional `selector` to wait for visible, optional `selectorTimeout` ms).
  - Response: JSON `{ success, steps: [ ... ], sessionId }`.
- **POST /run?stream=1** – Same body; response is SSE: one event per step, then final `type: "done"` with `sessionId`.
- **DELETE /session/:sessionId** – Close a session (optional auth). Sessions also expire after 15 min idle (configurable via `SESSION_TTL_MS`).

## Local

```bash
npm install
npm run dev
```

Worker runs at `http://localhost:3030`. In your Terabits app set `BROWSER_WORKER_URL=http://localhost:3030` and `ENABLE_BROWSER_AUTOMATION=true`.

## Deploy

### Railway

1. Create a new project, add a service.
2. Connect **this repo** (keithkatale/browser-worker). No root directory needed—repo root is the worker.
3. Build: `npm install`.
4. Start: `npm start`.
5. Add variable: `PORT` is set by Railway.
6. Copy the public URL and set `BROWSER_WORKER_URL` in your Terabits app.

### Render

1. New Web Service, connect this repo.
2. Build: `npm install`.
3. Start: `npm start`.
4. Set env: `PORT` provided by Render.
5. Use the service URL as `BROWSER_WORKER_URL` in Terabits.

### Fly.io

1. From this repo: `fly launch` (create app).
2. Use the Dockerfile below or a buildpack.
3. `fly deploy`.
4. Use `https://your-app.fly.dev` as `BROWSER_WORKER_URL`.

Optional **Dockerfile**:

```dockerfile
FROM mcr.microsoft.com/playwright:v1.49.0-noble
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
EXPOSE 3030
ENV PORT=3030
CMD ["node", "src/index.js"]
```

## Security

- **Optional:** Set `BROWSER_WORKER_SECRET` on the worker. Set the same value as `BROWSER_WORKER_SECRET` in your Terabits app. The app sends `Authorization: Bearer <secret>`; the worker rejects requests without it.
- Do not log or store user credentials; pass them only in the request body.
