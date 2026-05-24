const { upsertProducts, insertPriceChanges, close } = require('./db')
const WOOLWORTHS_BASE = 'https://www.woolworths.com.au'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:129.0) Gecko/20100101 Firefox/129.0'

async function getWoolworthsCookies() {
  const res = await fetch(`${WOOLWORTHS_BASE}/shop/browse/fruit-veg`, { headers: { 'User-Agent': UA }, redirect: 'manual' })
  const setCookies = res.headers.getSetCookie?.() || []
  return setCookies.map(c => c.split(';')[0]).join('; ')
}

async function scrapeWoolworths() {
  console.log('=== WOOLWORTHS (direct) ===')
  const cookies = await getWoolworthsCookies()
  if (!cookies) { console.log('ERROR: Failed to get cookies'); process.exit(1) }
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
      if (results.length < 10) { console.log(` only ${results.length} (filler), done`); break }

      const products = results.map(p => ({
        store: 'woolworths', product_id: String(p.Stockcode), name: p.Name || p.DisplayName,
        brand: p.Brand || null, size: p.PackageSize || null, category: dept.name,
        image: p.LargeImageFile || p.MediumImageFile || null,
      }))

      const prices = results.map(p => ({
        store: 'woolworths', product_id: String(p.Stockcode), price: p.Price || 0,
        was_price: p.WasPrice || null, is_on_special: p.IsOnSpecial || false,
      }))

      await upsertProducts(products)
      const changed = await insertPriceChanges(prices)
      changes += changed
      total += products.length
      console.log(` ${results.length} products (${changed} changes)`)
      await sleep(100)
    }
    console.log(`  ✓ ${dept.name}: ${total} cumulative`)
  }
  console.log(`\nWoolworths done: ${total} products, ${changes} price changes`)
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

console.log(`Woolworths scrape started: ${new Date().toISOString()}`)
scrapeWoolworths()
  .then(() => { console.log(`Woolworths scrape complete: ${new Date().toISOString()}`); return close() })
  .catch(e => { console.error('FAILED:', e.message); process.exit(1) })
