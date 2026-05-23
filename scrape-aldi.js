const SUPABASE_URL = process.env.SUPABASE_URL || 'https://asfnqfhpfufcbjzsrxlz.supabase.co'
const SUPABASE_KEY = process.env.SUPABASE_KEY || ''
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:129.0) Gecko/20100101 Firefox/129.0'

const ALDI_CATEGORIES = [
  '/products/fruits-vegetables/fresh-fruits/k/1111111152',
  '/products/fruits-vegetables/fresh-vegetables/k/1111111153',
  '/products/dairy-eggs-fridge/milk/k/1111111160',
  '/products/dairy-eggs-fridge/cheese/k/1111111161',
  '/products/dairy-eggs-fridge/yoghurt/k/1111111162',
  '/products/dairy-eggs-fridge/eggs/k/1111111163',
  '/products/pantry/canned-food/k/1111111170',
  '/products/pantry/pasta-rice-grains/k/1111111171',
  '/products/pantry/cereals-muesli/k/1111111172',
  '/products/pantry/chips-corn-chips-other/k/1111111173',
  '/products/pantry/confectionery/k/1111111174',
  '/products/pantry/sauces/k/1111111175',
  '/products/drinks/soft-drinks/k/1111111180',
  '/products/drinks/juice/k/1111111181',
  '/products/drinks/water/k/1111111182',
  '/products/meat-seafood/chicken/k/1111111191',
  '/products/meat-seafood/beef/k/1111111192',
  '/products/meat-seafood/pork/k/1111111193',
  '/products/frozen/frozen-pizzas/k/1111111207',
  '/products/frozen/frozen-fruit-vegetables/k/1111111208',
  '/products/bakery/bread/k/1111111216',
  '/products/household/cleaning/k/1111111240',
  '/products/household/laundry/k/1111111241',
]

function extractProducts(html) {
  const products = []
  // Extract product names from image URLs: /uuid/ProductName
  const imgPattern = /dm\.apac\.cms\.aldi\.cx\/is\/image\/aldiprodapac\/product\/jpg\/scaleWidth\/306\/([a-f0-9-]{36})\/([^"&\s]+)/g
  const seen = new Map() // uuid -> name
  let match
  while ((match = imgPattern.exec(html)) !== null) {
    const uuid = match[1]
    const name = decodeURIComponent(match[2]).trim()
    if (name.length > 2 && !seen.has(uuid)) {
      seen.set(uuid, { name, uuid })
    }
  }

  // Extract prices - pattern: $X.XX appearing in price elements
  // Prices appear in order matching products in the HTML
  const pricePattern = /\$(\d+\.\d{2})(?:\/|<)/g
  const prices = []
  while ((match = pricePattern.exec(html)) !== null) {
    prices.push(parseFloat(match[1]))
  }

  // Match products with prices (first price per product)
  const productList = [...seen.values()]
  for (let i = 0; i < productList.length; i++) {
    const p = productList[i]
    const price = prices[i] || null
    if (price && price > 0) {
      products.push({
        name: p.name,
        price,
        image: `https://dm.apac.cms.aldi.cx/is/image/aldiprodapac/product/jpg/scaleWidth/306/${p.uuid}/${encodeURIComponent(p.name)}`,
        productId: `aldi_${p.name.replace(/[^a-z0-9]/gi, '_').slice(0, 50)}`,
      })
    }
  }
  return products
}

async function scrapeCategory(url) {
  let allProducts = []
  let page = 1
  while (true) {
    const pageUrl = `https://www.aldi.com.au${url}${page > 1 ? '?page=' + page : ''}`
    const res = await fetch(pageUrl, { headers: { 'User-Agent': UA } })
    if (!res.ok) break
    const html = await res.text()
    const products = extractProducts(html)
    if (products.length === 0) break
    allProducts.push(...products)
    page++
    await new Promise(r => setTimeout(r, 500)) // 500ms between pages
  }
  return allProducts
}

async function main() {
  console.log('Starting Aldi scrape (fast HTML mode)...\n')
  let allProducts = []
  let allPrices = []

  for (const catUrl of ALDI_CATEGORIES) {
    const catName = catUrl.split('/')[2] || 'unknown'
    process.stdout.write(`  ${catName}... `)
    const products = await scrapeCategory(catUrl)
    
    for (const p of products) {
      allProducts.push({ store: 'aldi', product_id: p.productId, name: p.name, brand: null, size: null, category: catName, image: p.image })
      allPrices.push({ store: 'aldi', product_id: p.productId, price: p.price, was_price: null, is_on_special: false, cup_price: null })
    }
    console.log(`${products.length} products`)
    await new Promise(r => setTimeout(r, 1000)) // 1s between categories
  }

  console.log(`\nTotal: ${allProducts.length} products`)

  // Upsert products
  console.log('Saving to Supabase...')
  for (let i = 0; i < allProducts.length; i += 200) {
    await fetch(`${SUPABASE_URL}/rest/v1/products?on_conflict=store,product_id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify(allProducts.slice(i, i + 200)),
    })
  }

  // CamelCamelCamel technique: check last prices
  const ids = allPrices.map(p => p.product_id).join(',')
  const lastRes = await fetch(`${SUPABASE_URL}/rest/v1/price_history?store=eq.aldi&product_id=in.(${ids})&order=scraped_at.desc&select=product_id,price`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
  })
  const lastPrices = {}
  if (lastRes.ok) { for (const row of await lastRes.json()) { if (!lastPrices[row.product_id]) lastPrices[row.product_id] = row.price } }

  const changed = allPrices.filter(p => {
    const last = lastPrices[p.product_id]
    return last === undefined || parseFloat(last) !== parseFloat(p.price)
  })

  if (changed.length > 0) {
    for (let i = 0; i < changed.length; i += 200) {
      await fetch(`${SUPABASE_URL}/rest/v1/price_history?on_conflict=store,product_id,scraped_at`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, Prefer: 'resolution=ignore-duplicates' },
        body: JSON.stringify(changed.slice(i, i + 200)),
      })
    }
  }

  console.log(`Done! ${allProducts.length} products, ${changed.length} price changes stored.`)
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1) })
