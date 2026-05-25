const express = require('express')
const app = express()
const PORT = process.env.PORT || 3001

const COLES_BASE = 'https://www.coles.com.au'
const WOOLWORTHS_BASE = 'https://www.woolworths.com.au'
const IMG_BASE_COLES = 'https://productimages.coles.com.au/productimages'
const IMG_BASE_WOOLWORTHS = 'https://cdn0.woolworths.media/content/wowproductimages/large'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:129.0) Gecko/20100101 Firefox/129.0'

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
  if (wwCookies && Date.now() - wwCookieTime < 1800000) return wwCookies
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
    image: p.LargeImageFile || p.MediumImageFile || `${IMG_BASE_WOOLWORTHS}/${p.Stockcode}.jpg`,
    cupPrice: p.CupString || '', brand: p.Brand || '', size: p.PackageSize || '',
    store: 'woolworths', productId: String(p.Stockcode || ''),
  }
}

// --- SEARCH ENDPOINT (both stores) ---
app.get('/api/search', async (req, res) => {
  const q = req.query.q || 'milk'
  const store = req.query.store || 'all'
  let products = []

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

  if (store === 'all' || store === 'woolworths') {
    try {
      const data = await woolworthsSearch(q)
      if (data?.Products) {
        const wwProducts = data.Products.flatMap(g => g.Products || []).slice(0, 12).map(mapWoolworths)
        products.push(...wwProducts)
      }
    } catch (e) {}
  }

  products.sort((a, b) => (b.isOnSpecial - a.isOnSpecial) || (a.price - b.price))
  res.json({ products, query: q, total: products.length })
})

// Browse proxy - returns raw Coles/Woolworths category JSON (for GitHub Actions scrapers)
app.get('/api/browse/coles', async (req, res) => {
  try {
    const cat = req.query.category || 'dairy-eggs-fridge'
    const page = parseInt(req.query.page) || 1
    const id = await getBuildId()
    const url = `${COLES_BASE}/_next/data/${id}/en/browse/${cat}.json?slug=${cat}&page=${page}`
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } })
    if (!r.ok) return res.status(r.status).json({ error: 'Coles returned ' + r.status })
    const data = await r.json()
    res.json(data)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.get('/api/browse/woolworths', async (req, res) => {
  try {
    const categoryId = req.query.categoryId
    const page = parseInt(req.query.page) || 1
    if (!categoryId) return res.status(400).json({ error: 'categoryId required' })
    const data = await woolworthsBrowse(categoryId, page)
    if (!data) return res.status(502).json({ error: 'No data from Woolworths' })
    res.json(data)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.get('/health', (req, res) => res.json({ status: 'ok', buildId }))

app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`))
