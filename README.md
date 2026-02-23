# Terabits Browser Worker

Runs Playwright in a long-lived process. Deploy to **Railway**, **Render**, or **Fly.io** so your Terabits app (on Vercel) can run browser automation (navigate, click, fill, screenshots) without running a browser on Vercel.

## Endpoints

- **GET /** – Status page (links to /health and /logs).
- **GET /health** – Returns `{ ok: true }`.
- **GET /logs** – Recent request/error log (HTML table) for debugging.
- **POST /run** – Run a sequence of browser steps.
  - Body: `{ "steps": [ { "action": "navigate", "url": "https://..." }, { "action": "fill", "selector": "#email", "value": "..." }, ... ] }`
  - Actions: `navigate` (requires `url`), `snapshot` (screenshot only), `click` (requires `selector`), `fill` (requires `selector`, optional `value`).
  - Response (default): JSON `{ success, steps: [ { stepIndex, action, screenshotBase64, success, error? } ] }`.
- **POST /run?stream=1** – Same body; response is SSE: one event per step (`type: "step"`, then final `type: "done"`).

## Local

```bash
cd services/browser-worker
npm install
npm run dev
```

Worker runs at `http://localhost:3030`. In your app set `BROWSER_WORKER_URL=http://localhost:3030` and `ENABLE_BROWSER_AUTOMATION=true` for local testing.

## Deploy

### Railway

1. Create a new project, add a service.
2. Root directory: set to `services/browser-worker` (or deploy this folder only).
3. Build: `npm install` (or leave default).
4. Start: `npm start`.
5. Add variable: `PORT` is set by Railway.
6. Copy the public URL (e.g. `https://your-app.up.railway.app`) and set `BROWSER_WORKER_URL` in your Terabits app.

### Render

1. New Web Service, connect repo.
2. Root directory: `services/browser-worker`.
3. Build: `npm install`.
4. Start: `npm start`.
5. Set env: `PORT` provided by Render.
6. Use the service URL as `BROWSER_WORKER_URL` in Terabits.

### Fly.io

1. From repo root or from `services/browser-worker`: `fly launch` (create app).
2. In `services/browser-worker`, create `Dockerfile` (see below) or use `fly.toml` with buildpack.
3. `fly deploy`.
4. Use `https://your-app.fly.dev` as `BROWSER_WORKER_URL`.

Optional **Dockerfile** in `services/browser-worker`:

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

- **Optional:** Set `BROWSER_WORKER_SECRET` on the worker. Then set the same value as `BROWSER_WORKER_SECRET` in your Terabits app (Vercel env). The app will send `Authorization: Bearer <secret>` and the worker will reject requests without it.
- Do not log or store user credentials; pass them only in the request body and use in-memory for the single run.
