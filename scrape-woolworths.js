const { upsertProducts, insertPriceChanges, close, getStoreProductCount } = require('./db')
const WOOLWORTHS_BASE = 'https://www.woolworths.com.au'

// Retry on 5xx and network blips. Mirrors scrape-coles.js fetchWithRetry —
// without this a single transient failure killed an entire department
// (~10-15min of scrape lost).
const MAX_PAGE_ATTEMPTS = 3
async function fetchWithRetry(url, opts, label) {
  let lastErr = null
  for (let attempt = 1; attempt <= MAX_PAGE_ATTEMPTS; attempt++) {
    try {
      const r = await fetch(url, opts)
      if (r.ok) return { ok: true, response: r }
      if (r.status >= 500 && attempt < MAX_PAGE_ATTEMPTS) {
        lastErr = `HTTP ${r.status}`
        await new Promise(s => setTimeout(s, 1000 * Math.pow(2, attempt - 1)))
        continue
      }
      return { ok: false, status: r.status, error: `HTTP ${r.status}` }
    } catch (e) {
      lastErr = e.message
      if (attempt < MAX_PAGE_ATTEMPTS) {
        await new Promise(s => setTimeout(s, 1000 * Math.pow(2, attempt - 1)))
        continue
      }
    }
  }
  return { ok: false, error: lastErr || 'unknown' }
}

// Cookie refresh interval. Woolies session cookies appear to be ~60min TTL
// based on observation; refreshing every 30min mid-scrape prevents the
// silent "0 products" failure mode in later departments.
const COOKIE_TTL_MS = 30 * 60 * 1000
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:129.0) Gecko/20100101 Firefox/129.0'
const MIN_EXPECTED_PRODUCTS = 100

// Curated department list. The display name (apiName) is the stable lookup key —
// IDs rotate every few months; names rarely change. fallbackId is used if the
// PiesCategoriesWithSpecials endpoint is unreachable or doesn't list this dept.
const DEPARTMENTS = [
  { name: 'fruit-veg',         apiName: 'Fruit & Veg',              fallbackId: '1-E5BEE36E' },
  { name: 'bakery',            apiName: 'Bakery',                   fallbackId: '1_DEB537E'  },
  { name: 'meat-seafood-deli', apiName: 'Poultry, Meat & Seafood',  fallbackId: '1_D5A2236'  },
  { name: 'dairy-eggs-fridge', apiName: 'Dairy, Eggs & Fridge',     fallbackId: '1_6E4F4E4'  },
  { name: 'pantry',            apiName: 'Pantry',                   fallbackId: '1_39FD49C'  },
  { name: 'frozen',            apiName: 'Freezer',                  fallbackId: '1_ACA2FC2'  },
  { name: 'drinks',            apiName: 'Drinks',                   fallbackId: '1_5AF3A0A'  },
  { name: 'health-beauty',     apiName: 'Personal Care',            fallbackId: '1_894D0A8'  },
  { name: 'household',         apiName: 'Cleaning & Maintenance',   fallbackId: '1_2432B58'  },
  { name: 'baby',              apiName: 'Baby',                     fallbackId: '1_717A94B'  },
  { name: 'pet',               apiName: 'Pet',                      fallbackId: '1_61D6FEB'  },
  { name: 'front-of-store',    apiName: 'Front of Store',           fallbackId: '1_B63CF9E'  },
]

async function getWoolworthsCookies() {
  const res = await fetch(`${WOOLWORTHS_BASE}/shop/browse/fruit-veg`, { headers: { 'User-Agent': UA }, redirect: 'manual' })
  const setCookies = res.headers.getSetCookie?.() || []
  return setCookies.map(c => c.split(';')[0]).join('; ')
}

