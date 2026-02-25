/**
 * Terabits Browser Worker
 * Run Playwright in a long-lived process. Deploy to Railway, Render, or Fly.io.
 * - GET / — status page with link to /logs
 * - GET /health — health check
 * - GET /logs — recent request/error log (for debugging)
 * - POST /run (JSON body: { sessionId?, steps }) → runs steps, returns JSON with steps + sessionId (sessions persist for TTL)
 * - POST /run?stream=1 (same body) → SSE stream: one event per step (stepIndex, action, screenshotBase64)
 * - DELETE /session/:sessionId — close a session
 *
 * Sessions: pass sessionId to reuse the same browser; omit to create a new one. Response always includes sessionId.
 * Wait: navigate supports waitUntil ('domcontentloaded'|'load'|'networkidle') and timeout; action "wait" supports delay and/or selector.
 * Stealth: uses playwright-extra + puppeteer-extra-plugin-stealth to reduce bot detection.
 */

import express from 'express'
import cors from 'cors'
import { chromium } from 'playwright-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'

chromium.use(StealthPlugin())

const app = express()
app.use(cors())
app.use(express.json({ limit: '1mb' }))

const PORT = Number(process.env.PORT) || 3030
const SECRET = process.env.BROWSER_WORKER_SECRET?.trim() || null
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS) || 15 * 60 * 1000 // 15 min

const MAX_LOG_ENTRIES = 100
const logEntries = []

// sessionId -> { browser, context, page, lastUsedAt }
const sessions = new Map()

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

