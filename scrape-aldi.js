const SUPABASE_URL = process.env.SUPABASE_URL || 'https://asfnqfhpfufcbjzsrxlz.supabase.co'
const SUPABASE_KEY = process.env.SUPABASE_KEY || ''
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:129.0) Gecko/20100101 Firefox/129.0'
const ALDI_BASE = 'https://www.aldi.com.au'

// Skip non-grocery categories
const SKIP_CATEGORIES = ['snow-gear', 'limited-time-only', 'liquor', 'front-of-store']

async function discoverCategories() {
  const res = await fetch(`${ALDI_BASE}/products`, { headers: { 'User-Agent': UA } })
  const html = await res.text()
  const matches = [...html.matchAll(/\/products\/([^"]+)\/k\/(\d+)/g)]
  const seen = new Set()
  const categories = []
  for (const m of matches) {
    const url = `/products/${m[1]}/k/${m[2]}`
    if (seen.has(url)) continue
    seen.add(url)
    const parts = m[1].split('/')
    const topLevel = parts[0]
    const subName = parts[1] || topLevel
    if (SKIP_CATEGORIES.includes(topLevel)) continue
    // Only scrape subcategories (not top-level which duplicates)
    if (parts.length >= 2) {
      categories.push({ url, name: subName.replace(/-/g, ' '), topLevel })
    }
  }
  return categories
}

function extractProducts(html) {
  const products = []
  const imgPattern = /dm\.apac\.cms\.aldi\.cx\/is\/image\/aldiprodapac\/product\/jpg\/scaleWidth\/306\/([a-f0-9-]{36})\/([^"&\s]+)/g
  const seen = new Map()
  let match
  while ((match = imgPattern.exec(html)) !== null) {
    const uuid = match[1]
    const name = decodeURIComponent(match[2]).trim()
    if (name.length > 2 && !seen.has(uuid)) {
      seen.set(uuid, { name, uuid })
    }
  }

  const pricePattern = /\$(\d+\.\d{2})(?:\/|<)/g
  const prices = []
  while ((match = pricePattern.exec(html)) !== null) {
    prices.push(parseFloat(match[1]))
  }

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
    const pageUrl = `${ALDI_BASE}${url}${page > 1 ? '?page=' + page : ''}`
    const res = await fetch(pageUrl, { headers: { 'User-Agent': UA } })
    if (!res.ok) break
    const html = await res.text()
    const products = extractProducts(html)
    if (products.length === 0) break
    allProducts.push(...products)
    page++
    await new Promise(r => setTimeout(r, 500))
  }
  return allProducts
}

async function supabasePost(path, data, prefer) {
  for (let i = 0; i < data.length; i += 200) {
    await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, Prefer: prefer },
      body: JSON.stringify(data.slice(i, i + 200)),
    })
  }
}

async function main() {
  console.log('Discovering Aldi categories...')
  const categories = await discoverCategories()
  console.log(`Found ${categories.length} subcategories\n`)

  let allProducts = []
  let allPrices = []

  for (const cat of categories) {
    process.stdout.write(`  ${cat.name}... `)
    const products = await scrapeCategory(cat.url)
    for (const p of products) {
      allProducts.push({ store: 'aldi', product_id: p.productId, name: p.name, brand: null, size: null, category: cat.name, image: p.image })
      allPrices.push({ store: 'aldi', product_id: p.productId, price: p.price, was_price: null, is_on_special: false, cup_price: null })
    }
    console.log(`${products.length}`)
    await new Promise(r => setTimeout(r, 500))
  }

  console.log(`\nTotal: ${allProducts.length} products`)

  // Upsert products
  await supabasePost('products?on_conflict=store,product_id', allProducts, 'resolution=merge-duplicates')

  // CamelCamelCamel: only store price changes
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
    await supabasePost('price_history?on_conflict=store,product_id,scraped_at', changed, 'resolution=ignore-duplicates')
  }

  console.log(`Done! ${allProducts.length} products, ${changed.length} price changes stored.`)
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1) })
