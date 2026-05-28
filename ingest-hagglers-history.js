#!/usr/bin/env node
// ingest-hagglers-history.js — multi-strategy matcher
//
// One-shot ingest of competitor (Hagglers) daily price history into our
// price_history_v2, attached to the correct internal_id via product_aliases.
//
// MATCHING STRATEGIES (run in priority order — first hit wins; subsequent
// strategies skip products already matched).
//
//   S1 — exact normalized name. Hagglers's "INNER GOODNESS Regular Soy Milk 1L"
//        against our synthesized "INNER GOODNESS Regular Soy Milk 1L"
//        (brand + name normalized). Catches the "Hagglers keeps brand inline,
//        we keep brand in a separate column" pattern cleanly.
//
//   S2 — token-sort ≥ 0.85 inside (store, sizeNorm) bucket. Strict brand veto.
//
//   S3 — token-sort ≥ 0.78 inside (store, sizeNorm) bucket. STRICT brand check
//        (our brand token MUST appear in Hagglers's name).
//
//   S4 — partial-name containment. Hagglers's core appears as substring in
//        our core (or vice versa) + sizeNorm match + strict brand check.
//
//   S5 — token-sort ≥ 0.65 + sizeNorm match + STRICT brand check + extra
//        guard: both sides' first significant token must agree.
//
//   S6 — sizeless Coles disambiguation. For Hagglers Coles items lacking a
//        sizeNorm: find candidates by (store, core) text-overlap, then pick
//        if EXACTLY ONE candidate's latest price equals Hagglers's latest
//        price (±5c). Conservative — only one-of-one wins.
//
// ZERO false-merge goal: every threshold drop is paired with a tighter brand
// check. Audit JSON shows per-strategy counts so we can spot pollution.

const fs = require('fs')
const path = require('path')
const {
  normalize, extractCoreName, extractSize, tokenSortRatio,
} = require('./match-products')

const STORE_BRANDS = new Set([
  'coles', 'woolworths', 'aldi',
  'woolworths free from', 'woolworths essentials', 'woolworths macro',
  'coles simply', 'coles finest', "coles nature's kitchen",
])

const args = process.argv.slice(2)
const APPLY = args.includes('--apply')
const STORE_FILTER = args.includes('--store') ? args[args.indexOf('--store') + 1] : null
const dataFile = args.find(a => /\.json$/.test(a)) || 'hagglers-data.json'
const { pool } = require('./db')
// Tokens that can't be the start of a brand. Used by reExtractBrand and the
// strictBrandCheck.
const STOPWORDS = new Set([
  'organic', 'natural', 'fresh', 'free', 'range', 'fat', 'cream', 'low',
  'lite', 'light', 'whole', 'sliced', 'diced', 'mini', 'large', 'small',
  'medium', 'extra', 'premium', 'sweet', 'salted', 'unsalted', 'instant',
  'frozen', 'chilled', 'cold', 'hot', 'long', 'life', 'liquid', 'creamy',
  'thick', 'thin', 'plain', 'crunchy', 'smooth', 'classic', 'original',
  'real', 'pure', 'tasty', 'best', 'simply', 'with', 'and', 'the',
])

