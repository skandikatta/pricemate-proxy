const { upsertProducts, insertPriceChanges, close } = require('./db')
const { extractProducts } = require('./extract-aldi')
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:129.0) Gecko/20100101 Firefox/129.0'
const ALDI_BASE = 'https://www.aldi.com.au'

// Minimum products we expect — if below this, site likely changed
const MIN_EXPECTED_PRODUCTS = 50

// Per-request timeout. Aldi categories rarely take >5s; slow responses
// shouldn't hang forever (GH Actions 30-min cap is too coarse a net).
const REQUEST_TIMEOUT_MS = 15000

// Pagination safety guard. Real Aldi categories top out ~10-15 pages —
// if we loop past this, pagination detection has misfired.
const MAX_PAGES_PER_CATEGORY = 100

// Retry on transient errors. Mirrors scrape-coles.js / scrape-woolworths.js.
// 5xx + network errors retry with exp backoff; 4xx returns immediately.
async function fetchWithRetry(url, { headers = {}, retries = 3 } = {}) {
  let lastErr = null
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (res.ok) return res
      if (res.status >= 400 && res.status < 500) return res
      lastErr = new Error(`HTTP ${res.status}`)
    } catch (e) {
      lastErr = e
    }
    if (attempt < retries - 1) {
      await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)))
    }
  }
  throw lastErr || new Error('fetchWithRetry exhausted')
}

// Hardcoded top-level category IDs (discovered May 2026)
// These are stable — Aldi rarely changes category structure
const TOP_LEVEL_CATEGORIES = {
  'fruits-vegetables': '950000000',
  'meat-seafood': '940000000',
  'deli-chilled-meats': '930000000',
  'dairy-eggs-fridge': '960000000',
  'pantry': '970000000',
  'bakery': '920000000',
  'freezer': '980000000',
  'drinks': '1000000000',
  'health-beauty': '1040000000',
  'baby': '1030000000',
  'cleaning-household': '1050000000',
  'pets': '1020000000',
  'snacks-confectionery': '1588161408332087',
  'lower-prices': '1588161425841179',
  'higher-protein-food-and-drink': '1588161427774115',
  'super-savers': '1588161426952145',
}

async function discoverCategories() {
  // Try dynamic discovery first (resilient to ID changes)
  try {
    const res = await fetchWithRetry(`${ALDI_BASE}/products`, { headers: { 'User-Agent': UA } })
    if (res.ok) {
      const html = await res.text()
      const matches = [...html.matchAll(/href="\/products\/([^"]+)\/k\/(\d+)"/g)]
      const seen = new Set()
      const discovered = []
      const SKIP = ['snow-gear', 'limited-time-only', 'liquor', 'front-of-store']
      for (const m of matches) {
        const slug = m[1]; const id = m[2]
        const topLevel = slug.split('/')[0]
        if (SKIP.includes(topLevel)) continue
        // Only top-level (no slash in slug)
        if (slug.includes('/')) continue
        const url = `/products/${slug}/k/${id}`
        if (seen.has(topLevel)) continue
        seen.add(topLevel)
        discovered.push({ url, name: topLevel.replace(/-/g, ' '), id })
      }
      if (discovered.length >= 10) {
        console.log(`  Discovered ${discovered.length} categories dynamically`)
        return discovered
      }
    }
  } catch (e) { console.warn('  Dynamic discovery failed:', e.message) }

  // Fallback: hardcoded IDs (last verified May 2026)
  console.log('  Using hardcoded category IDs (fallback)')
  return Object.entries(TOP_LEVEL_CATEGORIES).map(([slug, id]) => ({
    url: `/products/${slug}/k/${id}`,
    name: slug.replace(/-/g, ' '),
    id,
  }))
}

async function scrapeCategory(url) {
  let allProducts = [], page = 1
  while (page <= MAX_PAGES_PER_CATEGORY) {
    const pageUrl = `${ALDI_BASE}${url}${page > 1 ? '?page=' + page : ''}`
    let res
    try {
      res = await fetchWithRetry(pageUrl, { headers: { 'User-Agent': UA } })
    } catch (e) {
      // All retries exhausted on this page. Keep what we got from earlier pages.
      console.warn(`    [retry-exhausted] ${pageUrl} → ${e.message}`)
      break
    }
    if (!res.ok) break
    const html = await res.text()
    // Aldi sends a meta-refresh redirect when you page past the last result.
    // Belt-and-braces: the products.length === 0 check below catches the same case
    // if Aldi ever switches to a JS or 302 redirect.
    if (html.includes('http-equiv="refresh"')) break
    const products = extractProducts(html)
    if (products.length === 0) break
    allProducts.push(...products)
    page++
    await new Promise(r => setTimeout(r, 500))
  }
  if (page > MAX_PAGES_PER_CATEGORY) {
    console.warn(`    [page-cap] hit ${MAX_PAGES_PER_CATEGORY}-page safety cap on ${url} — pagination terminator may have changed`)
  }
  return allProducts
}

