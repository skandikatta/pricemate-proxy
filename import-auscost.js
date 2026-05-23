const GRAFANA_URL = 'https://auscost.com.au/api/ds/query'
const DS_UID = 'ae02d0e7-f4a6-4e20-a23f-fbcd94a5a13e'
const SUPABASE_URL = 'https://asfnqfhpfufcbjzsrxlz.supabase.co'
const SUPABASE_KEY = process.env.SUPABASE_KEY || ''

async function queryAuscost(flux) {
  const res = await fetch(GRAFANA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      queries: [{ datasource: { uid: DS_UID }, query: flux, refId: 'A' }],
      from: 'now-240d', to: 'now'
    })
  })
  const data = await res.json()
  return data.results?.A?.frames || []
}

async function upsertSupabase(table, rows) {
  if (!rows.length) return
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Prefer': 'resolution=merge-duplicates',
    },
    body: JSON.stringify(rows),
  })
  if (!res.ok) console.error(`  Supabase error: ${res.status} ${await res.text().then(t=>t.slice(0,200))}`)
}

async function importData() {
  console.log('Importing auscost.com.au data into Supabase...')
  console.log('Querying 8 months of price history...\n')

  // Get all products with their latest price (to populate products table)
  const productFrames = await queryAuscost(`
    from(bucket: "groceries")
    |> range(start: -240d)
    |> filter(fn: (r) => r._measurement == "product" and r._field == "cents")
    |> last()
  `)

  console.log(`Found ${productFrames.length} products`)

  // Extract product info and insert
  const products = []
  const productIds = []
  for (const f of productFrames) {
    const labels = f.schema?.fields?.[1]?.labels || {}
    if (!labels.name || !labels.store) continue
    const store = labels.store.toLowerCase()
    const productId = labels.id || labels.name.replace(/[^a-z0-9]/gi, '_').slice(0, 50)
    products.push({
      store,
      product_id: productId,
      name: labels.name,
      brand: null,
      size: null,
      category: labels.department || null,
      image: null,
    })
    productIds.push({ store, productId, name: labels.name })
  }

  // Batch upsert products (100 at a time)
  for (let i = 0; i < products.length; i += 100) {
    await upsertSupabase('products', products.slice(i, i + 100))
    process.stdout.write(`  Products: ${Math.min(i + 100, products.length)}/${products.length}\r`)
  }
  console.log(`\n✓ ${products.length} products imported\n`)

  // Now get full price history for all products
  console.log('Importing price history (this takes a minute)...')
  
  // Query in 30-day chunks to avoid timeout
  const chunks = ['-240d', '-210d', '-180d', '-150d', '-120d', '-90d', '-60d', '-30d']
  let totalPrices = 0

  for (let c = 0; c < chunks.length - 1; c++) {
    const start = chunks[c]
    const stop = chunks[c + 1]
    console.log(`  Chunk ${c + 1}/${chunks.length - 1}: ${start} to ${stop}`)

    const frames = await queryAuscost(`
      from(bucket: "groceries")
      |> range(start: ${start}, stop: ${stop})
      |> filter(fn: (r) => r._measurement == "product" and r._field == "cents")
    `)

    const priceRows = []
    for (const f of frames) {
      const labels = f.schema?.fields?.[1]?.labels || {}
      if (!labels.name || !labels.store) continue
      const store = labels.store.toLowerCase()
      const productId = labels.id || labels.name.replace(/[^a-z0-9]/gi, '_').slice(0, 50)
      const vals = f.data?.values || []
      const times = vals[0] || []
      const prices = vals[1] || []

      for (let i = 0; i < times.length; i++) {
        const date = new Date(times[i]).toISOString().split('T')[0]
        const price = (prices[i] / 100).toFixed(2)
        priceRows.push({
          store,
          product_id: productId,
          price: parseFloat(price),
          was_price: null,
          is_on_special: false,
          scraped_at: date,
        })
      }
    }

    // Batch upsert prices (200 at a time)
    for (let i = 0; i < priceRows.length; i += 200) {
      await upsertSupabase('price_history', priceRows.slice(i, i + 200))
    }
    totalPrices += priceRows.length
    console.log(`    → ${priceRows.length} price records`)
  }

  console.log(`\n✓ Import complete: ${products.length} products, ${totalPrices} price records`)
  console.log('Predictions can now run on 8 months of historical data!')
}

importData().catch(e => { console.error('Import failed:', e.message); process.exit(1) })
