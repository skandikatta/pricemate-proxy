const express = require('express')
const app = express()
const PORT = process.env.PORT || 3001

const COLES_BASE = 'https://www.coles.com.au'
const WOOLWORTHS_BASE = 'https://www.woolworths.com.au'
const IMG_BASE_COLES = 'https://productimages.coles.com.au/productimages'
const IMG_BASE_WOOLWORTHS = 'https://cdn0.woolworths.media/content/wowproductimages/large'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:129.0) Gecko/20100101 Firefox/129.0'

// --- COLES ---
// Last-known-good buildId. Coles changes this roughly weekly. Falls back to this
// if Imperva blocks the homepage fetch (datacenter IP flagged). Update manually
// after confirming a new buildId works.
const FALLBACK_BUILD_ID = '20260519.2-dc6ca4a12a99dc741883de303f8dfa9ced7179b3'
let buildId = null
let buildIdTime = 0

async function getBuildId() {
  // Cache aggressively — buildId changes only on Coles deploy (weekly-ish).
  if (buildId && Date.now() - buildIdTime < 86400000) return buildId
  try {
    const res = await fetch(COLES_BASE, { headers: { 'User-Agent': UA } })
    const html = await res.text()
    const match = html.match(/"buildId":"([^"]+)"/)
    if (!match) throw new Error('No __NEXT_DATA__ in homepage (likely Imperva block)')
    buildId = match[1]
    buildIdTime = Date.now()
    return buildId
  } catch (e) {
    console.warn(`[buildId fetch failed] ${e.message} — falling back to ${FALLBACK_BUILD_ID}`)
    // Use last-known buildId rather than failing the whole scrape. Coles serves
    // older buildIds for ~1 week before they go 404, so this buys headroom.
    return FALLBACK_BUILD_ID
  }
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

async function woolworthsSearch(query, page = 1) {
  const cookies = await getWoolworthsCookies()
  const body = JSON.stringify({
    SearchTerm: query, PageNumber: page, PageSize: 36, SortType: 'TraderRelevance',
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
// Praveen 2026-05-27: Coles shows 137 results for "milk", Woolies shows 304.
// We should mirror that — fetch ALL pages (capped) and let the frontend
// filter/sort. Coles + Woolies upstream calls are independent so we run
// them in parallel; within each store we fetch page 1, then in parallel
// fetch pages 2..N up to MAX_PAGES based on the noOfResults header.
// Tuned so we can match what Coles + Woolies show on their own sites:
// Coles "milk" = 137 results; 4 pages × 48 covers it.
// Woolies "milk" = 304 results; 9 pages × 36 covers it.
const MAX_COLES_PAGES = 6
const MAX_WOOLIES_PAGES = 9
const COLES_PAGE_SIZE = 48
const WOOLIES_PAGE_SIZE = 36

async function fetchColesPage(q, page, buildId) {
  const url = `${COLES_BASE}/_next/data/${buildId}/en/search/products.json?q=${encodeURIComponent(q)}&page=${page}`
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } })
  if (!r.ok || !(r.headers.get('content-type') || '').includes('json')) {
    console.warn(`[search:coles] page ${page}: HTTP ${r.status} content-type=${r.headers.get('content-type')}`)
    return { results: [], total: 0 }
  }
  const data = await r.json()
  const sr = data?.pageProps?.searchResults || {}
  const results = (sr.results || []).filter(p => p._type === 'PRODUCT')
  const total = sr.noOfResults || sr.totalResults || sr.totalCount || results.length
  return { results, total }
}

async function searchColes(q) {
  try {
    const id = await getBuildId()
    const first = await fetchColesPage(q, 1, id)
    if (first.results.length === 0) return []
    const totalPages = Math.min(MAX_COLES_PAGES, Math.ceil(first.total / COLES_PAGE_SIZE))
    const rest = totalPages > 1
      ? await Promise.all(Array.from({ length: totalPages - 1 }, (_, i) => fetchColesPage(q, i + 2, id)))
      : []
    const all = [first, ...rest].flatMap(p => p.results)
    return all.map(mapColes)
  } catch (e) {
    console.error(`[search:coles] ${e.message}`)
    return []
  }
}

