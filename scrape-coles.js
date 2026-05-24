const COLES_BASE = 'https://www.coles.com.au'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:129.0) Gecko/20100101 Firefox/129.0'
const IMG_BASE_COLES = 'https://productimages.coles.com.au/productimages'
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://asfnqfhpfufcbjzsrxlz.supabase.co'
const SUPABASE_KEY = process.env.SUPABASE_KEY || ''

async function getColesBuildId() {
  const res = await fetch(COLES_BASE, { headers: { 'User-Agent': UA } })
  const html = await res.text()
  const match = html.match(/"buildId":"([^"]+)"/)
  if (!match) throw new Error('Cannot extract Coles buildId')
  return match[1]
}

async function scrapeColes() {
  console.log('=== COLES ===')
  const buildId = await getColesBuildId()
  console.log(`BuildId: ${buildId}`)
  const categories = ['dairy-eggs-fridge', 'fruit-vegetables', 'meat-seafood', 'pantry', 'drinks', 'frozen', 'bakery', 'household']
  let total = 0, changes = 0

  for (const cat of categories) {
    for (let page = 1; page <= 999; page++) {
      const url = `${COLES_BASE}/_next/data/${buildId}/en/browse/${cat}.json?slug=${cat}&page=${page}`
      const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } })
      if (!r.ok) break
      const data = await r.json()
      const results = (data?.pageProps?.searchResults?.results || []).filter(p => p._type === 'PRODUCT')
      if (results.length === 0) break

      const products = results.map(p => ({
        store: 'coles', product_id: String(p.id), name: p.name,
        brand: p.brand || null, size: p.size || null, category: cat,
        image: p.imageUris?.[0]?.uri ? IMG_BASE_COLES + p.imageUris[0].uri : null,
      }))

      const prices = results.map(p => {
        const pr = p.pricing || {}
        return { store: 'coles', product_id: String(p.id), price: pr.now || 0, was_price: pr.was || null, is_on_special: pr.onlineSpecial || false, cup_price: pr.comparable || null }
      })

      await supabasePost('products?on_conflict=store,product_id', products, 'resolution=merge-duplicates')

      const lastPrices = await getLastPrices('coles', prices.map(p => p.product_id))
      const changed = prices.filter(p => {
        const last = lastPrices[p.product_id]
        return last === undefined || parseFloat(last) !== parseFloat(p.price)
      })
      if (changed.length > 0) {
        await supabasePost('price_history?on_conflict=store,product_id,scraped_at', changed, 'resolution=ignore-duplicates')
        changes += changed.length
      }

      total += products.length
      await sleep(1000)
    }
    console.log(`  ${cat}: ${total} total`)
  }
  console.log(`\nColes done: ${total} products, ${changes} price changes`)
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

async function getLastPrices(store, productIds) {
  const ids = productIds.join(',')
  const r = await fetch(`${SUPABASE_URL}/rest/v1/price_history?store=eq.${store}&product_id=in.(${ids})&order=scraped_at.desc&select=product_id,price`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
  })
  const map = {}
  if (r.ok) { for (const row of await r.json()) { if (!map[row.product_id]) map[row.product_id] = row.price } }
  return map
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

console.log(`Coles scrape started: ${new Date().toISOString()}`)
scrapeColes()
  .then(() => console.log(`Coles scrape complete: ${new Date().toISOString()}`))
  .catch(e => { console.error('FAILED:', e.message); process.exit(1) })
