// db.js — shared PostgreSQL connection for all scrapers
const { Pool } = require('pg')

// Shared pool used by api-server.js (continuous), send-alerts.js (daily cron),
// and the one-shot ingest/match/review scripts. max:10 is api-server-driven —
// it's the only file with concurrent traffic; one-shots will at most spike to
// a few connections each. host falls back to localhost so VM-hosted scripts
// (running on the same box as Postgres) work without DB_HOST being set.
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432,
  database: 'pricemate',
  user: 'pricemate',
  password: process.env.DB_PASSWORD,
  max: 10,
  idleTimeoutMillis: 30000,
})
if (!process.env.DB_PASSWORD) {
  console.error('FATAL: DB_PASSWORD env var is not set'); process.exit(1)
}

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

async function insertPriceChanges(prices) {
  if (!prices.length) return 0

  // Filter out junk: missing price, zero, negative, NaN. Storing $0 corrupts cycle detection.
  // Silent skip: per-page logs interleave with scraper progress output.
  prices = prices.filter(p => {
    const n = parseFloat(p.price)
    return Number.isFinite(n) && n > 0
  })
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

  // 6 cols × 10000 rows = 60000, safely under the 65535 placeholder cap.
  const MAX_PRICE_BATCH = 10000
  for (let i = 0; i < changed.length; i += MAX_PRICE_BATCH) {
    const batch = changed.slice(i, i + MAX_PRICE_BATCH)
    const values = batch.map((_, j) => {
      const base = j * 6
      return `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6})`
    }).join(',')
    const params = batch.flatMap(p => [p.store, p.product_id, p.price, p.was_price || null, p.is_on_special || false, p.cup_price || null])
    await pool.query(
      `INSERT INTO price_history (store,product_id,price,was_price,is_on_special,cup_price) VALUES ${values}
       ON CONFLICT (store,product_id,scraped_at) DO NOTHING`,
      params
    )
  }
  return changed.length
}

async function getStoreProductCount(store) {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM products WHERE store = $1', [store])
  return rows[0]?.n ?? 0
}

// ─────────────────────────────────────────────────────────────────────────────
// Option C — internal_id (passport) + product_aliases (phone numbers).
//
// Shadow writes: when OPTION_C_SHADOW_WRITE=1, every upsertProducts +
// insertPriceChanges call ALSO writes to products_v2 / product_aliases /
// price_history_v2. The existing vendor-keyed writes still happen — Option B
// stays in force as the source of truth until predictions explicitly cut over.
//
// Rename detection (linking a new vendor_id to an existing internal_id when
// the retailer has rebranded an SKU) is intentionally NOT done inline. It's
// in detect-renames.js as an offline pass with brand+size guards. Inline
// fuzzy-matching was the 757caeb bug class — we don't repeat it.
//
// Setup order (see pricemate-proxy/OPTION_C_RUNBOOK.md):
//   1. Apply pricemate/migrations/005_option_c_passport_aliases.sql
//   2. Run backfill-internal-ids.js --apply
//   3. Turn on OPTION_C_SHADOW_WRITE=1 in the scraper env
//   4. Watch v2 tables grow alongside v1 for a few days
//   5. Run detect-renames.js periodically (manual review queue)
//   6. Cut predictions over to read v2 (later commit)
//   7. Drop v1 tables in migration 006 (later, after sustained verification)
// ─────────────────────────────────────────────────────────────────────────────

const SHADOW_WRITE_V2 = process.env.OPTION_C_SHADOW_WRITE === '1'

