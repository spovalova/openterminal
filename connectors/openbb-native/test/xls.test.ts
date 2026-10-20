import { describe, expect, it } from 'vitest'
import { quotePlus, urlencode } from '../src/lib/urlencode.js'
import { readCompoundStream, readXls } from '../src/lib/xls.js'

// ---- a small writer for the formats the reader parses: BIFF8 records inside an OLE2 compound file ----

const u16 = (n: number) => [n & 0xff, (n >> 8) & 0xff]
const u32 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]
const f64 = (n: number) => {
  const b = new DataView(new ArrayBuffer(8))
  b.setFloat64(0, n, true)
  return [...new Uint8Array(b.buffer)]
}
const rec = (id: number, payload: number[]) => [...u16(id), ...u16(payload.length), ...payload]
const latin1 = (s: string) => [...s].map((c) => c.charCodeAt(0))
const utf16 = (s: string) => [...s].flatMap((c) => u16(c.charCodeAt(0)))
/** A BIFF8 string: character count, flags, characters. */
const str = (s: string, bytes: 1 | 2 = 2) => {
  const wide = [...s].some((c) => c.charCodeAt(0) > 255)
  return [...(bytes === 1 ? [s.length] : u16(s.length)), wide ? 1 : 0, ...(wide ? utf16(s) : latin1(s))]
}
const rk = (n: number) => u32(((n << 2) | 2) >>> 0)
const rk100 = (n: number) => u32(((Math.round(n * 100) << 2) | 3) >>> 0)
const cell = (id: number, row: number, col: number, xf: number, rest: number[]) => rec(id, [...u16(row), ...u16(col), ...u16(xf), ...rest])

const BOF = (type: number) => rec(0x0809, [...u16(0x0600), ...u16(type), ...u16(0), ...u16(0), ...u32(0), ...u32(6)])
const EOF = rec(0x000a, [])

function workbook(options: { datemode?: number; pad?: number } = {}): number[] {
  const strings = ['Sourcekey', 'x'.repeat(300), 'Dépôt €', 'Data 1: Stocks']
  // The string table, split across a CONTINUE record in the middle of the long string.
  const sstBody = [...u32(strings.length), ...u32(strings.length), ...strings.slice(0, 1).flatMap((s) => str(s)), ...u16(300), 0, ...latin1('x'.repeat(100))]
  const sstContinue = [0, ...latin1('x'.repeat(200)), ...strings.slice(2).flatMap((s) => str(s))]
  const globals = [
    ...BOF(5),
    ...rec(0x0022, u16(options.datemode ?? 0)),
    ...rec(0x041e, [...u16(164), ...str('0.00')]),
    ...rec(0x041e, [...u16(165), ...str('dd/mm/yyyy')]),
    ...[0, 14, 164, 165].flatMap((format) => rec(0x00e0, [...u16(0), ...u16(format), ...new Array(16).fill(0)])),
    ...rec(0x00fc, sstBody),
    ...rec(0x003c, sstContinue),
  ]
  const boundsheet = (name: string, position: number) => rec(0x0085, [...u32(position), 0, 0, ...str(name, 1)])
  const sheetNames = ['Data 1', 'Empty']
  const globalsLength = globals.length + sheetNames.reduce((n, name) => n + boundsheet(name, 0).length, 0) + EOF.length
  const sheet1 = [
    ...BOF(0x10),
    ...cell(0x00fd, 0, 0, 0, u32(0)), // Sourcekey
    ...cell(0x00fd, 0, 1, 0, u32(1)), // the long string that crosses the CONTINUE
    ...cell(0x00fd, 0, 2, 0, u32(2)), // wide characters
    ...cell(0x00fd, 0, 3, 0, u32(3)),
    ...cell(0x0203, 1, 0, 1, f64(46296)), // a date, by number format 14
    ...cell(0x0203, 1, 1, 0, f64(4.25)),
    ...cell(0x027e, 1, 2, 0, rk(42)),
    ...cell(0x027e, 1, 3, 0, rk100(12.34)),
    ...rec(0x00bd, [...u16(2), ...u16(0), ...u16(0), ...rk(1), ...u16(0), ...rk(2), ...u16(0), ...rk(3), ...u16(2)]), // columns 0..2
    ...cell(0x0204, 3, 0, 0, str('plain label')),
    ...cell(0x0006, 3, 1, 0, [...f64(7.5), ...u16(0), ...u32(0), ...u32(0)]), // a numeric formula
    ...cell(0x0006, 3, 2, 0, [0, 0, 0, 0, 0, 0, 0xff, 0xff, ...u16(0), ...u32(0), ...u32(0)]), // a text formula ...
    ...rec(0x0207, str('from formula')), // ... and its text
    ...cell(0x0006, 3, 3, 0, [1, 0, 1, 0, 0, 0, 0xff, 0xff, ...u16(0), ...u32(0), ...u32(0)]), // a boolean formula
    ...cell(0x0205, 4, 0, 0, [1, 0]), // TRUE
    ...cell(0x0205, 4, 1, 0, [0x2a, 1]), // #N/A
    ...cell(0x0203, 4, 2, 3, f64(46296)), // custom date format dd/mm/yyyy
    ...cell(0x0203, 4, 3, 2, f64(46296)), // custom number format 0.00: a number
    ...cell(0x0203, 5, 0, 1, f64(46296.75)), // a date with a time
    ...EOF,
  ]
  const sheet2 = [...BOF(0x10), ...EOF]
  const at1 = globalsLength
  const at2 = at1 + sheet1.length
  const out = [...globals, ...boundsheet('Data 1', at1), ...boundsheet('Empty', at2), ...EOF, ...sheet1, ...sheet2]
  // A stream under 4096 bytes lives in the mini stream; padding with an unknown record moves it to the main FAT.
  return options.pad ? [...out, ...rec(0x1234, new Array(options.pad).fill(0))] : out
}

