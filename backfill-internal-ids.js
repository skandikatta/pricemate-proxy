#!/usr/bin/env node
// backfill-internal-ids.js
//
// One-time Option C backfill: assigns an internal_id (passport) to every
// existing (store, vendor_id) product, groups cross-store matches under
// shared passports, and re-keys price_history rows into price_history_v2.
//
// Reuses match-products.js Layers 0-3 so the same brand+size+name guards
// that prevented Option B's false-merge bug also gate the backfill grouping.
// That's the key difference from 757caeb (which matched on name alone and
// silently merged 896 unrelated products in Coles).
//
// Run (dry-run, default):
//   DB_HOST=... DB_PASSWORD=... node backfill-internal-ids.js
// Run (commit to DB — apply migration 005 FIRST):
//   DB_HOST=... DB_PASSWORD=... node backfill-internal-ids.js --apply
//
// Idempotency: bails out if products_v2 already has rows. To re-run, TRUNCATE
// products_v2 CASCADE first (which cascades to product_aliases + price_history_v2
// via ON DELETE CASCADE FK).

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { Pool } = require('pg')
const {
  normalize, extractCoreName, extractSize,
  matchLayer0, matchLayer05, matchLayer1, matchLayer2, matchLayer3, matchLayer4,
} = require('./match-products')

const DRY_RUN = !process.argv.includes('--apply')
const STORES = ['coles', 'woolworths', 'aldi']

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432,
  database: process.env.PGDATABASE || 'pricemate',
  user: process.env.PGUSER || 'pricemate',
  password: process.env.DB_PASSWORD,
  max: 5,
})

async function loadAllProducts() {
  const { rows } = await pool.query(
    `SELECT store, product_id, name, brand, size, category, image, barcode, image_phash
     FROM products
     WHERE name IS NOT NULL AND LENGTH(name) > 0`
  )
  const byStore = { coles: [], woolworths: [], aldi: [] }
  for (const r of rows) {
    if (!byStore[r.store]) continue
    byStore[r.store].push({
      ...r,
      normalized: normalize(r.name),
      core: extractCoreName(r.name, r.brand),
      sizeNorm: extractSize(r.name, r.size),
      image_phash: r.image_phash == null ? null : BigInt(r.image_phash),
    })
  }
  return byStore
}

async function assertEmptyV2() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM products_v2')
  if (rows[0].n > 0) {
    throw new Error(
      `products_v2 already has ${rows[0].n} rows. Backfill is one-shot. ` +
      `To re-run: TRUNCATE products_v2 CASCADE; (will cascade to aliases + price_history_v2)`
    )
  }
}

function runMatchers(products) {
  const matched = new Set()
  const mark = (g) => STORES.forEach(s => { if (g[s]) matched.add(`${s}_${g[s]}`) })

  const layer0  = matchLayer0(products);                layer0.forEach(mark)
  const layer05 = matchLayer05(products, matched);      layer05.forEach(mark)
  const layer1  = matchLayer1(products, matched);       layer1.forEach(mark)
  const layer2  = matchLayer2(products, matched);       layer2.forEach(mark)
  const layer3  = matchLayer3(products, matched);       layer3.forEach(mark)
  const layer4  = matchLayer4(products, matched);       layer4.forEach(mark)

  return {
    groups: [...layer0, ...layer05, ...layer1, ...layer2, ...layer3, ...layer4],
    matched,
    counts: {
      layer0: layer0.length, layer05: layer05.length, layer1: layer1.length,
      layer2: layer2.length, layer3: layer3.length, layer4: layer4.length,
    },
  }
}

function findMember(products, group) {
  for (const s of STORES) {
    if (!group[s]) continue
    const p = products[s].find(p => p.product_id === group[s])
    if (p) return { p, store: s }
  }
  return null
}

function planPassports(products, groups, matched) {
  const passports = []  // {internal_id, canonical_name, brand, size, category, image, barcode}
  const aliases = []    // {internal_id, store, vendor_id, vendor_name}

  // One passport per cross-store group
  for (const g of groups) {
    const m = findMember(products, g)
    if (!m) continue
    const internal_id = crypto.randomUUID()
    passports.push({
      internal_id,
      canonical_name: g.display_name || m.p.name,
      brand: m.p.brand || null,
      size: g.size || m.p.size || null,
      category: m.p.category || null,
      image: m.p.image || null,
      barcode: m.p.barcode || null,
    })
    for (const s of STORES) {
      if (!g[s]) continue
      const p = products[s].find(p => p.product_id === g[s])
      aliases.push({
        internal_id, store: s, vendor_id: g[s], vendor_name: p?.name || null,
      })
    }
  }

  // One passport per unmatched product (the long tail — never appears at
  // another store, or didn't match cleanly)
  for (const store of STORES) {
    for (const p of products[store]) {
      if (matched.has(`${store}_${p.product_id}`)) continue
      const internal_id = crypto.randomUUID()
      passports.push({
        internal_id,
        canonical_name: p.name,
        brand: p.brand || null,
        size: p.size || null,
        category: p.category || null,
        image: p.image || null,
        barcode: p.barcode || null,
      })
      aliases.push({
        internal_id, store, vendor_id: p.product_id, vendor_name: p.name,
      })
    }
  }

  return { passports, aliases }
}