async function shadowUpsertProductsV2(products) {
  if (!SHADOW_WRITE_V2 || !products.length) return

  // Batch-fetch existing aliases so we know which products already have a
  // passport (just bump last_seen) vs need a new passport minted.
  const stores = products.map(p => p.store)
  const vendorIds = products.map(p => p.product_id)
  const { rows: existingRows } = await pool.query(
    `SELECT pa.store, pa.vendor_id, pa.internal_id
       FROM product_aliases pa
       JOIN UNNEST($1::text[], $2::text[]) AS k(store, vendor_id)
         ON pa.store = k.store AND pa.vendor_id = k.vendor_id`,
    [stores, vendorIds]
  )
  const aliasMap = new Map()
  for (const r of existingRows) aliasMap.set(`${r.store}_${r.vendor_id}`, r.internal_id)

  const newProducts = products.filter(p => !aliasMap.has(`${p.store}_${p.product_id}`))
  const existing    = products.filter(p =>  aliasMap.has(`${p.store}_${p.product_id}`))

  // Mint passports + aliases for new vendor_ids. Each gets a fresh internal_id
  // (no rename stitching here — that's detect-renames.js's job offline).
  for (let i = 0; i < newProducts.length; i += 500) {
    const batch = newProducts.slice(i, i + 500)
    // INSERT products_v2 in one statement, RETURNING the minted internal_ids
    const passportValues = batch.map((_, j) => {
      const b = j * 6
      return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6})`
    }).join(',')
    const passportParams = batch.flatMap(p => [
      p.name, p.brand || null, p.size || null, p.category || null, p.image || null, p.barcode || null,
    ])
    const { rows: minted } = await pool.query(
      `INSERT INTO products_v2 (canonical_name, brand, size, category, image, barcode)
       VALUES ${passportValues}
       RETURNING internal_id`,
      passportParams
    )
    // The RETURNING order matches the INSERT order (Postgres guarantee), so
    // zip back to batch[i] → minted[i]
    const aliasValues = batch.map((_, j) => {
      const b = j * 4
      return `($${b+1},$${b+2},$${b+3},$${b+4})`
    }).join(',')
    const aliasParams = batch.flatMap((p, j) => [
      minted[j].internal_id, p.store, p.product_id, p.name,
    ])
    await pool.query(
      `INSERT INTO product_aliases (internal_id, store, vendor_id, vendor_name)
       VALUES ${aliasValues}
       ON CONFLICT (store, vendor_id) DO NOTHING`,
      aliasParams
    )
    batch.forEach((p, j) => aliasMap.set(`${p.store}_${p.product_id}`, minted[j].internal_id))
  }

  // For existing aliases: bump last_seen + refresh canonical metadata in case
  // the retailer changed the product page since first scrape.
  if (existing.length) {
    const ids = existing.map(p => aliasMap.get(`${p.store}_${p.product_id}`))
    await pool.query(
      `UPDATE product_aliases
          SET last_seen = CURRENT_DATE, active = TRUE
        WHERE internal_id = ANY($1::uuid[])`,
      [ids]
    )
    await pool.query(
      `UPDATE products_v2
          SET last_seen = CURRENT_DATE
        WHERE internal_id = ANY($1::uuid[])`,
      [ids]
    )
  }

  return aliasMap
}

async function shadowInsertPriceHistoryV2(prices) {
  if (!SHADOW_WRITE_V2 || !prices.length) return

  // Resolve all (store, vendor_id) → internal_id from product_aliases.
  // Anything missing means upsertProducts wasn't called first (shouldn't
  // happen) or the scraper sent a price for a product not in its own
  // products list (data bug). Silent skip rather than crash.
  const stores = prices.map(p => p.store)
  const vendorIds = prices.map(p => p.product_id)
  const { rows } = await pool.query(
    `SELECT pa.store, pa.vendor_id, pa.internal_id
       FROM product_aliases pa
       JOIN UNNEST($1::text[], $2::text[]) AS k(store, vendor_id)
         ON pa.store = k.store AND pa.vendor_id = k.vendor_id`,
    [stores, vendorIds]
  )
  const map = new Map()
  for (const r of rows) map.set(`${r.store}_${r.vendor_id}`, r.internal_id)

  // Mirror the existing change-only filter so v2 has identical density to v1.
  // This keeps Option B semantics intact during the dual-write period.
  const resolved = prices.flatMap(p => {
    const internal_id = map.get(`${p.store}_${p.product_id}`)
    return internal_id ? [{ ...p, internal_id }] : []
  })
  if (!resolved.length) return

  const ids = resolved.map(p => p.internal_id)
  const storeArr = resolved.map(p => p.store)
  const { rows: lastRows } = await pool.query(
    `SELECT DISTINCT ON (internal_id, store) internal_id, store, price
       FROM price_history_v2
       WHERE (internal_id, store) IN (
         SELECT * FROM UNNEST($1::uuid[], $2::text[])
       )
       ORDER BY internal_id, store, scraped_at DESC`,
    [ids, storeArr]
  )
  const lastByKey = new Map()
  for (const r of lastRows) lastByKey.set(`${r.internal_id}_${r.store}`, parseFloat(r.price))

  let badPriceCount = 0
  const changed = resolved.filter(p => {
    // CHECK (price > 0) constraint on price_history_v2 — one bad row poisons
    // the whole batch INSERT (entire page's writes rolled back). Drop here so
    // shadow-write keeps v2 density aligned with v1.
    if (!p.price || parseFloat(p.price) <= 0) { badPriceCount++; return false }
    const last = lastByKey.get(`${p.internal_id}_${p.store}`)
    return last === undefined || last !== parseFloat(p.price)
  })
  const unchanged = resolved.length - changed.length - badPriceCount
  if (badPriceCount > 0) console.log(`  [shadow-v2] skipped ${badPriceCount} rows with price <= 0`)
  if (unchanged > 0) console.log(`  [shadow-v2] ${unchanged} unchanged (price same as last v2 write)`)
  if (changed.length > 0) console.log(`  [shadow-v2] writing ${changed.length} price changes`)
  if (!changed.length) return

  // 5 placeholders per row (internal_id, store, price, was_price, is_on_special)
  // — scraped_at defaults to NOW() at INSERT time. 5 × 12000 = 60000, under
  // the 65535 placeholder cap.
  for (let i = 0; i < changed.length; i += 12000) {
    const batch = changed.slice(i, i + 12000)
    const values = batch.map((_, j) => {
      const b = j * 5
      return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5})`
    }).join(',')
    const params = batch.flatMap(p => [
      p.internal_id, p.store, p.price, p.was_price || null, p.is_on_special || false,
    ])
    await pool.query(
      `INSERT INTO price_history_v2 (internal_id, store, price, was_price, is_on_special)
       VALUES ${values}
       ON CONFLICT (internal_id, store, (scraped_at::date))
       DO UPDATE SET
         price = EXCLUDED.price,
         was_price = EXCLUDED.was_price,
         is_on_special = EXCLUDED.is_on_special`,
      params
    )
  }
}

