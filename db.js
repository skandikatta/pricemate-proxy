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

  // Skip products with no usable name — they're useless for matching and clutter the matcher.
  // Silent skip: per-page logs interleave with scraper progress output. Aggregate count
  // can be queried from DB if needed.
  products = products.filter(p => p.product_id && p.name && String(p.name).trim().length > 0)
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

// Writes a price_history row per (store, product_id, day) — every product, every run,
// even when the price hasn't changed. Day-granularity uniqueness comes from the
// price_history_daily_uniq index added in migrations/003. Same-day re-runs are
// idempotent (the duplicate just UPDATEs the existing row's price).
//
// Returns the number of products whose price actually CHANGED vs the most recent
// prior row. Scrapers log this as "X price changes" for human readability —
// the underlying row density is now uniform regardless of whether anything moved.
async function insertPriceChanges(prices) {
  if (!prices.length) return 0

  prices = prices.filter(p => {
    const n = parseFloat(p.price)
    return Number.isFinite(n) && n > 0
  })
  if (!prices.length) return 0

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

  const changedCount = prices.reduce((acc, p) => {
    const last = lastPrices[p.product_id]
    return acc + (last === undefined || last !== parseFloat(p.price) ? 1 : 0)
  }, 0)

  const MAX_PRICE_BATCH = 13000
  for (let i = 0; i < prices.length; i += MAX_PRICE_BATCH) {
    const batch = prices.slice(i, i + MAX_PRICE_BATCH)
    const values = batch.map((_, j) => {
      const base = j * 5
      return `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5})`
    }).join(',')
    const params = batch.flatMap(p => [p.store, p.product_id, p.price, p.was_price || null, p.is_on_special || false])
    await pool.query(
      `INSERT INTO price_history (store,product_id,price,was_price,is_on_special) VALUES ${values}
       ON CONFLICT (store, product_id, (scraped_at::date))
       DO UPDATE SET
         price = EXCLUDED.price,
         was_price = EXCLUDED.was_price,
         is_on_special = EXCLUDED.is_on_special`,
      params
    )
  }
  return changedCount
}

async function getStoreProductCount(store) {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM products WHERE store = $1', [store])
  return rows[0]?.n ?? 0
}

async function close() { await pool.end() }

module.exports = { upsertProducts, insertPriceChanges, close, normalizeName, getStoreProductCount }
