import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { zipMemberLines } from '../src/lib/zip.js'

function lines(zip: Uint8Array, pick: (name: string) => boolean = () => true): { name: string | undefined; lines: string[] } {
  const out: string[] = []
  const name = zipMemberLines(zip, pick, (l) => out.push(l))
  return { name, lines: out }
}

describe('zipMemberLines', () => {
  it('reads the picked member line by line, with LF, CRLF, a BOM and no final newline', () => {
    const zip = zipSync({ 'readme.txt': strToU8('skip me\n'), 'data.csv': strToU8('﻿a,b\r\n1,2\n\n3,é\r\n4,5') })
    expect(lines(zip, (n) => n.endsWith('.csv'))).toEqual({ name: 'data.csv', lines: ['a,b', '1,2', '', '3,é', '4,5'] })
  })

  it('streams a member larger than the inflate step without losing a line at a chunk boundary', () => {
    const rows = Array.from({ length: 60_000 }, (_, i) => `AE,2002-${String((i % 12) + 1).padStart(2, '0')},CRUDEOIL,INDPROD,KBD,${i}.5000,1`)
    const text = rows.join('\n') + '\n'
    expect(text.length).toBeGreaterThan(2_000_000)
    // Level 0 stores the member, so the archive is as large as the text and spans many 64 KB steps.
    const zip = zipSync({ 'big.csv': [strToU8(text), { level: 0 }] })
    const got = lines(zip)
    expect(got.lines.length).toBe(rows.length)
    expect(got.lines[0]).toBe(rows[0])
    expect(got.lines.at(-1)).toBe(rows.at(-1))
    expect(got.lines.every((l, i) => l === rows[i])).toBe(true)
  })

  it('reports no member when none matches', () => {
    expect(lines(zipSync({ 'a.txt': strToU8('x\n') }), (n) => n.endsWith('.csv'))).toEqual({ name: undefined, lines: [] })
  })
})
