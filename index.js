const express = require('express')
const app = express()
const PORT = process.env.PORT || 3001

const COLES_BASE = 'https://www.coles.com.au'
const WOOLWORTHS_BASE = 'https://www.woolworths.com.au'
const IMG_BASE_COLES = 'https://productimages.coles.com.au/productimages'
const IMG_BASE_WOOLWORTHS = 'https://cdn0.woolworths.media/content/wowproductimages/medium'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:129.0) Gecko/20100101 Firefox/129.0'

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://asfnqfhpfufcbjzsrxlz.supabase.co'
const SUPABASE_KEY = process.env.SUPABASE_KEY || ''

// --- COLES ---
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

// --- WOOLWORTHS (cookie-jar technique) ---
let wwCookies = ''
let wwCookieTime = 0

async function getWoolworthsCookies() {
  if (wwCookies && Date.now() - wwCookieTime < 1800000) return wwCookies // 30min cache
  const res = await fetch(`${WOOLWORTHS_BASE}/shop/browse/fruit-veg`, {
    headers: { 'User-Agent': UA },
    redirect: 'manual'
  })
  const setCookies = res.headers.getSetCookie?.() || []
  wwCookies = setCookies.map(c => c.split(';')[0]).join('; ')
  wwCookieTime = Date.now()
  return wwCookies
}

async function woolworthsBrowse(categoryId, page = 1) {
  const cookies = await getWoolworthsCookies()
  const body = JSON.stringify({
    categoryId, pageNumber: page, pageSize: 36, sortType: 'TraderRelevance',
    url: '/shop/browse/fruit-veg', location: '/shop/browse/fruit-veg',
    formatObject: '{"name":"Category"}', isSpecial: false, isBundle: false,
    isMobile: false, filters: [], token: '', gpBoost: 0,
    isHideUnavailableProducts: false, isRegisteredRewardCardPromotion: false,
    enableAdReRanking: false, groupEdmVariants: true, categoryVersion: 'v2'
  })
  const res = await fetch(`${WOOLWORTHS_BASE}/apis/ui/browse/category`, {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*', 'Content-Type': 'application/json', 'Cookie': cookies },
    body
  })
  if (!res.ok) return null
  return res.json()
}

async function woolworthsSearch(query) {
  const cookies = await getWoolworthsCookies()
  const body = JSON.stringify({
    SearchTerm: query, PageNumber: 1, PageSize: 24, SortType: 'TraderRelevance',
    Filters: [], IsSpecial: false, Location: `/shop/search/products?searchTerm=${query}`,
    IsHideEverydayMarketProducts: false, GroupEdmVariants: false, EnableAdReRanking: false
  })
  const res = await fetch(`${WOOLWORTHS_BASE}/apis/ui/Search/products`, {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*', 'Content-Type': 'application/json', 'Origin': WOOLWORTHS_BASE, 'Cookie': cookies },
    body
  })
  if (!res.ok) return null
  return res.json()
}

function mapColes(p) {
  const pr = p.pricing || {}
  const img = p.imageUris?.[0]?.uri
  return {
    name: p.name, price: pr.now || 0, wasPrice: pr.was || 0,
    isOnSpecial: pr.onlineSpecial || false, isHalfPrice: pr.promotionType === 'HALF_PRICE',
    savings: pr.was && pr.now ? +(pr.was - pr.now).toFixed(2) : 0,
    image: img ? IMG_BASE_COLES + img : '', cupPrice: pr.comparable || '',
    brand: p.brand || '', size: p.size || '', store: 'coles', productId: String(p.id || ''),
  }
}

function mapWoolworths(p) {
  return {
    name: p.Name || p.DisplayName, price: p.Price || 0, wasPrice: p.WasPrice || 0,
    isOnSpecial: p.IsOnSpecial || false, isHalfPrice: p.IsHalfPrice || false,
    savings: p.SavingsAmount || 0,
    image: p.MediumImageFile || `${IMG_BASE_WOOLWORTHS}/${p.Stockcode}.jpg`,
    cupPrice: p.CupString || '', brand: p.Brand || '', size: p.PackageSize || '',
    store: 'woolworths', productId: String(p.Stockcode || ''),
  }
}

