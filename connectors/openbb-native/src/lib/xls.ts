// A minimal legacy .xls reader (BIFF8 inside an OLE2 compound file) for the few spreadsheets the Federal Reserve banks
// still publish in that format (the counterpart of xlsx.ts, same output): sheet names, numbers (NUMBER, RK, MULRK),
// shared and inline strings, booleans, errors, formula results, and dates where the cell's number format is a date,
// as xlrd (through pandas.read_excel) gives them. No formulas, styles beyond the number format, charts or macros.
import { excelSerialToIso, type Cell, type Sheet } from './xlsx.js'

const SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]
const ENDOFCHAIN = 0xfffffffe
const FREESECT = 0xffffffff

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58])
const ERRORS: Record<number, string> = { 0x00: '#NULL!', 0x07: '#DIV/0!', 0x0f: '#VALUE!', 0x17: '#REF!', 0x1d: '#NAME?', 0x24: '#NUM!', 0x2a: '#N/A' }

/** Whether the bytes start like an OLE2 compound file (an .xls), as opposed to a zip (.xlsx). */
export function isXls(bytes: Uint8Array): boolean {
  return SIGNATURE.every((b, i) => bytes[i] === b)
}

/** The bytes of the named stream of an OLE2 compound file. */
function readStream(file: Uint8Array, names: string[]): Uint8Array {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength)
  const sectorSize = 1 << view.getUint16(0x1e, true)
  const miniSectorSize = 1 << view.getUint16(0x20, true)
  const cutoff = view.getUint32(0x38, true)
  const sector = (n: number): Uint8Array => {
    const at = (n + 1) * sectorSize
    if (at + sectorSize > file.length) throw new Error('truncated .xls file')
    return file.subarray(at, at + sectorSize)
  }

  // The FAT: the sectors listed in the header's DIFAT (then in the DIFAT chain), each holding sector numbers.
  const difat: number[] = []
  for (let i = 0; i < 109; i++) difat.push(view.getUint32(0x4c + i * 4, true))
  let next = view.getUint32(0x44, true)
  for (let i = 0; i < view.getUint32(0x48, true) && next !== ENDOFCHAIN && next !== FREESECT; i++) {
    const s = new DataView(sector(next).slice().buffer)
    for (let j = 0; j < sectorSize / 4 - 1; j++) difat.push(s.getUint32(j * 4, true))
    next = s.getUint32(sectorSize - 4, true)
  }
  const fat: number[] = []
  for (const id of difat) {
    if (id === FREESECT || id === ENDOFCHAIN) continue
    const s = new DataView(sector(id).slice().buffer)
    for (let j = 0; j < sectorSize / 4; j++) fat.push(s.getUint32(j * 4, true))
  }
  const chain = (start: number, table: number[]): number[] => {
    const out: number[] = []
    for (let n = start; n !== ENDOFCHAIN && n !== FREESECT && out.length <= table.length; n = table[n] ?? ENDOFCHAIN) out.push(n)
    return out
  }
  const readChain = (start: number): Uint8Array => {
    const parts = chain(start, fat).map(sector)
    const out = new Uint8Array(parts.length * sectorSize)
    parts.forEach((p, i) => out.set(p, i * sectorSize))
    return out
  }

  // The directory.
  const dir = readChain(view.getUint32(0x30, true))
  const dv = new DataView(dir.buffer, dir.byteOffset, dir.byteLength)
  type Entry = { name: string; type: number; start: number; size: number }
  const entries: Entry[] = []
  for (let at = 0; at + 128 <= dir.length; at += 128) {
    const len = dv.getUint16(at + 0x40, true)
    const name = new TextDecoder('utf-16le').decode(dir.subarray(at, at + Math.max(0, len - 2)))
    entries.push({ name, type: dir[at + 0x42]!, start: dv.getUint32(at + 0x74, true), size: dv.getUint32(at + 0x78, true) })
  }
  const entry = names.map((n) => entries.find((e) => e.type === 2 && e.name === n)).find(Boolean)
  if (!entry) throw new Error('no Workbook stream in the .xls file')

  if (entry.size >= cutoff) return readChain(entry.start).subarray(0, entry.size)
  // A short stream lives in the mini stream (the root entry's data), addressed through the mini FAT.
  const root = entries.find((e) => e.type === 5)
  if (!root) throw new Error('no root entry in the .xls file')
  const mini = readChain(root.start)
  const miniFatBytes = readChain(view.getUint32(0x3c, true))
  const mf = new DataView(miniFatBytes.buffer, miniFatBytes.byteOffset, miniFatBytes.byteLength)
  const miniFat: number[] = []
  for (let i = 0; i + 4 <= miniFatBytes.length; i += 4) miniFat.push(mf.getUint32(i, true))
  const parts = chain(entry.start, miniFat).map((n) => mini.subarray(n * miniSectorSize, (n + 1) * miniSectorSize))
  const out = new Uint8Array(parts.length * miniSectorSize)
  parts.forEach((p, i) => out.set(p, i * miniSectorSize))
  return out.subarray(0, entry.size)
}

