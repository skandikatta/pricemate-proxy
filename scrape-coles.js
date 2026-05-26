const { upsertProducts, insertPriceChanges, close } = require('./db')
const PROXY = process.env.PROXY_URL || 'https://pricemate-proxy.onrender.com'
const MIN_EXPECTED_PRODUCTS = 100

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
  const categories = await resolveCategories()
  let total = 0, changes = 0, failedCategories = []

  for (const cat of categories) {
    for (let page = 1; page <= 999; page++) {
      const url = `${PROXY}/api/browse/coles?category=${cat}&page=${page}`
      process.stdout.write(`  ${cat} p${page}...`)
      try {
        const r = await fetch(url)
        if (!r.ok) { console.log(` HTTP ${r.status}, stopping`); break }
        const data = await r.json()
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
          return { store: 'coles', product_id: String(p.id), price: pr.now || 0, was_price: pr.was || null, is_on_special: pr.onlineSpecial || false }
        })

        await upsertProducts(products)
        const changed = await insertPriceChanges(prices)
        changes += changed
        total += products.length
        console.log(` ${results.length} products (${changed} changes)`)
        await sleep(500)
      } catch (e) {
        console.log(` ERROR: ${e.message}`)
        failedCategories.push(cat)
        break
      }
    }
  }

  if (failedCategories.length > 0) console.warn(`WARNING: Failed categories: ${failedCategories.join(', ')}`)
  console.log(`\nColes done: ${total} products, ${changes} price changes`)

  if (total === 0) {
    console.warn('WARNING: Zero products scraped. Coles API may have changed or proxy is down.')
    console.warn('Existing DB data preserved.')
  } else if (total < MIN_EXPECTED_PRODUCTS) {
    console.warn(`WARNING: Only ${total} products (expected ${MIN_EXPECTED_PRODUCTS}+).`)
  }

  return { total, changes, failedCategories }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

console.log(`Coles scrape started: ${new Date().toISOString()}`)
scrapeColes()
  .then((result) => {
    console.log(`Coles scrape complete: ${new Date().toISOString()}`)
    if (result?.failedCategories?.length > 0) {
      console.error(`FAIL: ${result.failedCategories.length} categories did not complete: ${result.failedCategories.join(', ')}`)
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
