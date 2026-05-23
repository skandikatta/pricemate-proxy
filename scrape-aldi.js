const { chromium } = require('playwright')

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://asfnqfhpfufcbjzsrxlz.supabase.co'
const SUPABASE_KEY = process.env.SUPABASE_KEY || ''

const ALDI_CATEGORIES = [
  { url: '/products/fruits-vegetables/fresh-fruits/k/1111111152', name: 'fruit' },
  { url: '/products/fruits-vegetables/fresh-vegetables/k/1111111153', name: 'vegetables' },
  { url: '/products/dairy-eggs-fridge/milk/k/950000003', name: 'milk' },
  { url: '/products/dairy-eggs-fridge/cheese/k/950000004', name: 'cheese' },
  { url: '/products/dairy-eggs-fridge/yoghurt/k/950000005', name: 'yoghurt' },
  { url: '/products/pantry/canned-food/k/950000020', name: 'canned' },
  { url: '/products/pantry/pasta-rice-grains/k/950000024', name: 'pasta-rice' },
  { url: '/products/pantry/cereals-muesli/k/950000025', name: 'cereal' },
  { url: '/products/pantry/chips-corn-chips-other/k/950000027', name: 'snacks' },
  { url: '/products/drinks/soft-drinks/k/950000041', name: 'soft-drinks' },
  { url: '/products/drinks/juice/k/950000042', name: 'juice' },
  { url: '/products/meat-seafood/chicken/k/950000010', name: 'chicken' },
  { url: '/products/meat-seafood/beef/k/950000011', name: 'beef' },
  { url: '/products/frozen/frozen-pizzas/k/950000037', name: 'frozen-pizza' },
  { url: '/products/bakery/bread/k/950000015', name: 'bread' },
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
      await page.goto(`https://www.aldi.com.au${cat.url}`, { waitUntil: 'networkidle', timeout: 30000 })
      await page.waitForTimeout(2000)

      // Extract products from rendered page
      const products = await page.evaluate(() => {
        const items = []
        // Aldi uses product tiles with data attributes or structured elements
        const tiles = document.querySelectorAll('[data-testid="product-tile"], .product-tile, [class*="product"]')
        tiles.forEach(tile => {
          const name = tile.querySelector('[class*="title"], [class*="name"], h3, h4')?.textContent?.trim()
          const priceEl = tile.querySelector('[class*="price"]')?.textContent?.trim()
          const price = priceEl ? parseFloat(priceEl.replace(/[^0-9.]/g, '')) : null
          const img = tile.querySelector('img')?.src || ''
          const sku = tile.getAttribute('data-sku') || tile.getAttribute('data-product-id') || ''
          if (name && price) {
            items.push({ name, price, img, sku })
          }
        })
        // Fallback: look for any price + name pattern
        if (items.length === 0) {
          const allText = document.body.innerText
          const matches = allText.match(/([A-Z][^\n]{3,50})\n\$([0-9]+\.[0-9]+)/g) || []
          matches.forEach(m => {
            const parts = m.split('\n')
            if (parts.length >= 2) {
              items.push({ name: parts[0].trim(), price: parseFloat(parts[1].replace('$', '')), img: '', sku: '' })
            }
          })
        }
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

  // Insert prices (CamelCamelCamel technique - ignore duplicates for same day)
  for (let i = 0; i < allPrices.length; i += 100) {
    await fetch(`${SUPABASE_URL}/rest/v1/price_history?on_conflict=store,product_id,scraped_at`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, Prefer: 'resolution=ignore-duplicates' },
      body: JSON.stringify(allPrices.slice(i, i + 100)),
    })
  }

  console.log(`Done! ${allProducts.length} Aldi products scraped and stored.`)
}

scrapeAldi().catch(e => { console.error('Scrape failed:', e.message); process.exit(1) })