// --- SEARCH ENDPOINT (both stores) ---
app.get('/api/search', async (req, res) => {
  const q = req.query.q || 'milk'
  const store = req.query.store || 'all'
  let products = []

  // Coles search
  if (store === 'all' || store === 'coles') {
    try {
      const id = await getBuildId()
      const url = `${COLES_BASE}/_next/data/${id}/en/search/products.json?q=${encodeURIComponent(q)}&page=1`
      const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } })
      if (r.ok && (r.headers.get('content-type') || '').includes('json')) {
        const data = await r.json()
        const results = data?.pageProps?.searchResults?.results || []
        products.push(...results.filter(p => p._type === 'PRODUCT').slice(0, 12).map(mapColes))
      }
    } catch (e) {}
  }

  // Woolworths search
  if (store === 'all' || store === 'woolworths') {
    try {
      const data = await woolworthsSearch(q)
      if (data?.Products) {
        const wwProducts = data.Products.flatMap(g => g.Products || []).slice(0, 12).map(mapWoolworths)
        products.push(...wwProducts)
      }
    } catch (e) {}
  }

  // Sort: specials first, then by price
  products.sort((a, b) => (b.isOnSpecial - a.isOnSpecial) || (a.price - b.price))

  res.json({ products, query: q, total: products.length })
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
  const maxPages = parseInt(req.query.pages) || 999
  let total = 0, priceChanges = 0

  for (const cat of categories) {
    for (let page = 1; page <= maxPages; page++) {
      try {
        const id = await getBuildId()
        const url = `${COLES_BASE}/_next/data/${id}/en/browse/${cat}.json?slug=${cat}&page=${page}`
        const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } })
        if (!r.ok) break
        const data = await r.json()
        const results = (data?.pageProps?.searchResults?.results || []).filter(p => p._type === 'PRODUCT')
        if (results.length === 0) break

        // Upsert all products (always)
        const products = results.map(p => ({
          store: 'coles', product_id: String(p.id), name: p.name,
          brand: p.brand || null, size: p.size || null, category: cat,
          image: p.imageUris?.[0]?.uri ? IMG_BASE + p.imageUris[0].uri : null,
        }))

        await fetch(`${SUPABASE_URL}/rest/v1/products?on_conflict=store,product_id`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Prefer': 'resolution=merge-duplicates' },
          body: JSON.stringify(products),
        })

        // Only store price if it CHANGED from last recorded price (CamelCamelCamel technique)
        // This saves 70%+ storage when scaling to Woolworths + Aldi
        const prices = results.map(p => {
          const pr = p.pricing || {}
          return {
            store: 'coles', product_id: String(p.id), price: pr.now || 0,
            was_price: pr.was || null, is_on_special: pr.onlineSpecial || false,
            cup_price: pr.comparable || null,
          }
        })

        // Fetch last known prices for these products (batch query)
        const productIds = prices.map(p => `"${p.product_id}"`).join(',')
        const lastPricesRes = await fetch(
          `${SUPABASE_URL}/rest/v1/price_history?store=eq.coles&product_id=in.(${prices.map(p=>p.product_id).join(',')})&order=scraped_at.desc&select=product_id,price`,
          { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
        )
        let lastPrices = {}
        if (lastPricesRes.ok) {
          const lp = await lastPricesRes.json()
          // Only keep first (latest) per product
          for (const row of lp) {
            if (!lastPrices[row.product_id]) lastPrices[row.product_id] = row.price
          }
        }

        // Filter: only insert if price changed OR product is new
        const changedPrices = prices.filter(p => {
          const last = lastPrices[p.product_id]
          return last === undefined || parseFloat(last) !== parseFloat(p.price)
        })

        if (changedPrices.length > 0) {
          await fetch(`${SUPABASE_URL}/rest/v1/price_history?on_conflict=store,product_id,scraped_at`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Prefer': 'resolution=ignore-duplicates,return=headers-only' },
            body: JSON.stringify(changedPrices),
          })
          priceChanges += changedPrices.length
        }

        total += products.length
        await new Promise(r => setTimeout(r, 1000))
      } catch (e) { break }
    }
  }

  // --- WOOLWORTHS SCRAPE ---
  const wwDepartments = [
    '1-E5BEE36E', // Fruit & Veg
    '1_DEB537E',  // Bakery
    '1_D5A2236',  // Meat
    '1_6E4F4E4',  // Dairy, Eggs & Fridge
    '1_39FD49C',  // Pantry
    '1_ACA2FC2',  // Freezer
    '1_5AF3A0A',  // Drinks
  ]

  for (const dept of wwDepartments) {
    for (let page = 1; page <= maxPages; page++) {
      try {
        const data = await woolworthsBrowse(dept, page)
        if (!data) break
        const bundles = data.Bundles || []
        if (bundles.length === 0) break
        const results = bundles.flatMap(b => b.Products || [])

        const products = results.map(p => ({
          store: 'woolworths', product_id: String(p.Stockcode), name: p.Name || p.DisplayName,
          brand: p.Brand || null, size: p.PackageSize || null, category: dept,
          image: p.MediumImageFile || null,
        }))

        await fetch(`${SUPABASE_URL}/rest/v1/products?on_conflict=store,product_id`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Prefer': 'resolution=merge-duplicates' },
          body: JSON.stringify(products),
        })

        // CamelCamelCamel technique for Woolworths too
        const prices = results.map(p => ({
          store: 'woolworths', product_id: String(p.Stockcode), price: p.Price || 0,
          was_price: p.WasPrice || null, is_on_special: p.IsOnSpecial || false,
          cup_price: p.CupString || null,
        }))

        const wwProductIds = prices.map(p => p.product_id).join(',')
        const wwLastRes = await fetch(
          `${SUPABASE_URL}/rest/v1/price_history?store=eq.woolworths&product_id=in.(${wwProductIds})&order=scraped_at.desc&select=product_id,price`,
          { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
        )
        let wwLastPrices = {}
        if (wwLastRes.ok) {
          for (const row of await wwLastRes.json()) {
            if (!wwLastPrices[row.product_id]) wwLastPrices[row.product_id] = row.price
          }
        }

        const wwChanged = prices.filter(p => {
          const last = wwLastPrices[p.product_id]
          return last === undefined || parseFloat(last) !== parseFloat(p.price)
        })

        if (wwChanged.length > 0) {
          await fetch(`${SUPABASE_URL}/rest/v1/price_history?on_conflict=store,product_id,scraped_at`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Prefer': 'resolution=ignore-duplicates,return=headers-only' },
            body: JSON.stringify(wwChanged),
          })
          priceChanges += wwChanged.length
        }

        total += products.length
        await new Promise(r => setTimeout(r, 100)) // Woolworths allows 10req/sec
      } catch (e) { break }
    }
  }

  res.json({ success: true, totalProducts: total, categories: 8, priceChanges })
})

app.get('/health', (req, res) => res.json({ status: 'ok', buildId }))

app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`))
