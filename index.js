const express = require('express')
const app = express()
const PORT = process.env.PORT || 3001

const COLES_BASE = 'https://www.coles.com.au'
const IMG_BASE = 'https://productimages.coles.com.au/productimages'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:129.0) Gecko/20100101 Firefox/129.0'

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://asfnqfhpfufcbjzsrxlz.supabase.co'
const SUPABASE_KEY = process.env.SUPABASE_KEY || ''

let buildId = null
let buildIdTime = 0

async function getBuildId() {
  if (buildId && Date.now() - buildIdTime < 3600000) return buildId
  const res = await fetch(COLES_BASE, { headers: { 'User-Agent': UA } })
  const html = await res.text()
  const match = html.match(/"buildId":"([^"]+)"/)
  if (!match) throw new Error('Cannot extract buildId')
  buildId = match[1]
  buildIdTime = Date.now()
  return buildId
}

function mapProduct(p) {
  const pr = p.pricing || {}
  const img = p.imageUris?.[0]?.uri
  return {
    name: p.name,
    price: pr.now || 0,
    wasPrice: pr.was || 0,
    isOnSpecial: pr.onlineSpecial || false,
    isHalfPrice: pr.promotionType === 'HALF_PRICE',
    savings: pr.was && pr.now ? +(pr.was - pr.now).toFixed(2) : 0,
    image: img ? IMG_BASE + img : '',
    cupPrice: pr.comparable || '',
    brand: p.brand || '',
    size: p.size || '',
    store: 'coles',
    productId: String(p.id || ''),
  }
}

// Search endpoint
app.get('/api/search', async (req, res) => {
  const q = req.query.q || 'milk'
  try {
    const id = await getBuildId()
    const url = `${COLES_BASE}/_next/data/${id}/en/search/products.json?q=${encodeURIComponent(q)}&page=1`
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } })
    if (!r.ok || !(r.headers.get('content-type') || '').includes('json')) {
      return res.json({ error: 'Coles unavailable', products: [], query: q })
    }
    const data = await r.json()
    const results = data?.pageProps?.searchResults?.results || []
    const products = results.filter(p => p._type === 'PRODUCT').slice(0, 24).map(mapProduct)
    res.json({ products, query: q, store: 'coles', total: data?.pageProps?.searchResults?.noOfResults || 0 })
  } catch (e) {
    res.json({ error: e.message, products: [], query: q })
  }
})

// Daily scraper endpoint - scrapes a category and stores in Supabase
app.get('/api/scrape', async (req, res) => {
  if (!SUPABASE_KEY) return res.json({ error: 'SUPABASE_KEY not set' })
  const categories = ['dairy-eggs-fridge', 'fruit-vegetables', 'meat-seafood', 'pantry', 'drinks', 'frozen', 'bakery', 'household']
  const category = req.query.category || categories[0]
  const page = parseInt(req.query.page) || 1

  try {
    const id = await getBuildId()
    const url = `${COLES_BASE}/_next/data/${id}/en/browse/${category}.json?slug=${category}&page=${page}`
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } })
    if (!r.ok) return res.json({ error: `Coles returned ${r.status}`, category })

    const data = await r.json()
    const results = (data?.pageProps?.searchResults?.results || []).filter(p => p._type === 'PRODUCT')
    const totalPages = Math.ceil((data?.pageProps?.searchResults?.noOfResults || 0) / 48)

    // Upsert products
    const products = results.map(p => ({
      store: 'coles',
      product_id: String(p.id),
      name: p.name,
      brand: p.brand || null,
      size: p.size || null,
      category,
      image: p.imageUris?.[0]?.uri ? IMG_BASE + p.imageUris[0].uri : null,
    }))

    if (products.length > 0) {
      await fetch(`${SUPABASE_URL}/rest/v1/products`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Prefer': 'resolution=merge-duplicates',
        },
        body: JSON.stringify(products),
      })
    }

    // Insert price history
    const prices = results.map(p => {
      const pr = p.pricing || {}
      return {
        store: 'coles',
        product_id: String(p.id),
        price: pr.now || 0,
        was_price: pr.was || null,
        is_on_special: pr.onlineSpecial || false,
        cup_price: pr.comparable || null,
      }
    })

    if (prices.length > 0) {
      await fetch(`${SUPABASE_URL}/rest/v1/price_history`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Prefer': 'resolution=merge-duplicates',
        },
        body: JSON.stringify(prices),
      })
    }

    res.json({ success: true, category, page, productsScraped: products.length, totalPages })
  } catch (e) {
    res.json({ error: e.message, category })
  }
})

// Scrape all categories (triggered by cron)
app.get('/api/scrape-all', async (req, res) => {
  if (!SUPABASE_KEY) return res.json({ error: 'SUPABASE_KEY not set' })
  const categories = ['dairy-eggs-fridge', 'fruit-vegetables', 'meat-seafood', 'pantry', 'drinks', 'frozen', 'bakery', 'household']
  const pages = parseInt(req.query.pages) || 3
  let total = 0

  for (const cat of categories) {
    for (let page = 1; page <= pages; page++) {
      try {
        const id = await getBuildId()
        const url = `${COLES_BASE}/_next/data/${id}/en/browse/${cat}.json?slug=${cat}&page=${page}`
        const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } })
        if (!r.ok) break
        const data = await r.json()
        const results = (data?.pageProps?.searchResults?.results || []).filter(p => p._type === 'PRODUCT')
        if (results.length === 0) break

        const products = results.map(p => ({
          store: 'coles', product_id: String(p.id), name: p.name,
          brand: p.brand || null, size: p.size || null, category: cat,
          image: p.imageUris?.[0]?.uri ? IMG_BASE + p.imageUris[0].uri : null,
        }))

        const prices = results.map(p => {
          const pr = p.pricing || {}
          return {
            store: 'coles', product_id: String(p.id), price: pr.now || 0,
            was_price: pr.was || null, is_on_special: pr.onlineSpecial || false,
            cup_price: pr.comparable || null,
          }
        })

        if (products.length > 0) {
          await fetch(`${SUPABASE_URL}/rest/v1/products?on_conflict=store,product_id`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Prefer': 'resolution=ignore-duplicates' },
            body: JSON.stringify(products),
          })
          await fetch(`${SUPABASE_URL}/rest/v1/price_history?on_conflict=store,product_id,scraped_at`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Prefer': 'resolution=ignore-duplicates' },
            body: JSON.stringify(prices),
          })
        }
        total += products.length
        await new Promise(r => setTimeout(r, 1000))
      } catch (e) { break }
    }
  }

  res.json({ success: true, totalProducts: total, categories: 8, pagesPerCategory: pages })
})

app.get('/health', (req, res) => res.json({ status: 'ok', buildId }))

app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`))