/** The stream in an OLE2 compound file: in 512-byte sectors, or (when small) in 64-byte mini sectors. */
function compound(stream: number[]): Uint8Array {
  const pad = (a: number[], to: number) => [...a, ...new Array((to - (a.length % to)) % to).fill(0)]
  const ENDCHAIN = 0xfffffffe
  const entry = (name: string, type: number, start: number, size: number) => {
    const nameBytes = utf16(name)
    return [...nameBytes, ...new Array(64 - nameBytes.length).fill(0), ...u16(nameBytes.length + 2), type, 1, ...u32(0xffffffff), ...u32(0xffffffff), ...u32(0xffffffff), ...new Array(36).fill(0), ...u32(start), ...u32(size), ...u32(0)]
  }
  const big = stream.length >= 4096
  const header = (nMini: number, firstMini: number) => [
    0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, ...new Array(16).fill(0), ...u16(0x3e), ...u16(3), ...u16(0xfffe), ...u16(9), ...u16(6), ...new Array(6).fill(0),
    ...u32(0), ...u32(1), ...u32(1), ...u32(0), ...u32(4096), ...u32(firstMini), ...u32(nMini), ...u32(ENDCHAIN), ...u32(0), ...u32(0), ...new Array(108 * 4).fill(0xff),
  ]
  if (big) {
    const data = pad(stream, 512)
    const n = data.length / 512
    const fat = [0xfffffffd, ENDCHAIN, ...Array.from({ length: n }, (_, i) => (i === n - 1 ? ENDCHAIN : 3 + i))]
    const dir = pad([...entry('Root Entry', 5, ENDCHAIN, 0), ...entry('Workbook', 2, 2, stream.length)], 512)
    return new Uint8Array([...header(0, ENDCHAIN), ...pad(fat.flatMap(u32), 512), ...dir, ...data])
  }
  const mini = pad(stream, 64)
  const nMiniSectors = mini.length / 64
  const miniFat = Array.from({ length: nMiniSectors }, (_, i) => (i === nMiniSectors - 1 ? ENDCHAIN : i + 1))
  const containerSectors = Math.ceil(mini.length / 512)
  const fat = [0xfffffffd, ENDCHAIN, ENDCHAIN, ...Array.from({ length: containerSectors }, (_, i) => (i === containerSectors - 1 ? ENDCHAIN : 4 + i))]
  const dir = pad([...entry('Root Entry', 5, 3, mini.length), ...entry('Workbook', 2, 0, stream.length)], 512)
  return new Uint8Array([...header(1, 2), ...pad(fat.flatMap(u32), 512), ...dir, ...pad(miniFat.flatMap(u32), 512), ...pad(mini, 512)])
}

describe('xls', () => {
  const expected = [
    ['Sourcekey', 'x'.repeat(300), 'Dépôt €', 'Data 1: Stocks'],
    ['2026-10-01', 4.25, 42, 12.34],
    [1, 2, 3],
    ['plain label', 7.5, 'from formula', true],
    [true, null, '2026-10-01', 46296],
    ['2026-10-01T18:00:00'],
  ]

  it('reads strings across CONTINUE records, numbers, RK values, formulas, booleans and dates (main FAT)', () => {
    const sheets = readXls(compound(workbook({ pad: 4200 })))
    expect(sheets.map((s) => s.name)).toEqual(['Data 1', 'Empty'])
    expect(sheets[0]!.rows).toEqual(expected)
    expect(sheets[1]!.rows).toEqual([])
  })

  it('reads a workbook small enough to live in the mini stream', () => {
    const bytes = workbook()
    expect(bytes.length).toBeLessThan(4096)
    const stream = readCompoundStream(compound(bytes))
    expect([...stream]).toEqual(bytes)
    expect(readXls(compound(bytes))[0]!.rows).toEqual(expected)
  })

  it('counts dates from 1904 when the workbook says so', () => {
    expect(readXls(compound(workbook({ datemode: 1 })))[0]!.rows[1]![0]).toBe('2030-10-02')
  })

  it('refuses what it cannot read', () => {
    expect(() => readXls(new Uint8Array(600))).toThrow('not an OLE2 compound file')
    expect(() => readXls(new Uint8Array(100))).toThrow('not an OLE2 compound file')
  })
})

describe('urlencode', () => {
  it('encodes as Python does: spaces as +, tilde and unreserved characters kept, brackets and stars escaped', () => {
    expect(quotePlus('a b~c*d[e]/f.g-h_i')).toBe('a+b~c%2Ad%5Be%5D%2Ff.g-h_i')
    expect(quotePlus('é€')).toBe('%C3%A9%E2%82%AC')
    expect(urlencode([['api_key', 'K'], ['facets[x][]', 'A B'], ['n', 5]])).toBe('api_key=K&facets%5Bx%5D%5B%5D=A+B&n=5')
    expect(urlencode({ a: 1, b: ['x', 'y'], c: undefined })).toBe('a=1&b=x&b=y&c=None')
    expect(urlencode({ flag: true })).toBe('flag=True')
  })
})
