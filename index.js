const express = require('express')
const app = express()
const PORT = process.env.PORT || 3001

const COLES_BASE = 'https://www.coles.com.au'
const IMG_BASE = 'https://productimages.coles.com.au/productimages'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:129.0) Gecko/20100101 Firefox/129.0'

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
    const products = results
      .filter(p => p._type === 'PRODUCT')
      .slice(0, 24)
      .map(p => {
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
        }
      })

    res.json({ products, query: q, store: 'coles', total: data?.pageProps?.searchResults?.noOfResults || 0 })
  } catch (e) {
    res.json({ error: e.message, products: [], query: q })
  }
})

app.get('/health', (req, res) => res.json({ status: 'ok' }))

app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`))
