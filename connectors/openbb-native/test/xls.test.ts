import { describe, expect, it } from 'vitest'
import { isXls, readXls } from '../src/lib/xls.js'

// A tiny BIFF8 workbook in an OLE2 container, built by hand: one FAT sector, one directory sector, then the stream.
const u16 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff]
const u32 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]
const f64 = (n: number): number[] => [...new Uint8Array(new Float64Array([n]).buffer)]
const record = (type: number, data: number[]): number[] => [...u16(type), ...u16(data.length), ...data]
const text = (s: string): number[] => [...s].map((c) => c.charCodeAt(0))
const wide = (s: string): number[] => [...s].flatMap((c) => u16(c.charCodeAt(0)))

function workbook(): Uint8Array {
  const bof = (type: number) => record(0x0809, [...u16(0x0600), ...u16(type), ...u16(0), ...u16(0), ...u32(0), ...u32(0)])
  const xf = (ifmt: number) => record(0x00e0, [...u16(0), ...u16(ifmt), ...new Array<number>(16).fill(0)])
  // Shared strings: "alpha", a wide "βeta", and a string broken over a CONTINUE record.
  const sst = record(0x00fc, [...u32(3), ...u32(3), ...u16(5), 0, ...text('alpha'), ...u16(4), 1, ...wide('βeta'), ...u16(6), 0, ...text('spl')])
  const cont = record(0x003c, [0, ...text('ice')])
  const globalsBody = (offset: number): number[] => [
    ...bof(0x0005),
    ...record(0x0022, u16(0)),
    ...record(0x041e, [...u16(164), ...u16(10), 0, ...text('yyyy-mm-dd')]),
    ...xf(0),
    ...xf(14),
    ...xf(164),
    ...sst,
    ...cont,
    ...record(0x00eb, new Array<number>(6000).fill(0)),
    ...record(0x0085, [...u32(offset), 0, 0, 4, 0, ...text('Data')]),
    ...record(0x000a, []),
  ]
  const sheet = [
    ...bof(0x0010),
    ...record(0x0203, [...u16(0), ...u16(0), ...u16(0), ...f64(1.5)]),
    ...record(0x00fd, [...u16(0), ...u16(1), ...u16(0), ...u32(0)]),
    ...record(0x027e, [...u16(1), ...u16(0), ...u16(0), ...u32((42 << 2) | 2)]),
    ...record(0x00bd, [...u16(1), ...u16(1), ...u16(0), ...u32((7 << 2) | 2), ...u16(0), ...u32((1234 << 2) | 3), ...u16(2)]),
    ...record(0x0203, [...u16(2), ...u16(0), ...u16(1), ...f64(46296)]),
    ...record(0x0203, [...u16(2), ...u16(1), ...u16(2), ...f64(46297)]),
    ...record(0x00fd, [...u16(2), ...u16(2), ...u16(0), ...u32(1)]),
    ...record(0x00fd, [...u16(2), ...u16(3), ...u16(0), ...u32(2)]),
    ...record(0x0006, [...u16(3), ...u16(0), ...u16(0), ...f64(2.5), ...u16(0), ...u32(0)]),
    ...record(0x0006, [...u16(3), ...u16(1), ...u16(0), 1, 0, 1, 0, 0, 0, 0xff, 0xff, ...u16(0), ...u32(0)]),
    ...record(0x0205, [...u16(3), ...u16(2), ...u16(0), 0x2a, 1]),
    ...record(0x000a, []),
  ]
  const offset = globalsBody(0).length
  const stream = [...globalsBody(offset), ...sheet]

  const sectors = Math.ceil(stream.length / 512)
  const out = new Uint8Array(512 * (3 + sectors))
  const head = new DataView(out.buffer)
  out.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0)
  head.setUint16(0x18, 0x3e, true)
  head.setUint16(0x1a, 3, true)
  head.setUint16(0x1c, 0xfffe, true)
  head.setUint16(0x1e, 9, true)
  head.setUint16(0x20, 6, true)
  head.setUint32(0x2c, 1, true)
  head.setUint32(0x30, 1, true)
  head.setUint32(0x38, 4096, true)
  head.setUint32(0x3c, 0xfffffffe, true)
  head.setUint32(0x40, 0, true)
  head.setUint32(0x44, 0xfffffffe, true)
  head.setUint32(0x48, 0, true)
  for (let i = 0; i < 109; i++) head.setUint32(0x4c + i * 4, i === 0 ? 0 : 0xffffffff, true)
  // sector 0: the FAT
  const fat = new DataView(out.buffer, 512, 512)
  for (let i = 0; i < 128; i++) fat.setUint32(i * 4, 0xffffffff, true)
  fat.setUint32(0, 0xfffffffd, true)
  fat.setUint32(4, 0xfffffffe, true)
  for (let i = 0; i < sectors; i++) fat.setUint32((2 + i) * 4, i === sectors - 1 ? 0xfffffffe : 3 + i, true)
  // sector 1: the directory
  const dir = new DataView(out.buffer, 1024, 512)
  const entry = (at: number, name: string, type: number, start: number, size: number) => {
    for (let i = 0; i < name.length; i++) dir.setUint16(at + i * 2, name.charCodeAt(i), true)
    dir.setUint16(at + 0x40, (name.length + 1) * 2, true)
    dir.setUint8(at + 0x42, type)
    dir.setUint32(at + 0x74, start, true)
    dir.setUint32(at + 0x78, size, true)
  }
  entry(0, 'Root Entry', 5, 0xfffffffe, 0)
  entry(128, 'Workbook', 2, 2, stream.length)
  out.set(stream, 512 * 3)
  return out
}

describe('xls', () => {
  it('reads strings (also split over CONTINUE), numbers, RK, formulas, errors and date-formatted cells', () => {
    const bytes = workbook()
    expect(isXls(bytes)).toBe(true)
    const sheets = readXls(bytes)
    expect(sheets.map((s) => s.name)).toEqual(['Data'])
    expect(sheets[0]!.rows).toEqual([
      [1.5, 'alpha'],
      [42, 7, 12.34],
      ['2026-10-01', '2026-10-02', 'βeta', 'splice'],
      [2.5, true, '#N/A'],
    ])
  })

  it('rejects a zip', () => {
    expect(isXls(new Uint8Array([0x50, 0x4b, 3, 4]))).toBe(false)
    expect(() => readXls(new Uint8Array(600))).toThrow()
  })
})
