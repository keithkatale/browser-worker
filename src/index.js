/**
 * Terabits Browser Worker
 * Run Playwright in a long-lived process. Deploy to Railway, Render, or Fly.io.
 * - GET / — status page with link to /logs
 * - GET /health — health check
 * - GET /logs — recent request/error log (for debugging)
 * - POST /run (JSON body: { steps }) → runs steps, returns JSON with all step results + screenshots
 * - POST /run?stream=1 (same body) → SSE stream: one event per step (stepIndex, action, screenshotBase64)
 */

import express from 'express'
import cors from 'cors'
import { chromium } from 'playwright'

const app = express()
app.use(cors())
app.use(express.json({ limit: '1mb' }))

const PORT = Number(process.env.PORT) || 3030
const SECRET = process.env.BROWSER_WORKER_SECRET?.trim() || null

const MAX_LOG_ENTRIES = 100
const logEntries = []

function log(level, message, meta = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    message,
    ...meta,
  }
  logEntries.push(entry)
  if (logEntries.length > MAX_LOG_ENTRIES) logEntries.shift()
  console.log(`[${entry.ts}] ${level}: ${message}`)
}

function sseEvent(data) {
  return `data: ${JSON.stringify(data)}\n\n`
}

function checkAuth(req, res) {
  if (!SECRET) return true
  const auth = req.headers.authorization
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null
  if (token !== SECRET) {
    res.status(401).json({ success: false, error: 'Unauthorized' })
    return false
  }
  return true
}

app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.send(`
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Browser Worker</title></head>
<body style="font-family:system-ui;max-width:640px;margin:2rem auto;padding:1rem;">
  <h1>Terabits Browser Worker</h1>
  <p>Playwright worker for navigate / snapshot / click / fill. Use with Terabits app.</p>
  <ul>
    <li><a href="/health">/health</a> — health check</li>
    <li><a href="/logs">/logs</a> — recent logs and errors</li>
  </ul>
  <p><small>POST /run with body <code>{"steps":[...]}</code> to run browser steps.</small></p>
</body>
</html>`)
})

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'terabits-browser-worker' })
})

app.get('/logs', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  const rows = logEntries
    .slice()
    .reverse()
    .map(
      (e) =>
        `<tr><td>${e.ts}</td><td>${e.level}</td><td>${escapeHtml(e.message)}</td><td>${e.error ? escapeHtml(e.error).slice(0, 200) : '-'}</td></tr>`
    )
    .join('')
  res.send(`
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Worker logs</title></head>
<body style="font-family:system-ui;margin:1rem;">
  <h1>Recent logs</h1>
  <p><a href="/">Back to status</a></p>
  <table border="1" cellpadding="6" style="border-collapse:collapse;font-size:12px;">
    <thead><tr><th>Time</th><th>Level</th><th>Message</th><th>Error</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="4">No entries yet.</td></tr>'}</tbody>
  </table>
</body>
</html>`)
})

function escapeHtml(s) {
  if (s == null) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

app.post('/run', async (req, res) => {
  if (!checkAuth(req, res)) return
  const stream = req.query.stream === '1' || req.headers.accept === 'text/event-stream'
  const { steps } = req.body || {}

  if (!Array.isArray(steps) || steps.length === 0) {
    log('warn', 'POST /run missing steps')
    return res.status(400).json({ success: false, error: 'steps array required (1-15 items)' })
  }
  if (steps.length > 15) {
    log('warn', 'POST /run too many steps', { count: steps.length })
    return res.status(400).json({ success: false, error: 'max 15 steps' })
  }

  log('info', 'POST /run start', { stepCount: steps.length })
  const results = []
  let browser
  let page

  const emitStep = (payload) => {
    results.push(payload)
    if (stream && res.headersSent) {
      try {
        res.write(sseEvent(payload))
      } catch (_) {}
    }
  }

  try {
    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')
      res.flushHeaders?.()
    }

    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    })
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      ignoreHTTPSErrors: true,
    })
    page = await context.newPage()

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]
      const action = step.action || 'snapshot'
      let screenshotBase64 = null
      let error = null

      try {
        if (action === 'navigate') {
          const url = step.url || 'about:blank'
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
        } else if (action === 'click') {
          const selector = step.selector
          if (!selector) throw new Error('selector required for click')
          await page.click(selector, { timeout: 10000 })
        } else if (action === 'fill') {
          const selector = step.selector
          const value = step.value ?? ''
          if (!selector) throw new Error('selector required for fill')
          await page.fill(selector, value, { timeout: 10000 })
        }
        // snapshot: just take screenshot; navigate/click/fill also get a screenshot below
        const buf = await page.screenshot({
          type: 'png',
          encoding: 'base64',
          fullPage: false,
        })
        screenshotBase64 = typeof buf === 'string' ? buf : buf?.toString?.('base64') ?? null
      } catch (e) {
        error = e?.message || String(e)
        try {
          const buf = await page.screenshot({ type: 'png', encoding: 'base64', fullPage: false })
          screenshotBase64 = typeof buf === 'string' ? buf : buf?.toString?.('base64') ?? null
        } catch (_) {}
      }

      const payload = {
        type: 'step',
        stepIndex: i,
        action,
        screenshotBase64,
        success: !error,
        error: error || undefined,
      }
      emitStep(payload)
    }

    log('info', 'POST /run success', { stepCount: results.length })
    if (stream) {
      res.write(sseEvent({ type: 'done', success: true, steps: results }))
      res.end()
    } else {
      res.json({ success: true, steps: results })
    }
  } catch (err) {
    const msg = err?.message || String(err)
    log('error', 'POST /run failed', { error: msg })
    if (stream && res.headersSent) {
      try {
        res.write(sseEvent({ type: 'done', success: false, error: msg, steps: results }))
        res.end()
      } catch (_) {
        res.end()
      }
    } else {
      res.status(500).json({
        success: false,
        error: msg,
        steps: results,
      })
    }
  } finally {
    if (browser) await browser.close().catch(() => {})
  }
})

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Browser worker listening on 0.0.0.0:${PORT}`)
})
