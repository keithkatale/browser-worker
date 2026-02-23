/**
 * Terabits Browser Worker
 * Run Playwright in a long-lived process. Deploy to Railway, Render, or Fly.io.
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

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'terabits-browser-worker' })
})

app.post('/run', async (req, res) => {
  if (!checkAuth(req, res)) return
  const stream = req.query.stream === '1' || req.headers.accept === 'text/event-stream'
  const { steps } = req.body || {}

  if (!Array.isArray(steps) || steps.length === 0) {
    return res.status(400).json({ success: false, error: 'steps array required (1-15 items)' })
  }
  if (steps.length > 15) {
    return res.status(400).json({ success: false, error: 'max 15 steps' })
  }

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

    if (stream) {
      res.write(sseEvent({ type: 'done', success: true, steps: results }))
      res.end()
    } else {
      res.json({ success: true, steps: results })
    }
  } catch (err) {
    const msg = err?.message || String(err)
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

app.listen(PORT, () => {
  console.log(`Browser worker listening on port ${PORT}`)
})
