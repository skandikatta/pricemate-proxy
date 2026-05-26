import { describe, test, expect } from 'vitest'
import db from '../db.js'

const { normalizeName } = db

describe('normalizeName', () => {
  test('lowercases input', () => {
    expect(normalizeName('Bega Cheese')).toBe('bega cheese')
  })

  test('strips straight and smart quotes', () => {
    expect(normalizeName(`Bird's Eye Peas`)).toBe('birds eye peas')
    expect(normalizeName('Bird’s Eye Peas')).toBe('birds eye peas')
    expect(normalizeName('"Premium" Brand')).toBe('premium brand')
    expect(normalizeName('“Premium” Brand')).toBe('premium brand')
  })

  test('collapses runs of whitespace', () => {
    expect(normalizeName('a   b\t\tc\n\nd')).toBe('a b c d')
  })

  test('trims leading and trailing whitespace', () => {
    expect(normalizeName('   coles milk   ')).toBe('coles milk')
  })

  test('handles null and undefined safely', () => {
    expect(normalizeName(null)).toBe('')
    expect(normalizeName(undefined)).toBe('')
    expect(normalizeName('')).toBe('')
  })

  test('preserves units and digits (no aggressive stripping)', () => {
    expect(normalizeName('Milk 2L')).toBe('milk 2l')
    expect(normalizeName('Cheese 500g')).toBe('cheese 500g')
  })

  test('is idempotent (running twice = running once)', () => {
    const input = `  Bird's  Eye  ` + '\t' + 'Peas '
    expect(normalizeName(normalizeName(input))).toBe(normalizeName(input))
  })
})
