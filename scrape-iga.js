const { upsertProducts, insertPriceChanges, close } = require('./db')
const { AdaptiveThrottle, fetchWithRetry, Progress, Stats, sleep } = require('./scrape-utils')

const IGA_API = 'https://storefrontgateway.igashop.com.au/api/stores'
const STORE_ID = '32600'
const PAGE_SIZE = 50
const MIN_EXPECTED_PRODUCTS = 100

// Scrape by iterating all categories from the hierarchy
async function fetchCategoryTree() {
  const result = await fetchWithRetry(`https://www.igashop.com.au/api/storefront/stores/${STORE_ID}/categoryHierarchy`)
  if (!result.ok) throw new Error(`Category tree failed: ${result.error}`)
  const data = await result.response.json()
  // Flatten leaf categories
  const leaves = []
  function walk(node) {
    if (!node.children || node.children.length === 0) {
      leaves.push(node.identifier)
    } else {
      for (const child of node.children) walk(child)
    }
  }
  if (data.children) for (const child of data.children) walk(child)
  return leaves
}

function parseProduct(item) {
  if (!item || !item.productId || !item.priceNumeric) return null
  const size = item.unitOfSize
    ? `${item.unitOfSize.size}${item.unitOfSize.abbreviation}`
    : null
  return {
    product_id: item.productId,
    name: item.name,
    brand: item.brand || null,
    size: size,
    image: item.image?.default || null,
    barcode: item.barcode || null,
    category: item.defaultCategory?.[0]?.category || item.categories?.[0]?.category || null,
    price: item.priceNumeric,
    was_price: item.tprPrice?.[0]?.priceNumeric || null,
    is_on_special: item.priceSource === 'special' || (item.tprPrice?.length > 0),
    cup_price: item.pricePerUnit || null,
  }
}

async function scrapeAll(throttle, stats) {
  const products = []
  let skip = 0
  // First call to get total count
  const firstUrl = `${IGA_API}/${STORE_ID}/search?q=*&take=${PAGE_SIZE}&skip=0&sort=brand`
  const firstResult = await fetchWithRetry(firstUrl)
  if (!firstResult.ok) throw new Error(`Initial fetch failed: ${firstResult.error}`)
  const firstData = await firstResult.response.json()
  const total = firstData.total || 0
  console.log(`  Total products in store: ${total}`)
  
  // Process first page
  for (const item of (firstData.items || [])) {
    const p = parseProduct(item)
    if (p) products.push(p)
  }
  stats.tick(firstData.items?.length || 0)
  skip += PAGE_SIZE

  // Paginate through all
  while (skip < total) {
    const url = `${IGA_API}/${STORE_ID}/search?q=*&take=${PAGE_SIZE}&skip=${skip}&sort=brand`
    const result = await fetchWithRetry(url)
    if (!result.ok) break
    if (result.elapsed) throttle.record(result.elapsed)
    const data = await result.response.json()
    const items = data.items || []
    if (items.length === 0) break
    for (const item of items) {
      const p = parseProduct(item)
      if (p) products.push(p)
    }
    stats.tick(items.length)
    if ((skip / PAGE_SIZE) % 20 === 0) {
      console.log(`  ${skip}/${total}`)
    }
    skip += PAGE_SIZE
    await throttle.wait()
  }
  return products
}

async function main() {
  console.log('=== IGA (storefrontgateway API) ===')

  // Preflight
  console.log('[preflight] Testing IGA API...')
  const testResult = await fetchWithRetry(`${IGA_API}/${STORE_ID}/search?q=milk&take=3`)
  if (testResult.ok) {
    const data = await testResult.response.json()
    if (data.items?.length > 0) {
      console.log(`[preflight] OK — ${data.total} total products, "${data.items[0].name}" $${data.items[0].priceNumeric}`)
    } else {
      console.warn('[preflight] WARNING: API returned 0 items. Exiting gracefully.')
      process.exitCode = 0; return
    }
  } else {
    console.warn(`[preflight] API returned ${testResult.error}. Exiting gracefully.`)
    process.exitCode = 0; return
  }

  // Scrape all products via paginated search
  console.log('Scraping all products...')
  const throttle = new AdaptiveThrottle({ minDelay: 100, maxDelay: 1500, targetConcurrency: 4 })
  const stats = new Stats('iga')
  const allScraped = await scrapeAll(throttle, stats)

  if (allScraped.length === 0) {
    console.warn('WARNING: Zero products scraped. API may have changed.')
    process.exitCode = 0; return
  }

  // Dedupe (shouldn't be needed with q=* but just in case)
  const seen = new Map()
  for (const p of allScraped) seen.set(p.product_id, p)
  const allProducts = [...seen.values()]
  const allPrices = allProducts.map(p => ({ store: 'iga', product_id: p.product_id, price: p.price, was_price: p.was_price, is_on_special: p.is_on_special, cup_price: p.cup_price }))

  console.log(`\nTotal: ${allProducts.length} unique products`)
  await upsertProducts(allProducts.map(p => ({ store: 'iga', product_id: p.product_id, name: p.name, brand: p.brand, size: p.size, category: p.category, image: p.image, barcode: p.barcode })))
  const changes = await insertPriceChanges(allPrices)

  if (allProducts.length < MIN_EXPECTED_PRODUCTS) {
    console.warn(`WARNING: Only ${allProducts.length} products (expected ${MIN_EXPECTED_PRODUCTS}+).`)
  }

  console.log(`IGA done: ${allProducts.length} products, ${changes} price changes`)
  const summary = { store: 'iga', total: allProducts.length, changes, completedAt: new Date().toISOString() }
  console.log('SCRAPE_SUMMARY ' + JSON.stringify(summary))
  stats.print()
  return { total: allProducts.length, changes }
}

console.log(`IGA scrape started: ${new Date().toISOString()}`)
main()
  .then(() => { console.log(`IGA scrape complete: ${new Date().toISOString()}`); return close() })
  .catch(e => {
    const external = ['fetch failed', 'ECONNREFUSED', 'ETIMEDOUT', 'HTTP']
    if (external.some(msg => e.message?.includes(msg))) { console.warn('EXTERNAL FAILURE:', e.message); process.exitCode = 0 }
    else { console.error('CODE BUG:', e.message, e.stack); process.exitCode = 1 }
    return close()
  })
