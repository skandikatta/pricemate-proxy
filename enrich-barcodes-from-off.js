// enrich-barcodes-from-off.js
//
// Populate `products.barcode` for Coles + Aldi products by matching their
// (brand, name) against Open Food Facts Australia CSV.
//
// Why: Coles/Aldi APIs/HTML don't expose barcode. Without barcodes, Layer 0
// (EAN exact match) in match-products.js produces ZERO cross-store groups.
// Enriching from OFF unlocks high-confidence cross-store matching.
//
// Run: OFF_CSV=/home/ubuntu/off_australia.csv DB_HOST=... DB_PASSWORD=... node enrich-barcodes-from-off.js
//
// Strategy (conservative — false positives are worse than misses here):
//   1. Build OFF index keyed on (normalize(brand), normalize(name)) → barcode
//   2. For each Coles+Aldi product with no barcode, look up by exact key first
//   3. If no exact match, try (brand-only) + fuzzy name (Levenshtein ≤ 2)
//   4. Only UPDATE if the candidate barcode looks like an EAN-13 (13 digits)

const fs = require('fs')
const readline = require('readline')
const { Pool } = require('pg')

const OFF_CSV = process.env.OFF_CSV || '/home/ubuntu/off_australia.csv'
const MIN_NAME_LEN = 6  // skip products with names too short to confidently match

const pool = new Pool({
  host: process.env.DB_HOST,
  port: 5432,
  database: 'pricemate',
  user: 'pricemate',
  password: process.env.DB_PASSWORD,
  max: 4,
})

// Reuse normalization logic from match-products.js (kept local to avoid coupling)
function normalize(s) {
  return (s || '').toLowerCase()
    .replace(/['"‘’“”&,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function levenshtein(a, b) {
  const m = a.length, n = b.length
  if (m === 0) return n
  if (n === 0) return m
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)])
  for (let j = 1; j <= n; j++) d[0][j] = j
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      d[i][j] = a[i-1] === b[j-1] ? d[i-1][j-1] : 1 + Math.min(d[i-1][j], d[i][j-1], d[i-1][j-1])
  return d[m][n]
}

// EAN-13 / EAN-8 sanity check — barcode field in OFF can contain junk.
// For AU products we strongly prefer Australian GS1 prefix (93xxxxxxxxxxx) to
// avoid falsely linking to UK/EU products that happen to share a name.
// Also accept internal/PLU prefix (0-2) only for length-13 codes.
function looksLikeBarcode(code) {
  if (!code) return false
  const digits = code.replace(/\D/g, '')
  if (digits.length < 8 || digits.length > 14) return false
  // Reject obvious foreign GS1 prefixes for safety:
  //   5* = UK/Ireland     7* = Norway/Israel    400-440 = Germany
  //   45*/49* = Japan     30-37 = France        80-83 = Italy
  // Allow: 93* (Australia), 94* (NZ), 0-1* (US/Canada/global), 2* (internal/PLU)
  if (digits.length === 13) {
    const prefix = digits.slice(0, 2)
    if (['50','51','52','53','54','55','56','57','58','59'].includes(prefix)) return false  // UK
    if (['40','41','42','43','44'].includes(prefix)) return false  // Germany
    if (['30','31','32','33','34','35','36','37'].includes(prefix)) return false  // France
    if (['45','49'].includes(prefix)) return false  // Japan
    if (['80','81','82','83'].includes(prefix)) return false  // Italy
    if (['70','71','72','73','74','75','76'].includes(prefix)) return false  // Nordics
  }
  return true
}

