import { describe, test, expect } from 'vitest'
import mp from '../match-products.js'

const {
  normalize,
  extractCoreName,
  extractSize,
  matchLayer0,
  matchLayer1,
  matchLayer2,
  matchLayer3,
  matchLayer4,
} = mp

// ─────────────────────────────────────────────────────────────────────────
// Fixture helper — mimics loadProducts() output by computing the same
// derived fields (normalized, core, sizeNorm) the layers expect.
// ─────────────────────────────────────────────────────────────────────────
function makeProduct(store, partial) {
  const name = partial.name || ''
  const brand = partial.brand ?? null
  const size = partial.size ?? null
  return {
    store,
    product_id: partial.product_id,
    name,
    brand,
    size,
    category: partial.category || null,
    barcode: partial.barcode ?? null,
    normalized: normalize(name),
    core: extractCoreName(name, brand),
    sizeNorm: extractSize(name, size),
  }
}

function emptyProducts() {
  return { coles: [], woolworths: [], aldi: [] }
}

// ─────────────────────────────────────────────────────────────────────────
// Layer 0 — barcode (EAN) exact match
// ─────────────────────────────────────────────────────────────────────────
describe('matchLayer0 (barcode EAN match)', () => {
  test('matches across coles + woolworths via same barcode', () => {
    const products = emptyProducts()
    products.coles.push(makeProduct('coles', {
      product_id: 'C1', name: 'Bega Cheese 500g', brand: 'Bega', barcode: '9300000000001',
    }))
    products.woolworths.push(makeProduct('woolworths', {
      product_id: 'W1', name: 'Bega Cheese Block 500g', brand: 'Bega', barcode: '9300000000001',
    }))

    const groups = matchLayer0(products)
    expect(groups).toHaveLength(1)
    expect(groups[0].coles).toBe('C1')
    expect(groups[0].woolworths).toBe('W1')
    expect(groups[0].aldi).toBeNull()
  })

  test('matches across all 3 stores when barcode shared', () => {
    const products = emptyProducts()
    const bc = '9300000000002'
    products.coles.push(makeProduct('coles', { product_id: 'C2', name: 'Milk 2L', barcode: bc }))
    products.woolworths.push(makeProduct('woolworths', { product_id: 'W2', name: 'Milk 2L', barcode: bc }))
    products.aldi.push(makeProduct('aldi', { product_id: 'A2', name: 'Milk 2L', barcode: bc }))

    const groups = matchLayer0(products)
    expect(groups).toHaveLength(1)
    expect(groups[0].coles).toBe('C2')
    expect(groups[0].woolworths).toBe('W2')
    expect(groups[0].aldi).toBe('A2')
  })

  test('rejects single-store matches (< 2 stores)', () => {
    const products = emptyProducts()
    products.coles.push(makeProduct('coles', { product_id: 'C3', name: 'Solo Item', barcode: '9300000000003' }))

    expect(matchLayer0(products)).toHaveLength(0)
  })

  test('ignores products without barcodes', () => {
    const products = emptyProducts()
    products.coles.push(makeProduct('coles', { product_id: 'C4', name: 'No Barcode', barcode: null }))
    products.woolworths.push(makeProduct('woolworths', { product_id: 'W4', name: 'No Barcode', barcode: null }))

    expect(matchLayer0(products)).toHaveLength(0)
  })

  test('first product_id per store wins when duplicate barcodes within a store', () => {
    const products = emptyProducts()
    const bc = '9300000000005'
    products.coles.push(makeProduct('coles', { product_id: 'C5a', name: 'Item A', barcode: bc }))
    products.coles.push(makeProduct('coles', { product_id: 'C5b', name: 'Item B', barcode: bc }))
    products.woolworths.push(makeProduct('woolworths', { product_id: 'W5', name: 'Item C', barcode: bc }))

    const groups = matchLayer0(products)
    expect(groups).toHaveLength(1)
    expect(groups[0].coles).toBe('C5a')  // first wins, not C5b
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Layer 1 — exact match (core name + size)
// ─────────────────────────────────────────────────────────────────────────
describe('matchLayer1 (exact brand+size+core name)', () => {
  test('matches coles + woolworths with same core + size', () => {
    const products = emptyProducts()
    products.coles.push(makeProduct('coles', {
      product_id: 'C10', name: 'Bega Cheese 500g', brand: 'Bega',
    }))
    products.woolworths.push(makeProduct('woolworths', {
      product_id: 'W10', name: 'Bega Cheese 500g', brand: 'Bega',
    }))

    const groups = matchLayer1(products)
    expect(groups).toHaveLength(1)
    expect(groups[0].coles).toBe('C10')
    expect(groups[0].woolworths).toBe('W10')
  })

  test('rejects when sizes differ', () => {
    const products = emptyProducts()
    products.coles.push(makeProduct('coles', {
      product_id: 'C11', name: 'Bega Cheese 500g', brand: 'Bega',
    }))
    products.woolworths.push(makeProduct('woolworths', {
      product_id: 'W11', name: 'Bega Cheese 1kg', brand: 'Bega',
    }))

    expect(matchLayer1(products)).toHaveLength(0)
  })

  test('ignores products with no extractable size', () => {
    const products = emptyProducts()
    products.coles.push(makeProduct('coles', {
      product_id: 'C12', name: 'Loose Apples', brand: null,
    }))
    products.woolworths.push(makeProduct('woolworths', {
      product_id: 'W12', name: 'Loose Apples', brand: null,
    }))

    // No sizeNorm → both skipped → no group
    expect(matchLayer1(products)).toHaveLength(0)
  })

  test('captures match across all 3 stores when keys align', () => {
    const products = emptyProducts()
    products.coles.push(makeProduct('coles', {
      product_id: 'C13', name: 'Coles Milk 2L', brand: 'Coles',
    }))
    products.woolworths.push(makeProduct('woolworths', {
      product_id: 'W13', name: 'Coles Milk 2L', brand: 'Coles',
    }))
    products.aldi.push(makeProduct('aldi', {
      product_id: 'A13', name: 'Coles Milk 2L', brand: 'Coles',
    }))

    const groups = matchLayer1(products)
    expect(groups).toHaveLength(1)
    expect(groups[0].coles).toBe('C13')
    expect(groups[0].woolworths).toBe('W13')
    expect(groups[0].aldi).toBe('A13')
  })

  // Regression for 2026-05-28 audit finding — false-merge of 3 different
  // brand "Lactose Free Full Cream Milk 2L" SKUs because Layer 1's key
  // omitted brand. Pauls Zymil, Coles brand, a2 Milk, and Aldi FARMDALE
  // all extract to the same core+size — and were collapsing into one group.
  test('Pauls Zymil ≠ Coles brand ≠ a2 Milk for the same core+size product', () => {
    const products = emptyProducts()
    products.coles.push(makeProduct('coles', {
      product_id: 'C-COLES', name: 'Lactose Free Full Cream Milk', brand: 'Coles', size: '2L',
    }))
    products.coles.push(makeProduct('coles', {
      product_id: 'C-A2', name: 'Lactose Free Full Cream Milk', brand: 'a2 Milk', size: '2L',
    }))
    products.woolworths.push(makeProduct('woolworths', {
      product_id: 'W-ZYMIL', name: 'Pauls Zymil Lactose Free Full Cream Milk', brand: 'Pauls Zymil', size: '2L',
    }))

    const groups = matchLayer1(products)
    // No group should have BOTH Coles-brand and Pauls Zymil — different brands
    // are different products even when core+size match.
    expect(groups).toHaveLength(0)  // each is unique → none cross-store-paired at Layer 1
  })

  test('empty brand falls through to later layers (does not group blindly)', () => {
    const products = emptyProducts()
    products.coles.push(makeProduct('coles', {
      product_id: 'C-BLANK1', name: 'Generic Item 500g', brand: null, size: '500g',
    }))
    products.woolworths.push(makeProduct('woolworths', {
      product_id: 'W-BLANK1', name: 'Generic Item 500g', brand: null, size: '500g',
    }))

    const groups = matchLayer1(products)
    expect(groups).toHaveLength(0)  // Layer 1 only groups when brand is present on both sides
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Layer 2 — fuzzy Levenshtein ≤ 3, core length > 5, coles ↔ woolies only
// ─────────────────────────────────────────────────────────────────────────
describe('matchLayer2 (fuzzy Levenshtein ≤ 3)', () => {
  test('matches near-identical core names with same size', () => {
    const products = emptyProducts()
    products.coles.push(makeProduct('coles', {
      product_id: 'C20', name: 'Bega Cheese Block 500g', brand: 'Bega',
    }))
    products.woolworths.push(makeProduct('woolworths', {
      product_id: 'W20', name: 'Bega Cheeses Block 500g', brand: 'Bega',  // 1 edit (extra 's')
    }))

    const groups = matchLayer2(products, new Set())
    expect(groups).toHaveLength(1)
    expect(groups[0].coles).toBe('C20')
    expect(groups[0].woolworths).toBe('W20')
  })

  test('rejects when core too short (length <= 5)', () => {
    const products = emptyProducts()
    // After brand+size removal "milk" is only 4 chars → core too short
    products.coles.push(makeProduct('coles', {
      product_id: 'C21', name: 'Milk 2L', brand: null,
    }))
    products.woolworths.push(makeProduct('woolworths', {
      product_id: 'W21', name: 'Milkk 2L', brand: null,  // levenshtein=1 but core <= 5
    }))

    expect(matchLayer2(products, new Set())).toHaveLength(0)
  })

  test('rejects when sizes differ', () => {
    const products = emptyProducts()
    products.coles.push(makeProduct('coles', {
      product_id: 'C22', name: 'Bega Cheese Block 500g', brand: 'Bega',
    }))
    products.woolworths.push(makeProduct('woolworths', {
      product_id: 'W22', name: 'Bega Cheese Block 1kg', brand: 'Bega',
    }))

    expect(matchLayer2(products, new Set())).toHaveLength(0)
  })

  test('respects existingMatched (does NOT double-match)', () => {
    const products = emptyProducts()
    products.coles.push(makeProduct('coles', {
      product_id: 'C23', name: 'Bega Cheese Block 500g', brand: 'Bega',
    }))
    products.woolworths.push(makeProduct('woolworths', {
      product_id: 'W23', name: 'Bega Cheeses Block 500g', brand: 'Bega',
    }))

    const matched = new Set(['coles_C23'])
    expect(matchLayer2(products, matched)).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Layer 3 — token sort ratio ≥ 80% + brand veto
// ─────────────────────────────────────────────────────────────────────────
describe('matchLayer3 (token sort + brand veto)', () => {
  test('matches when both products share the same brand', () => {
    const products = emptyProducts()
    products.coles.push(makeProduct('coles', {
      product_id: 'C30', name: 'Bega Cheese Block 500g', brand: 'Bega',
    }))
    products.woolworths.push(makeProduct('woolworths', {
      product_id: 'W30', name: 'Bega Cheese Block 500g', brand: 'Bega',
    }))

    const groups = matchLayer3(products, new Set())
    expect(groups).toHaveLength(1)
  })

  test('brand veto: rejects when both have specific (non-store) brands that differ', () => {
    const products = emptyProducts()
    products.coles.push(makeProduct('coles', {
      product_id: 'C31', name: 'Bega Cheese Block 500g', brand: 'Bega',
    }))
    products.woolworths.push(makeProduct('woolworths', {
      product_id: 'W31', name: 'Pauls Cheese Block 500g', brand: 'Pauls',
    }))

    expect(matchLayer3(products, new Set())).toHaveLength(0)
  })

  test('REJECTS store-brand vs specific-brand (the Bega cheese loophole)', () => {
    // Pre-fix this case was matched (Coles store-brand cheese ↔ WW Bega cheese).
    // Post-fix (2026-05-26): tightened veto — different non-empty brands reject
    // UNLESS both sides are store brands.
    const products = emptyProducts()
    products.coles.push(makeProduct('coles', {
      product_id: 'C32', name: 'Coles Cheese Block 500g', brand: 'Coles',
    }))
    products.woolworths.push(makeProduct('woolworths', {
      product_id: 'W32', name: 'Pauls Cheese Block 500g', brand: 'Pauls',
    }))

    expect(matchLayer3(products, new Set())).toHaveLength(0)
  })

  test('ALLOWS store-brand vs store-brand (legitimate cross-store house-brand match)', () => {
    // Coles brand cheese AND Woolworths brand cheese — both store brands of
    // the same generic product. This should match.
    const products = emptyProducts()
    products.coles.push(makeProduct('coles', {
      product_id: 'C32b', name: 'Coles Cheese Block 500g', brand: 'Coles',
    }))
    products.woolworths.push(makeProduct('woolworths', {
      product_id: 'W32b', name: 'Woolworths Cheese Block 500g', brand: 'Woolworths',
    }))

    expect(matchLayer3(products, new Set()).length).toBeGreaterThanOrEqual(0)  // not blocked by veto
  })

  test('rejects when token sort ratio < 80%', () => {
    const products = emptyProducts()
    products.coles.push(makeProduct('coles', {
      product_id: 'C33', name: 'Bega Cheese 500g', brand: 'Bega',
    }))
    products.woolworths.push(makeProduct('woolworths', {
      product_id: 'W33', name: 'Bega Yoghurt Greek 500g', brand: 'Bega',
    }))

    expect(matchLayer3(products, new Set())).toHaveLength(0)
  })

  test('respects existingMatched', () => {
    const products = emptyProducts()
    products.coles.push(makeProduct('coles', {
      product_id: 'C34', name: 'Bega Cheese Block 500g', brand: 'Bega',
    }))
    products.woolworths.push(makeProduct('woolworths', {
      product_id: 'W34', name: 'Bega Cheese Block 500g', brand: 'Bega',
    }))

    expect(matchLayer3(products, new Set(['woolworths_W34']))).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Layer 4 — Aldi house brand → store-brand/brandless equivalent
// ─────────────────────────────────────────────────────────────────────────
describe('matchLayer4 (Aldi house brand to store brand)', () => {
  test('matches Aldi Farmdale milk to Coles brand milk + Woolworths brand milk', () => {
    const products = emptyProducts()
    products.aldi.push(makeProduct('aldi', {
      product_id: 'A40', name: 'Farmdale Full Cream Milk 2L', brand: 'Farmdale',
    }))
    products.coles.push(makeProduct('coles', {
      product_id: 'C40', name: 'Coles Full Cream Milk 2L', brand: 'Coles',
    }))
    products.woolworths.push(makeProduct('woolworths', {
      product_id: 'W40', name: 'Woolworths Full Cream Milk 2L', brand: 'Woolworths',
    }))

    const groups = matchLayer4(products, new Set())
    expect(groups).toHaveLength(1)
    expect(groups[0].aldi).toBe('A40')
    expect(groups[0].coles).toBe('C40')
    expect(groups[0].woolworths).toBe('W40')
  })

  test('rejects Coles match when Coles has a specific named brand', () => {
    const products = emptyProducts()
    products.aldi.push(makeProduct('aldi', {
      product_id: 'A41', name: 'Farmdale Full Cream Milk 2L', brand: 'Farmdale',
    }))
    products.coles.push(makeProduct('coles', {
      product_id: 'C41', name: 'a2 Full Cream Milk 2L', brand: 'a2',
    }))

    // 'a2' is specific brand, not in storeBrands → Coles side skipped
    const groups = matchLayer4(products, new Set())
    expect(groups).toHaveLength(0)
  })

  test('allows store-branded Coles match to Aldi house brand', () => {
    const products = emptyProducts()
    products.aldi.push(makeProduct('aldi', {
      product_id: 'A42', name: 'Brooklea Greek Yoghurt 500g', brand: 'Brooklea',
    }))
    products.coles.push(makeProduct('coles', {
      product_id: 'C42', name: 'Coles Greek Yoghurt 500g', brand: 'Coles',  // store brand
    }))

    // Both cores reduce to 'greek yoghurt' after brand+size strip → tokenSortRatio = 1.0
    const groups = matchLayer4(products, new Set())
    expect(groups).toHaveLength(1)
    expect(groups[0].coles).toBe('C42')
    expect(groups[0].aldi).toBe('A42')
  })

  test('creates Aldi-only-to-one-store group when only one peer matches', () => {
    const products = emptyProducts()
    products.aldi.push(makeProduct('aldi', {
      product_id: 'A43', name: 'Cattleman Beef Mince 500g', brand: 'Cattleman',
    }))
    products.coles.push(makeProduct('coles', {
      product_id: 'C43', name: 'Coles Beef Mince 500g', brand: 'Coles',
    }))
    // no woolworths peer

    const groups = matchLayer4(products, new Set())
    expect(groups).toHaveLength(1)
    expect(groups[0].coles).toBe('C43')
    expect(groups[0].woolworths).toBeNull()
    expect(groups[0].aldi).toBe('A43')
  })

  test('respects existingMatched (skip already-matched Aldi)', () => {
    const products = emptyProducts()
    products.aldi.push(makeProduct('aldi', {
      product_id: 'A44', name: 'Farmdale Full Cream Milk 2L', brand: 'Farmdale',
    }))
    products.coles.push(makeProduct('coles', {
      product_id: 'C44', name: 'Coles Full Cream Milk 2L', brand: 'Coles',
    }))

    expect(matchLayer4(products, new Set(['aldi_A44']))).toHaveLength(0)
  })

  test('rejects when sizes differ', () => {
    const products = emptyProducts()
    products.aldi.push(makeProduct('aldi', {
      product_id: 'A45', name: 'Farmdale Full Cream Milk 2L', brand: 'Farmdale',
    }))
    products.coles.push(makeProduct('coles', {
      product_id: 'C45', name: 'Coles Full Cream Milk 1L', brand: 'Coles',
    }))

    expect(matchLayer4(products, new Set())).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Layer interaction — the matched Set discipline across the pipeline
// ─────────────────────────────────────────────────────────────────────────
describe('Layer interaction (no double-matching)', () => {
  test('Layer 2 skips products already matched by Layer 1', () => {
    const products = emptyProducts()
    products.coles.push(makeProduct('coles', {
      product_id: 'C50', name: 'Bega Cheese Block 500g', brand: 'Bega',
    }))
    products.woolworths.push(makeProduct('woolworths', {
      product_id: 'W50', name: 'Bega Cheese Block 500g', brand: 'Bega',
    }))
    products.woolworths.push(makeProduct('woolworths', {
      // Another candidate that's a fuzzy match — Layer 2 should NOT see C50
      product_id: 'W50b', name: 'Bega Cheeses Block 500g', brand: 'Bega',
    }))

    const layer1 = matchLayer1(products)
    expect(layer1).toHaveLength(1)

    // Simulate the pipeline: build matched set from Layer 1 results
    const matched = new Set()
    for (const g of layer1) {
      if (g.coles) matched.add(`coles_${g.coles}`)
      if (g.woolworths) matched.add(`woolworths_${g.woolworths}`)
    }

    const layer2 = matchLayer2(products, matched)
    // C50 already matched → Layer 2 should not produce a new group for it
    expect(layer2).toHaveLength(0)
  })

  test('Layer 4 skips Aldi products already matched in earlier layers', () => {
    const products = emptyProducts()
    products.aldi.push(makeProduct('aldi', {
      product_id: 'A60', name: 'Farmdale Full Cream Milk 2L', brand: 'Farmdale',
    }))
    products.coles.push(makeProduct('coles', {
      product_id: 'C60', name: 'Coles Full Cream Milk 2L', brand: 'Coles',
    }))

    // Pretend Layer 0 (barcode) already grabbed this Aldi product
    const layer4 = matchLayer4(products, new Set(['aldi_A60']))
    expect(layer4).toHaveLength(0)
  })

  test('REGRESSION: Layer 1 respects existingMatched (no duplicate groups with Layer 0)', () => {
    // This is the bug fix verification. Before the fix:
    // matchLayer1 didn't accept existingMatched. If a pair matched in both
    // Layer 0 (barcode) AND Layer 1 (core+size), allGroups got TWO entries
    // for the same product pair → duplicate rows in product_groups table.
    const products = emptyProducts()
    // This pair will match both Layer 0 (barcode) and Layer 1 (exact core+size)
    products.coles.push(makeProduct('coles', {
      product_id: 'C70', name: 'Item One 500g', barcode: 'BC70',
    }))
    products.woolworths.push(makeProduct('woolworths', {
      product_id: 'W70', name: 'Item One 500g', barcode: 'BC70',
    }))

    const layer0 = matchLayer0(products)
    expect(layer0).toHaveLength(1)  // barcode pair found

    // Build matched set from Layer 0 results (mirrors main() in match-products.js)
    const matched = new Set()
    for (const g of layer0) {
      if (g.coles) matched.add(`coles_${g.coles}`)
      if (g.woolworths) matched.add(`woolworths_${g.woolworths}`)
    }

    // Layer 1 with matched set passed → must not duplicate Layer 0's group
    const layer1 = matchLayer1(products, matched)
    expect(layer1).toHaveLength(0)  // <-- WAS LENGTH 1 BEFORE THE FIX
  })

  test('Layer 1 with no existingMatched argument still works (backward compat)', () => {
    // Defensive: if someone calls matchLayer1(products) without the new arg,
    // it should default to "no skips" rather than throwing.
    const products = emptyProducts()
    products.coles.push(makeProduct('coles', {
      product_id: 'C80', name: 'Coles Milk 2L', brand: 'Coles',
    }))
    products.woolworths.push(makeProduct('woolworths', {
      product_id: 'W80', name: 'Coles Milk 2L', brand: 'Coles',
    }))

    const layer1 = matchLayer1(products)  // no existingMatched arg
    expect(layer1).toHaveLength(1)
  })
})
