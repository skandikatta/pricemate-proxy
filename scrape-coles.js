const { upsertProducts, insertPriceChanges, close } = require('./db')
const PROXY = process.env.PROXY_URL || 'https://pricemate-proxy.onrender.com'

async function scrapeColes() {
  console.log('=== COLES (via Render proxy) ===')
  const categories = ['dairy-eggs-fridge', 'fruit-vegetables', 'meat-seafood', 'pantry', 'drinks', 'frozen', 'bakery', 'household']
  let total = 0, changes = 0

  for (const cat of categories) {
    for (let page = 1; page <= 999; page++) {
      const url = `${PROXY}/api/browse/coles?category=${cat}&page=${page}`
      process.stdout.write(`  ${cat} p${page}...`)
      const r = await fetch(url)
      if (!r.ok) { console.log(` HTTP ${r.status}, stopping`); break }
      const data = await r.json()
      if (data.error) { console.log(` ${data.error}, stopping`); break }
      const results = (data?.pageProps?.searchResults?.results || []).filter(p => p._type === 'PRODUCT')
      if (results.length === 0) { console.log(' empty, done'); break }

      const products = results.map(p => ({
        store: 'coles', product_id: String(p.id), name: p.name,
        brand: p.brand || null, size: p.size || null, category: cat,
        image: p.imageUris?.[0]?.uri ? 'https://productimages.coles.com.au/productimages' + p.imageUris[0].uri : null,
      }))

      const prices = results.map(p => {
        const pr = p.pricing || {}
        return { store: 'coles', product_id: String(p.id), price: pr.now || 0, was_price: pr.was || null, is_on_special: pr.onlineSpecial || false }
      })

      await upsertProducts(products)
      const changed = await insertPriceChanges(prices)
      changes += changed
      total += products.length
      console.log(` ${results.length} products (${changed} changes)`)
      await sleep(1500)
    }
    console.log(`  ✓ ${cat}: ${total} cumulative`)
  }
  console.log(`\nColes done: ${total} products, ${changes} price changes`)
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

console.log(`Coles scrape started: ${new Date().toISOString()}`)
scrapeColes()
  .then(() => { console.log(`Coles scrape complete: ${new Date().toISOString()}`); return close() })
  .catch(e => { console.error('FAILED:', e.message); process.exit(1) })
