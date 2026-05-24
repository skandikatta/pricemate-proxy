const WOOLWORTHS_BASE = 'https://www.woolworths.com.au'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:129.0) Gecko/20100101 Firefox/129.0'
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://asfnqfhpfufcbjzsrxlz.supabase.co'
const SUPABASE_KEY = process.env.SUPABASE_KEY || ''

async function getWoolworthsCookies() {
  const res = await fetch(`${WOOLWORTHS_BASE}/shop/browse/fruit-veg`, { headers: { 'User-Agent': UA }, redirect: 'manual' })
  const setCookies = res.headers.getSetCookie?.() || []
  return setCookies.map(c => c.split(';')[0]).join('; ')
}

async function scrapeWoolworths() {
  console.log('=== WOOLWORTHS (direct) ===')
  const cookies = await getWoolworthsCookies()
  if (!cookies) { console.log('ERROR: Failed to get cookies (likely IP blocked)'); process.exit(1) }
  console.log('Cookies obtained ✓')

  const departments = [
    { id: '1-E5BEE36E', name: 'fruit-veg' },
    { id: '1_DEB537E', name: 'bakery' },
    { id: '1_D5A2236', name: 'meat' },
    { id: '1_6E4F4E4', name: 'dairy' },
    { id: '1_39FD49C', name: 'pantry' },
    { id: '1_ACA2FC2', name: 'frozen' },
    { id: '1_5AF3A0A', name: 'drinks' },
  ]
  let total = 0, changes = 0

  for (const dept of departments) {
    for (let page = 1; page <= 999; page++) {
      const body = JSON.stringify({
        categoryId: dept.id, pageNumber: page, pageSize: 36, sortType: 'TraderRelevance',
        url: '/shop/browse/fruit-veg', location: '/shop/browse/fruit-veg',
        formatObject: '{"name":"Category"}', isSpecial: false, isBundle: false,
        isMobile: false, filters: [], token: '', gpBoost: 0,
        isHideUnavailableProducts: false, isRegisteredRewardCardPromotion: false,
        enableAdReRanking: false, groupEdmVariants: true, categoryVersion: 'v2'
      })
      process.stdout.write(`  ${dept.name} p${page}...`)
      const r = await fetch(`${WOOLWORTHS_BASE}/apis/ui/browse/category`, {
        method: 'POST',
        headers: { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*', 'Content-Type': 'application/json', 'Cookie': cookies },
        body
      })
      if (!r.ok) { console.log(` HTTP ${r.status}, stopping`); break }
      const data = await r.json()
      const bundles = data.Bundles || []
      if (bundles.length === 0) { console.log(' empty, done'); break }
      const results = bundles.flatMap(b => b.Products || [])

      const products = results.map(p => ({
        store: 'woolworths', product_id: String(p.Stockcode), name: p.Name || p.DisplayName,
        brand: p.Brand || null, size: p.PackageSize || null, category: dept.name,
        image: p.MediumImageFile || null,
      }))

      const prices = results.map(p => ({
        store: 'woolworths', product_id: String(p.Stockcode), price: p.Price || 0,
        was_price: p.WasPrice || null, is_on_special: p.IsOnSpecial || false, cup_price: p.CupString || null,
      }))

      await supabasePost('products?on_conflict=store,product_id', products, 'resolution=merge-duplicates')

      const lastPrices = await getLastPrices('woolworths', prices.map(p => p.product_id))
      const changed = prices.filter(p => {
        const last = lastPrices[p.product_id]
        return last === undefined || parseFloat(last) !== parseFloat(p.price)
      })
      if (changed.length > 0) {
        await supabasePost('price_history?on_conflict=store,product_id,scraped_at', changed, 'resolution=ignore-duplicates')
        changes += changed.length
      }

      total += products.length
      console.log(` ${results.length} products (${changed.length} changes)`)
      await sleep(100)
    }
    console.log(`  ✓ ${dept.name}: ${total} cumulative`)
  }
  console.log(`\nWoolworths done: ${total} products, ${changes} price changes`)
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

console.log(`Woolworths scrape started: ${new Date().toISOString()}`)
scrapeWoolworths()
  .then(() => console.log(`Woolworths scrape complete: ${new Date().toISOString()}`))
  .catch(e => { console.error('FAILED:', e.message); process.exit(1) })
