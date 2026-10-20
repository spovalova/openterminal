// The legacy .xls reader used by the usda ports (src/usda/xls.ts), on workbooks built here: an OLE2 compound file around a BIFF8 stream.
import { describe, expect, it } from 'vitest'
import { isXls, readXls } from '../src/usda/xls.js'

const u16 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff]
const u32 = (n: number): number[] => [...u16(n & 0xffff), ...u16(n >>> 16)]
const f64 = (n: number): number[] => {
  const b = new DataView(new ArrayBuffer(8))
  b.setFloat64(0, n, true)
  return [...new Uint8Array(b.buffer)]
}
const rec = (id: number, ...data: number[][]): number[] => {
  const body = data.flat()
  return [...u16(id), ...u16(body.length), ...body]
}
const latin = (s: string): number[] => [...s].map((c) => c.charCodeAt(0))
const wide = (s: string): number[] => [...s].flatMap((c) => u16(c.charCodeAt(0)))
/** An unfragmented string with a 2-byte length. */
const str16 = (s: string, utf16 = false): number[] => [...u16(s.length), utf16 ? 1 : 0, ...(utf16 ? wide(s) : latin(s))]
const rk = (n: number): number[] => u32(((n << 2) | 2) >>> 0)

/** A one-sheet workbook stream with every cell type the reader handles. */
function workbookStream(): number[] {
  const longText = 'abcdefghijklmnopqrstuvwxyz'
  const bof = (type: number) => rec(0x0809, u16(0x0600), u16(type), u16(0x0dbb), u16(0x07cc), u32(0), u32(6))
  const globalsHead = [
    ...bof(0x0005),
    ...rec(0x0022, u16(0)),
    ...rec(0x041e, u16(164), str16('yyyy-mm-dd')),
    ...rec(0x00e0, u16(0), u16(0)),
    ...rec(0x00e0, u16(0), u16(14)),
    ...rec(0x00e0, u16(0), u16(164)),
    // Three strings; the last is cut in two by a CONTINUE record (the new chunk starts with the width flag).
    ...rec(0x00fc, u32(3), u32(3), str16('Alpha'), str16('Café 中', true), [...u16(longText.length), 0, ...latin(longText.slice(0, 10))]),
    ...rec(0x003c, [0], latin(longText.slice(10))),
  ]
  const sheetName = [5, 0, ...latin('Sheet')]
  const boundsheetLen = 4 + 6 + sheetName.length
  const sheetOffset = globalsHead.length + boundsheetLen + 4 // + EOF
  const globals = [...globalsHead, ...rec(0x0085, u32(sheetOffset), [0, 0], sheetName), ...rec(0x000a)]
  const sheet = [
    ...bof(0x0010),
    ...rec(0x00fd, u16(0), u16(0), u16(0), u32(0)), // A1: "Alpha"
    ...rec(0x00fd, u16(0), u16(1), u16(0), u32(1)), // B1: wide string
    ...rec(0x00fd, u16(0), u16(2), u16(0), u32(2)), // C1: string across CONTINUE
    ...rec(0x0203, u16(1), u16(0), u16(0), f64(1.5)), // A2: number
    ...rec(0x027e, u16(1), u16(1), u16(0), rk(7)), // B2: RK integer
    ...rec(0x027e, u16(1), u16(2), u16(0), u32(0x00000003 | (1234 << 2))), // C2: RK integer / 100
    ...rec(0x00bd, u16(2), u16(0), u16(0), rk(10), u16(0), rk(20), u16(1)), // A3:B3 MULRK
    ...rec(0x0203, u16(3), u16(0), u16(1), f64(45000)), // A4: built-in date format
    ...rec(0x0203, u16(3), u16(1), u16(2), f64(45000.5)), // B4: custom date format with a time
    ...rec(0x0205, u16(3), u16(2), u16(0), [1, 0]), // C4: boolean true
    ...rec(0x0205, u16(3), u16(3), u16(0), [0x2a, 1]), // D4: error, read as missing
    ...rec(0x0204, u16(4), u16(0), u16(0), str16('label')), // A5: LABEL
    ...rec(0x0006, u16(4), u16(1), u16(0), f64(2.25), u16(0), u32(0), [0]), // B5: formula, number
    ...rec(0x0006, u16(4), u16(2), u16(0), [0, 0, 0, 0, 0, 0, 0xff, 0xff], u16(0), u32(0), [0]), // C5: formula, string result follows
    ...rec(0x0207, str16('computed')),
    ...rec(0x0201, u16(4), u16(3), u16(0)), // D5: blank
    ...rec(0x000a),
  ]
  return [...globals, ...sheet]
}

