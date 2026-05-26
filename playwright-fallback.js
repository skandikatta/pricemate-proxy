// Playwright fallback for Coles scraping.
//
// Use case: when Render's IP gets Imperva-flagged (the `_next/data` path
// returns the 1KB Incapsula challenge instead of real JSON), this module
// drives a real headless Chromium with stealth plugin against Coles
// directly from the GH Actions runner.
//
// Mechanism (verified empirically 2026-05-27 — see probe/coles-bypass branch):
//   1. Launch chromium with puppeteer-extra-plugin-stealth → patches
//      navigator.webdriver, UA, plugins, etc.
//   2. Navigate coles.com.au homepage → Imperva serves JS challenge →
//      Chromium executes it → 21 cookies set including visid_incap_2800108,
//      incap_ses_*, nlbi_*.
//   3. page.evaluate(fetch('/_next/data/.../<cat>.json')) → cookies attach
//      automatically → Imperva passes the request → real 380 KB JSON.
//
// Plain curl, curl-impersonate with Chrome 110 TLS, and Playwright without
// the homepage warmup all return the 1KB challenge from a cloud IP. The
// warmup-then-fetch flow is what unblocks it.

const COLES_BASE = 'https://www.coles.com.au'
const STEALTH_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

let _ctx = null

async function getContext() {
  if (_ctx) return _ctx
  const { chromium } = require('playwright-extra')
  const stealth = require('puppeteer-extra-plugin-stealth')()
  chromium.use(stealth)

  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({
    userAgent: STEALTH_UA,
    viewport: { width: 1280, height: 800 },
    locale: 'en-AU',
  })
  const page = await ctx.newPage()

  console.log('  [pw] warming up via coles.com.au homepage...')
  await page.goto(COLES_BASE, { waitUntil: 'domcontentloaded', timeout: 30000 })
  // Imperva's JS challenge takes 1-3s to execute and set cookies. 5s is
  // generous headroom — collected 21 cookies including the Incapsula
  // session cookies in test runs.
  await page.waitForTimeout(5000)

  // Extract buildId from the homepage HTML in the same shot — kills the
  // need for the FALLBACK_BUILD_ID weekly ritual in index.js.
  const buildId = await page.evaluate(() => {
    const m = document.documentElement.innerHTML.match(/"buildId":"([^"]+)"/)
    return m ? m[1] : null
  })
  if (!buildId) throw new Error('[pw] no buildId in homepage — stealth may be defeated')

  const cookieCount = (await ctx.cookies(COLES_BASE)).length
  console.log(`  [pw] warmed up: buildId=${buildId.slice(0, 24)}..., ${cookieCount} cookies`)

  _ctx = { browser, ctx, page, buildId }
  return _ctx
}

async function fetchCategoryPage(slug, pageNum) {
  const { page, buildId } = await getContext()
  const url = `${COLES_BASE}/_next/data/${buildId}/en/browse/${slug}.json?slug=${slug}&page=${pageNum}`
  return await page.evaluate(async (u) => {
    try {
      const r = await fetch(u, { headers: { 'Accept': 'application/json' } })
      const text = await r.text()
      return { ok: r.ok, status: r.status, contentType: r.headers.get('content-type'), body: text }
    } catch (e) {
      return { ok: false, status: 0, error: e.message }
    }
  }, url)
}

async function close() {
  if (_ctx) {
    try { await _ctx.browser.close() } catch {}
    _ctx = null
  }
}

module.exports = { fetchCategoryPage, close }
