import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { zipMemberByRange, zipMemberLines, type RangeGet } from '../src/lib/zip.js'

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

/** A server for one file that understands `bytes=a-b` and `bytes=-n`, and logs what it was asked. */
function server(file: Uint8Array, ranges = true): { get: RangeGet; asked: string[] } {
  const asked: string[] = []
  const get: RangeGet = async (range) => {
    asked.push(range)
    if (!ranges) return { status: 200, body: file }
    const m = /^bytes=(\d*)-(\d*)$/.exec(range)!
    const [from, to] = m[1] === '' ? [Math.max(0, file.length - Number(m[2])), file.length - 1] : [Number(m[1]), Math.min(Number(m[2]), file.length - 1)]
    return { status: 206, body: file.slice(from, to + 1) }
  }
  return { get, asked }
}

describe('zipMemberByRange', () => {
  const members: Record<string, Uint8Array> = {}
  // Noise does not compress, so each member takes its share of the archive.
  const noise = (seed: number, n: number): Uint8Array => {
    const out = new Uint8Array(n)
    let x = seed
    for (let i = 0; i < n; i++) out[i] = (x = (Math.imul(x, 1103515245) + 12345) >>> 0) >>> 16
    return out
  }
  for (let i = 0; i < 12; i++) members[`Country${i}.Dat`] = noise(i + 1, 30_000)
  members['Stored.Dat'] = strToU8('kept as it is')
  const zip = zipSync(Object.fromEntries(Object.entries(members).map(([k, v]) => [k, k === 'Stored.Dat' ? ([v, { level: 0 }] as [Uint8Array, { level: 0 }]) : v])))

  it('reads a member from the end of the archive and its own bytes, in two requests', async () => {
    const s = server(zip)
    const got = await zipMemberByRange(s.get, 'Country7.Dat')
    expect(Buffer.from(got!).equals(Buffer.from(members['Country7.Dat']!))).toBe(true)
    expect(s.asked.length).toBe(2)
    expect(s.asked[0]).toBe('bytes=-65536')
    // The second request asks for far less than the archive.
    const [from, to] = s.asked[1]!.slice(6).split('-').map(Number)
    expect(to! - from! + 1).toBeLessThan(zip.length / 4)
  })

  it('reads a stored member, and fetches a long central directory with a third request', async () => {
    const s = server(zip)
    const got = await zipMemberByRange(s.get, 'Stored.Dat', 40)
    expect(new TextDecoder().decode(got!)).toBe('kept as it is')
    expect(s.asked.length).toBe(3)
  })

  it('returns undefined for an absent member', async () => {
    expect(await zipMemberByRange(server(zip).get, 'Nope.Dat')).toBeUndefined()
  })

  it('falls back to the whole archive when the server ignores ranges', async () => {
    const s = server(zip, false)
    const got = await zipMemberByRange(s.get, 'Country3.Dat')
    expect(Buffer.from(got!).equals(Buffer.from(members['Country3.Dat']!))).toBe(true)
    expect(s.asked.length).toBe(1)
  })
})