function randomId() {
  return `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

async function createNewSession(sessionId) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
    ],
  })
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    ignoreHTTPSErrors: true,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  })
  const page = await context.newPage()
  const entry = { browser, context, page, lastUsedAt: Date.now() }
  sessions.set(sessionId, entry)
  log('info', 'Session created', { sessionId })
  return entry
}

async function getOrCreateSession(requestedId) {
  const existing = requestedId ? sessions.get(requestedId) : null
  if (existing) {
    existing.lastUsedAt = Date.now()
    return { sessionId: requestedId, ...existing }
  }
  const id = requestedId || randomId()
  const entry = await createNewSession(id)
  return { sessionId: id, ...entry }
}

function closeSession(sessionId) {
  const entry = sessions.get(sessionId)
  if (!entry) return
  sessions.delete(sessionId)
  entry.browser.close().catch(() => {})
  log('info', 'Session closed', { sessionId })
}

function cleanupExpiredSessions() {
  const now = Date.now()
  for (const [id, entry] of sessions.entries()) {
    if (now - entry.lastUsedAt > SESSION_TTL_MS) {
      closeSession(id)
    }
  }
}

// Run every 2 minutes
setInterval(cleanupExpiredSessions, 2 * 60 * 1000)

app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.send(`
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Browser Worker</title></head>
<body style="font-family:system-ui;max-width:640px;margin:2rem auto;padding:1rem;">
  <h1>Terabits Browser Worker</h1>
  <p>Playwright worker for navigate / snapshot / click / fill / wait. Uses sessions and stealth.</p>
  <ul>
    <li><a href="/health">/health</a> — health check</li>
    <li><a href="/logs">/logs</a> — recent logs and errors</li>
  </ul>
  <p><small>POST /run with body <code>{"steps":[...]}</code> or <code>{"sessionId":"...", "steps":[...]}</code>. Response includes sessionId for reuse.</small></p>
</body>
</html>`)
})

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'terabits-browser-worker', sessions: sessions.size })
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

app.delete('/session/:sessionId', (req, res) => {
  if (!checkAuth(req, res)) return
  const { sessionId } = req.params
  if (!sessionId) return res.status(400).json({ success: false, error: 'sessionId required' })
  closeSession(sessionId)
  res.json({ success: true, message: 'Session closed' })
})

app.post('/run', async (req, res) => {
  if (!checkAuth(req, res)) return
  const stream = req.query.stream === '1' || req.headers.accept === 'text/event-stream'
  const { steps, sessionId: requestedSessionId } = req.body || {}

  if (!Array.isArray(steps) || steps.length === 0) {
    log('warn', 'POST /run missing steps')
    return res.status(400).json({ success: false, error: 'steps array required (1-15 items)' })
  }
  if (steps.length > 15) {
    log('warn', 'POST /run too many steps', { count: steps.length })
    return res.status(400).json({ success: false, error: 'max 15 steps' })
  }

  log('info', 'POST /run start', { stepCount: steps.length, sessionId: requestedSessionId || 'new' })
  const results = []
  let resolvedSessionId

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

    const { sessionId: sid, page } = await getOrCreateSession(requestedSessionId || null)
    resolvedSessionId = sid

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]
      const action = step.action || 'snapshot'
      let screenshotBase64 = null
      let error = null

      try {
        if (action === 'navigate') {
          const url = step.url || 'about:blank'
          const waitUntil = step.waitUntil || 'load'
          const timeout = step.timeout ?? 60000
          if (!['domcontentloaded', 'load', 'networkidle'].includes(waitUntil)) {
            throw new Error(`waitUntil must be domcontentloaded, load, or networkidle, got: ${waitUntil}`)
          }
          await page.goto(url, { waitUntil, timeout })
        } else if (action === 'wait') {
          const delay = step.delay
          const selector = step.selector
          const selectorTimeout = step.selectorTimeout ?? 15000
          if (typeof delay === 'number' && delay > 0) {
            await new Promise((r) => setTimeout(r, delay))
          }
          if (selector) {
            await page.waitForSelector(selector, { state: 'visible', timeout: selectorTimeout })
          }
          if (typeof delay !== 'number' && !selector) {
            throw new Error('wait action requires delay (ms) and/or selector')
          }
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

    log('info', 'POST /run success', { stepCount: results.length, sessionId: resolvedSessionId })
    if (stream) {
      res.write(sseEvent({ type: 'done', success: true, steps: results, sessionId: resolvedSessionId }))
      res.end()
    } else {
      res.json({ success: true, steps: results, sessionId: resolvedSessionId })
    }
  } catch (err) {
    const msg = err?.message || String(err)
    log('error', 'POST /run failed', { error: msg })
    if (stream && res.headersSent) {
      try {
        res.write(sseEvent({ type: 'done', success: false, error: msg, steps: results, sessionId: resolvedSessionId }))
        res.end()
      } catch (_) {
        res.end()
      }
    } else {
      res.status(500).json({
        success: false,
        error: msg,
        steps: results,
        sessionId: resolvedSessionId ?? undefined,
      })
    }
  }
})

/**
 * GET /session/:sessionId/screenshot
 * Returns current screenshot + URL + title for the live browser panel.
 */
app.get('/session/:sessionId/screenshot', async (req, res) => {
  if (!checkAuth(req, res)) return
  const { sessionId } = req.params
  const entry = sessions.get(sessionId)
  if (!entry) return res.status(404).json({ success: false, error: 'Session not found' })
  try {
    const buf = await entry.page.screenshot({ type: 'png', encoding: 'base64', fullPage: false })
    const screenshotBase64 = typeof buf === 'string' ? buf : buf?.toString?.('base64') ?? null
    const url = entry.page.url()
    const title = await entry.page.title().catch(() => '')
    res.json({ success: true, screenshotBase64, url, title, sessionId })
  } catch (e) {
    res.status(500).json({ success: false, error: e?.message || String(e) })
  }
})

/**
 * GET /session/:sessionId/info
 * Returns current URL + title without taking a screenshot.
 */
app.get('/session/:sessionId/info', async (req, res) => {
  if (!checkAuth(req, res)) return
  const { sessionId } = req.params
  const entry = sessions.get(sessionId)
  if (!entry) return res.status(404).json({ success: false, error: 'Session not found' })
  try {
    const url = entry.page.url()
    const title = await entry.page.title().catch(() => '')
    res.json({ success: true, url, title, sessionId })
  } catch (e) {
    res.status(500).json({ success: false, error: e?.message || String(e) })
  }
})

/**
 * POST /session/:sessionId/interact
 * User-driven interaction endpoint for the human-handoff flow (login, CAPTCHA, etc.).
 * Body: { action: 'click'|'type'|'navigate'|'key'|'scroll', x?, y?, text?, url?, key? }
 */
app.post('/session/:sessionId/interact', async (req, res) => {
  if (!checkAuth(req, res)) return
  const { sessionId } = req.params
  const entry = sessions.get(sessionId)
  if (!entry) return res.status(404).json({ success: false, error: 'Session not found' })

  const { action, x, y, text, url: targetUrl, key } = req.body || {}
  const { page } = entry
  entry.lastUsedAt = Date.now()

  try {
    if (action === 'click') {
      if (typeof x !== 'number' || typeof y !== 'number') {
        return res.status(400).json({ success: false, error: 'x and y required for click' })
      }
      await page.mouse.click(x, y)
    } else if (action === 'type') {
      if (typeof text !== 'string') {
        return res.status(400).json({ success: false, error: 'text required for type' })
      }
      await page.keyboard.type(text, { delay: 30 })
    } else if (action === 'key') {
      if (typeof key !== 'string') {
        return res.status(400).json({ success: false, error: 'key required for key action' })
      }
      await page.keyboard.press(key)
    } else if (action === 'navigate') {
      if (typeof targetUrl !== 'string') {
        return res.status(400).json({ success: false, error: 'url required for navigate' })
      }
      await page.goto(targetUrl, { waitUntil: 'load', timeout: 60000 })
    } else if (action === 'scroll') {
      if (typeof x !== 'number' || typeof y !== 'number') {
        return res.status(400).json({ success: false, error: 'x and y (delta) required for scroll' })
      }
      await page.mouse.wheel(x, y)
    } else {
      return res.status(400).json({ success: false, error: `Unknown action: ${action}` })
    }

    const buf = await page.screenshot({ type: 'png', encoding: 'base64', fullPage: false })
    const screenshotBase64 = typeof buf === 'string' ? buf : buf?.toString?.('base64') ?? null
    const currentUrl = page.url()
    const title = await page.title().catch(() => '')
    res.json({ success: true, screenshotBase64, url: currentUrl, title, sessionId })
  } catch (e) {
    res.status(500).json({ success: false, error: e?.message || String(e) })
  }
})

/**
 * POST /session/:sessionId/smart-fill
 * Fills a form using Playwright smart locators (label → placeholder → CSS).
 * No pixel coordinates needed — much more reliable than coordinate-based clicks.
 */
app.post('/session/:sessionId/smart-fill', async (req, res) => {
  if (!checkAuth(req, res)) return
  const { sessionId } = req.params
  const entry = sessions.get(sessionId)
  if (!entry) return res.status(404).json({ success: false, error: 'Session not found' })

  const { fields = [], submitLabel, submitSelector, waitAfterMs = 3000 } = req.body || {}
  const { page } = entry
  entry.lastUsedAt = Date.now()
  const filled = [], errors = []

  try {
    for (const field of fields) {
      const { label, placeholder, selector, value = '' } = field
      try {
        let locator = null
        if (label) { locator = page.getByLabel(label, { exact: false }); if (!(await locator.count())) locator = null }
        if (!locator && placeholder) { locator = page.getByPlaceholder(placeholder, { exact: false }); if (!(await locator.count())) locator = null }
        if (!locator && selector) { locator = page.locator(selector); if (!(await locator.count())) locator = null }
        if (!locator) { errors.push({ field: label || placeholder || selector, error: 'Could not locate field' }); continue }
        await locator.first().click({ timeout: 5000 })
        await locator.first().fill(value, { timeout: 5000 })
        filled.push(label || placeholder || selector)
      } catch (e) {
        errors.push({ field: label || placeholder || selector, error: e?.message || String(e) })
      }
    }
    let submitted = false
    if (submitLabel) {
      try { const btn = page.getByRole('button', { name: new RegExp(submitLabel, 'i') }); if (await btn.count()) { await btn.first().click({ timeout: 8000 }); submitted = true } } catch {}
    }
    if (!submitted && submitSelector) {
      try { await page.click(submitSelector, { timeout: 8000 }); submitted = true } catch {}
    }
    if (!submitted) { try { await page.keyboard.press('Enter'); submitted = true } catch {} }
    if (submitted && waitAfterMs > 0) {
      await Promise.race([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: waitAfterMs }).catch(() => {}), new Promise(r => setTimeout(r, waitAfterMs))])
    }
    const buf = await page.screenshot({ type: 'jpeg', quality: 70, encoding: 'base64', fullPage: false })
    const screenshotBase64 = typeof buf === 'string' ? buf : buf?.toString?.('base64') ?? null
    res.json({ success: true, filled, errors, submitted, screenshotBase64, url: page.url(), title: await page.title().catch(() => ''), sessionId })
  } catch (e) {
    res.status(500).json({ success: false, error: e?.message || String(e), filled, errors })
  }
})

/**
 * GET /session/:sessionId/stream
 * SSE endpoint — pushes JPEG screenshots every 300ms when the page changes.
 */
app.get('/session/:sessionId/stream', async (req, res) => {
  if (!checkAuth(req, res)) return
  const { sessionId } = req.params
  const entry = sessions.get(sessionId)
  if (!entry) return res.status(404).json({ success: false, error: 'Session not found' })

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders?.()

  let lastHash = ''
  let active = true

  const push = async () => {
    if (!active) return
    const e = sessions.get(sessionId)
    if (!e) { res.write(`data: ${JSON.stringify({ type: 'session_closed' })}\n\n`); res.end(); active = false; return }
    try {
      const buf = await e.page.screenshot({ type: 'jpeg', quality: 60, fullPage: false })
      const b64 = typeof buf === 'string' ? buf : buf.toString('base64')
      const hash = b64.slice(0, 32)
      if (hash !== lastHash) {
        lastHash = hash
        res.write(`data: ${JSON.stringify({ type: 'frame', screenshotBase64: b64, url: e.page.url(), sessionId })}\n\n`)
      }
    } catch { /* skip frame during navigation */ }
  }

  const interval = setInterval(push, 300)
  const keepalive = setInterval(() => { if (active) res.write(': keepalive\n\n') }, 15_000)
  req.on('close', () => { active = false; clearInterval(interval); clearInterval(keepalive) })
})

/**
 * GET /session/:sessionId/state
 * Returns Playwright storageState (cookies + localStorage) for persistence.
 */
app.get('/session/:sessionId/state', async (req, res) => {
  if (!checkAuth(req, res)) return
  const { sessionId } = req.params
  const entry = sessions.get(sessionId)
  if (!entry) return res.status(404).json({ success: false, error: 'Session not found' })
  try {
    const storageState = await entry.context.storageState()
    const url = entry.page.url()
    const title = await entry.page.title().catch(() => '')
    res.json({ success: true, storageState, url, title, sessionId })
  } catch (e) {
    res.status(500).json({ success: false, error: e?.message || String(e) })
  }
})

/**
 * POST /sessions/restore
 * Creates a new browser session pre-loaded with saved cookies/localStorage.
 * Body: { storageState, startUrl? }
 */
app.post('/sessions/restore', async (req, res) => {
  if (!checkAuth(req, res)) return
  const { storageState, startUrl } = req.body || {}
  if (!storageState) return res.status(400).json({ success: false, error: 'storageState required' })
  try {
    const sessionId = randomId()
    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
    })
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      ignoreHTTPSErrors: true,
      storageState,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    })
    const page = await context.newPage()
    if (startUrl) await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {})
    sessions.set(sessionId, { browser, context, page, lastUsedAt: Date.now() })
    log('info', 'Session restored from saved state', { sessionId, startUrl })
    const url = page.url()
    const title = await page.title().catch(() => '')
    res.json({ success: true, sessionId, url, title })
  } catch (e) {
    res.status(500).json({ success: false, error: e?.message || String(e) })
  }
})

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Browser worker listening on 0.0.0.0:${PORT}`)
})
