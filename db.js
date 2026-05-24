// db.js — shared PostgreSQL connection for all scrapers
const { Pool } = require('pg')

const pool = new Pool({
  host: process.env.DB_HOST || 'REDACTED_HOST',
  port: 5432,
  database: 'pricemate',
  user: 'pricemate',
  password: process.env.DB_PASSWORD || 'REDACTED_PASSWORD',
  max: 5,
  idleTimeoutMillis: 30000,
})

async function upsertProducts(products) {
  if (!products.length) return
  const values = products.map((p, i) => {
    const base = i * 7
    return `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7})`
  }).join(',')
  const params = products.flatMap(p => [p.store, p.product_id, p.name, p.brand || null, p.size || null, p.category || null, p.image || null])
  await pool.query(
    `INSERT INTO products (store,product_id,name,brand,size,category,image) VALUES ${values}
     ON CONFLICT (store,product_id) DO UPDATE SET name=EXCLUDED.name, brand=EXCLUDED.brand, size=EXCLUDED.size, category=EXCLUDED.category, image=EXCLUDED.image`,
    params
  )
}

async function insertPriceChanges(prices) {
  if (!prices.length) return 0
  // Get last known prices
  const ids = prices.map(p => p.product_id)
  const store = prices[0].store
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (product_id) product_id, price FROM price_history WHERE store=$1 AND product_id = ANY($2) ORDER BY product_id, scraped_at DESC`,
    [store, ids]
  )
  const lastPrices = Object.fromEntries(rows.map(r => [r.product_id, parseFloat(r.price)]))

  // Filter: only insert if price changed
  const changed = prices.filter(p => {
    const last = lastPrices[p.product_id]
    return last === undefined || last !== parseFloat(p.price)
  })

  if (!changed.length) return 0

  const values = changed.map((p, i) => {
    const base = i * 5
    return `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5})`
  }).join(',')
  const params = changed.flatMap(p => [p.store, p.product_id, p.price, p.was_price || null, p.is_on_special || false])
  await pool.query(
    `INSERT INTO price_history (store,product_id,price,was_price,is_on_special) VALUES ${values}
     ON CONFLICT (store,product_id,scraped_at) DO NOTHING`,
    params
  )
  return changed.length
}

async function close() { await pool.end() }

module.exports = { upsertProducts, insertPriceChanges, close }