type Record_ = { type: number; data: Uint8Array; at: number }

/** The BIFF records of a stream from `from`, with CONTINUE records kept separate. */
function* records(stream: Uint8Array, from = 0): Generator<Record_> {
  const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength)
  for (let at = from; at + 4 <= stream.length; ) {
    const type = view.getUint16(at, true)
    const len = view.getUint16(at + 2, true)
    yield { type, data: stream.subarray(at + 4, at + 4 + len), at }
    at += 4 + len
  }
}

/** A BIFF8 string: u8 or u16 length, flags (bit0: 16-bit characters), characters. Returns the text and the bytes used. */
function unicodeString(data: Uint8Array, at: number, longLength: boolean): { text: string; end: number } {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const cch = longLength ? dv.getUint16(at, true) : data[at]!
  let p = at + (longLength ? 2 : 1)
  const flags = data[p++]!
  if (flags & 0x08) p += 2
  if (flags & 0x04) p += 4
  const wide = (flags & 0x01) !== 0
  const bytes = wide ? cch * 2 : cch
  const text = wide ? new TextDecoder('utf-16le').decode(data.subarray(p, p + bytes)) : latin1(data.subarray(p, p + bytes))
  return { text, end: p + bytes }
}

const latin1 = (b: Uint8Array): string => {
  let s = ''
  for (const c of b) s += String.fromCharCode(c)
  return s
}

/** The shared string table: SST plus its CONTINUE records, whose broken strings restart with a flags byte. */
function sharedStrings(segments: Uint8Array[]): string[] {
  const out: string[] = []
  let seg = 0
  let pos = 8 // total and unique counts
  const unique = new DataView(segments[0]!.buffer, segments[0]!.byteOffset).getUint32(4, true)
  const u16 = (): number => {
    const d = segments[seg]!
    const v = d[pos]! | (d[pos + 1]! << 8)
    pos += 2
    return v
  }
  const skip = (n: number): void => {
    while (n > 0 && seg < segments.length) {
      const left = segments[seg]!.length - pos
      if (n <= left) {
        pos += n
        return
      }
      n -= left
      seg++
      pos = 0
    }
  }
  for (let i = 0; i < unique && seg < segments.length; i++) {
    if (pos >= segments[seg]!.length) {
      seg++
      pos = 0
      if (seg >= segments.length) break
    }
    const cch = u16()
    const flags = segments[seg]![pos++]!
    const runs = flags & 0x08 ? u16() : 0
    let ext = 0
    if (flags & 0x04) {
      const d = segments[seg]!
      ext = (d[pos]! | (d[pos + 1]! << 8) | (d[pos + 2]! << 16) | (d[pos + 3]! << 24)) >>> 0
      pos += 4
    }
    let wide = (flags & 0x01) !== 0
    let text = ''
    let left = cch
    while (left > 0 && seg < segments.length) {
      const d = segments[seg]!
      const size = wide ? 2 : 1
      const take = Math.min(left, Math.floor((d.length - pos) / size))
      const chunk = d.subarray(pos, pos + take * size)
      text += wide ? new TextDecoder('utf-16le').decode(chunk) : latin1(chunk)
      pos += take * size
      left -= take
      if (left > 0) {
        seg++
        pos = 0
        if (seg >= segments.length) break
        wide = (segments[seg]![pos++]! & 0x01) !== 0
      }
    }
    skip(runs * 4 + ext)
    out.push(text)
  }
  return out
}

/** A BIFF RK number. */
function rkValue(rk: number): number {
  let v: number
  if (rk & 2) v = rk >> 2
  else {
    const b = new DataView(new ArrayBuffer(8))
    b.setUint32(4, (rk & 0xfffffffc) >>> 0, true)
    v = b.getFloat64(0, true)
  }
  return rk & 1 ? v / 100 : v
}

