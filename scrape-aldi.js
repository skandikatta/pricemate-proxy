const { chromium } = require('playwright')

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://asfnqfhpfufcbjzsrxlz.supabase.co'
const SUPABASE_KEY = process.env.SUPABASE_KEY || ''

const ALDI_CATEGORIES = [
  { url: '/products/fruits-vegetables/fresh-fruits/k/1111111152', name: 'fruit' },
  { url: '/products/fruits-vegetables/fresh-vegetables/k/950000002', name: 'vegetables' },
  { url: '/products/dairy-eggs-fridge/milk/k/950000003', name: 'milk' },
  { url: '/products/dairy-eggs-fridge/cheese/k/950000004', name: 'cheese' },
  { url: '/products/dairy-eggs-fridge/yoghurt/k/950000005', name: 'yoghurt' },
  { url: '/products/dairy-eggs-fridge/eggs/k/950000006', name: 'eggs' },
  { url: '/products/pantry/canned-food/k/950000020', name: 'canned' },
  { url: '/products/pantry/pasta-rice-grains/k/950000024', name: 'pasta-rice' },
  { url: '/products/pantry/cereals-muesli/k/950000025', name: 'cereal' },
  { url: '/products/pantry/chips-corn-chips-other/k/950000027', name: 'snacks' },
  { url: '/products/pantry/confectionery/k/950000026', name: 'confectionery' },
  { url: '/products/pantry/sauces/k/950000021', name: 'sauces' },
  { url: '/products/drinks/soft-drinks/k/950000041', name: 'soft-drinks' },
  { url: '/products/drinks/juice/k/950000042', name: 'juice' },
  { url: '/products/drinks/water/k/950000043', name: 'water' },
  { url: '/products/meat-seafood/chicken/k/950000010', name: 'chicken' },
  { url: '/products/meat-seafood/beef/k/950000011', name: 'beef' },
  { url: '/products/meat-seafood/pork/k/950000012', name: 'pork' },
  { url: '/products/frozen/frozen-pizzas/k/950000037', name: 'frozen-pizza' },
  { url: '/products/frozen/frozen-fruit-vegetables/k/950000034', name: 'frozen-veg' },
  { url: '/products/bakery/bread/k/950000015', name: 'bread' },
  { url: '/products/household/cleaning/k/950000050', name: 'cleaning' },
  { url: '/products/household/laundry/k/950000051', name: 'laundry' },
]

async function scrapeAldi() {
  console.log('Starting Aldi scrape...')
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  let allProducts = []
  let allPrices = []

  for (const cat of ALDI_CATEGORIES) {
    try {
      console.log(`  ${cat.name}...`)
      await page.goto(`https://www.aldi.com.au${cat.url}`, { waitUntil: 'domcontentloaded', timeout: 60000 })
      // Wait for products to render (Vue SPA needs time)
      await page.waitForSelector('[class*="product"], [data-testid*="product"], .product-tile', { timeout: 15000 }).catch(() => {})
      await page.waitForTimeout(3000)

      // Extract products from rendered page
      const products = await page.evaluate(() => {
        const items = []
        const tiles = document.querySelectorAll('.product-tile')
        tiles.forEach(tile => {
          const text = tile.innerText || ''
          const lines = text.split('\n').filter(l => l.trim())
          const name = lines[0]?.trim() || ''
          const priceEl = tile.querySelector('.base-price__regular')
          const priceText = priceEl?.textContent?.trim() || ''
          const price = parseFloat(priceText.replace(/[^0-9.]/g, '')) || null
          const img = tile.querySelector('img')?.src || ''
          if (name && price && price > 0 && name.length > 2) {
            items.push({ name, price, img, sku: name.replace(/[^a-z0-9]/gi, '_').slice(0, 50) })
          }
        })
        return items
      })

      for (const p of products) {
        const productId = p.sku || p.name.replace(/[^a-z0-9]/gi, '_').slice(0, 50)
        allProducts.push({
          store: 'aldi', product_id: `aldi_${productId}`, name: p.name,
          brand: null, size: null, category: cat.name, image: p.img || null,
        })
        allPrices.push({
          store: 'aldi', product_id: `aldi_${productId}`, price: p.price,
          was_price: null, is_on_special: false, cup_price: null,
        })
      }
      console.log(`    → ${products.length} products`)
    } catch (e) {
      console.log(`    → ERROR: ${e.message.slice(0, 50)}`)
    }
    // Wait between categories to avoid rate limiting
    await new Promise(r => setTimeout(r, 5000))
  }

  await browser.close()

  // Push to Supabase
  console.log(`\nPushing ${allProducts.length} products to Supabase...`)

  // Upsert products
  for (let i = 0; i < allProducts.length; i += 100) {
    await fetch(`${SUPABASE_URL}/rest/v1/products?on_conflict=store,product_id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify(allProducts.slice(i, i + 100)),
    })
  }

  // CamelCamelCamel technique: only store price changes
  // Fetch last known prices
  const productIds = allPrices.map(p => p.product_id).join(',')
  const lastRes = await fetch(`${SUPABASE_URL}/rest/v1/price_history?store=eq.aldi&product_id=in.(${productIds})&order=scraped_at.desc&select=product_id,price`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
  })
  const lastPrices = {}
  if (lastRes.ok) {
    for (const row of await lastRes.json()) {
      if (!lastPrices[row.product_id]) lastPrices[row.product_id] = row.price
    }
  }

  // Filter: only insert if price changed or product is new
  const changedPrices = allPrices.filter(p => {
    const last = lastPrices[p.product_id]
    return last === undefined || parseFloat(last) !== parseFloat(p.price)
  })

  console.log(`Price changes: ${changedPrices.length} of ${allPrices.length} products`)

  for (let i = 0; i < changedPrices.length; i += 100) {
    await fetch(`${SUPABASE_URL}/rest/v1/price_history?on_conflict=store,product_id,scraped_at`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, Prefer: 'resolution=ignore-duplicates' },
      body: JSON.stringify(changedPrices.slice(i, i + 100)),
    })
  }

  console.log(`Done! ${allProducts.length} products scraped, ${changedPrices.length} price changes stored.`)
}

scrapeAldi().catch(e => { console.error('Scrape failed:', e.message); process.exit(1) })
