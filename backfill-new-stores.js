#!/usr/bin/env node
// backfill-new-stores.js
//
// Incremental backfill for stores added AFTER the original Option C backfill.
// Mints passports + aliases for products that exist in `products` but have
// no entry in `product_aliases`. Also re-keys their price_history into
// price_history_v2.
//
// Usage:
//   DB_HOST=... DB_PASSWORD=... node backfill-new-stores.js                    # dry-run (default)
//   DB_HOST=... DB_PASSWORD=... node backfill-new-stores.js --apply            # commit to DB
//   DB_HOST=... DB_PASSWORD=... node backfill-new-stores.js --store iga --apply  # single store
//
// Safe to re-run: skips products that already have an alias.

const { pool } = require('./db')

const DRY_RUN = !process.argv.includes('--apply')
const storeFlag = process.argv.find((a, i) => process.argv[i - 1] === '--store')
const STORES = storeFlag ? [storeFlag] : ['iga', 'chemistwarehouse', 'priceline']

async function main() {
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'APPLY'}`)
  console.log(`Stores: ${STORES.join(', ')}\n`)

  for (const store of STORES) {
    // Find products with no alias yet
    const { rows: missing } = await pool.query(
      `SELECT p.store, p.product_id, p.name, p.brand, p.size, p.category, p.image, p.barcode
         FROM products p
         LEFT JOIN product_aliases pa ON pa.store = p.store AND pa.vendor_id = p.product_id
        WHERE p.store = $1 AND pa.internal_id IS NULL AND p.name IS NOT NULL`,
      [store]
    )

    if (missing.length === 0) {
      console.log(`${store}: 0 products need backfill (all have aliases already)`)
      continue
    }
    console.log(`${store}: ${missing.length} products need passports`)

    if (DRY_RUN) continue

    // Mint passports + aliases in batches of 500
    let minted = 0
    for (let i = 0; i < missing.length; i += 500) {
      const batch = missing.slice(i, i + 500)

      // Insert into products_v2, get internal_ids back
      const passportValues = batch.map((_, j) => {
        const b = j * 6
        return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6})`
      }).join(',')
      const passportParams = batch.flatMap(p => [
        p.name, p.brand || null, p.size || null, p.category || null, p.image || null, p.barcode || null,
      ])
      const { rows: ids } = await pool.query(
        `INSERT INTO products_v2 (canonical_name, brand, size, category, image, barcode)
         VALUES ${passportValues} RETURNING internal_id`,
        passportParams
      )

      // Create aliases
      const aliasValues = batch.map((_, j) => {
        const b = j * 4
        return `($${b+1},$${b+2},$${b+3},$${b+4})`
      }).join(',')
      const aliasParams = batch.flatMap((p, j) => [
        ids[j].internal_id, p.store, p.product_id, p.name,
      ])
      await pool.query(
        `INSERT INTO product_aliases (internal_id, store, vendor_id, vendor_name)
         VALUES ${aliasValues} ON CONFLICT (store, vendor_id) DO NOTHING`,
        aliasParams
      )

      minted += batch.length
      if (minted % 2000 === 0 || i + 500 >= missing.length) {
        console.log(`  ${store}: ${minted}/${missing.length} passports minted`)
      }
    }

    // Re-key price_history into price_history_v2
    console.log(`  ${store}: re-keying price_history → price_history_v2...`)
    const { rowCount } = await pool.query(
      `INSERT INTO price_history_v2 (internal_id, store, price, was_price, is_on_special, scraped_at)
       SELECT pa.internal_id, ph.store, ph.price, ph.was_price, ph.is_on_special, ph.scraped_at
         FROM price_history ph
         JOIN product_aliases pa ON pa.store = ph.store AND pa.vendor_id = ph.product_id
        WHERE ph.store = $1
       ON CONFLICT (internal_id, store, (scraped_at::date)) DO NOTHING`,
      [store]
    )
    console.log(`  ${store}: ${rowCount} price_history rows re-keyed to v2`)
    console.log(`  ${store}: DONE ✅\n`)
  }

  if (DRY_RUN) console.log('\nDry run complete. Pass --apply to commit.')
  await pool.end()
}

main().catch(e => { console.error(e); process.exitCode = 1; pool.end() })