// ─── Hagglers brand re-extraction ────────────────────────────────────────────
function reExtractBrand(name) {
  if (!name) return null
  const tokens = name.trim().split(/\s+/)
  if (tokens.length < 2) return null
  for (const n of [2, 1]) {
    if (tokens.length <= n) continue
    const tokensLower = tokens.slice(0, n).map(t => t.toLowerCase())
    const ok =
      tokensLower.every(t => /^[a-z][a-z0-9'&-]*$/i.test(t)) &&
      tokensLower.every(t => !STOPWORDS.has(t)) &&
      tokens.slice(0, n).every(t => /^[A-Z]/.test(t))
    if (ok) return tokens.slice(0, n).join(' ')
  }
  return null
}

// ─── Strict brand check ─────────────────────────────────────────────────────
// Required by S3, S4, S5. Either:
//   (a) Our brand's significant first-token appears in Hagglers's normalized name, OR
//   (b) Hagglers's re-extracted brand appears in our normalized name + brand-norm
// At least one direction must hold. Brands that look like generic product words
// don't qualify (returns true to allow fall-through — the next layer's check
// will be stricter).
function strictBrandCheck(item, candidate, reBrandNorm) {
  const haggNameNorm = (item.name || '').toLowerCase()
  const ourBrandNorm = candidate.brandNorm || ''
  const ourNameNorm = (candidate.name || '').toLowerCase()

  if (!ourBrandNorm && !reBrandNorm) return true  // neither side has a brand → skip check

  // Direction A: our brand token in Hagglers's name
  if (ourBrandNorm) {
    const firstToken = ourBrandNorm.split(/\s+/).find(t => !STOPWORDS.has(t) && t.length >= 3)
    if (firstToken && haggNameNorm.includes(firstToken)) return true
    // Store-brand carve-out — our brand IS the store, allow if no other named brand in Hagglers
    if (STORE_BRANDS.has(ourBrandNorm)) {
      // No competing brand prefix detected in Hagglers's name → accept
      const haggFirstToken = haggNameNorm.split(/\s+/).find(t => !STOPWORDS.has(t) && t.length >= 3)
      if (!haggFirstToken || !/^[a-z]/.test(haggFirstToken)) return true
      // If Hagglers's first significant token doesn't look like a brand name, accept
      // (the reExtractBrand returning null means Hagglers didn't see a brand either)
      if (!reBrandNorm) return true
    }
  }

  // Direction B: Hagglers's re-extracted brand in our name+brand
  if (reBrandNorm) {
    const haggFirstToken = reBrandNorm.split(/\s+/).find(t => !STOPWORDS.has(t) && t.length >= 3)
    if (haggFirstToken && (ourNameNorm.includes(haggFirstToken) || ourBrandNorm.includes(haggFirstToken))) {
      return true
    }
  }

  return false
}

// ─── Date label → ISO ───────────────────────────────────────────────────────
function parseDateLabel(label, refYear = 2026) {
  const m = label.match(/^([A-Za-z]{3})\s+(\d{1,2})$/)
  if (!m) return null
  const months = { Jan:1, Feb:2, Mar:3, Apr:4, May:5, Jun:6, Jul:7, Aug:8, Sep:9, Oct:10, Nov:11, Dec:12 }
  const mo = months[m[1]]; const d = parseInt(m[2], 10)
  if (!mo || !d) return null
  return `${refYear}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

// ─── Load catalog into rich lookup structures ───────────────────────────────
async function loadOurCatalog() {
  const { rows } = await pool.query(
    `SELECT p.store, p.product_id, p.name, p.brand, p.size,
            pa.internal_id,
            (SELECT price FROM price_history ph
              WHERE ph.store = p.store AND ph.product_id = p.product_id
              ORDER BY ph.scraped_at DESC LIMIT 1) AS latest_price
       FROM products p
       JOIN product_aliases pa
         ON pa.store = p.store AND pa.vendor_id = p.product_id
      WHERE p.name IS NOT NULL AND LENGTH(p.name) > 0`
  )

  const sizedBuckets = new Map()      // (store|sizeNorm) → [candidates]
  const sizelessBuckets = new Map()   // (store) → [candidates with no sizeNorm]
  const exactFullNameIndex = new Map() // (store|normalize(brand+name+size)) → candidate
  const normNameIndex = new Map()     // (store|normalize(name)) → [candidates]

  for (const r of rows) {
    const core = extractCoreName(r.name, r.brand)
    const sizeNorm = extractSize(r.name, r.size)
    const brandNorm = (r.brand || '').toLowerCase().trim()
    const synthFull = normalize([r.brand, r.name, r.size].filter(Boolean).join(' '))
    const nameNorm = normalize(r.name)

    const c = {
      store: r.store, product_id: r.product_id, internal_id: r.internal_id,
      name: r.name, brand: r.brand, brandNorm, core, sizeNorm,
      synthFull, nameNorm, latest_price: r.latest_price ? parseFloat(r.latest_price) : null,
    }

    if (sizeNorm) {
      const k = `${r.store}|${sizeNorm}`
      if (!sizedBuckets.has(k)) sizedBuckets.set(k, [])
      sizedBuckets.get(k).push(c)
    } else {
      const k = r.store
      if (!sizelessBuckets.has(k)) sizelessBuckets.set(k, [])
      sizelessBuckets.get(k).push(c)
    }

    if (synthFull) {
      const k = `${r.store}|${synthFull}`
      if (!exactFullNameIndex.has(k)) exactFullNameIndex.set(k, c)
    }
    const nk = `${r.store}|${nameNorm}`
    if (!normNameIndex.has(nk)) normNameIndex.set(nk, [])
    normNameIndex.get(nk).push(c)
  }
  return { sizedBuckets, sizelessBuckets, exactFullNameIndex, normNameIndex }
}

// ─── 5-strategy matcher ─────────────────────────────────────────────────────
function matchOne(item, cat, claimed) {
  const store = item.store
  const reBrand = reExtractBrand(item.name)
  const reBrandNorm = reBrand ? reBrand.toLowerCase().trim() : ''
  const sizeNorm = extractSize(item.name, item.size)
  const core = extractCoreName(item.name, reBrand)
  const haggNameNorm = normalize(item.name)
  const haggLatestPrice = item.prices?.[item.prices.length - 1] ?? null

  const isClaimed = (c) => claimed.has(`${c.store}_${c.product_id}`)

  // ── S1: exact normalized full-name match ──────────────────────────────────
  const synthKey = `${store}|${haggNameNorm}`
  const directMatch = cat.exactFullNameIndex.get(synthKey)
  if (directMatch && !isClaimed(directMatch)) {
    return { match: directMatch, strategy: 'S1-exact', score: 1.00, sizeNorm, core, reBrand }
  }

  // ── S2-S5: sized matching with progressive thresholds ─────────────────────
  if (sizeNorm && core && core.length >= 5) {
    const candidates = (cat.sizedBuckets.get(`${store}|${sizeNorm}`) || []).filter(c => !isClaimed(c))

    // S2: token-sort >= 0.85 with brand veto (existing behaviour)
    {
      let best = null, bestScore = 0
      for (const c of candidates) {
        if (reBrandNorm && c.brandNorm && reBrandNorm !== c.brandNorm) {
          const both = STORE_BRANDS.has(reBrandNorm) && STORE_BRANDS.has(c.brandNorm)
          if (!both) continue
        }
        const s = tokenSortRatio(core, c.core)
        if (s > bestScore) { best = c; bestScore = s }
      }
      if (best && bestScore >= 0.85) {
        return { match: best, strategy: 'S2-tokensort-085', score: bestScore, sizeNorm, core, reBrand }
      }
    }

    // S3, S4, S5 (sub-0.85 token-sort + partial-containment) DISABLED 2026-05-28.
    // Audit on full prod data found 30-50% false-merge rate at these thresholds
    // (e.g. Vitasoy Almond ↔ Vitasoy Soy; Westgold Unsalted ↔ Westgold Salted;
    // generic "Full Cream Milk 1L" ↔ The Little Big Dairy Company FCM).
    //
    // Token-sort can't tell apart products whose differentiator word is short
    // (almond/soy/oat differ by ≤3 chars but represent fundamentally different
    // products). Until we encode mutually-exclusive variant sets per category,
    // S3-S5 are unsafe. Audit evidence in ingest-hagglers-audit-2026-05-27T23-40-32-458Z.json.
  }

  // ── S6: sizeless price-disambiguation for Coles ───────────────────────────
  // Only triggers when:
  //   - Hagglers's item has no sizeNorm
  //   - There's EXACTLY ONE catalog candidate in same store whose nameNorm shares
  //     the core text AND whose latest price equals Hagglers's latest price ±5c
  if (!sizeNorm && haggLatestPrice != null && (cat.sizelessBuckets.size || cat.sizedBuckets.size)) {
    const allCandidates = []
    // Look across BOTH sized + sizeless catalog (the sized ones are where Coles items live)
    for (const [k, arr] of cat.sizedBuckets) {
      if (!k.startsWith(`${store}|`)) continue
      for (const c of arr) if (!isClaimed(c)) allCandidates.push(c)
    }
    for (const arr of [cat.sizelessBuckets.get(store) || []]) {
      for (const c of arr) if (!isClaimed(c)) allCandidates.push(c)
    }

    // Narrow by core text overlap (Hagglers core must be substring of ours, or vice versa)
    const narrowed = []
    for (const c of allCandidates) {
      if (core.length >= 8 && (c.nameNorm.includes(core) || c.core === core)) {
        if (!strictBrandCheck(item, c, reBrandNorm)) continue
        // Price disambiguation: candidate's latest_price must match Hagglers's latest
        if (c.latest_price != null && Math.abs(c.latest_price - haggLatestPrice) <= 0.05) {
          narrowed.push(c)
        }
      }
    }
    if (narrowed.length === 1) {
      return {
        match: narrowed[0], strategy: 'S6-sizeless-priceuniq', score: 0.95,
        sizeNorm: null, core, reBrand,
      }
    }
    if (narrowed.length === 0) {
      return { match: null, reason: 'S6: no name-overlap + price-match candidate' }
    }
    return { match: null, reason: `S6: ${narrowed.length} ambiguous candidates (same price+name)` }
  }

  return { match: null, reason: 'no sizeNorm and not Coles sizeless / no strategy match' }
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
  console.log(`=== ingest-hagglers-history (5-strategy) ${APPLY ? '[APPLY]' : '[DRY-RUN]'} ===`)
  console.log(`Loading ${dataFile}...`)
  const raw = fs.readFileSync(dataFile, 'utf8')
  let hagglers = JSON.parse(raw)
  console.log(`  ${hagglers.length} Hagglers items in file`)
  if (STORE_FILTER) {
    hagglers = hagglers.filter(h => h.store === STORE_FILTER)
    console.log(`  ${hagglers.length} after --store ${STORE_FILTER} filter`)
  }

  console.log('Loading our catalog + aliases + latest prices...')
  const cat = await loadOurCatalog()
  const sizedTotal = [...cat.sizedBuckets.values()].reduce((a, b) => a + b.length, 0)
  const sizelessTotal = [...cat.sizelessBuckets.values()].reduce((a, b) => a + b.length, 0)
  console.log(`  ${sizedTotal} sized + ${sizelessTotal} sizeless of our products indexed`)
  console.log(`  ${cat.exactFullNameIndex.size} exact full-name keys`)

  console.log('Matching (5 strategies, first-hit-wins)...')
  const claimed = new Set()  // tracks our products already matched, prevents double-matching
  const matches = []
  const unmatched = []
  const strategyCounts = {}

  for (const item of hagglers) {
    const result = matchOne(item, cat, claimed)
    if (result.match) {
      matches.push({ hagglers: item, ...result })
      claimed.add(`${result.match.store}_${result.match.product_id}`)
      strategyCounts[result.strategy] = (strategyCounts[result.strategy] || 0) + 1
    } else {
      unmatched.push({ hagglers: item, reason: result.reason })
    }
  }

  console.log(`  ${matches.length} matched (${(100 * matches.length / hagglers.length).toFixed(1)}%)`)
  console.log(`  ${unmatched.length} unmatched`)
  console.log('  per-strategy:')
  for (const [k, v] of Object.entries(strategyCounts).sort()) console.log(`    ${k}: ${v}`)

  const byStore = {}
  for (const m of matches) (byStore[m.hagglers.store] ||= { m:0, u:0 }).m++
  for (const u of unmatched) (byStore[u.hagglers.store] ||= { m:0, u:0 }).u++
  console.log('  per-store:')
  for (const [s, c] of Object.entries(byStore)) {
    console.log(`    ${s}: ${c.m}/${c.m + c.u} (${(100*c.m/(c.m+c.u)).toFixed(1)}%)`)
  }

  // History row count
  let totalRows = 0
  for (const m of matches) totalRows += (m.hagglers.prices || []).length
  console.log(`  ${totalRows} candidate price_history_v2 rows to insert`)

  // Audit JSON
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const auditPath = path.join(path.dirname(dataFile), `ingest-hagglers-audit-${ts}.json`)
  const byStrategy = {}
  for (const m of matches) {
    if (!byStrategy[m.strategy]) byStrategy[m.strategy] = []
    byStrategy[m.strategy].push(m)
  }
  const sampleByStrategy = {}
  for (const [strat, arr] of Object.entries(byStrategy)) {
    sampleByStrategy[strat] = arr.slice(0, 20).map(m => ({
      score: m.score?.toFixed?.(2) || m.score,
      hagglers_name: m.hagglers.name,
      our_name: m.match.name,
      our_brand: m.match.brand,
      store: m.hagglers.store,
      sizeNorm: m.sizeNorm,
      our_internal_id: m.match.internal_id,
      our_vendor_id: m.match.product_id,
      history_rows: m.hagglers.prices.length,
    }))
  }
  fs.writeFileSync(auditPath, JSON.stringify({
    generated_at: new Date().toISOString(),
    dry_run: !APPLY,
    totals: {
      hagglers_items: hagglers.length, matched: matches.length, unmatched: unmatched.length,
      candidate_history_rows: totalRows,
    },
    per_strategy: strategyCounts,
    per_store: byStore,
    samples_per_strategy_first_20: sampleByStrategy,
    unmatched_sample_50: unmatched.slice(0, 50).map(u => ({
      hagglers_name: u.hagglers.name, store: u.hagglers.store, reason: u.reason,
    })),
  }, null, 2))
  console.log(`\nAudit: ${auditPath}`)

  if (!APPLY) {
    console.log('\nDRY-RUN — inspect audit then re-run with --apply.')
    return
  }

  // INSERT
  console.log('\nInserting price_history_v2 rows...')
  const REF_YEAR = 2026
  const BATCH = 5000
  let inserted = 0, skipped = 0
  const pending = []
  for (const m of matches) {
    const { hagglers, match } = m
    for (let i = 0; i < hagglers.dates.length; i++) {
      const date = parseDateLabel(hagglers.dates[i], REF_YEAR)
      const price = hagglers.prices[i]
      if (!date || price == null || price <= 0) { skipped++; continue }
      pending.push({ internal_id: match.internal_id, store: match.store, scraped_at: date, price })
    }
  }
  console.log(`  ${pending.length} rows queued (skipped ${skipped} bad)`)

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
    if (i % 50000 === 0 && i > 0) console.log(`  ${i + batch.length}/${pending.length}  inserted=${inserted}`)
  }
  console.log(`\n✓ DONE. ${inserted} new rows in price_history_v2 (${pending.length - inserted} were duplicates).`)
}

main()
  .then(() => pool.end())
  .catch(e => { console.error('FAILED:', e.message); console.error(e.stack); pool.end(); process.exit(1) })
