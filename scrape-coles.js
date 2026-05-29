const { upsertProducts, insertPriceChanges, close, getStoreProductCount } = require('./db')
const { AdaptiveThrottle, fetchWithRetry, Progress, Stats, sleep, UA } = require('./scrape-utils')
const PROXY = process.env.PROXY_URL || 'https://pricemate-proxy.onrender.com'
const MIN_EXPECTED_PRODUCTS = 100
const DEGRADATION_THRESHOLD = 0.70 // alert if today's total < 70% of prior catalog size

// Playwright fallback is lazy-required only when Render fails — keeps cold-start
// time down on the happy path. The module ships ~Chromium-sized deps so we don't
// want to load it eagerly.
let playwrightFallback = null
function getPlaywrightFallback() {
  if (!playwrightFallback) playwrightFallback = require('./playwright-fallback')
  return playwrightFallback
}

// Curated category list. The display title (apiTitle) is the stable lookup key
// against /api/coles/categories — slugs occasionally rotate (household →
// cleaning-laundry); titles don't. fallbackSlug is used if discovery degrades.
const CATEGORIES = [
  { apiTitle: 'Dairy, Eggs & Fridge',    fallbackSlug: 'dairy-eggs-fridge' },
  { apiTitle: 'Fruit & Vegetables',      fallbackSlug: 'fruit-vegetables' },
  { apiTitle: 'Meat & Seafood',          fallbackSlug: 'meat-seafood' },
  { apiTitle: 'Pantry',                  fallbackSlug: 'pantry' },
  { apiTitle: 'Drinks',                  fallbackSlug: 'drinks' },
  { apiTitle: 'Frozen',                  fallbackSlug: 'frozen' },
  { apiTitle: 'Bakery',                  fallbackSlug: 'bakery' },
  { apiTitle: 'Health & Beauty',         fallbackSlug: 'health-beauty' },
  { apiTitle: 'Baby',                    fallbackSlug: 'baby' },
  { apiTitle: 'Pet',                     fallbackSlug: 'pet' },
  { apiTitle: 'Deli',                    fallbackSlug: 'deli' },
  { apiTitle: 'Cleaning & Laundry',      fallbackSlug: 'cleaning-laundry' },
  { apiTitle: 'Chips & Chocolate',       fallbackSlug: 'chips-chocolates-snacks' },
  { apiTitle: 'Dietary & World Foods',   fallbackSlug: 'dietary-world-foods' },
  { apiTitle: 'Home & Garden',           fallbackSlug: 'home-garden' },
]

async function resolveCategories() {
  try {
    const r = await fetch(`${PROXY}/api/coles/categories`)
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const { categories: api } = await r.json()
    if (!Array.isArray(api) || api.length < 10) throw new Error(`only ${api?.length || 0} categories from proxy`)
    const apiMap = new Map(api.map(c => [c.title, c.slug]))

    let rotated = 0, missing = 0
    const resolved = CATEGORIES.map(c => {
      const currentSlug = apiMap.get(c.apiTitle)
      if (currentSlug && currentSlug !== c.fallbackSlug) {
        console.log(`  [cat rotated] ${c.apiTitle}: ${c.fallbackSlug} → ${currentSlug}`)
        rotated++
      } else if (!currentSlug) {
        console.warn(`  [cat missing in API] ${c.apiTitle} — using fallback ${c.fallbackSlug}`)
        missing++
      }
      return currentSlug || c.fallbackSlug
    })
    console.log(`  Resolved ${resolved.length} categories via discovery (${rotated} rotated, ${missing} missing → fallback)`)
    return resolved
  } catch (e) {
    console.warn(`  Category discovery failed (${e.message}) — using hardcoded fallback list`)
    return CATEGORIES.map(c => c.fallbackSlug)
  }
}

