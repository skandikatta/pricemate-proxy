const { upsertProducts, insertPriceChanges, close } = require('./db')
const { extractProducts } = require('./extract-aldi')
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:129.0) Gecko/20100101 Firefox/129.0'
const ALDI_BASE = 'https://www.aldi.com.au'

// Minimum products we expect — if below this, site likely changed
const MIN_EXPECTED_PRODUCTS = 50

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
}

async function discoverCategories() {
  // Use hardcoded top-level IDs (reliable) + discover subcategories (dynamic)
  const categories = Object.entries(TOP_LEVEL_CATEGORIES).map(([slug, id]) => ({
    url: `/products/${slug}/k/${id}`,
    name: slug.replace(/-/g, ' '),
    id,
  }))
  return categories
}

async function scrapeCategory(url) {
  let allProducts = [], page = 1
  while (true) {
    const pageUrl = `${ALDI_BASE}${url}${page > 1 ? '?page=' + page : ''}`
    const res = await fetch(pageUrl, { headers: { 'User-Agent': UA } })
    if (!res.ok) break
    const html = await res.text()
    if (html.includes('http-equiv="refresh"')) break
    const products = extractProducts(html)
    if (products.length === 0) break
    allProducts.push(...products)
    page++
    await new Promise(r => setTimeout(r, 500))
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
        allProducts.push({ store: 'aldi', product_id: p.productId, name: p.name, brand: p.brand, size: null, category: cat.name, image: p.image })
        allPrices.push({ store: 'aldi', product_id: p.productId, price: p.price, was_price: null, is_on_special: false })
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

  // Still save whatever we got — partial data is better than no data
  console.log(`\nTotal: ${allProducts.length} products`)
  await upsertProducts(allProducts)
  const changes = await insertPriceChanges(allPrices)
  console.log(`Done! ${allProducts.length} products, ${changes} price changes`)
}

console.log(`Aldi scrape started: ${new Date().toISOString()}`)
main()
  .then(() => { console.log(`Aldi scrape complete: ${new Date().toISOString()}`); return close() })
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