function writeAuditFile(plan, matchCounts) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const file = path.join(__dirname, `backfill-audit-${ts}.json`)
  const sample = plan.passports.slice(0, 200).map(p => ({
    internal_id: p.internal_id,
    canonical_name: p.canonical_name,
    brand: p.brand,
    size: p.size,
    aliases: plan.aliases
      .filter(a => a.internal_id === p.internal_id)
      .map(a => ({ store: a.store, vendor_id: a.vendor_id, vendor_name: a.vendor_name })),
  }))
  // Highlight any multi-alias passports (cross-store or within-store merges)
  // up-front so spot-checking the merge groups is easy
  sample.sort((a, b) => b.aliases.length - a.aliases.length)
  fs.writeFileSync(file, JSON.stringify({
    generated_at: new Date().toISOString(),
    dry_run: DRY_RUN,
    match_counts: matchCounts,
    total_passports: plan.passports.length,
    total_aliases: plan.aliases.length,
    merged_passports_sample_top200: sample,
  }, null, 2))
  return file
}

const BATCH = 1000

async function applyPassports(passports) {
  for (let i = 0; i < passports.length; i += BATCH) {
    const batch = passports.slice(i, i + BATCH)
    const values = batch.map((_, j) => {
      const b = j * 7
      return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7})`
    }).join(',')
    const params = batch.flatMap(p => [
      p.internal_id, p.canonical_name, p.brand, p.size, p.category, p.image, p.barcode,
    ])
    await pool.query(
      `INSERT INTO products_v2 (internal_id, canonical_name, brand, size, category, image, barcode)
       VALUES ${values}`,
      params
    )
  }
}

async function applyAliases(aliases) {
  for (let i = 0; i < aliases.length; i += BATCH) {
    const batch = aliases.slice(i, i + BATCH)
    const values = batch.map((_, j) => {
      const b = j * 4
      return `($${b+1},$${b+2},$${b+3},$${b+4})`
    }).join(',')
    const params = batch.flatMap(a => [a.internal_id, a.store, a.vendor_id, a.vendor_name])
    await pool.query(
      `INSERT INTO product_aliases (internal_id, store, vendor_id, vendor_name)
       VALUES ${values}
       ON CONFLICT (store, vendor_id) DO NOTHING`,
      params
    )
  }
}

async function copyPriceHistory() {
  // Set-based re-key from old price_history to price_history_v2 via aliases.
  // Day-granular ON CONFLICT collapses any (store, vendor_id)-keyed dupes
  // that happen to share a date — the new schema's invariant is one row per
  // (internal_id, store, day).
  const { rowCount } = await pool.query(
    `INSERT INTO price_history_v2 (internal_id, store, scraped_at, price, was_price, is_on_special)
     SELECT pa.internal_id, ph.store, ph.scraped_at, ph.price, ph.was_price, ph.is_on_special
       FROM price_history ph
       JOIN product_aliases pa
         ON pa.store = ph.store AND pa.vendor_id = ph.product_id
     ON CONFLICT (internal_id, store, (scraped_at::date)) DO NOTHING`
  )
  return rowCount
}

async function main() {
  console.log(`=== Option C backfill ${DRY_RUN ? '[DRY-RUN]' : '[APPLY]'} ===`)

  if (!DRY_RUN) await assertEmptyV2()

  const products = await loadAllProducts()
  const total = STORES.reduce((acc, s) => acc + products[s].length, 0)
  console.log(`Loaded ${total} products (${products.coles.length} coles, ${products.woolworths.length} woolies, ${products.aldi.length} aldi)`)

  const { groups, matched, counts } = runMatchers(products)
  console.log(`Cross-store groups: ${groups.length}`)
  console.log(`  Layer 0 (barcode EAN):   ${counts.layer0}`)
  console.log(`  Layer 0.5 (image pHash): ${counts.layer05}`)
  console.log(`  Layer 1 (exact):         ${counts.layer1}`)
  console.log(`  Layer 2 (Levenshtein):   ${counts.layer2}`)
  console.log(`  Layer 3 (token-sort):    ${counts.layer3}`)
  console.log(`  Layer 4 (Aldi house):    ${counts.layer4}`)

  const plan = planPassports(products, groups, matched)
  console.log(`Plan: ${plan.passports.length} passports, ${plan.aliases.length} aliases`)

  const audit = writeAuditFile(plan, counts)
  console.log(`Audit file: ${audit}`)

  if (DRY_RUN) {
    console.log('\nDRY-RUN — no DB writes. Review audit file then re-run with --apply.')
    return
  }

  console.log('\nApplying to DB...')
  await applyPassports(plan.passports)
  console.log(`  ✓ ${plan.passports.length} passports written`)
  await applyAliases(plan.aliases)
  console.log(`  ✓ ${plan.aliases.length} aliases written`)
  const copied = await copyPriceHistory()
  console.log(`  ✓ ${copied} price_history rows copied to price_history_v2`)
  console.log('\nDone. Verify with:')
  console.log("  SELECT COUNT(*) FROM products_v2;")
  console.log("  SELECT COUNT(*) FROM product_aliases;")
  console.log("  SELECT COUNT(*) FROM price_history_v2;")
  console.log("  SELECT internal_id, COUNT(*) FROM product_aliases GROUP BY internal_id HAVING COUNT(*) > 1 LIMIT 20;")
}

// Exported for tests. When this file is the main module (run directly), kick
// off the backfill; when required by tests, just expose the pure functions.
if (require.main === module) {
  main()
    .then(() => pool.end())
    .catch(e => {
      console.error('FAILED:', e.message)
      console.error(e.stack)
      pool.end()
      process.exit(1)
    })
}

module.exports = { runMatchers, planPassports, findMember }
