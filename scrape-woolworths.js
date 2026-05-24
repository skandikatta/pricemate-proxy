const PROXY = process.env.PROXY_URL || 'https://pricemate-proxy.onrender.com'
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://asfnqfhpfufcbjzsrxlz.supabase.co'
const SUPABASE_KEY = process.env.SUPABASE_KEY || ''

async function scrapeWoolworths() {
  console.log('=== WOOLWORTHS (via Render proxy) ===')
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
      const url = `${PROXY}/api/browse/woolworths?categoryId=${dept.id}&page=${page}`
      const r = await fetch(url)
      if (!r.ok) { console.log(`  ${dept.name} p${page}: HTTP ${r.status}, stopping`); break }
      const data = await r.json()
      if (data.error) { console.log(`  ${dept.name} p${page}: ${data.error}, stopping`); break }
      const bundles = data.Bundles || []
      if (bundles.length === 0) break
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
      await sleep(300)
    }
    console.log(`  ${dept.name}: ${total} total`)
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