/** Every sheet of an .xls workbook, in workbook order (the counterpart of `readXlsx`). */
export function readXls(bytes: Uint8Array): Sheet[] {
  if (!isXls(bytes)) throw new Error('not an .xls file (OLE2 compound file expected)')
  const stream = readStream(bytes, ['Workbook', 'Book'])

  // Workbook globals: date mode, number formats, XF → format, shared strings, sheet list.
  let date1904 = false
  const formats = new Map<number, string>()
  const xfFormat: number[] = []
  let sst: string[] = []
  const boundSheets: { name: string; offset: number }[] = []
  let depth = 0
  const sstSegments: Uint8Array[] = []
  let inSst = false
  for (const r of records(stream)) {
    if (inSst && r.type === 0x003c) {
      sstSegments.push(r.data)
      continue
    }
    if (inSst) {
      sst = sharedStrings(sstSegments)
      inSst = false
    }
    const dv = new DataView(r.data.buffer, r.data.byteOffset, r.data.byteLength)
    if (r.type === 0x0809) depth++
    else if (r.type === 0x000a) {
      depth--
      if (depth <= 0) break
    } else if (r.type === 0x0022) date1904 = dv.getUint16(0, true) === 1
    else if (r.type === 0x041e) formats.set(dv.getUint16(0, true), unicodeString(r.data, 2, true).text)
    else if (r.type === 0x00e0) xfFormat.push(dv.getUint16(2, true))
    else if (r.type === 0x00fc) {
      sstSegments.length = 0
      sstSegments.push(r.data)
      inSst = true
    } else if (r.type === 0x0085) boundSheets.push({ offset: dv.getUint32(0, true), name: unicodeString(r.data, 6, false).text })
  }
  if (inSst) sst = sharedStrings(sstSegments)

  const isDateFormat = (xf: number): boolean => {
    const id = xfFormat[xf]
    if (id === undefined) return false
    if (BUILTIN_DATE_FORMATS.has(id)) return true
    const code = formats.get(id)
    return code !== undefined && /[ymd]/i.test(code.replace(/"[^"]*"|\[[^\]]*\]|\\./g, ''))
  }
  const number = (xf: number, v: number): Cell => (isDateFormat(xf) ? excelSerialToIso(date1904 ? v + 1462 : v) : v)

  return boundSheets.map(({ name, offset }) => {
    const rows: Cell[][] = []
    const put = (r: number, c: number, v: Cell): void => {
      const row = (rows[r] ??= [])
      for (let i = row.length; i < c; i++) row[i] = null
      row[c] = v
    }
    let level = 0
    let pendingFormula: [number, number] | undefined
    for (const rec of records(stream, offset)) {
      const d = rec.data
      const dv = new DataView(d.buffer, d.byteOffset, d.byteLength)
      if (rec.type === 0x0809) {
        level++
        continue
      }
      if (rec.type === 0x000a) {
        if (--level <= 0) break
        continue
      }
      if (level !== 1) continue
      switch (rec.type) {
        case 0x00fd:
          put(dv.getUint16(0, true), dv.getUint16(2, true), sst[dv.getUint32(6, true)] ?? null)
          break
        case 0x0204:
          put(dv.getUint16(0, true), dv.getUint16(2, true), unicodeString(d, 6, true).text)
          break
        case 0x0203:
          put(dv.getUint16(0, true), dv.getUint16(2, true), number(dv.getUint16(4, true), dv.getFloat64(6, true)))
          break
        case 0x027e:
          put(dv.getUint16(0, true), dv.getUint16(2, true), number(dv.getUint16(4, true), rkValue(dv.getUint32(6, true))))
          break
        case 0x00bd: {
          const row = dv.getUint16(0, true)
          const first = dv.getUint16(2, true)
          const count = (d.length - 6) / 6
          for (let i = 0; i < count; i++) put(row, first + i, number(dv.getUint16(4 + i * 6, true), rkValue(dv.getUint32(6 + i * 6, true))))
          break
        }
        case 0x0205:
          put(dv.getUint16(0, true), dv.getUint16(2, true), d[7] ? (ERRORS[d[6]!] ?? '#VALUE!') : d[6] !== 0)
          break
        case 0x0006: {
          const row = dv.getUint16(0, true)
          const col = dv.getUint16(2, true)
          if (dv.getUint16(12, true) === 0xffff) {
            if (d[6] === 0) pendingFormula = [row, col]
            else if (d[6] === 1) put(row, col, d[8] !== 0)
            else if (d[6] === 2) put(row, col, ERRORS[d[8]!] ?? '#VALUE!')
          } else put(row, col, number(dv.getUint16(4, true), dv.getFloat64(6, true)))
          break
        }
        case 0x0207:
          if (pendingFormula) {
            put(pendingFormula[0], pendingFormula[1], unicodeString(d, 0, true).text)
            pendingFormula = undefined
          }
          break
        default:
      }
    }
    return { name, rows: Array.from(rows, (r) => (r ? Array.from(r, (c) => (c === undefined ? null : c)) : [])) }
  })
}
