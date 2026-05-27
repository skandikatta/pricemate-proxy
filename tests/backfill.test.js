import { describe, test, expect } from 'vitest'
const mp = require('../match-products')
const { runMatchers, planPassports } = require('../backfill-internal-ids')

const { normalize, extractCoreName, extractSize } = mp

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
    image: partial.image || null,
    barcode: partial.barcode ?? null,
    normalized: normalize(name),
    core: extractCoreName(name, brand),
    sizeNorm: extractSize(name, size),
  }
}

function emptyProducts() {
  return { coles: [], woolworths: [], aldi: [] }
}

describe('Option C backfill — passport+alias grouping', () => {
  test('cross-store barcode match yields ONE passport with both aliases', () => {
    const products = emptyProducts()
    const bc = '9300000000001'
    products.coles.push(makeProduct('coles', {
      product_id: 'C1', name: 'Bega Cheese 500g', brand: 'Bega', barcode: bc,
    }))
    products.woolworths.push(makeProduct('woolworths', {
      product_id: 'W1', name: 'Bega Cheese Block 500g', brand: 'Bega', barcode: bc,
    }))

    const { groups, matched } = runMatchers(products)
    const plan = planPassports(products, groups, matched)

    expect(plan.passports).toHaveLength(1)
    expect(plan.aliases).toHaveLength(2)
    const ids = new Set(plan.aliases.map(a => a.internal_id))
    expect(ids.size).toBe(1)  // same internal_id for both aliases
    const stores = plan.aliases.map(a => a.store).sort()
    expect(stores).toEqual(['coles', 'woolworths'])
  })

  test('genuinely different products with same normalized name are NOT merged (audit-finding protection)', () => {
    // This is the 757caeb false-merge class: "full cream milk" → 14 different
    // vendor_ids across Pauls / a2 / Coles brand / Pura / etc. The match
    // layers gate on brand+size, not just name.
    const products = emptyProducts()
    products.coles.push(makeProduct('coles', {
      product_id: 'C-PAULS', name: 'Pauls Full Cream Milk 2L', brand: 'Pauls',
    }))
    products.coles.push(makeProduct('coles', {
      product_id: 'C-A2', name: 'a2 Full Cream Milk 2L', brand: 'a2',
    }))
    products.woolworths.push(makeProduct('woolworths', {
      product_id: 'W-PAULS', name: 'Pauls Full Cream Milk 2L', brand: 'Pauls',
    }))

    const { groups, matched } = runMatchers(products)
    const plan = planPassports(products, groups, matched)

    // Pauls@coles and Pauls@woolies should share one internal_id (cross-store match)
    // a2@coles stands alone with its own internal_id (no a2 product at woolies)
    expect(plan.passports.length).toBeGreaterThanOrEqual(2)
    expect(plan.aliases.length).toBe(3)

    // No two aliases for different brands should share an internal_id
    const aliasesByPassport = new Map()
    for (const a of plan.aliases) {
      if (!aliasesByPassport.has(a.internal_id)) aliasesByPassport.set(a.internal_id, [])
      aliasesByPassport.get(a.internal_id).push(a)
    }
    for (const [, aliases] of aliasesByPassport) {
      const names = aliases.map(a => a.vendor_name)
      // Any passport that groups multiple aliases must have all aliases for
      // the same canonical product (i.e. brand should agree)
      if (aliases.length > 1) {
        const brandsInThisGroup = new Set(names.map(n => n.split(' ')[0].toLowerCase()))
        expect(brandsInThisGroup.size).toBe(1)
      }
    }
  })

  test('unmatched single-store product gets its own passport', () => {
    const products = emptyProducts()
    products.coles.push(makeProduct('coles', {
      product_id: 'C-LONELY', name: 'Some Coles Exclusive 250g', brand: 'Some',
    }))

    const { groups, matched } = runMatchers(products)
    const plan = planPassports(products, groups, matched)

    expect(plan.passports).toHaveLength(1)
    expect(plan.aliases).toHaveLength(1)
    expect(plan.aliases[0].store).toBe('coles')
    expect(plan.aliases[0].vendor_id).toBe('C-LONELY')
    expect(plan.aliases[0].internal_id).toBe(plan.passports[0].internal_id)
  })

  test('passport metadata carries brand+size from the group member', () => {
    const products = emptyProducts()
    const bc = '9300000000002'
    products.coles.push(makeProduct('coles', {
      product_id: 'C-MILK', name: 'Coles Full Cream Milk 2L', brand: 'Coles', size: '2L', barcode: bc,
    }))
    products.woolworths.push(makeProduct('woolworths', {
      product_id: 'W-MILK', name: 'Woolworths Full Cream Milk 2L', brand: 'Woolworths', size: '2L', barcode: bc,
    }))

    const { groups, matched } = runMatchers(products)
    const plan = planPassports(products, groups, matched)

    expect(plan.passports).toHaveLength(1)
    expect(plan.passports[0].size).toBeTruthy()
    expect(plan.passports[0].barcode).toBe(bc)
  })

  test('every (store, vendor_id) gets exactly one alias — no orphans', () => {
    const products = emptyProducts()
    products.coles.push(makeProduct('coles', { product_id: 'C1', name: 'A 100g', brand: 'A' }))
    products.coles.push(makeProduct('coles', { product_id: 'C2', name: 'B 200g', brand: 'B' }))
    products.woolworths.push(makeProduct('woolworths', { product_id: 'W1', name: 'A 100g', brand: 'A' }))
    products.aldi.push(makeProduct('aldi', { product_id: 'A1', name: 'C 300g', brand: 'C' }))

    const { groups, matched } = runMatchers(products)
    const plan = planPassports(products, groups, matched)

    // 4 products in → 4 alias rows out (regardless of how they grouped)
    expect(plan.aliases).toHaveLength(4)
    const inputKeys = new Set(['coles_C1', 'coles_C2', 'woolworths_W1', 'aldi_A1'])
    const outputKeys = new Set(plan.aliases.map(a => `${a.store}_${a.vendor_id}`))
    expect(outputKeys).toEqual(inputKeys)
  })
})