async function main() {
  console.log('=== ALDI (direct, HTML parsing) ===')
  const categories = await discoverCategories()

  if (categories.length === 0) {
    console.warn('WARNING: No categories discovered — Aldi may have changed their site structure')
    console.warn('Scraper needs manual update. Exiting gracefully.')
    process.exitCode = 0
    return
  }

  console.log(`Found ${categories.length} categories\n`)

  let allProducts = [], allPrices = [], failedCategories = []
  for (const cat of categories) {
    process.stdout.write(`  ${cat.name}...`)
    try {
      const products = await scrapeCategory(cat.url)
      if (products.length === 0) {
        console.log(' 0 (may have changed)')
        failedCategories.push(cat.name)
        continue
      }
      for (const p of products) {
        allProducts.push({ store: 'aldi', product_id: p.productId, name: p.name, brand: p.brand, size: p.size || null, category: cat.name, image: p.image })
        allPrices.push({ store: 'aldi', product_id: p.productId, price: p.price, was_price: p.wasPrice || null, is_on_special: !!p.isOnSpecial, cup_price: p.cupPrice || null })
      }
      console.log(` ${products.length}`)
    } catch (e) {
      console.log(` ERROR: ${e.message}`)
      failedCategories.push(cat.name)
    }
    await new Promise(r => setTimeout(r, 500))
  }

  // --- Graceful degradation ---
  if (allProducts.length === 0) {
    console.warn('\nWARNING: Zero products extracted. Aldi likely changed their HTML structure.')
    console.warn('Skipping DB write — existing data preserved.')
    console.warn('Action needed: update extractProducts() regex patterns.')
    // Exit 0 so the pipeline doesn't fail — old data in DB is still valid
    process.exitCode = 0
    return
  }

  if (allProducts.length < MIN_EXPECTED_PRODUCTS) {
    console.warn(`\nWARNING: Only ${allProducts.length} products (expected ${MIN_EXPECTED_PRODUCTS}+). Some categories may have broken.`)
  }

  if (failedCategories.length > 0) {
    console.warn(`\nWARNING: ${failedCategories.length} categories returned 0 products: ${failedCategories.join(', ')}`)
  }

  // Dedup across categories — a product can appear in multiple categories
  // (e.g. 'lower-prices' overlaps with 'pantry'). db.js dedupes inside
  // insertPriceChanges already, but doing it here too avoids passing 2x rows
  // through upsertProducts and keeps SCRAPE_SUMMARY counts honest.
  const productMap = new Map()
  for (const p of allProducts) productMap.set(p.product_id, p)
  const priceMap = new Map()
  for (const p of allPrices) priceMap.set(p.product_id, p)
  const dedupedProducts = [...productMap.values()]
  const dedupedPrices = [...priceMap.values()]
  if (dedupedProducts.length < allProducts.length) {
    console.log(`  Deduped ${allProducts.length - dedupedProducts.length} cross-category duplicates`)
  }
  allProducts = dedupedProducts
  allPrices = dedupedPrices

  // Still save whatever we got — partial data is better than no data
  console.log(`\nTotal: ${allProducts.length} products`)
  await upsertProducts(allProducts)
  const changes = await insertPriceChanges(allPrices)
  console.log(`Done! ${allProducts.length} products, ${changes} price changes`)

  const onSpecial = allPrices.filter(p => p.is_on_special).length
  const summary = {
    store: 'aldi',
    total: allProducts.length,
    changes,
    failedCategories,
    onSpecial,
    completedAt: new Date().toISOString(),
  }
  console.log('SCRAPE_SUMMARY ' + JSON.stringify(summary))

  return { total: allProducts.length, changes, failedCategories }
}

console.log(`Aldi scrape started: ${new Date().toISOString()}`)
main()
  .then((result) => {
    console.log(`Aldi scrape complete: ${new Date().toISOString()}`)
    if (result?.failedCategories?.length > 0) {
      console.error(`FAIL: ${result.failedCategories.length} categories did not complete: ${result.failedCategories.join(', ')}`)
      process.exitCode = 1
    }
    return close()
  })
  .catch(e => {
    // Classify: external (site changed) vs internal (our bug)
    const external = [
      'No products extracted',
      'Failed to get',
      'HTTP',
      'ECONNREFUSED',
      'ETIMEDOUT',
      'fetch failed',
    ]
    const isExternal = external.some(msg => e.message?.includes(msg))

    if (isExternal) {
      console.warn('EXTERNAL FAILURE:', e.message)
      console.warn('Site may have changed — existing DB data preserved.')
      process.exitCode = 0  // Don't break pipeline
    } else {
      console.error('CODE BUG:', e.message)
      console.error(e.stack)
      process.exitCode = 1  // Break pipeline — needs fix
    }
    return close()
  })
