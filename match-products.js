// match-products.js — 4-layer aggressive product matcher
// Matches same products across Coles, Woolworths, Aldi
// Run: node match-products.js
const { pool } = require('./db')
// --- House brand equivalents (Aldi house brands → what they actually are) ---
const HOUSE_BRANDS = {
  // Aldi brands → generic category
  'farmdale': 'milk', 'cowbelle': 'dairy', 'remano': 'pasta',
  'belmont': 'biscuits', 'brooklea': 'yoghurt', 'westacre': 'dairy',
  'lyttos': 'greek', 'monarc': 'pantry', 'beautifully butterfully': 'butter',
  'baker life': 'bread', 'berg': 'smallgoods', 'brannans': 'butchery',
  'cattleman': 'beef', 'colway': 'cheese', 'forresters': 'pie',
  'golden crumpets': 'crumpets', 'jindurra': 'grain', 'just organic': 'organic',
  'kindling': 'coffee', 'lacura': 'skincare', 'mamia': 'baby',
  'milfina': 'chocolate', 'nature\'s nectar': 'juice', 'ocean rise': 'seafood',
  'penfield': 'olives', 'radiance': 'vitamins', 'sakata': 'crackers',
  'so natural': 'milk', 'urban eats': 'meals', 'westcliff': 'tea',
  // Added 2026-05-30: from unmatched brand audit
  'hillcrest': 'pantry', 'ready, set…cook!': 'meals', 'stonemill': 'spices',
  'power force': 'cleaning', 'choceur': 'chocolate', 'damora': 'pasta',
  'portview': 'seafood', 'white mill': 'flour', 'emporium selection': 'deli',
  'world kitchen': 'meals', 'broad oak farms': 'meat', 'chefs\' cupboard': 'pantry',
  'imperial grain': 'rice', 'deli originals fresh': 'deli', 'specially selected': 'premium',
  'bakers life': 'bread', 'belmont biscuit co.': 'biscuits',
  'market fare': 'frozen', 'golden fields': 'pantry', 'harvest moon': 'juice',
  'alcafe': 'coffee', 'dermaveen': 'skincare', 'tandil': 'cleaning',
  'di san': 'cleaning', 'logix': 'cleaning', 'almat': 'cleaning',
}

// Known cross-store brand equivalents
const BRAND_EQUIVALENTS = [
  ['coles', 'woolworths essentials', 'aldi'],  // store brands
  ['coles finest', 'woolworths gold', 'aldi'],
  ['coles simply', 'woolworths macro', 'just organic'],
]

