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
    .replace(/[''""]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Smart upsert: if a product's ID changed but name+store match an existing record,
 * migrate the old ID to the new one (preserving price history).
 */
async function upsertProducts(products) {
  if (!products.length) return

  const store = products[0].store

  // Get existing products for this store in one query
  const { rows: existing } = await pool.query(
    'SELECT product_id, name FROM products WHERE store = $1',
    [store]
  )

  // Build lookup: normalized name → old product_id
  const nameToId = new Map()
  for (const row of existing) {
    nameToId.set(normalizeName(row.name), row.product_id)
  }

  // Also build id set for quick "already exists" check
  const existingIds = new Set(existing.map(r => r.product_id))

  let migrated = 0

  for (const p of products) {
    const normalName = normalizeName(p.name)
    const oldId = nameToId.get(normalName)

    if (oldId && oldId !== p.product_id && !existingIds.has(p.product_id)) {
      // Same product, different ID → migrate
      await pool.query(
        'UPDATE products SET product_id = $1 WHERE store = $2 AND product_id = $3',
        [p.product_id, store, oldId]
      )
      await pool.query(
        'UPDATE price_history SET product_id = $1 WHERE store = $2 AND product_id = $3',
        [p.product_id, store, oldId]
      )
      // Update product_groups too
      const col = store === 'coles' ? 'coles_id' : store === 'woolworths' ? 'woolworths_id' : 'aldi_id'
      await pool.query(
        `UPDATE product_groups SET ${col} = $1 WHERE ${col} = $2`,
        [p.product_id, oldId]
      )
      existingIds.delete(oldId)
      existingIds.add(p.product_id)
      nameToId.set(normalName, p.product_id)
      migrated++
    }
  }

  if (migrated > 0) {
    console.log(`  [ID migration] ${migrated} products had ID changes — history preserved`)
  }

  // Now do the normal upsert (deduplicate by product_id first)
  const seen = new Set()
  const deduped = products.filter(p => {
    if (seen.has(p.product_id)) return false
    seen.add(p.product_id)
    return true
  })

  const values = deduped.map((p, i) => {
    const base = i * 7
    return `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7})`
  }).join(',')
  const params = deduped.flatMap(p => [p.store, p.product_id, p.name, p.brand || null, p.size || null, p.category || null, p.image || null])
  await pool.query(
    `INSERT INTO products (store,product_id,name,brand,size,category,image) VALUES ${values}
     ON CONFLICT (store,product_id) DO UPDATE SET name=EXCLUDED.name, brand=EXCLUDED.brand, size=EXCLUDED.size, category=EXCLUDED.category, image=EXCLUDED.image`,
    params
  )
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
