// Product Matching v2 — Multi-layer approach
// Layer 1: Exact brand + size match
// Layer 2: Token-sort fuzzy match (RapidFuzz-style in JS)
// Run: node match-products-v2.js

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://asfnqfhpfufcbjzsrxlz.supabase.co'
const SUPABASE_KEY = process.env.SUPABASE_KEY || ''

// --- NORMALIZATION ---
function normalize(name, brand, size) {
  let n = (name || '').toLowerCase().trim()
  let b = (brand || '').toLowerCase().trim()
  let s = (size || '').toLowerCase().trim()

  // Extract size from name if not in size field (Aldi)
  if (!s) {
    const m = n.match(/(\d+(?:\.\d+)?)\s*(ml|l|g|kg|pk|pack|each)\b/i)
    if (m) { s = m[1] + m[2].replace(/\s/g, ''); n = n.replace(m[0], '').trim() }
  }

  // Normalize size: "325ml" "325mL" "325 ml" → "325ml"
  s = s.replace(/\s+/g, '').replace(/\.0+([a-z])/i, '$1').toLowerCase()

  // Remove brand from name if redundant
  if (b && n.toLowerCase().startsWith(b)) n = n.slice(b.length).trim()

  // Clean name: remove punctuation, extra spaces
  n = n.replace(/[''`]/g, '').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()

  // Create match key: sorted tokens of brand+name+size
  const tokens = `${b} ${n} ${s}`.split(' ').filter(t => t.length > 1).sort()
  const matchKey = tokens.join(' ')

  return { name: n, brand: b, size: s, matchKey, tokens: new Set(tokens) }
}

// --- TOKEN SORT RATIO (like RapidFuzz) ---
function tokenSortRatio(a, b) {
  if (a === b) return 100
  const longer = a.length > b.length ? a : b
  const shorter = a.length > b.length ? b : a
  if (longer.length === 0) return 0

  // Levenshtein distance
  const costs = []
  for (let i = 0; i <= longer.length; i++) {
    let lastVal = i
    for (let j = 0; j <= shorter.length; j++) {
      if (i === 0) { costs[j] = j; continue }
      let newVal = costs[j - 1]
      if (longer[i - 1] !== shorter[j - 1])
        newVal = Math.min(costs[j - 1], lastVal, costs[j]) + 1
      costs[j - 1] = lastVal
      lastVal = newVal
    }
    if (i > 0) costs[shorter.length] = lastVal
  }
  return Math.round((1 - costs[shorter.length] / longer.length) * 100)
}

// --- JACCARD + SIZE MATCH (faster pre-filter) ---
function quickScore(a, b) {
  // Size must match
  if (a.size && b.size && a.size !== b.size) return 0

  // Token overlap (Jaccard)
  let overlap = 0
  for (const t of a.tokens) { if (b.tokens.has(t)) overlap++ }
  const union = new Set([...a.tokens, ...b.tokens]).size
  return union > 0 ? overlap / union : 0
}

// --- FETCH ALL PRODUCTS ---
async function fetchAll(store) {
  const products = []
  let offset = 0
  while (true) {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/products?store=eq.${store}&select=product_id,name,brand,size&order=name&limit=1000&offset=${offset}`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    )
    const batch = await r.json()
    if (!batch.length) break
    products.push(...batch)
    offset += 1000
  }
  return products
}

