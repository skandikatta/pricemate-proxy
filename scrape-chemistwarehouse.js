const { upsertProducts, insertPriceChanges, close } = require('./db')
const { AdaptiveThrottle, fetchWithRetry, Progress, Stats, sleep } = require('./scrape-utils')

const SITEMAP_URL = 'https://static.chemistwarehouse.com.au/AMS/sitemap/cwh/products.xml'
const MIN_EXPECTED_PRODUCTS = 100
const BATCH_SIZE = 50 // products per upsert batch

async function fetchSitemap() {
  console.log('Fetching product sitemap...')
  const result = await fetchWithRetry(SITEMAP_URL)
  if (!result.ok) throw new Error(`Sitemap fetch failed: ${result.error}`)
  const xml = await result.response.text()
  const urls = [...xml.matchAll(/<loc>(https:\/\/www\.chemistwarehouse\.com\.au\/buy\/[^<]+)<\/loc>/g)]
    .map(m => m[1])
  console.log(`  ${urls.length} product URLs in sitemap`)
  return urls
}

function extractProduct(html, url) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s)
  if (!m) return null
  try {
    const data = JSON.parse(m[1])
    const p = data.props?.pageProps?.product?.product
    if (!p) return null
    const v = p.variants?.[0]
    if (!v) return null

    const brand = typeof v.brand === 'object' ? v.brand?.label : v.brand
    const image = v.images?.[0]?.url || null

    // Extract prices: find all "amount" values in the product JSON
    const priceStr = JSON.stringify(data.props.pageProps.product)
    const amounts = [...priceStr.matchAll(/"amount":\s*([\d.]+)/g)].map(m => parseFloat(m[1]))

    // First amount = current/sale price, second = RRP (if different)
    const price = amounts[0] || 0
    const rrp = amounts[1] && amounts[1] > price ? amounts[1] : null

    // Extract product ID from URL: /buy/{id}/{slug}
    const idMatch = url.match(/\/buy\/(\d+)\//)
    const productId = idMatch ? idMatch[1] : v.sku

    // Extract size from name (e.g. "454g", "250ml", "400 Capsules", "16 Caplets")
    const sizeMatch = p.name.match(/(\d+\.?\d*)\s*(mg|g|kg|ml|l|capsules|caplets|tablets|pack|sachets)\b/i)
    // Prefer g/ml/l/kg over mg (mg is dosage, not pack size)
    const allSizes = [...p.name.matchAll(/(\d+\.?\d*)\s*(mg|g|kg|ml|l|capsules|caplets|tablets|pack|sachets)\b/gi)]
    const packSize = allSizes.find(m => !m[2].toLowerCase().startsWith('mg')) || allSizes[0]
    const size = packSize ? packSize[0] : null

    return {
      product_id: productId,
      name: p.name,
      brand: brand || null,
      size: size,
      image: image,
      price: price,
      was_price: rrp,
      is_on_special: rrp !== null && price < rrp,
      category: p.categories?.[0]?.ancestors?.find(a => a.key !== 'Category' && a.key !== 'cwr-cw-au-root')?.name || p.type || null,
    }
  } catch (e) {
    return null
  }
}

