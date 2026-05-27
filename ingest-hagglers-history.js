#!/usr/bin/env node
// ingest-hagglers-history.js
//
// One-shot ingest of competitor (Hagglers) daily price history into our
// price_history_v2, attached to the correct internal_id via our existing
// product_aliases.
//
// Hagglers's daily series (median 32 days / max 67 days per product) gives
// our cycle-detector enough density to predict on products that currently
// have <7 sparse change-event rows.
//
// SAFETY: matches use the SAME audit-class guards as match-products.js:
//   - re-extract brand+size from Hagglers `name` (their `brand` field is
//     94% garbage — usually just the first words of the name)
//   - require sizeNorm match (no size-blind merging)
//   - require token-sort ratio ≥ 0.85 on core (high confidence threshold)
//   - brand veto: when both sides parse a brand AND they differ AND neither
//     side is a store-brand, REJECT (prevents Pauls Zymil ↔ Coles brand
//     class of false-merges)
//   - INSERT ON CONFLICT DO NOTHING — never overwrites existing v2 rows
//
// Run (dry-run, default — writes audit JSON, no DB writes):
//   DB_HOST=localhost DB_PASSWORD=... node ingest-hagglers-history.js hagglers-data.json
//
// Run (commit to DB after audit looks clean):
//   DB_HOST=localhost DB_PASSWORD=... node ingest-hagglers-history.js hagglers-data.json --apply
//
// Idempotent: re-running just re-inserts; unique index drops duplicates.

const fs = require('fs')
const path = require('path')
const { Pool } = require('pg')
const {
  normalize, extractCoreName, extractSize,
  tokenSortRatio,
} = require('./match-products')

const TOKEN_THRESHOLD = 0.85
const STORE_BRANDS = new Set([
  'coles', 'woolworths', 'aldi',
  'woolworths free from', 'woolworths essentials', 'woolworths macro',
  'coles simply', 'coles finest', "coles nature's kitchen",
])

const args = process.argv.slice(2)
const APPLY = args.includes('--apply')
const dataFile = args.find(a => !a.startsWith('--')) || 'hagglers-data.json'

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432,
  database: process.env.PGDATABASE || 'pricemate',
  user: process.env.PGUSER || 'pricemate',
  password: process.env.DB_PASSWORD,
  max: 5,
})

