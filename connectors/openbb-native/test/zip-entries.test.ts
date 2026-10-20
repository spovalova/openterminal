import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { openZip } from '../src/lib/zip-entries.js'

describe('openZip', () => {
  it('lists members and inflates them one at a time', () => {
    const big = 'x'.repeat(50_000)
    const bytes = zipSync({ 'a/one.xml': strToU8('<bill>1</bill>'), 'two.txt': [strToU8(big), { level: 0 }], 'three.csv': strToU8('a,b\n1,2\n') })
    const zip = openZip(bytes)
    expect(zip.entries.map((e) => e.name)).toEqual(['a/one.xml', 'two.txt', 'three.csv'])
    expect(zip.readText(zip.entries[0]!)).toBe('<bill>1</bill>')
    expect(zip.readText(zip.entries[1]!)).toBe(big)
    expect(zip.readText(zip.entries[2]!)).toBe('a,b\n1,2\n')
  })

  it('rejects data that is not a zip', () => {
    expect(() => openZip(new Uint8Array(100))).toThrow(/not a zip/)
  })
})