async function main() {
  console.log('=== CHEMIST WAREHOUSE (sitemap + __NEXT_DATA__) ===')

  // Pre-flight: verify site is reachable and extraction works
  console.log('[preflight] Testing Chemist Warehouse...')
  const testResult = await fetchWithRetry('https://www.chemistwarehouse.com.au/buy/91329/cerave-moisturising-cream-454g')
  if (testResult.ok) {
    const html = await testResult.response.text()
    console.log(`[preflight] Page fetched: ${html.length} bytes`)
    const testProduct = extractProduct(html, 'https://www.chemistwarehouse.com.au/buy/91329/cerave-moisturising-cream-454g')
    if (testProduct && testProduct.price > 0) {
      console.log(`[preflight] OK — "${testProduct.name}" $${testProduct.price} (RRP $${testProduct.was_price || 'N/A'})`)
    } else {
      console.warn('[preflight] WARNING: Page loaded but extraction failed — HTML structure may have changed')
      console.warn(`[preflight] extractProduct returned: ${JSON.stringify(testProduct)}`)
      console.warn('[preflight] Exiting gracefully — no DB writes.')
      process.exitCode = 0; return
    }
  } else {
    console.warn(`[preflight] Site returned ${testResult.error} — may be down`)
    console.warn('[preflight] Exiting gracefully — existing DB data preserved.')
    process.exitCode = 0; return
  }

  const urls = await fetchSitemap()
  if (urls.length < MIN_EXPECTED_PRODUCTS) {
    console.warn(`WARNING: Only ${urls.length} URLs in sitemap (expected ${MIN_EXPECTED_PRODUCTS}+)`)
    if (urls.length === 0) { console.warn('Exiting — sitemap empty.'); process.exitCode = 0; return }
  }

  const throttle = new AdaptiveThrottle({ minDelay: 100, maxDelay: 1500, targetConcurrency: 6 })
  const stats = new Stats('chemistwarehouse')
  const progress = new Progress('chemistwarehouse')
  let products = [], prices = [], failed = 0

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i]
    const id = url.match(/\/buy\/(\d+)\//)?.[1]
    if (progress.isCompleted(id)) continue

    const result = await fetchWithRetry(url)
    if (!result.ok) { failed++; continue }
    if (result.elapsed) throttle.record(result.elapsed)

    const html = await result.response.text()
    const p = extractProduct(html, url)
    if (!p || !p.price || p.price <= 0) { failed++; continue }

    products.push({ store: 'chemistwarehouse', product_id: p.product_id, name: p.name, brand: p.brand, size: p.size, category: p.category, image: p.image })
    prices.push({ store: 'chemistwarehouse', product_id: p.product_id, price: p.price, was_price: p.was_price, is_on_special: p.is_on_special, cup_price: null })
    stats.tick(1)
    progress.markCompleted(id)

    // Batch upsert every BATCH_SIZE products
    if (products.length >= BATCH_SIZE) {
      await upsertProducts(products)
      await insertPriceChanges(prices)
      products = []; prices = []
    }

    if ((i + 1) % 200 === 0) {
      console.log(`  ${i + 1}/${urls.length} (${failed} failed)`)
    }
    await throttle.wait()
  }

  // Final batch
  if (products.length > 0) {
    await upsertProducts(products)
    await insertPriceChanges(prices)
  }

  const total = stats.summary().items
  
  // Graceful degradation
  if (total === 0) {
    console.warn('WARNING: Zero products scraped. Site may have changed.')
    console.warn('Existing DB data preserved.')
    process.exitCode = 0; return { total: 0, failed }
  }
  if (total < MIN_EXPECTED_PRODUCTS) {
    console.warn(`WARNING: Only ${total} products (expected ${MIN_EXPECTED_PRODUCTS}+). Extraction may be broken.`)
  }

  console.log(`\nChemist Warehouse done: ${total} products, ${failed} failed`)

  const summary = { store: 'chemistwarehouse', total, failed, completedAt: new Date().toISOString() }
  console.log('SCRAPE_SUMMARY ' + JSON.stringify(summary))
  stats.print()
  progress.clear()
  return { total, failed }
}

console.log(`Chemist Warehouse scrape started: ${new Date().toISOString()}`)
main()
  .then((result) => {
    console.log(`Chemist Warehouse scrape complete: ${new Date().toISOString()}`)
    return close()
  })
  .catch(e => {
    const external = ['fetch failed', 'ECONNREFUSED', 'ETIMEDOUT', 'HTTP']
    const isExternal = external.some(msg => e.message?.includes(msg))
    if (isExternal) { console.warn('EXTERNAL FAILURE:', e.message); process.exitCode = 0 }
    else { console.error('CODE BUG:', e.message, e.stack); process.exitCode = 1 }
    return close()
  })