async function resolveDepartments() {
  try {
    const res = await fetch(`${WOOLWORTHS_BASE}/apis/ui/PiesCategoriesWithSpecials`, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    const apiMap = new Map()
    for (const c of data.Categories || []) {
      if (c.NodeLevel === 1 && c.Description && c.NodeId) apiMap.set(c.Description, c.NodeId)
    }
    if (apiMap.size < 10) throw new Error(`only ${apiMap.size} top-level depts from API`)

    let rotated = 0, missing = 0
    const resolved = DEPARTMENTS.map(d => {
      const currentId = apiMap.get(d.apiName)
      if (currentId && currentId !== d.fallbackId) {
        console.log(`  [dept rotated] ${d.apiName}: ${d.fallbackId} → ${currentId}`)
        rotated++
      } else if (!currentId) {
        console.warn(`  [dept missing in API] ${d.apiName} — using fallback ${d.fallbackId}`)
        missing++
      }
      return { id: currentId || d.fallbackId, name: d.name }
    })
    console.log(`  Resolved ${resolved.length} departments via discovery (${rotated} rotated, ${missing} missing → fallback)`)
    return resolved
  } catch (e) {
    console.warn(`  Department discovery failed (${e.message}) — using hardcoded fallback list`)
    return DEPARTMENTS.map(d => ({ id: d.fallbackId, name: d.name }))
  }
}

async function scrapeWoolworths() {
  console.log('=== WOOLWORTHS (direct) ===')
  const cookies = await getWoolworthsCookies()
  if (!cookies) {
    console.warn('WARNING: Failed to get cookies — Woolworths may have changed auth.')
    console.warn('Exiting gracefully — existing DB data preserved.')
    return
  }
  console.log('Cookies obtained ✓')

  const priorCatalogCount = await getStoreProductCount('woolworths').catch(() => null)
  const departments = await resolveDepartments()
  let total = 0, changes = 0, failedDepts = []
  let cookiesFetchedAt = Date.now()
  let activeCookies = cookies

  for (const dept of departments) {
    // Refresh cookies if older than COOKIE_TTL_MS. Long scrapes (~1h43m total)
    // outlive Woolies' session — without this, later departments silently
    // returned 0 products.
    if (Date.now() - cookiesFetchedAt > COOKIE_TTL_MS) {
      try {
        const refreshed = await getWoolworthsCookies()
        if (refreshed) {
          activeCookies = refreshed
          cookiesFetchedAt = Date.now()
          console.log(`  [cookies refreshed] before ${dept.name}`)
        }
      } catch (e) {
        console.warn(`  [cookies refresh failed] ${e.message} — continuing with stale cookies`)
      }
    }
    for (let page = 1; page <= 999; page++) {
      const body = JSON.stringify({
        categoryId: dept.id, pageNumber: page, pageSize: 36, sortType: 'TraderRelevance',
        url: '/shop/browse/fruit-veg', location: '/shop/browse/fruit-veg',
        formatObject: '{"name":"Category"}', isSpecial: false, isBundle: false,
        isMobile: false, filters: [], token: '', gpBoost: 0,
        isHideUnavailableProducts: false, isRegisteredRewardCardPromotion: false,
        enableAdReRanking: false, groupEdmVariants: true, categoryVersion: 'v2'
      })
      process.stdout.write(`  ${dept.name} p${page}...`)
      try {
        const fetched = await fetchWithRetry(`${WOOLWORTHS_BASE}/apis/ui/browse/category`, {
          method: 'POST',
          headers: { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*', 'Content-Type': 'application/json', 'Cookie': activeCookies },
          body
        }, `${dept.name} p${page}`)
        if (!fetched.ok) { console.log(` ${fetched.error}, stopping`); break }
        const r = fetched.response
        const data = await r.json()
        const bundles = data.Bundles || []
        if (bundles.length === 0) { console.log(' empty, done'); break }
        const results = bundles.flatMap(b => b.Products || [])
        if (results.length < 10) { console.log(` only ${results.length} (filler), done`); break }

        const products = results.map(p => ({
          store: 'woolworths', product_id: String(p.Stockcode), name: p.Name || p.DisplayName,
          brand: p.Brand || null, size: p.PackageSize || null, category: dept.name,
          image: p.LargeImageFile || p.MediumImageFile || null,
          barcode: p.Barcode || null,
        }))

        const prices = results.map(p => ({
          store: 'woolworths', product_id: String(p.Stockcode), price: p.Price || 0,
          was_price: p.WasPrice || null, is_on_special: p.IsOnSpecial || false,
        }))

        await upsertProducts(products)
        const changed = await insertPriceChanges(prices)
        changes += changed
        total += products.length
        console.log(` ${results.length} products (${changed} changes)`)
        await sleep(100)
      } catch (e) {
        console.log(` ERROR: ${e.message}`)
        failedDepts.push(dept.name)
        break
      }
    }
  }

  if (failedDepts.length > 0) console.warn(`WARNING: Failed departments: ${failedDepts.join(', ')}`)
  console.log(`\nWoolworths done: ${total} products, ${changes} price changes`)

  let degraded = false
  if (total === 0) {
    console.warn('WARNING: Zero products scraped. Woolworths API may have changed.')
    console.warn('Existing DB data preserved.')
    degraded = true
  } else if (total < MIN_EXPECTED_PRODUCTS) {
    console.warn(`WARNING: Only ${total} products (expected ${MIN_EXPECTED_PRODUCTS}+).`)
    degraded = true
  } else if (priorCatalogCount && total < priorCatalogCount * 0.7) {
    console.warn(`WARNING: ${total} products < 70% of prior catalog (${priorCatalogCount}). Likely cookie/auth degradation.`)
    degraded = true
  }

  const summary = {
    store: 'woolworths',
    total, changes, failedDepts, degraded,
    priorCatalogCount,
    completedAt: new Date().toISOString(),
  }
  console.log('SCRAPE_SUMMARY ' + JSON.stringify(summary))

  return { total, changes, failedDepts, degraded }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

console.log(`Woolworths scrape started: ${new Date().toISOString()}`)
scrapeWoolworths()
  .then((result) => {
    console.log(`Woolworths scrape complete: ${new Date().toISOString()}`)
    if (result?.failedDepts?.length > 0) {
      console.error(`FAIL: ${result.failedDepts.length} departments did not complete: ${result.failedDepts.join(', ')}`)
      process.exitCode = 1
    }
    return close()
  })
  .catch(e => {
    const external = ['fetch failed', 'ECONNREFUSED', 'ETIMEDOUT', 'HTTP', 'cookies', 'Woolworths']
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
