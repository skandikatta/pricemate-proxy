const { upsertProducts, insertPriceChanges, close } = require('./db')
const { AdaptiveThrottle, fetchWithRetry, Stats, sleep } = require('./scrape-utils')

const SITEMAP_URL = 'https://www.priceline.com.au/Product.xml'
const OCC_BASE = 'https://api.priceline.com.au/occ/v2/priceline/products'
const MIN_EXPECTED_PRODUCTS = 100
const BATCH_SIZE = 50

async function fetchProductCodes() {
  console.log('Fetching product sitemap...')
  const result = await fetchWithRetry(SITEMAP_URL)
  if (!result.ok) throw new Error(`Sitemap fetch failed: ${result.error}`)
  const xml = await result.response.text()
  const codes = [...xml.matchAll(/\/product\/(\d+)\//g)].map(m => m[1])
  console.log(`  ${codes.length} product codes in sitemap`)
  return codes
}

async function fetchProduct(code, throttle) {
  const result = await fetchWithRetry(`${OCC_BASE}/${code}?fields=FULL`, { retries: 2, timeoutMs: 10000 })
  if (!result.ok) return null
  if (result.elapsed) throttle.record(result.elapsed)
  const p = await result.response.json()
  if (!p.price?.value || p.price.value <= 0) return null

  // Extract size from name
  const sizeMatch = p.name?.match(/(\d+\.?\d*)\s*(mg|g|kg|ml|l|capsules|caplets|tablets|pack|sachets|each|set|kit)\b/i)
  const size = sizeMatch ? sizeMatch[0] : null

  return {
    product_id: p.code,
    name: p.name,
    brand: p.brandName || null,
    size,
    category: p.categories?.[0]?.name || null,
    image: p.images?.[0]?.url ? `https://api.priceline.com.au${p.images[0].url}` : null,
    price: p.price.value,
    was_price: p.previousPrice?.value || null,
    is_on_special: !!p.previousPrice && p.previousPrice.value > p.price.value,
  }
}

async function main() {
  console.log('=== PRICELINE (OCC API, sitemap-driven) ===')

  // Preflight
  console.log('[preflight] Testing Priceline OCC API...')
  const testResult = await fetchWithRetry(`${OCC_BASE}/199919?fields=FULL`)
  if (testResult.ok) {
    const p = await testResult.response.json()
    if (p.name && p.price?.value > 0) {
      console.log(`[preflight] OK — "${p.name}" $${p.price.value}`)
    } else {
      console.warn('[preflight] WARNING: API returned but no price data. Exiting gracefully.')
      process.exitCode = 0; return
    }
  } else {
    console.warn(`[preflight] API returned ${testResult.error}. Exiting gracefully.`)
    process.exitCode = 0; return
  }

  const codes = await fetchProductCodes()
  if (codes.length < MIN_EXPECTED_PRODUCTS) {
    console.warn(`WARNING: Only ${codes.length} codes in sitemap.`)
    if (codes.length === 0) { process.exitCode = 0; return }
  }

  const throttle = new AdaptiveThrottle({ minDelay: 50, maxDelay: 1000, targetConcurrency: 6 })
  const stats = new Stats('priceline')
  let products = [], prices = [], failed = 0

  for (let i = 0; i < codes.length; i++) {
    const p = await fetchProduct(codes[i], throttle)
    if (!p) { failed++; continue }

    products.push({ store: 'priceline', product_id: p.product_id, name: p.name, brand: p.brand, size: p.size, category: p.category, image: p.image, barcode: null })
    prices.push({ store: 'priceline', product_id: p.product_id, price: p.price, was_price: p.was_price, is_on_special: p.is_on_special, cup_price: null })
    stats.tick(1)

    if (products.length >= BATCH_SIZE) {
      await upsertProducts(products)
      await insertPriceChanges(prices)
      products = []; prices = []
    }

    if ((i + 1) % 500 === 0) console.log(`  ${i + 1}/${codes.length} (${failed} failed)`)
    await throttle.wait()
  }

  // Final batch
  if (products.length > 0) {
    await upsertProducts(products)
    await insertPriceChanges(prices)
  }

  const total = stats.summary().items
  if (total === 0) {
    console.warn('WARNING: Zero products scraped.')
    process.exitCode = 0; return
  }

  console.log(`\nPriceline done: ${total} products, ${failed} failed`)
  console.log('SCRAPE_SUMMARY ' + JSON.stringify({ store: 'priceline', total, failed, completedAt: new Date().toISOString() }))
  stats.print()
}

console.log(`Priceline scrape started: ${new Date().toISOString()}`)
main()
  .then(() => { console.log(`Priceline scrape complete: ${new Date().toISOString()}`); return close() })
  .catch(e => {
    const external = ['fetch failed', 'ECONNREFUSED', 'ETIMEDOUT', 'HTTP']
    if (external.some(msg => e.message?.includes(msg))) { console.warn('EXTERNAL FAILURE:', e.message); process.exitCode = 0 }
    else { console.error('CODE BUG:', e.message, e.stack); process.exitCode = 1 }
    return close()
  })
