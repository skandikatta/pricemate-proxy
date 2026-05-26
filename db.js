// db.js — shared PostgreSQL connection for all scrapers
const { Pool } = require('pg')

const pool = new Pool({
  host: process.env.DB_HOST,
  port: 5432,
  database: 'pricemate',
  user: 'pricemate',
  password: process.env.DB_PASSWORD,
  max: 5,
  idleTimeoutMillis: 30000,
})

/**
 * Normalize a product name for matching.
 * Strips case, extra spaces, common suffixes like "each", "loose", pack sizes.
 */
function normalizeName(name) {
  return (name || '').toLowerCase()
    .replace(/['"‘’“”]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// Postgres caps parameters at 65535 per statement (16-bit). 8 cols × 8000 rows = 64000.
const MAX_UPSERT_BATCH = 8000

async function upsertProducts(products) {
  if (!products.length) return

  // Dedupe by product_id (same product can appear in multiple categories within one scrape)
  const seen = new Set()
  const deduped = products.filter(p => {
    if (seen.has(p.product_id)) return false
    seen.add(p.product_id)
    return true
  })

  for (let i = 0; i < deduped.length; i += MAX_UPSERT_BATCH) {
    const batch = deduped.slice(i, i + MAX_UPSERT_BATCH)
    const values = batch.map((_, j) => {
      const base = j * 8
      return `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7},$${base+8})`
    }).join(',')
    const params = batch.flatMap(p => [p.store, p.product_id, p.name, p.brand || null, p.size || null, p.category || null, p.image || null, p.barcode || null])
    await pool.query(
      `INSERT INTO products (store,product_id,name,brand,size,category,image,barcode) VALUES ${values}
       ON CONFLICT (store,product_id) DO UPDATE SET name=EXCLUDED.name, brand=EXCLUDED.brand, size=EXCLUDED.size, category=EXCLUDED.category, image=EXCLUDED.image, barcode=COALESCE(EXCLUDED.barcode, products.barcode)`,
      params
    )
  }
}

async function insertPriceChanges(prices) {
  if (!prices.length) return 0
  // Deduplicate by product_id (same product can appear in multiple categories)
  const seen = new Map()
  for (const p of prices) seen.set(p.product_id, p)
  prices = [...seen.values()]

  const ids = prices.map(p => p.product_id)
  const store = prices[0].store
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (product_id) product_id, price FROM price_history WHERE store=$1 AND product_id = ANY($2) ORDER BY product_id, scraped_at DESC`,
    [store, ids]
  )
  const lastPrices = Object.fromEntries(rows.map(r => [r.product_id, parseFloat(r.price)]))

  const changed = prices.filter(p => {
    const last = lastPrices[p.product_id]
    return last === undefined || last !== parseFloat(p.price)
  })

  if (!changed.length) return 0

  // 5 cols × 13000 rows = 65000, safely under the 65535 placeholder cap.
  const MAX_PRICE_BATCH = 13000
  for (let i = 0; i < changed.length; i += MAX_PRICE_BATCH) {
    const batch = changed.slice(i, i + MAX_PRICE_BATCH)
    const values = batch.map((_, j) => {
      const base = j * 5
      return `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5})`
    }).join(',')
    const params = batch.flatMap(p => [p.store, p.product_id, p.price, p.was_price || null, p.is_on_special || false])
    await pool.query(
      `INSERT INTO price_history (store,product_id,price,was_price,is_on_special) VALUES ${values}
       ON CONFLICT (store,product_id,scraped_at) DO NOTHING`,
      params
    )
  }
  return changed.length
}

async function close() { await pool.end() }

module.exports = { upsertProducts, insertPriceChanges, close, normalizeName }