async function scrapeColes() {
  console.log('=== COLES (via Render proxy) ===')
  const startedAt = Date.now()

  // Pre-flight: verify the scrape path works before committing to a full run
  const { preflight } = require('./coles-preflight')
  const flightConfig = await preflight(PROXY)
  console.log(`[preflight] Using path: ${flightConfig.path}, price field: ${flightConfig.priceField}`)

  const priorCatalogCount = await getStoreProductCount('coles').catch(() => null)
  const categories = await resolveCategories()
  let total = 0, changes = 0, failedCategories = []
  const throttle = new AdaptiveThrottle({ minDelay: 200, maxDelay: 2000, targetConcurrency: 4 })
  const stats = new Stats('coles')
  const progress = new Progress('coles')

  let usedPlaywright = false

  for (const cat of categories) {
    if (progress.isCompleted(cat)) { continue }
    // Render is primary (4× faster); Playwright kicks in only when Render
    // returns errors. Once we switch a category to Playwright we stay on
    // Playwright for that category — don't flip back mid-pagination.
    let viaPlaywright = false

    for (let pageNum = 1; pageNum <= 999; pageNum++) {
      process.stdout.write(`  ${cat} p${pageNum}${viaPlaywright ? ' [pw]' : ''}...`)
      let data = null

      if (!viaPlaywright) {
        const url = `${PROXY}/api/browse/coles?category=${cat}&page=${pageNum}`
        const fetched = await fetchWithRetry(url, `${cat} p${pageNum}`)
        if (!fetched.ok) {
          // Render exhausted retries. If we haven't gotten any pages for this
          // category yet, try Playwright. If we're mid-pagination, just stop
          // this category (a partial Render+Playwright stitch isn't worth the
          // complexity for an edge case).
          if (pageNum === 1) {
            console.log(` ${fetched.error} after retries → switching to Playwright fallback`)
            viaPlaywright = true
            usedPlaywright = true
          } else {
            console.log(` ${fetched.error} mid-category, stopping`)
            failedCategories.push(cat)
            break
          }
        } else {
          try {
            data = await fetched.response.json()
          } catch (e) {
            console.log(` PARSE ERROR: ${e.message}`)
            failedCategories.push(cat)
            break
          }
        }
      }

      if (viaPlaywright) {
        try {
          const pw = getPlaywrightFallback()
          const res = await pw.fetchCategoryPage(cat, pageNum)
          if (!res.ok) {
            console.log(` Playwright HTTP ${res.status}, stopping`)
            failedCategories.push(cat)
            break
          }
          // Imperva sometimes returns 200 with a 1KB challenge body. Detect.
          if (res.body.length < 2000) {
            console.log(` Playwright body=${res.body.length}b (Imperva challenge), stopping`)
            failedCategories.push(cat)
            break
          }
          data = JSON.parse(res.body)
        } catch (e) {
          console.log(` Playwright ERROR: ${e.message}`)
          failedCategories.push(cat)
          break
        }
      }

      if (data.error) { console.log(` ${data.error}, stopping`); break }
      const results = (data?.pageProps?.searchResults?.results || []).filter(p => p._type === 'PRODUCT')
      if (results.length === 0) { console.log(' empty, done'); break }

      const products = results.map(p => ({
        store: 'coles', product_id: String(p.id), name: p.name,
        brand: p.brand || null, size: p.size || null, category: cat,
        image: p.imageUris?.[0]?.uri ? 'https://productimages.coles.com.au/productimages' + p.imageUris[0].uri : null,
      }))

      const prices = results.map(p => {
        const pr = p.pricing || {}
        return { store: 'coles', product_id: String(p.id), price: pr.now || 0, was_price: pr.was || null, is_on_special: pr.onlineSpecial || false, cup_price: pr.comparable || null }
      })

      await upsertProducts(products)
      const changed = await insertPriceChanges(prices)
      changes += changed
      total += products.length
      stats.tick(products.length)
      console.log(` ${results.length} products (${changed} changes)`)
      await throttle.wait()
    }
    progress.markCompleted(cat)
  }

  // Tear down Playwright if we used it (browser process + Chromium = memory).
  if (usedPlaywright) {
    await getPlaywrightFallback().close()
  }

  const durationS = Math.round((Date.now() - startedAt) / 1000)

  if (failedCategories.length > 0) console.warn(`WARNING: Failed categories: ${failedCategories.join(', ')}`)
  console.log(`\nColes done: ${total} products, ${changes} price changes in ${durationS}s`)

  let degraded = false
  if (total === 0) {
    console.warn('WARNING: Zero products scraped. Coles API may have changed or proxy is down.')
    console.warn('Existing DB data preserved.')
  } else if (total < MIN_EXPECTED_PRODUCTS) {
    console.warn(`WARNING: Only ${total} products (expected ${MIN_EXPECTED_PRODUCTS}+).`)
  }

  // Degradation alert: if today's scrape is materially smaller than the active
  // catalog before this run, something is silently broken (Imperva block on a
  // subset of categories, slug change, etc).
  if (priorCatalogCount !== null && priorCatalogCount > 0 && total > 0) {
    const ratio = total / priorCatalogCount
    if (ratio < DEGRADATION_THRESHOLD) {
      degraded = true
      console.error(`DEGRADATION: scraped ${total} vs prior catalog of ${priorCatalogCount} (${(ratio * 100).toFixed(1)}%, threshold ${DEGRADATION_THRESHOLD * 100}%)`)
    }
  }

  // One-line JSON summary, grep-friendly for GH Actions log scraping + alerting.
  const summary = {
    date: new Date().toISOString().slice(0, 10),
    store: 'coles',
    total,
    changes,
    failed_categories: failedCategories,
    duration_s: durationS,
    prior_catalog_count: priorCatalogCount,
    degraded,
    used_playwright_fallback: usedPlaywright,
  }
  console.log('SCRAPE_SUMMARY ' + JSON.stringify(summary))
  stats.print()
  progress.clear()

  return { total, changes, failedCategories, degraded }
}


console.log(`Coles scrape started: ${new Date().toISOString()}`)
scrapeColes()
  .then((result) => {
    console.log(`Coles scrape complete: ${new Date().toISOString()}`)
    if (result?.failedCategories?.length > 0) {
      console.error(`FAIL: ${result.failedCategories.length} categories did not complete: ${result.failedCategories.join(', ')}`)
      process.exitCode = 1
    }
    if (result?.degraded) {
      process.exitCode = 1
    }
    return close()
  })
  .catch(e => {
    const external = ['fetch failed', 'ECONNREFUSED', 'ETIMEDOUT', 'HTTP', 'proxy', 'Render']
    const isExternal = external.some(msg => e.message?.includes(msg))
    if (isExternal) {
      console.warn('EXTERNAL FAILURE:', e.message)
      process.exitCode = 0
    } else {
      console.error('CODE BUG:', e.message)
      console.error(e.stack)
      process.exitCode = 1
    }
    return close()
  })