const FREE = 0xffffffff
const END = 0xfffffffe

/** An OLE2 compound file (512-byte sectors) holding one stream named Workbook, in the mini stream when it is under 4096 bytes. */
function compoundFile(stream: number[]): Uint8Array {
  const mini = stream.length < 4096
  const sector = 512
  const pad = (a: number[], n: number): number[] => [...a, ...new Array<number>(Math.ceil(a.length / n) * n - a.length).fill(0)]
  const data = pad(stream, mini ? 64 : sector)
  const dataSectors = mini ? Math.ceil(data.length / sector) : data.length / sector
  const miniCount = data.length / 64

  const fat = new Array<number>(sector / 4).fill(FREE)
  fat[0] = 0xfffffffd
  fat[1] = END
  if (mini) {
    fat[2] = END // the mini FAT
    for (let i = 0; i < dataSectors; i++) fat[3 + i] = i === dataSectors - 1 ? END : 4 + i
  } else for (let i = 0; i < dataSectors; i++) fat[2 + i] = i === dataSectors - 1 ? END : 3 + i

  const entry = (name: string, type: number, start: number, size: number): number[] => {
    const nameBytes = [...wide(name), 0, 0]
    return [...nameBytes, ...new Array<number>(64 - nameBytes.length).fill(0), ...u16(nameBytes.length), type, 1, ...u32(FREE), ...u32(FREE), ...u32(FREE), ...new Array<number>(16).fill(0), ...new Array<number>(20).fill(0), ...u32(start), ...u32(size), ...u32(0)]
  }
  const dir = pad([...entry('Root Entry', 5, mini ? 3 : END, mini ? data.length : 0), ...entry('Workbook', 2, mini ? 0 : 2, stream.length)], sector)

  const miniFat = new Array<number>(sector / 4).fill(FREE)
  for (let i = 0; i < miniCount; i++) miniFat[i] = i === miniCount - 1 ? END : i + 1

  const header = [
    0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, ...new Array<number>(16).fill(0), ...u16(0x3e), ...u16(3), ...u16(0xfffe), ...u16(9), ...u16(6), ...new Array<number>(6).fill(0),
    ...u32(0), ...u32(1), ...u32(1), ...u32(0), ...u32(4096), ...u32(mini ? 2 : END), ...u32(mini ? 1 : 0), ...u32(END), ...u32(0),
    ...u32(0), ...new Array<number>(108 * 4).fill(0xff),
  ]
  const bytes = [...header, ...fat.flatMap(u32), ...dir, ...(mini ? miniFat.flatMap(u32) : []), ...pad(data, sector)]
  return Uint8Array.from(bytes)
}

const EXPECTED = [
  ['Alpha', 'Café 中', 'abcdefghijklmnopqrstuvwxyz', null],
  [1.5, 7, 12.34, null],
  [10, 20, null, null],
  ['2023-03-15', '2023-03-15T12:00:00', true, null],
  ['label', 2.25, 'computed', null],
]

describe('legacy xls reader', () => {
  it('reads strings (wide and across CONTINUE), numbers, RK, MULRK, dates, booleans, errors and formulas from a mini-stream workbook', () => {
    const file = compoundFile(workbookStream())
    expect(isXls(file)).toBe(true)
    const sheets = readXls(file)
    expect(sheets.map((s) => s.name)).toEqual(['Sheet'])
    expect(sheets[0]?.rows).toEqual(EXPECTED)
  })

  it('reads the same workbook from a regular stream of 4096 bytes or more', () => {
    const stream = workbookStream()
    const padded = [...stream, ...new Array<number>(4200 - stream.length).fill(0)]
    expect(readXls(compoundFile(padded))[0]?.rows).toEqual(EXPECTED)
  })

  it('refuses anything that is not a compound file', () => {
    expect(isXls(new Uint8Array([80, 75, 3, 4]))).toBe(false)
    expect(() => readXls(new Uint8Array([80, 75, 3, 4]))).toThrow(/compound/)
  })
})