async function loadOff() {
  console.log(`Loading OFF CSV: ${OFF_CSV}`)
  const exactMap = new Map()       // 'brand|name' → barcode
  const brandIndex = new Map()      // 'brand' → [{name, barcode}]
  let totalRows = 0, usableRows = 0

  const rl = readline.createInterface({ input: fs.createReadStream(OFF_CSV) })
  let header = null
  for await (const line of rl) {
    if (!header) { header = line.split('\t'); continue }
    totalRows++
    const cols = line.split('\t')
    const code = cols[0]
    const productName = cols[1]
    const brands = cols[2]
    if (!code || !productName || !brands) continue
    if (!looksLikeBarcode(code)) continue

    const normalizedName = normalize(productName)
    if (normalizedName.length < MIN_NAME_LEN) continue

    // OFF brands can be comma-separated multi-brand; index under each
    const brandList = brands.split(',').map(b => normalize(b)).filter(Boolean)
    for (const brand of brandList) {
      const exactKey = `${brand}|${normalizedName}`
      if (!exactMap.has(exactKey)) exactMap.set(exactKey, code)
      if (!brandIndex.has(brand)) brandIndex.set(brand, [])
      brandIndex.get(brand).push({ name: normalizedName, barcode: code })
    }
    usableRows++
  }
  console.log(`  OFF: ${totalRows} rows, ${usableRows} usable, ${exactMap.size} unique (brand|name) keys, ${brandIndex.size} brands`)
  return { exactMap, brandIndex }
}

async function enrich() {
  const { exactMap, brandIndex } = await loadOff()

  // Fetch Coles + Aldi products that don't have a barcode yet
  console.log('\nFetching Coles + Aldi products without barcode...')
  const { rows: targets } = await pool.query(
    `SELECT store, product_id, name, brand FROM products
     WHERE store IN ('coles','aldi') AND barcode IS NULL`
  )
  console.log(`  Targets: ${targets.length}`)

  let exactHits = 0, fuzzyHits = 0, misses = 0
  const updates = []  // { store, product_id, barcode, method }

  for (const p of targets) {
    if (!p.name) { misses++; continue }
    const nName = normalize(p.name)
    if (nName.length < MIN_NAME_LEN) { misses++; continue }
    const nBrand = normalize(p.brand || '')

    // Tier 1: exact (brand, name) match
    if (nBrand) {
      const code = exactMap.get(`${nBrand}|${nName}`)
      if (code) { updates.push({ ...p, barcode: code, method: 'exact' }); exactHits++; continue }
    }

    // Tier 2: brand match + Levenshtein ≤ 2 on name (cheap, only if brand known)
    if (nBrand && brandIndex.has(nBrand)) {
      const candidates = brandIndex.get(nBrand)
      let best = null, bestDist = 3
      for (const c of candidates) {
        const d = levenshtein(c.name, nName)
        if (d < bestDist) { best = c; bestDist = d }
      }
      if (best) { updates.push({ ...p, barcode: best.barcode, method: 'fuzzy', dist: bestDist }); fuzzyHits++; continue }
    }

    misses++
  }

  console.log(`\nMatching summary:`)
  console.log(`  Exact (brand+name):  ${exactHits.toString().padStart(6)}`)
  console.log(`  Fuzzy (brand, ≤2):   ${fuzzyHits.toString().padStart(6)}`)
  console.log(`  Misses:              ${misses.toString().padStart(6)}`)
  console.log(`  Coverage:            ${((exactHits + fuzzyHits) / targets.length * 100).toFixed(1)}%`)

  if (process.env.DRY_RUN === '1') {
    console.log('\nDRY_RUN=1 — not writing any updates.')
    console.log(`Sample matches:`)
    for (const u of updates.slice(0, 10)) {
      console.log(`  [${u.method}${u.dist !== undefined ? ' d='+u.dist : ''}] ${u.store} ${u.product_id} "${u.name}" → ${u.barcode}`)
    }
    return
  }

  // Apply updates in batches
  console.log(`\nApplying ${updates.length} UPDATEs...`)
  const batchSize = 500
  let applied = 0
  for (let i = 0; i < updates.length; i += batchSize) {
    const batch = updates.slice(i, i + batchSize)
    // Use a single multi-statement UPDATE via CASE for speed
    await Promise.all(batch.map(u =>
      pool.query(
        'UPDATE products SET barcode = $1 WHERE store = $2 AND product_id = $3 AND barcode IS NULL',
        [u.barcode, u.store, u.product_id]
      )
    ))
    applied += batch.length
    if (applied % 2000 === 0) console.log(`  ${applied}/${updates.length}`)
  }
  console.log(`  Done. ${applied} products enriched.`)
}

console.log(`OFF barcode enrichment started: ${new Date().toISOString()}`)
enrich()
  .then(() => { console.log(`Done: ${new Date().toISOString()}`); return pool.end() })
  .catch(e => { console.error('ERROR:', e.message, e.stack); pool.end(); process.exit(1) })
