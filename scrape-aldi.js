const { upsertProducts, insertPriceChanges, close } = require('./db')
const { extractProducts } = require('./extract-aldi')
const { AdaptiveThrottle, fetchWithRetry, fetchConcurrent, Progress, Stats, sleep, UA } = require('./scrape-utils')
const ALDI_BASE = 'https://www.aldi.com.au'

// Minimum products we expect — if below this, site likely changed
const MIN_EXPECTED_PRODUCTS = 50

// Pagination safety guard. Real Aldi categories top out ~10-15 pages.
const MAX_PAGES_PER_CATEGORY = 100

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
    const result = await fetchWithRetry(`${ALDI_BASE}/products`)
    if (result.ok) {
      const html = await result.response.text()
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

async function scrapeCategory(url, throttle, stats) {
  let allProducts = [], page = 1
  while (page <= MAX_PAGES_PER_CATEGORY) {
    const pageUrl = `${ALDI_BASE}${url}${page > 1 ? '?page=' + page : ''}`
    const result = await fetchWithRetry(pageUrl)
    if (!result.ok) break
    if (result.elapsed) throttle.record(result.elapsed)
    const html = await result.response.text()
    stats.tick(0, html.length)
    if (html.includes('http-equiv="refresh"')) break
    const products = extractProducts(html)
    if (products.length === 0) break
    allProducts.push(...products)
    page++
    await throttle.wait()
  }
  if (page > MAX_PAGES_PER_CATEGORY) {
    console.warn(`    [page-cap] hit ${MAX_PAGES_PER_CATEGORY}-page safety cap on ${url} — pagination terminator may have changed`)
  }
  return allProducts
}

async function main() {
  console.log('=== ALDI (direct, HTML parsing) ===')

  // Pre-flight: verify Aldi is reachable and extraction works
  console.log('[preflight] Testing Aldi site...')
  const testResult = await fetchWithRetry(`${ALDI_BASE}/products/dairy-eggs-fridge/k/960000000`)
  if (testResult.ok) {
    const html = await testResult.response.text()
    const testProducts = extractProducts(html)
    if (testProducts.length > 0) {
      console.log(`[preflight] OK — ${testProducts.length} products extracted from test page`)
    } else {
      console.warn('[preflight] WARNING: 0 products extracted — HTML structure may have changed')
      console.warn('[preflight] Continuing anyway — other categories may still work')
    }
  } else {
    console.warn(`[preflight] Aldi returned ${testResult.error} — site may be down`)
  }

  const categories = await discoverCategories()

  if (categories.length === 0) {
    console.warn('WARNING: No categories discovered — Aldi may have changed their site structure')
    console.warn('Scraper needs manual update. Exiting gracefully.')
    process.exitCode = 0
    return
  }

  console.log(`Found ${categories.length} categories\n`)

  let allProducts = [], allPrices = [], failedCategories = []
  const throttle = new AdaptiveThrottle({ minDelay: 300, maxDelay: 2000, targetConcurrency: 2 })
  const stats = new Stats('aldi')
  const progress = new Progress('aldi')

  for (const cat of categories) {
    if (progress.isCompleted(cat.name)) {
      console.log(`  ${cat.name}... skipped (resumed)`)
      continue
    }
    process.stdout.write(`  ${cat.name}...`)
    try {
      const products = await scrapeCategory(cat.url, throttle, stats)
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
      progress.markCompleted(cat.name)
    } catch (e) {
      console.log(` ERROR: ${e.message}`)
      stats.error()
      failedCategories.push(cat.name)
    }
    await throttle.wait()
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
  stats.print()
  progress.clear()

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
