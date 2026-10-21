// The small shared helper the metadata commands sort with.
import { describe, expect, it } from 'vitest'
import { compareText } from '../src/lib/compare-text.js'

describe('compareText', () => {
  it('orders text as Python does, by code point', () => {
    expect(['b', 'B', 'a', 'é', 'Z', '_'].sort(compareText)).toEqual(['B', 'Z', '_', 'a', 'b', 'é'])
    expect(compareText('abc', 'abd')).toBe(-1)
    expect(compareText('abc', 'abc')).toBe(0)
    expect(compareText('abcd', 'abc')).toBeGreaterThan(0)
    expect(compareText('', 'a')).toBeLessThan(0)
  })

  it('puts a character beyond U+FFFF after one in U+E000-U+FFFF, which UTF-16 order does not', () => {
    const astral = '\u{1F600}' // a surrogate pair, D83D DE00
    const bmp = '�'
    expect(astral < bmp).toBe(true)
    expect(compareText(astral, bmp)).toBe(1)
    expect(compareText(bmp, astral)).toBe(-1)
    expect(compareText(`a${astral}`, `a${astral}b`)).toBeLessThan(0)
  })
})