// Wrap the existing upsertProducts / insertPriceChanges so shadow writes run
// automatically after the v1 path completes. Scrapers don't need to change.
const _upsertProductsV1 = upsertProducts
async function upsertProductsWrapped(products) {
  await _upsertProductsV1(products)
  if (SHADOW_WRITE_V2) {
    try { await shadowUpsertProductsV2(products) }
    catch (e) { console.warn(`  [shadow-v2 upsert] ${e.message}`) }
  }
}

const _insertPriceChangesV1 = insertPriceChanges
async function insertPriceChangesWrapped(prices) {
  const changed = await _insertPriceChangesV1(prices)
  if (SHADOW_WRITE_V2) {
    try { await shadowInsertPriceHistoryV2(prices) }
    catch (e) { console.warn(`  [shadow-v2 price] ${e.message}`) }
  }
  return changed
}

async function close() { await pool.end() }

module.exports = {
  pool, // shared Pool — see Phase 3 consolidation 2026-05-29
  upsertProducts: upsertProductsWrapped,
  insertPriceChanges: insertPriceChangesWrapped,
  close,
  normalizeName,
  getStoreProductCount,
  // Exposed for tests + the future cutover commit:
  shadowUpsertProductsV2,
  shadowInsertPriceHistoryV2,
}
