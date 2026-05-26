import { describe, test, expect } from 'vitest'
import mp from '../match-products.js'

const {
  HOUSE_BRANDS,
  normalize,
  extractSize,
  extractCoreName,
  tokenize,
  tokenSortRatio,
  tokenOverlap,
  levenshtein,
} = mp

describe('normalize (in match-products.js)', () => {
  test('lowercases and collapses whitespace', () => {
    expect(normalize('  Bega   Cheese  ')).toBe('bega cheese')
  })

  test('replaces ampersand and smart quotes with space (NOT removed)', () => {
    // distinct from db.js normalizeName which REMOVES them
    expect(normalize('Salt & Pepper')).toBe('salt pepper')
    expect(normalize(`Bird's Eye`)).toBe('bird s eye')
  })

  test('handles null/undefined/empty', () => {
    expect(normalize(null)).toBe('')
    expect(normalize(undefined)).toBe('')
    expect(normalize('')).toBe('')
  })
})

describe('levenshtein', () => {
  test('identical strings have distance 0', () => {
    expect(levenshtein('cheese', 'cheese')).toBe(0)
    expect(levenshtein('', '')).toBe(0)
  })

  test('empty string distance equals other string length', () => {
    expect(levenshtein('', 'abc')).toBe(3)
    expect(levenshtein('abc', '')).toBe(3)
  })

  test('single-character edits', () => {
    expect(levenshtein('cat', 'bat')).toBe(1)  // substitution
    expect(levenshtein('cat', 'cats')).toBe(1) // insertion
    expect(levenshtein('cats', 'cat')).toBe(1) // deletion
  })

  test('multi-character distance (cheese vs cheez = 2)', () => {
    // delete final 'e' + substitute 's' -> 'z' = 2 edits
    expect(levenshtein('cheese', 'cheez')).toBe(2)
  })

  test('is symmetric', () => {
    expect(levenshtein('coles milk', 'woolies milk')).toBe(
      levenshtein('woolies milk', 'coles milk')
    )
  })
})

describe('tokenize', () => {
  test('splits on whitespace and keeps words length > 2', () => {
    expect(tokenize('the quick brown fox')).toEqual(['the', 'quick', 'brown', 'fox'])
  })

  test('filters out 1 and 2 char tokens', () => {
    // length > 2 filter — 'a' (1), 'bc' (2) excluded; 'def' (3) included
    expect(tokenize('a bc def ghij')).toEqual(['def', 'ghij'])
  })

  test('lowercases', () => {
    expect(tokenize('BEGA Cheese')).toEqual(['bega', 'cheese'])
  })

  test('empty / whitespace-only inputs', () => {
    expect(tokenize('')).toEqual([])
    expect(tokenize('   ')).toEqual([])
  })
})

describe('tokenSortRatio', () => {
  test('returns 1 for word-permutations (key property!)', () => {
    // "cheese block bega" vs "bega cheese block" — same tokens, different order
    expect(tokenSortRatio('cheese block bega', 'bega cheese block')).toBe(1)
  })

  test('returns 1 for identical strings', () => {
    expect(tokenSortRatio('coles milk 2l', 'coles milk 2l')).toBe(1)
  })

  test('returns 0 when one side has no tokens > 2 chars', () => {
    expect(tokenSortRatio('a b c', 'cheese')).toBe(0)
  })

  test('partial overlap gives a value between 0 and 1', () => {
    const r = tokenSortRatio('bega cheese block 500g', 'bega cheese slice 500g')
    expect(r).toBeGreaterThan(0)
    expect(r).toBeLessThan(1)
  })
})