// --- MAIN ---
async function main() {
  console.log('=== PRODUCT MATCHING v2 ===\n')

  // Load all products
  process.stdout.write('Loading Coles...')
  const coles = await fetchAll('coles')
  process.stdout.write(` ${coles.length}\nLoading Woolworths...`)
  const woolworths = await fetchAll('woolworths')
  process.stdout.write(` ${woolworths.length}\nLoading Aldi...`)
  const aldi = await fetchAll('aldi')
  console.log(` ${aldi.length}\n`)

  // Normalize all
  const colesNorm = coles.map(p => ({ ...p, norm: normalize(p.name, p.brand, p.size) }))
  const wwNorm = woolworths.map(p => ({ ...p, norm: normalize(p.name, p.brand, p.size) }))
  const aldiNorm = aldi.map(p => ({ ...p, norm: normalize(p.name, p.brand, p.size) }))

  // --- LAYER 1: Exact brand+size match ---
  console.log('Layer 1: Exact brand + size match...')
  const wwByKey = new Map()
  for (const p of wwNorm) { if (p.norm.brand && p.norm.size) wwByKey.set(`${p.norm.brand}|${p.norm.size}|${p.norm.name}`, p) }
  const aldiByKey = new Map()
  for (const p of aldiNorm) { if (p.norm.size) aldiByKey.set(`${p.norm.name}|${p.norm.size}`, p) }

  const matches = []
  const matchedWW = new Set()
  const matchedAldi = new Set()
  let layer1 = 0

  for (const c of colesNorm) {
    if (!c.norm.brand || !c.norm.size) continue
    const key = `${c.norm.brand}|${c.norm.size}|${c.norm.name}`
    const ww = wwByKey.get(key)
    if (ww && !matchedWW.has(ww.product_id)) {
      matches.push({ coles_id: c.product_id, woolworths_id: ww.product_id, aldi_id: null, display_name: c.name, size: c.size || c.norm.size, confidence: 100, method: 'exact' })
      matchedWW.add(ww.product_id)
      layer1++
    }
  }
  console.log(`  Layer 1: ${layer1} exact matches\n`)

  // --- LAYER 2: Fuzzy token-sort match ---
  console.log('Layer 2: Fuzzy matching (token sort)...')
  const unmatchedColes = colesNorm.filter(c => !matches.find(m => m.coles_id === c.product_id))
  const unmatchedWW = wwNorm.filter(w => !matchedWW.has(w.product_id))
  let layer2 = 0

  for (const c of unmatchedColes) {
    if (!c.norm.size) continue // Skip products without size (can't compare meaningfully)

    let bestWW = { score: 0, product: null }
    for (const ww of unmatchedWW) {
      // Quick pre-filter: size must match and at least 30% token overlap
      const quick = quickScore(c.norm, ww.norm)
      if (quick < 0.3) continue

      // Full token sort ratio
      const score = tokenSortRatio(c.norm.matchKey, ww.norm.matchKey)
      if (score > bestWW.score) bestWW = { score, product: ww }
    }

    let bestAldi = { score: 0, product: null }
    for (const a of aldiNorm) {
      if (matchedAldi.has(a.product_id)) continue
      const quick = quickScore(c.norm, a.norm)
      if (quick < 0.3) continue
      const score = tokenSortRatio(c.norm.matchKey, a.norm.matchKey)
      if (score > bestAldi.score) bestAldi = { score, product: a }
    }

    if (bestWW.score >= 85 || bestAldi.score >= 85) {
      matches.push({
        coles_id: c.product_id,
        woolworths_id: bestWW.score >= 85 ? bestWW.product.product_id : null,
        aldi_id: bestAldi.score >= 85 ? bestAldi.product.product_id : null,
        display_name: c.name,
        size: c.size || c.norm.size,
        confidence: Math.max(bestWW.score, bestAldi.score),
        method: 'fuzzy'
      })
      if (bestWW.score >= 85) matchedWW.add(bestWW.product.product_id)
      if (bestAldi.score >= 85) matchedAldi.add(bestAldi.product.product_id)
      layer2++
    }

    if (layer2 % 100 === 0 && layer2 > 0) process.stdout.write(`  ${layer2} fuzzy matches...\r`)
  }
  console.log(`  Layer 2: ${layer2} fuzzy matches\n`)

  // --- RESULTS ---
  console.log(`TOTAL: ${matches.length} product groups`)
  console.log(`  Exact: ${layer1}`)
  console.log(`  Fuzzy: ${layer2}`)
  console.log(`  With Woolworths: ${matches.filter(m => m.woolworths_id).length}`)
  console.log(`  With Aldi: ${matches.filter(m => m.aldi_id).length}`)
  console.log(`  Both: ${matches.filter(m => m.woolworths_id && m.aldi_id).length}`)

  // Show samples
  console.log('\n--- Sample Exact Matches ---')
  for (const m of matches.filter(m => m.method === 'exact').slice(0, 5)) {
    const ww = woolworths.find(p => p.product_id === m.woolworths_id)
    console.log(`  ${m.display_name} (${m.size})`)
    console.log(`    → WW: ${ww?.name}`)
  }
  console.log('\n--- Sample Fuzzy Matches ---')
  for (const m of matches.filter(m => m.method === 'fuzzy').slice(0, 5)) {
    const ww = m.woolworths_id ? woolworths.find(p => p.product_id === m.woolworths_id) : null
    const al = m.aldi_id ? aldi.find(p => p.product_id === m.aldi_id) : null
    console.log(`  ${m.display_name} [${m.confidence}%]`)
    if (ww) console.log(`    → WW: ${ww.name}`)
    if (al) console.log(`    → Aldi: ${al.name}`)
  }

  // --- SAVE TO SUPABASE ---
  console.log(`\nSaving ${matches.length} groups to Supabase...`)

  // Delete old matches first
  await fetch(`${SUPABASE_URL}/rest/v1/product_groups?id=gt.0`, {
    method: 'DELETE',
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
  })

  // Insert new
  for (let i = 0; i < matches.length; i += 200) {
    const batch = matches.slice(i, i + 200).map(m => ({
      coles_id: m.coles_id, woolworths_id: m.woolworths_id, aldi_id: m.aldi_id,
      display_name: m.display_name, size: m.size
    }))
    await fetch(`${SUPABASE_URL}/rest/v1/product_groups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, Prefer: 'resolution=ignore-duplicates' },
      body: JSON.stringify(batch),
    })
  }
  console.log('Done! ✅')
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1) })