function normalize(name) {
  return (name || '').toLowerCase()
    .replace(/['"‘’“”&]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b(each|loose|approx|per kg|kg|g|ml|l|pk|pack)\b/gi, m => m) // keep units
    .trim()
}

function extractSize(name, sizeField) {
  // Try size field first
  if (sizeField) return sizeField.toLowerCase().replace(/\s+/g, '')
  // Extract from name: "2L", "500g", "6 Pack", "1kg"
  const m = name.match(/(\d+\.?\d*)\s*(kg|g|ml|l|litre|liter|pack|pk)\b/i)
  return m ? (m[1] + m[2]).toLowerCase() : ''
}

// Variant qualifiers — words/phrases that distinguish a product variant from
// the "base" version. If one side has any of these and the other doesn't,
// they're different products even when brand + size match. Added 2026-05-28
// after the matcher false-merged Coles a2 Full Cream Milk 2L with Woolies a2
// Milk Lactose Free Light 2L (shared brand+size, visually similar cartons,
// Layer 0.5 image-pHash picked the wrong pair).
//
// Order matters: longer phrases checked first via the regex pattern below.
const VARIANT_QUALIFIERS = [
  'lactose free', 'gluten free', 'dairy free', 'sugar free', 'fat free',
  'no added sugar', 'reduced sugar', 'reduced fat', 'low fat', 'low carb',
  'high protein', 'long life', 'no salt', 'extra light', 'extra creamy',
  'extra virgin', 'unsweetened',
  'light', 'lite', 'skim', 'decaf', 'decaffeinated',
  'salted', 'unsalted', 'organic', 'uht', 'diet', 'zero', 'keto', 'vegan',
  'wholemeal', 'whole grain', 'multigrain',
]

function variantQualifiers(name) {
  const n = (name || '').toLowerCase()
  const found = new Set()
  for (const q of VARIANT_QUALIFIERS) {
    if (new RegExp(`\\b${q.replace(/\s+/g, '\\s+')}\\b`).test(n)) found.add(q)
  }
  return found
}

// Two names are variant-compatible iff they carry exactly the same set of
// variant qualifiers. "Full Cream Milk" vs "Lactose Free Milk" — different
// qualifier sets ({} vs {lactose free}) → REJECT. "Full Cream Milk" vs
// "Pure Full Cream Milk" — same qualifier sets ({}) → ALLOW.
function variantsMatch(nameA, nameB) {
  const a = variantQualifiers(nameA)
  const b = variantQualifiers(nameB)
  if (a.size !== b.size) return false
  for (const q of a) if (!b.has(q)) return false
  return true
}

function extractCoreName(name, brand) {
  let n = normalize(name)
  // Remove brand from name
  if (brand) n = n.replace(normalize(brand), '').trim()
  // Remove size info
  n = n.replace(/\d+\.?\d*\s*(kg|g|ml|l|litre|liter|pack|pk)\b/gi, '').trim()
  // Remove common filler words
  n = n.replace(/\b(the|a|an|of|with|and|in|for|from)\b/g, '').replace(/\s+/g, ' ').trim()
  return n
}

function tokenize(str) {
  return str.toLowerCase().split(/\s+/).filter(w => w.length > 2)
}

function tokenSortRatio(a, b) {
  const ta = tokenize(a).sort().join(' ')
  const tb = tokenize(b).sort().join(' ')
  if (!ta || !tb) return 0
  // Levenshtein-based similarity on sorted token strings
  const maxLen = Math.max(ta.length, tb.length)
  if (maxLen === 0) return 0
  const dist = levenshtein(ta, tb)
  return 1 - dist / maxLen
}

function tokenOverlap(a, b) {
  const ta = new Set(tokenize(a))
  const tb = new Set(tokenize(b))
  if (ta.size === 0 || tb.size === 0) return 0
  const intersection = [...ta].filter(t => tb.has(t)).length
  return intersection / Math.min(ta.size, tb.size)
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

async function loadProducts() {
  const { rows } = await pool.query('SELECT store, product_id, name, brand, size, category, barcode, image_phash FROM products ORDER BY store, name')
  const byStore = { coles: [], woolworths: [], aldi: [] }
  for (const r of rows) {
    if (byStore[r.store]) {
      byStore[r.store].push({
        ...r,
        normalized: normalize(r.name),
        core: extractCoreName(r.name, r.brand),
        sizeNorm: extractSize(r.name, r.size),
        // PG returns BIGINT as string. Keep as BigInt for cheap XOR/popcount in
        // matchLayer05. null when image hash hasn't been computed yet.
        image_phash: r.image_phash == null ? null : BigInt(r.image_phash),
      })
    }
  }
  return byStore
}

function matchLayer0(products) {
  // Barcode: exact EAN match across stores.
  //
  // 2026-05-28 size guard added: manufacturers sometimes share an EAN across
  // the size-variants of a product family (e.g. Jalna Greek Style Yoghurt
  // 1kg and 2kg both list 9310354980202 in OFF AU). Without a size guard
  // Layer 0 would merge them, and that wrong pairing would block Layer 0.5
  // from finding the correct same-size cross-store match.
  // Now: same barcode AND same sizeNorm required.
  const groups = new Map() // (barcode|sizeNorm) → group
  for (const store of ['coles', 'woolworths', 'aldi']) {
    for (const p of products[store]) {
      if (!p.barcode) continue
      // sizeNorm null acts as its own bucket — products without size info
      // group amongst themselves, won't merge with sized products on bare barcode.
      const key = `${p.barcode}|${p.sizeNorm || ''}`
      if (!groups.has(key)) groups.set(key, { coles: null, woolworths: null, aldi: null, display_name: p.name, size: p.sizeNorm })
      if (!groups.get(key)[store]) groups.get(key)[store] = p.product_id
    }
  }
  return [...groups.values()].filter(g => [g.coles, g.woolworths, g.aldi].filter(Boolean).length >= 2)
}

// Hamming distance for two 64-bit BigInt hashes. Returns 0..64.
function hammingDistance(a, b) {
  let x = a ^ b
  let n = 0
  while (x > 0n) {
    n += Number(x & 1n)
    x >>= 1n
  }
  return n
}

const IMAGE_HASH_THRESHOLD = 6  // out of 64 bits — ≤6 = highly similar photo

// Layer 0.5 — image perceptual-hash match.
//
// Same-brand-and-same-size guard, then Hamming(image_phash) ≤ 6 across stores.
// This catches identity matches the text layers miss because retailers name
// the same product differently (e.g. Coles "Dairy Yoghurt Greek Style"
// vs Woolworths "Jalna Pot Set Greek Style Natural Yoghurt" — both brand
// "Jalna" 2kg, both photos of the same tub).
//
// Hashes populated by compute-image-hashes.js. Products without a hash skip
// this layer and fall through to Layers 1-4.
function matchLayer05(products, existingMatched) {
  const matched = new Set(existingMatched)
  const groups = []

  function bucketByBrandSize(list) {
    const m = new Map()
    for (const p of list) {
      if (p.image_phash == null) continue
      if (!p.sizeNorm) continue
      const brand = (p.brand || '').toLowerCase().trim()
      if (!brand) continue  // brand REQUIRED for image matching
      const key = `${brand}|${p.sizeNorm}`
      if (!m.has(key)) m.set(key, [])
      m.get(key).push(p)
    }
    return m
  }

  const colesByKey = bucketByBrandSize(products.coles)
  const wwByKey = bucketByBrandSize(products.woolworths)
  const aldiByKey = bucketByBrandSize(products.aldi)
  const allKeys = new Set([...colesByKey.keys(), ...wwByKey.keys(), ...aldiByKey.keys()])

  for (const key of allKeys) {
    const colesList = colesByKey.get(key) || []
    const wwList    = wwByKey.get(key)    || []
    const aldiList  = aldiByKey.get(key)  || []

    // Coles → Woolies + Aldi. Variant guard added 2026-05-28: when multiple
    // products share brand+size (e.g. a2 Milk Full Cream / Lactose Free /
    // Lactose Free Light, all 2L), image-pHash alone is not enough to
    // distinguish them — the cartons look visually similar. Require matching
    // variant-qualifier sets to reject Full Cream ↔ Lactose Free Light pairs.
    for (const cp of colesList) {
      if (matched.has(`coles_${cp.product_id}`)) continue
      let bestWW = null, bestWWDist = IMAGE_HASH_THRESHOLD + 1
      for (const wp of wwList) {
        if (matched.has(`woolworths_${wp.product_id}`)) continue
        if (!variantsMatch(cp.name, wp.name)) continue
        const d = hammingDistance(cp.image_phash, wp.image_phash)
        if (d <= IMAGE_HASH_THRESHOLD && d < bestWWDist) { bestWW = wp; bestWWDist = d }
      }
      let bestAldi = null, bestAldiDist = IMAGE_HASH_THRESHOLD + 1
      for (const ap of aldiList) {
        if (matched.has(`aldi_${ap.product_id}`)) continue
        if (!variantsMatch(cp.name, ap.name)) continue
        const d = hammingDistance(cp.image_phash, ap.image_phash)
        if (d <= IMAGE_HASH_THRESHOLD && d < bestAldiDist) { bestAldi = ap; bestAldiDist = d }
      }
      if (bestWW || bestAldi) {
        groups.push({
          coles: cp.product_id,
          woolworths: bestWW?.product_id || null,
          aldi: bestAldi?.product_id || null,
          display_name: cp.name,
          size: cp.sizeNorm,
        })
        matched.add(`coles_${cp.product_id}`)
        if (bestWW) matched.add(`woolworths_${bestWW.product_id}`)
        if (bestAldi) matched.add(`aldi_${bestAldi.product_id}`)
      }
    }

    // Woolies → Aldi (for products without a Coles equivalent)
    for (const wp of wwList) {
      if (matched.has(`woolworths_${wp.product_id}`)) continue
      let bestAldi = null, bestAldiDist = IMAGE_HASH_THRESHOLD + 1
      for (const ap of aldiList) {
        if (matched.has(`aldi_${ap.product_id}`)) continue
        if (!variantsMatch(wp.name, ap.name)) continue
        const d = hammingDistance(wp.image_phash, ap.image_phash)
        if (d <= IMAGE_HASH_THRESHOLD && d < bestAldiDist) { bestAldi = ap; bestAldiDist = d }
      }
      if (bestAldi) {
        groups.push({
          coles: null,
          woolworths: wp.product_id,
          aldi: bestAldi.product_id,
          display_name: wp.name,
          size: wp.sizeNorm,
        })
        matched.add(`woolworths_${wp.product_id}`)
        matched.add(`aldi_${bestAldi.product_id}`)
      }
    }
  }

  return groups
}

function matchLayer1(products, existingMatched) {
  // Exact: brand + size + core name.
  //
  // BRAND IS LOAD-BEARING IN THE KEY. Before 2026-05-28 this key was just
  // `core|sizeNorm` — the comment said brand was included but the code wasn't.
  // The audit found false-merges in prod: a2 Milk + Pauls Zymil + Coles brand
  // "Lactose Free Full Cream Milk 2L" all collapsed into one group because
  // they shared the same extracted core+size. Including brand in the key
  // (with empty-brand falling through to Layers 3-4's store-brand carve-outs)
  // is the audit-class fix for the 757caeb failure mode at this layer too.
  const matched = new Set(existingMatched || [])
  const groups = new Map() // key → { coles, woolworths, aldi }
  for (const store of ['coles', 'woolworths', 'aldi']) {
    for (const p of products[store]) {
      if (!p.sizeNorm || !p.core) continue
      if (matched.has(`${store}_${p.product_id}`)) continue
      // Empty brand → unbranded products fall through to Layer 3 (token-sort
      // with store-brand carve-out) so we don't blindly group every brandless
      // SKU sharing a core+size.
      const brandKey = (p.brand || '').toLowerCase().trim()
      if (!brandKey) continue
      const key = `${brandKey}|${p.core}|${p.sizeNorm}`
      if (!groups.has(key)) groups.set(key, { coles: null, woolworths: null, aldi: null, display_name: p.name, size: p.sizeNorm })
      if (!groups.get(key)[store]) groups.get(key)[store] = p.product_id
    }
  }
  // Only keep groups with 2+ stores
  return [...groups.values()].filter(g => [g.coles, g.woolworths, g.aldi].filter(Boolean).length >= 2)
}

// Bucket products by sizeNorm for O(1) candidate lookup.
// Replaces the O(N*M) double-loop in Layer 2/3/4 with O(N + candidates-per-size).
// Without this, Layer 2 on 22K Coles × 52K Woolworths = 1.18B iterations
// took 50+ minutes in production. With bucketing it's seconds.
function bucketBySize(list) {
  const bySize = new Map()
  for (const p of list) {
    if (!p.sizeNorm) continue
    if (!bySize.has(p.sizeNorm)) bySize.set(p.sizeNorm, [])
    bySize.get(p.sizeNorm).push(p)
  }
  return bySize
}

function matchLayer2(products, existingMatched) {
  // Fuzzy: Levenshtein < 3 on core name + same size + brand check.
  //
  // 2026-05-28: same audit-class fix as Layer 1. Layer 2 had no brand guard,
  // so e.g. "Lactose Free Full Cream Milk" 2L at Coles (brand=Coles) was
  // matching "Pauls Zymil Lactose Free Full Cream Milk" 2L at Woolies
  // (brand=Pauls Zymil) because their extracted cores were Levenshtein 0 apart.
  // Now uses the same Layer 3 brand veto: reject cross-brand unless both are
  // store-brands of the same generic product.
  const matched = new Set(existingMatched)
  const groups = []
  const storeBrands = new Set(['coles', 'woolworths', 'woolworths free from', 'woolworths essentials', 'woolworths macro', 'coles simply', 'coles finest', "coles nature's kitchen"])
  const wwBySize = bucketBySize(products.woolworths)

  for (const cp of products.coles) {
    if (matched.has(`coles_${cp.product_id}`)) continue
    if (!cp.sizeNorm) continue
    const candidates = wwBySize.get(cp.sizeNorm)
    if (!candidates) continue

    for (const wp of candidates) {
      if (matched.has(`woolworths_${wp.product_id}`)) continue
      // Brand veto (mirrors Layer 3): reject differing brands unless both sides
      // are store brands of the same generic product.
      const cb = (cp.brand || '').toLowerCase().trim()
      const wb = (wp.brand || '').toLowerCase().trim()
      if (cb && wb && cb !== wb) {
        const bothStoreBrand = storeBrands.has(cb) && storeBrands.has(wb)
        if (!bothStoreBrand) continue
      }
      if (!variantsMatch(cp.name, wp.name)) continue
      if (levenshtein(cp.core, wp.core) <= 3 && cp.core.length > 5) {
        groups.push({ coles: cp.product_id, woolworths: wp.product_id, aldi: null, display_name: cp.name, size: cp.sizeNorm })
        matched.add(`coles_${cp.product_id}`)
        matched.add(`woolworths_${wp.product_id}`)
        break
      }
    }
  }
  return groups
}

function matchLayer3(products, existingMatched) {
  // Token sort ratio > 80% + same size + same brand (or one has no brand)
  const matched = new Set(existingMatched)
  const groups = []
  const storeBrands = new Set(['coles', 'woolworths', 'woolworths free from', 'woolworths essentials', 'woolworths macro', 'coles simply', 'coles finest', 'coles nature\'s kitchen'])
  const wwBySize = bucketBySize(products.woolworths)

  for (const cp of products.coles) {
    if (matched.has(`coles_${cp.product_id}`)) continue
    if (!cp.sizeNorm) continue
    const candidates = wwBySize.get(cp.sizeNorm)
    if (!candidates) continue

    for (const wp of candidates) {
      if (matched.has(`woolworths_${wp.product_id}`)) continue
      // Brand check (tightened 2026-05-26 — closes the "Bega cheese" loophole):
      //   Reject if both sides have non-empty brands that DIFFER, UNLESS both are
      //   store brands (Coles vs Woolworths house brand of the same generic
      //   product can legitimately match).
      //   The previous rule allowed any brand match as long as ONE side was a
      //   store brand, which falsely paired e.g. Coles store-brand cheese to
      //   Woolworths Bega-brand cheese.
      const cb = normalize(cp.brand || '')
      const wb = normalize(wp.brand || '')
      let bothStoreBrand = false
      if (cb && wb && cb !== wb) {
        bothStoreBrand = storeBrands.has(cb) && storeBrands.has(wb)
        if (!bothStoreBrand) continue
      } else if (cb && wb && cb === wb) {
        bothStoreBrand = storeBrands.has(cb)
      }
      // For Coles ↔ Woolworths store-brand matches, compare core names (brand
      // stripped) using tokenOverlap — more forgiving of word-order differences
      // and extra qualifiers like "Australian" or "UHT" that one side adds.
      // variantsMatch still guards against flavour/type mismatches.
      if (!variantsMatch(cp.name, wp.name)) continue
      let isMatch = false
      if (bothStoreBrand) {
        // Store-brand path: use tokenOverlap on core (brand-stripped) names
        isMatch = tokenOverlap(cp.core, wp.core) >= 0.75 && cp.core.length > 3
      } else {
        // Named-brand path: stricter tokenSortRatio on full normalized name
        isMatch = tokenSortRatio(cp.normalized, wp.normalized) >= 0.80
      }
      if (isMatch) {
        groups.push({ coles: cp.product_id, woolworths: wp.product_id, aldi: null, display_name: cp.name, size: cp.sizeNorm })
        matched.add(`coles_${cp.product_id}`)
        matched.add(`woolworths_${wp.product_id}`)
        break
      }
    }
  }
  return groups
}

function matchLayer4(products, existingMatched) {
  // Aldi house brand matching — match by core product type + size
  // Only match Aldi house brands to store-brand or brandless equivalents at Coles/WW
  // Never match to a specific named brand (Rokeby, a2, Pauls etc)
  const matched = new Set(existingMatched)
  const groups = []
  const storeBrands = new Set(['coles', 'woolworths', 'woolworths free from', 'woolworths essentials', 'woolworths macro', 'coles simply', 'coles finest', 'coles nature\'s kitchen', ''])
  const colesBySize = bucketBySize(products.coles)
  const wwBySize = bucketBySize(products.woolworths)

  for (const ap of products.aldi) {
    if (matched.has(`aldi_${ap.product_id}`)) continue
    if (!ap.sizeNorm) continue

    let bestColes = null, bestWW = null
    const colesCandidates = colesBySize.get(ap.sizeNorm) || []

    for (const cp of colesCandidates) {
      if (matched.has(`coles_${cp.product_id}`)) continue
      const cb = normalize(cp.brand || '')
      // Only match to store-brand or brandless Coles products
      if (cb && !storeBrands.has(cb)) continue
      if (!variantsMatch(ap.name, cp.name)) continue
      if (tokenSortRatio(ap.core, cp.core) >= 0.75) { bestColes = cp; break }
    }

    const wwCandidates = wwBySize.get(ap.sizeNorm) || []
    for (const wp of wwCandidates) {
      if (matched.has(`woolworths_${wp.product_id}`)) continue
      const wb = normalize(wp.brand || '')
      if (wb && !storeBrands.has(wb)) continue
      if (!variantsMatch(ap.name, wp.name)) continue
      if (tokenSortRatio(ap.core, wp.core) >= 0.75) { bestWW = wp; break }
    }

    if (bestColes || bestWW) {
      groups.push({
        coles: bestColes?.product_id || null,
        woolworths: bestWW?.product_id || null,
        aldi: ap.product_id,
        display_name: ap.name,
        size: ap.sizeNorm,
      })
      matched.add(`aldi_${ap.product_id}`)
      if (bestColes) matched.add(`coles_${bestColes.product_id}`)
      if (bestWW) matched.add(`woolworths_${bestWW.product_id}`)
    }
  }
  return groups
}

async function saveGroups(groups) {
  if (!groups.length) return 0
  // Clear and rebuild
  await pool.query('TRUNCATE product_groups')

  // Batch insert
  const batchSize = 100
  let inserted = 0
  for (let i = 0; i < groups.length; i += batchSize) {
    const batch = groups.slice(i, i + batchSize)
    const values = batch.map((g, j) => {
      const base = j * 5
      return `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5})`
    }).join(',')
    const params = batch.flatMap(g => [g.coles, g.woolworths, g.aldi, g.display_name, g.size])
    await pool.query(
      `INSERT INTO product_groups (coles_id, woolworths_id, aldi_id, display_name, size) VALUES ${values}`,
      params
    )
    inserted += batch.length
  }
  return inserted
}

async function main() {
  console.log('=== Product Matcher (4-layer) ===\n')
  console.log('Loading products...')
  const products = await loadProducts()
  console.log(`  Coles: ${products.coles.length} | Woolworths: ${products.woolworths.length} | Aldi: ${products.aldi.length}\n`)

  // Layer 0: Barcode match
  const layer0 = matchLayer0(products)
  console.log(`Layer 0 (barcode EAN match): ${layer0.length} groups`)

  // Track what's been matched
  const matched = new Set()
  for (const g of layer0) {
    if (g.coles) matched.add(`coles_${g.coles}`)
    if (g.woolworths) matched.add(`woolworths_${g.woolworths}`)
    if (g.aldi) matched.add(`aldi_${g.aldi}`)
  }

  // Layer 0.5: Image perceptual-hash match (same brand + same size + Hamming ≤ 6)
  const layer05 = matchLayer05(products, matched)
  console.log(`Layer 0.5 (image pHash, brand+size guard): ${layer05.length} groups`)
  for (const g of layer05) {
    if (g.coles) matched.add(`coles_${g.coles}`)
    if (g.woolworths) matched.add(`woolworths_${g.woolworths}`)
    if (g.aldi) matched.add(`aldi_${g.aldi}`)
  }

  // Layer 1: Exact match (skip products already matched by Layer 0/0.5)
  const layer1 = matchLayer1(products, matched)
  console.log(`Layer 1 (exact brand+size+name): ${layer1.length} groups`)
  for (const g of layer1) {
    if (g.coles) matched.add(`coles_${g.coles}`)
    if (g.woolworths) matched.add(`woolworths_${g.woolworths}`)
    if (g.aldi) matched.add(`aldi_${g.aldi}`)
  }

  // Layer 2: Fuzzy
  const layer2 = matchLayer2(products, matched)
  console.log(`Layer 2 (fuzzy Levenshtein ≤3): ${layer2.length} groups`)
  for (const g of layer2) {
    if (g.coles) matched.add(`coles_${g.coles}`)
    if (g.woolworths) matched.add(`woolworths_${g.woolworths}`)
    if (g.aldi) matched.add(`aldi_${g.aldi}`)
  }

  // Layer 3: Token overlap
  const layer3 = matchLayer3(products, matched)
  console.log(`Layer 3 (token sort ratio ≥80%): ${layer3.length} groups`)
  for (const g of layer3) {
    if (g.coles) matched.add(`coles_${g.coles}`)
    if (g.woolworths) matched.add(`woolworths_${g.woolworths}`)
    if (g.aldi) matched.add(`aldi_${g.aldi}`)
  }

  // Layer 4: Aldi house brands
  const layer4 = matchLayer4(products, matched)
  console.log(`Layer 4 (Aldi house brand): ${layer4.length} groups`)

  const allGroups = [...layer0, ...layer05, ...layer1, ...layer2, ...layer3, ...layer4]
  console.log(`\nTotal: ${allGroups.length} product groups`)

  // Stats
  const with3 = allGroups.filter(g => g.coles && g.woolworths && g.aldi).length
  const with2 = allGroups.length - with3
  console.log(`  3-store matches: ${with3}`)
  console.log(`  2-store matches: ${with2}`)

  // Save — default is DRY-RUN (writes to JSON for audit). Pass --apply to
  // actually mutate product_groups. Audit dry-run output before applying:
  //   node match-products.js                  # dry-run
  //   node match-products.js --apply          # write to DB
  const APPLY = process.argv.includes('--apply')
  if (APPLY) {
    const saved = await saveGroups(allGroups)
    console.log(`\nSaved ${saved} groups to product_groups table`)
  } else {
    const fs = require('fs')
    const outPath = '/tmp/match-dryrun.json'
    fs.writeFileSync(outPath, JSON.stringify(allGroups, null, 2))
    console.log(`\nDRY-RUN: wrote ${allGroups.length} groups to ${outPath} (no DB writes)`)
    console.log(`Re-run with --apply to commit to product_groups table.`)
  }

  await pool.end()
}

module.exports = {
  HOUSE_BRANDS,
  BRAND_EQUIVALENTS,
  normalize,
  extractSize,
  extractCoreName,
  tokenize,
  tokenSortRatio,
  tokenOverlap,
  levenshtein,
  matchLayer0,
  matchLayer05,
  matchLayer1,
  matchLayer2,
  matchLayer3,
  matchLayer4,
  hammingDistance,
  loadProducts,
  saveGroups,
  main,
}

if (require.main === module) {
  console.log(`Product matching started: ${new Date().toISOString()}`)
  main()
    .then(() => console.log(`Done: ${new Date().toISOString()}`))
    .catch(e => { console.error('ERROR:', e.message); process.exit(1) })
}
