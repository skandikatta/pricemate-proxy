// coles-preflight.js — Pre-flight check + self-healing for Coles scraper
// Called at the start of scrape-coles.js. Returns the best working config.
// Does NOT modify the scraper logic — just determines which path to use.

const { fetchWithRetry, UA } = require('./scrape-utils')

const COLES_BASE = 'https://www.coles.com.au'
const TEST_CATEGORY = 'dairy-eggs-fridge'

// Known field mappings for price extraction (in priority order)
const PRICE_EXTRACTORS = [
  p => p.pricing?.now,
  p => p.price,
  p => p.Price,
  p => p.currentPrice,
  p => p.salePrice,
]

/**
 * Run pre-flight checks. Returns a config object the scraper should use.
 * 
 * @param {string} proxyUrl - Render proxy URL
 * @returns {{ path: 'render'|'playwright'|'html', buildId: string|null, priceField: string, storeId: string }}
 */
async function preflight(proxyUrl) {
  const config = { path: 'render', buildId: null, priceField: 'pricing.now', storeId: '7674', needsStoreCookie: false }

  console.log('[preflight] Testing Render proxy...')

  // Step 1: Try Render
  const renderResult = await fetchWithRetry(`${proxyUrl}/api/browse/coles?category=${TEST_CATEGORY}&page=1`)
  if (renderResult.ok) {
    try {
      const data = await renderResult.response.json()
      const results = (data?.pageProps?.searchResults?.results || []).filter(p => p._type === 'PRODUCT')
      if (results.length > 0) {
        const priceCheck = checkPrices(results)
        if (priceCheck.hasPrice) {
          config.priceField = priceCheck.field
          console.log(`[preflight] Render OK — ${results.length} products, prices via ${priceCheck.field}`)
          return config
        } else {
          console.log('[preflight] Render returned products but no prices — may need store cookie')
        }
      }
    } catch (e) {
      console.log(`[preflight] Render parse error: ${e.message}`)
    }
  } else {
    console.log(`[preflight] Render failed: ${renderResult.error || renderResult.status}`)
  }

  // Step 2: Try direct _next/data with fresh buildId
  console.log('[preflight] Trying direct with fresh buildId...')
  const buildId = await discoverBuildId()
  if (buildId) {
    config.buildId = buildId
    const directUrl = `${COLES_BASE}/_next/data/${buildId}/en/browse/${TEST_CATEGORY}.json?slug=${TEST_CATEGORY}&page=1`
    const directResult = await fetchWithRetry(directUrl)
    if (directResult.ok) {
      try {
        const data = await directResult.response.json()
        const results = (data?.pageProps?.searchResults?.results || []).filter(p => p._type === 'PRODUCT')
        if (results.length > 0) {
          const priceCheck = checkPrices(results)
          if (priceCheck.hasPrice) {
            config.path = 'render' // direct works, Render just needs new buildId
            config.priceField = priceCheck.field
            console.log(`[preflight] Direct OK — buildId=${buildId.slice(0, 20)}..., prices via ${priceCheck.field}`)
            return config
          }
        }
      } catch {}
    }
  }

  // Step 3: Fall to Playwright (it has store cookie fix built in)
  console.log('[preflight] Falling to Playwright path')
  config.path = 'playwright'
  return config
}

/**
 * HTML fallback: extract products from the rendered page's __NEXT_DATA__
 * Use when both Render and Playwright JSON paths fail.
 */
async function extractFromHtml(category, page = 1) {
  const url = `${COLES_BASE}/browse/${category}${page > 1 ? '?page=' + page : ''}`
  const result = await fetchWithRetry(url)
  if (!result.ok) return null

  const html = await result.response.text()
  const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([^<]+)<\/script>/)
  if (!match) return null

  try {
    const data = JSON.parse(match[1])
    return data?.pageProps?.searchResults || null
  } catch {
    return null
  }
}

function checkPrices(results) {
  const sample = results.slice(0, 5)
  for (const extractor of PRICE_EXTRACTORS) {
    const prices = sample.map(p => extractor(p)).filter(v => v && v > 0)
    if (prices.length >= 3) {
      // Determine field name for logging
      const fieldName = extractor.toString().match(/p\.([a-zA-Z?.]+)/)?.[1] || 'unknown'
      return { hasPrice: true, field: fieldName }
    }
  }
  return { hasPrice: false, field: null }
}

async function discoverBuildId() {
  try {
    const result = await fetchWithRetry(COLES_BASE)
    if (!result.ok) return null
    const html = await result.response.text()
    const match = html.match(/"buildId":"([^"]+)"/)
    return match ? match[1] : null
  } catch {
    return null
  }
}

module.exports = { preflight, extractFromHtml }