// ─── Brand re-extraction (Hagglers's brand field is unreliable) ─────────────
// Strategy: split the name into tokens; if the first 1-3 tokens look like a
// brand prefix (Title-Case, not a common product word), treat that as the
// brand. Conservative — returns null if uncertain rather than guessing.
const PRODUCT_WORDS = new Set([
  'organic', 'natural', 'fresh', 'free', 'range', 'fat', 'cream', 'low',
  'lite', 'light', 'whole', 'sliced', 'diced', 'mini', 'large', 'small',
  'medium', 'extra', 'premium', 'sweet', 'salted', 'unsalted', 'instant',
  'frozen', 'chilled', 'cold', 'hot', 'long', 'life', 'fresh', 'liquid',
  'creamy', 'thick', 'thin', 'plain', 'crunchy', 'smooth', 'classic',
  'original', 'real', 'pure', 'tasty', 'best', 'simply',
])
function reExtractBrand(name) {
  if (!name) return null
  const tokens = name.trim().split(/\s+/)
  if (tokens.length < 2) return null
  // Try first 2 tokens, then first 1 token, as candidate brand prefixes
  for (const n of [2, 1]) {
    if (tokens.length <= n) continue
    const prefix = tokens.slice(0, n).join(' ')
    const tokensLower = tokens.slice(0, n).map(t => t.toLowerCase())
    const looksBrand =
      tokensLower.every(t => /^[a-z][a-z0-9'&-]*$/i.test(t)) &&
      tokensLower.every(t => !PRODUCT_WORDS.has(t)) &&
      tokens.slice(0, n).every(t => /^[A-Z]/.test(t))
    if (looksBrand) return prefix
  }
  return null
}

// Date label → ISO string. Assumes current year (data is recent).
function parseDateLabel(label, refYear = 2026) {
  const m = label.match(/^([A-Za-z]{3})\s+(\d{1,2})$/)
  if (!m) return null
  const months = { Jan:1, Feb:2, Mar:3, Apr:4, May:5, Jun:6, Jul:7, Aug:8, Sep:9, Oct:10, Nov:11, Dec:12 }
  const mo = months[m[1]]
  const d = parseInt(m[2], 10)
  if (!mo || !d) return null
  return `${refYear}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

// ─── Load our catalog into in-memory matching structures ────────────────────
async function loadOurCatalog() {
  const { rows } = await pool.query(
    `SELECT p.store, p.product_id, p.name, p.brand, p.size,
            pa.internal_id
       FROM products p
       JOIN product_aliases pa
         ON pa.store = p.store AND pa.vendor_id = p.product_id
      WHERE p.name IS NOT NULL AND LENGTH(p.name) > 0`
  )
  // Bucket by (store, sizeNorm) for O(1) candidate lookup
  const buckets = new Map() // key: store|sizeNorm → [{ ...row, core, brandNorm }]
  for (const r of rows) {
    const core = extractCoreName(r.name, r.brand)
    const sizeNorm = extractSize(r.name, r.size)
    if (!sizeNorm) continue  // skip sizeless catalog rows — we won't match them
    const key = `${r.store}|${sizeNorm}`
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key).push({
      store: r.store,
      product_id: r.product_id,
      internal_id: r.internal_id,
      name: r.name,
      brand: r.brand,
      brandNorm: (r.brand || '').toLowerCase().trim(),
      core,
      sizeNorm,
    })
  }
  return buckets
}

// ─── Match one Hagglers item to our catalog ─────────────────────────────────
function matchOne(item, buckets) {
  const store = item.store
  const reBrand = reExtractBrand(item.name)
  const reBrandNorm = reBrand ? reBrand.toLowerCase().trim() : ''
  const sizeNorm = extractSize(item.name, item.size)
  const core = extractCoreName(item.name, reBrand)
  if (!sizeNorm || !core || core.length < 5) {
    return { match: null, reason: 'no sizeNorm or core too short' }
  }
  const candidates = buckets.get(`${store}|${sizeNorm}`) || []
  if (!candidates.length) return { match: null, reason: 'no same-store same-size candidates' }

  let best = null, bestScore = 0
  for (const c of candidates) {
    // Brand veto: if both sides have a brand AND they differ AND not both
    // store-brands, reject. Mirrors Layer 3's logic.
    if (reBrandNorm && c.brandNorm && reBrandNorm !== c.brandNorm) {
      const bothStoreBrand = STORE_BRANDS.has(reBrandNorm) && STORE_BRANDS.has(c.brandNorm)
      if (!bothStoreBrand) continue
    }
    const score = tokenSortRatio(core, c.core)
    if (score > bestScore) {
      best = c
      bestScore = score
    }
  }
  if (!best || bestScore < TOKEN_THRESHOLD) {
    return { match: null, reason: `best score ${bestScore.toFixed(2)} < ${TOKEN_THRESHOLD}` }
  }
  return {
    match: best,
    score: bestScore,
    reBrand: reBrand,
    sizeNorm,
    core,
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
  console.log(`=== ingest-hagglers-history ${APPLY ? '[APPLY]' : '[DRY-RUN]'} ===`)
  console.log(`Loading ${dataFile}...`)
  const raw = fs.readFileSync(dataFile, 'utf8')
  const hagglers = JSON.parse(raw)
  console.log(`  ${hagglers.length} Hagglers items`)

  console.log('Loading our catalog + aliases...')
  const buckets = await loadOurCatalog()
  const catalogCount = [...buckets.values()].reduce((a, b) => a + b.length, 0)
  console.log(`  ${catalogCount} of our products (bucketed by store+sizeNorm)`)

  console.log('Matching...')
  const matches = []
  const unmatched = []
  for (const item of hagglers) {
    const result = matchOne(item, buckets)
    if (result.match) {
      matches.push({ hagglers: item, ...result })
    } else {
      unmatched.push({ hagglers: item, reason: result.reason })
    }
  }
  console.log(`  ${matches.length} matched (${(100 * matches.length / hagglers.length).toFixed(1)}%)`)
  console.log(`  ${unmatched.length} unmatched`)

  // Match-rate by store
  const byStore = { coles: { m: 0, u: 0 }, woolworths: { m: 0, u: 0 }, aldi: { m: 0, u: 0 } }
  for (const m of matches) (byStore[m.hagglers.store] ||= { m:0, u:0 }).m++
  for (const u of unmatched) (byStore[u.hagglers.store] ||= { m:0, u:0 }).u++
  console.log('  per-store match rate:')
  for (const [s, c] of Object.entries(byStore)) {
    const total = c.m + c.u
    console.log(`    ${s}: ${c.m}/${total} (${(100*c.m/total).toFixed(1)}%)`)
  }

  // Distribution of token-sort scores
  const scores = matches.map(m => m.score).sort((a, b) => a - b)
  if (scores.length) {
    console.log(`  score distribution: min ${scores[0].toFixed(2)} | p50 ${scores[Math.floor(scores.length*0.5)].toFixed(2)} | p90 ${scores[Math.floor(scores.length*0.9)].toFixed(2)} | max ${scores[scores.length-1].toFixed(2)}`)
  }

  // Total history rows we'd insert
  let totalRows = 0
  for (const m of matches) totalRows += (m.hagglers.prices || []).length
  console.log(`  ${totalRows} candidate price_history_v2 rows to insert`)

  // Write audit JSON: 200 random matches + 50 low-score matches + 50 unmatched
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const auditPath = path.join(path.dirname(dataFile), `ingest-hagglers-audit-${ts}.json`)
  const lowScoreMatches = [...matches].sort((a, b) => a.score - b.score).slice(0, 50)
  const randomMatches = [...matches].sort(() => Math.random() - 0.5).slice(0, 200)
  fs.writeFileSync(auditPath, JSON.stringify({
    generated_at: new Date().toISOString(),
    dry_run: !APPLY,
    totals: {
      hagglers_items: hagglers.length,
      matched: matches.length,
      unmatched: unmatched.length,
      candidate_history_rows: totalRows,
    },
    per_store: byStore,
    score_distribution: scores.length ? {
      min: scores[0], p50: scores[Math.floor(scores.length*0.5)],
      p90: scores[Math.floor(scores.length*0.9)], max: scores[scores.length-1],
    } : null,
    sample_matches_random_200: randomMatches.map(m => ({
      score: m.score.toFixed(2),
      hagglers_name: m.hagglers.name,
      hagglers_brand_raw: m.hagglers.brand,
      hagglers_brand_extracted: m.reBrand,
      our_name: m.match.name,
      our_brand: m.match.brand,
      store: m.hagglers.store,
      sizeNorm: m.sizeNorm,
      core: m.core,
      our_internal_id: m.match.internal_id,
      our_vendor_id: m.match.product_id,
      history_rows: m.hagglers.prices.length,
    })),
    lowest_score_50: lowScoreMatches.map(m => ({
      score: m.score.toFixed(2),
      hagglers_name: m.hagglers.name,
      our_name: m.match.name,
      store: m.hagglers.store,
    })),
    unmatched_sample_50: unmatched.slice(0, 50).map(u => ({
      hagglers_name: u.hagglers.name,
      store: u.hagglers.store,
      reason: u.reason,
    })),
  }, null, 2))
  console.log(`\nAudit written to: ${auditPath}`)

  if (!APPLY) {
    console.log('\nDRY-RUN — no DB writes. Inspect audit JSON, then re-run with --apply.')
    return
  }

  // ─── INSERT history rows ─────────────────────────────────────────────────
  console.log('\nInserting price_history_v2 rows...')
  const REF_YEAR = 2026  // all Hagglers dates are within the past 2 months → 2026
  const BATCH = 5000
  let inserted = 0
  let skipped = 0
  const pending = []  // { internal_id, store, scraped_at(YYYY-MM-DD), price }
  for (const m of matches) {
    const { hagglers, match } = m
    for (let i = 0; i < hagglers.dates.length; i++) {
      const date = parseDateLabel(hagglers.dates[i], REF_YEAR)
      const price = hagglers.prices[i]
      if (!date || price == null || price <= 0) { skipped++; continue }
      pending.push({ internal_id: match.internal_id, store: match.store, scraped_at: date, price })
    }
  }
  console.log(`  Total rows queued: ${pending.length} (skipped ${skipped} bad)`)

  for (let i = 0; i < pending.length; i += BATCH) {
    const batch = pending.slice(i, i + BATCH)
    const values = batch.map((_, j) => {
      const b = j * 4
      return `($${b+1}::uuid, $${b+2}, $${b+3}::timestamp, $${b+4}::numeric(10,2))`
    }).join(',')
    const params = batch.flatMap(r => [r.internal_id, r.store, r.scraped_at, r.price])
    const res = await pool.query(
      `INSERT INTO price_history_v2 (internal_id, store, scraped_at, price)
       VALUES ${values}
       ON CONFLICT (internal_id, store, (scraped_at::date)) DO NOTHING`,
      params
    )
    inserted += res.rowCount
    if (i % 50000 === 0) console.log(`  ${i + batch.length}/${pending.length}  inserted=${inserted}`)
  }
  console.log(`\n✓ DONE. ${inserted} rows inserted into price_history_v2 (${pending.length - inserted} were duplicates or no-op).`)
}

main()
  .then(() => pool.end())
  .catch(e => { console.error('FAILED:', e.message); console.error(e.stack); pool.end(); process.exit(1) })