async function searchWoolworths(q) {
  try {
    const first = await woolworthsSearch(q, 1)
    if (!first?.Products) return []
    const firstProducts = first.Products.flatMap(g => g.Products || [])
    const total = first.SearchResultsCount || first.TotalCount || firstProducts.length
    const totalPages = Math.min(MAX_WOOLIES_PAGES, Math.ceil(total / WOOLIES_PAGE_SIZE))
    const rest = totalPages > 1
      ? await Promise.all(Array.from({ length: totalPages - 1 }, (_, i) => woolworthsSearch(q, i + 2)))
      : []
    const all = [first, ...rest]
      .filter(Boolean)
      .flatMap(p => (p.Products || []).flatMap(g => g.Products || []))
    return all.map(mapWoolworths)
  } catch (e) {
    console.error(`[search:woolworths] ${e.message}`)
    return []
  }
}

app.get('/api/search', async (req, res) => {
  const q = req.query.q || 'milk'
  const store = req.query.store || 'all'

  const [colesProducts, wooliesProducts] = await Promise.all([
    (store === 'all' || store === 'coles') ? searchColes(q) : Promise.resolve([]),
    (store === 'all' || store === 'woolworths') ? searchWoolworths(q) : Promise.resolve([]),
  ])
  const products = [...colesProducts, ...wooliesProducts]
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

// Coles category discovery — extracts the homepage navigation from __NEXT_DATA__.
// Used by scrape-coles.js to auto-handle slug rotations (e.g. household → cleaning-laundry).
// Cached for 1h since the homepage doesn't change often.
let colesCategories = null
let colesCategoriesTime = 0

function walkFor(obj, key) {
  if (!obj || typeof obj !== 'object') return null
  if (Array.isArray(obj[key])) return obj[key]
  for (const v of Object.values(obj)) {
    const r = walkFor(v, key)
    if (r) return r
  }
  return null
}

app.get('/api/coles/categories', async (req, res) => {
  try {
    // Hold cached list for 24h. Categories rotate maybe quarterly, so stale-but-valid
    // is far better than failing the scrape entirely when Imperva flags our IP.
    if (colesCategories && Date.now() - colesCategoriesTime < 86400000) {
      return res.json({ categories: colesCategories, cached: true })
    }
    const html = await fetch(COLES_BASE, { headers: { 'User-Agent': UA } }).then(r => r.text())
    const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([^<]+)<\/script>/)
    if (!match) {
      // Imperva blocked us. If we have any cached list (even >24h old), serve it.
      if (colesCategories) {
        console.warn('[coles/categories] homepage block — serving stale cache')
        return res.json({ categories: colesCategories, cached: true, stale: true })
      }
      return res.status(502).json({ error: 'No __NEXT_DATA__ found in homepage' })
    }
    const data = JSON.parse(match[1])
    const items = walkFor(data.props?.pageProps, 'categoryItems') || []
    const categories = items
      .filter(i => /^https?:\/\/[^/]*coles\.com\.au\/browse\/[a-z0-9-]+\/?$/.test(i.linkUrl || '')
                || /^\/browse\/[a-z0-9-]+\/?$/.test(i.linkUrl || ''))
      .map(i => ({
        title: i.title,
        slug: i.linkUrl.replace(/^https?:\/\/[^/]*coles\.com\.au/, '').replace(/^\/browse\//, '').replace(/\/$/, ''),
      }))
      .filter(c => c.slug && c.title)
    if (categories.length < 10) return res.status(502).json({ error: `Only ${categories.length} categories extracted` })
    colesCategories = categories
    colesCategoriesTime = Date.now()
    res.json({ categories, cached: false })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.get('/health', (req, res) => res.json({ status: 'ok', buildId }))

app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`))
