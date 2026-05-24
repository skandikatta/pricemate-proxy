// AI-assisted product matching Layer 3
// Uses product name intelligence + brand normalization
// Catches what fuzzy matching misses (different name ordering, abbreviations)
// Run: node match-products-ai.js

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://asfnqfhpfufcbjzsrxlz.supabase.co'
const SUPABASE_KEY = process.env.SUPABASE_KEY || ''

// Brand normalization — same brand, different names across stores
const BRAND_ALIASES = {
  'gippsland dairy': ['gippsland'],
  'yoplait': ['yoplait'],
  'vaalia': ['vaalia'],
  'chobani': ['chobani'],
  'jalna': ['jalna'],
  'activia': ['activia', 'danone activia'],
  'farmers union': ['farmers union'],
  'bega': ['bega'],
  'devondale': ['devondale'],
  'pauls': ['pauls'],
  'pura': ['pura'],
  'a2': ['a2', 'a2 milk'],
  'sanitarium': ['sanitarium'],
  'uncle tobys': ['uncle tobys', 'uncle toby'],
  'kelloggs': ['kelloggs', "kellogg's"],
  'nestle': ['nestle', 'nestlé'],
  'cadbury': ['cadbury'],
  'arnotts': ['arnotts', "arnott's"],
  'smiths': ['smiths', "smith's"],
  'doritos': ['doritos'],
  'coca cola': ['coca cola', 'coca-cola', 'coke'],
  'pepsi': ['pepsi', 'pepsico'],
}

function normalizeBrand(brand) {
  const b = (brand || '').toLowerCase().replace(/['']/g, '').trim()
  for (const [canonical, aliases] of Object.entries(BRAND_ALIASES)) {
    if (aliases.some(a => b.includes(a) || a.includes(b))) return canonical
  }
  return b
}

function normalizeSize(size) {
  return (size || '').toLowerCase().replace(/\s+/g, '').replace(/\.0+([a-z])/i, '$1')
    .replace('litre', 'l').replace('liter', 'l').replace('kilogram', 'kg').replace('gram', 'g')
}

function extractCore(name, brand) {
  // Remove brand from name, extract the "core" product description
  let n = (name || '').toLowerCase()
  const b = (brand || '').toLowerCase()
  if (b) n = n.replace(new RegExp(b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '').trim()
  // Remove size from name
  n = n.replace(/\d+(?:\.\d+)?\s*(ml|l|g|kg|pk|pack|each|x\s*\d+)/gi, '').trim()
  // Remove filler words
  n = n.replace(/\b(the|and|with|style|australian|fresh|new|original)\b/g, '').trim()
  return n.replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
}

async function fetchAll(store) {
  const products = []
  let offset = 0
  while (true) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/products?store=eq.${store}&select=product_id,name,brand,size&order=name&limit=1000&offset=${offset}`, { headers: { apikey: SUPABASE_KEY } })
    const batch = await r.json()
    if (!batch.length) break
    products.push(...batch)
    offset += 1000
  }
  return products
}

async function fetchMatched() {
  const matched = new Set()
  let offset = 0
  while (true) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/product_groups?select=coles_id,woolworths_id,aldi_id&limit=1000&offset=${offset}`, { headers: { apikey: SUPABASE_KEY } })
    const batch = await r.json()
    if (!batch.length) break
    for (const g of batch) {
      if (g.coles_id) matched.add('coles_' + g.coles_id)
      if (g.woolworths_id) matched.add('woolworths_' + g.woolworths_id)
    }
    offset += 1000
  }
  return matched
}

async function main() {
  console.log('=== AI-ASSISTED MATCHING (Layer 3) ===\n')

  const coles = await fetchAll('coles')
  const ww = await fetchAll('woolworths')
  const matched = await fetchMatched()

  // Get unmatched products
  const unmatchedColes = coles.filter(p => !matched.has('coles_' + p.product_id))
  const unmatchedWW = ww.filter(p => !matched.has('woolworths_' + p.product_id))
  console.log(`Unmatched: ${unmatchedColes.length} Coles, ${unmatchedWW.length} Woolworths\n`)

  // Index Woolworths by normalized brand
  const wwByBrand = new Map()
  for (const p of unmatchedWW) {
    const brand = normalizeBrand(p.brand)
    if (!wwByBrand.has(brand)) wwByBrand.set(brand, [])
    wwByBrand.get(brand).push({ ...p, normBrand: brand, normSize: normalizeSize(p.size), core: extractCore(p.name, p.brand) })
  }

  const newMatches = []
  for (const c of unmatchedColes) {
    const brand = normalizeBrand(c.brand)
    const size = normalizeSize(c.size)
    const core = extractCore(c.name, c.brand)

    if (!brand || !size) continue

    // Find candidates: same brand + same size
    const candidates = wwByBrand.get(brand) || []
    const sameSize = candidates.filter(w => w.normSize === size)

    if (sameSize.length === 0) continue

    // Score by core product name similarity
    let best = { score: 0, product: null }
    for (const w of sameSize) {
      // Simple word overlap on core name
      const cWords = new Set(core.split(' ').filter(t => t.length > 2))
      const wWords = new Set(w.core.split(' ').filter(t => t.length > 2))
      let overlap = 0
      for (const t of cWords) { if (wWords.has(t)) overlap++ }
      const score = cWords.size > 0 ? overlap / Math.max(cWords.size, wWords.size) : 0
      if (score > best.score) best = { score, product: w }
    }

    if (best.score >= 0.6) {
      newMatches.push({ coles_id: c.product_id, woolworths_id: best.product.product_id, display_name: c.name, size: c.size, score: best.score })
    }
  }

  console.log(`New matches found: ${newMatches.length}\n`)
  console.log('--- Samples ---')
  for (const m of newMatches.slice(0, 15)) {
    const wwP = unmatchedWW.find(p => p.product_id === m.woolworths_id)
    console.log(`  Coles: ${m.display_name} (${m.size})`)
    console.log(`  WW:    ${wwP?.name} (${wwP?.size}) [${Math.round(m.score * 100)}%]`)
    console.log()
  }

  // Save to Supabase
  if (newMatches.length > 0) {
    console.log(`Saving ${newMatches.length} new matches...`)
    for (let i = 0; i < newMatches.length; i += 200) {
      const batch = newMatches.slice(i, i + 200).map(m => ({
        coles_id: m.coles_id, woolworths_id: m.woolworths_id, aldi_id: null,
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
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1) })