describe('tokenOverlap', () => {
  test('full overlap = 1', () => {
    expect(tokenOverlap('cheese bega', 'bega cheese')).toBe(1)
  })

  test('half overlap', () => {
    // {cheese, bega} vs {cheese, fish} — intersection={cheese}=1, min=2 → 0.5
    expect(tokenOverlap('cheese bega', 'cheese fish')).toBe(0.5)
  })

  test('zero overlap', () => {
    expect(tokenOverlap('cheese bega', 'milk farmdale')).toBe(0)
  })

  test('empty sets return 0', () => {
    expect(tokenOverlap('', '')).toBe(0)
    expect(tokenOverlap('a b', '')).toBe(0)  // 'a' and 'b' filtered (<=2 chars), set empty
  })
})

describe('extractSize', () => {
  test('prefers explicit size field over name regex', () => {
    expect(extractSize('Milk 2L', '500ml')).toBe('500ml')
  })

  test('extracts size from product name when field absent', () => {
    expect(extractSize('Milk 2L', null)).toBe('2l')
    expect(extractSize('Bega Cheese 500g', null)).toBe('500g')
    expect(extractSize('Toilet Paper 12 Pack', null)).toBe('12pack')
  })

  test('returns empty string when no size detected', () => {
    expect(extractSize('Loose Apples', null)).toBe('')
  })

  test('lowercases and strips whitespace from explicit size field', () => {
    expect(extractSize('whatever', '500 G')).toBe('500g')
  })
})

describe('extractCoreName', () => {
  test('removes brand and size, leaves the product core', () => {
    expect(extractCoreName('Bega Cheese 500g', 'Bega')).toBe('cheese')
  })

  test('removes filler words (the, of, with, etc.)', () => {
    expect(extractCoreName('The Best of Cheese', null)).toBe('best cheese')
  })

  test('handles missing brand', () => {
    expect(extractCoreName('Cheese Block 500g', null)).toBe('cheese block')
  })
})

describe('HOUSE_BRANDS dictionary (Aldi domain knowledge — locks core mappings)', () => {
  test('Aldi dairy/milk brands map correctly', () => {
    expect(HOUSE_BRANDS['farmdale']).toBe('milk')
    expect(HOUSE_BRANDS['cowbelle']).toBe('dairy')
    expect(HOUSE_BRANDS['brooklea']).toBe('yoghurt')
    expect(HOUSE_BRANDS['westacre']).toBe('dairy')
  })

  test('Aldi pantry brands map correctly', () => {
    expect(HOUSE_BRANDS['remano']).toBe('pasta')
    expect(HOUSE_BRANDS['belmont']).toBe('biscuits')
    expect(HOUSE_BRANDS['baker life']).toBe('bread')
    expect(HOUSE_BRANDS['sakata']).toBe('crackers')
  })

  test('Aldi meat brands map correctly', () => {
    expect(HOUSE_BRANDS['cattleman']).toBe('beef')
    expect(HOUSE_BRANDS['brannans']).toBe('butchery')
    expect(HOUSE_BRANDS['berg']).toBe('smallgoods')
    expect(HOUSE_BRANDS['ocean rise']).toBe('seafood')
  })

  test('all keys are lowercase (no accidental capitalisation)', () => {
    for (const key of Object.keys(HOUSE_BRANDS)) {
      expect(key).toBe(key.toLowerCase())
    }
  })

  test('all keys are non-empty strings', () => {
    for (const key of Object.keys(HOUSE_BRANDS)) {
      expect(typeof key).toBe('string')
      expect(key.length).toBeGreaterThan(0)
      expect(key.trim()).toBe(key)  // no leading/trailing whitespace
    }
  })

  test('all values are non-empty generic categories', () => {
    for (const [key, value] of Object.entries(HOUSE_BRANDS)) {
      expect(typeof value).toBe('string')
      expect(value.length).toBeGreaterThan(0)
    }
  })

  test('dictionary size baseline (regression alarm if entries are deleted)', () => {
    // Locks current state — if you delete entries, this test fires to confirm intent
    const count = Object.keys(HOUSE_BRANDS).length
    expect(count).toBeGreaterThanOrEqual(30)
  })
})
