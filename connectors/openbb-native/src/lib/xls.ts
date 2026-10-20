// A minimal legacy .xls reader (Excel 97-2003, BIFF8 inside an OLE2 compound file) for the workbooks agencies still
// publish in that format (EIA's Weekly Petroleum Status Report). It reads what xlrd, and so pandas.read_excel, gives:
// sheet names, cell values (numbers, strings from the shared string table, booleans, cached formula results) and
// dates where the cell's number format is a date. Error cells and blanks are null. xlsx files go through lib/xlsx.ts.
import { excelSerialToIso, type Cell, type Sheet } from './xlsx.js'

export type { Cell, Sheet }

const OLE_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]
const END_OF_CHAIN = 0xfffffffe

/** The bytes of the "Workbook" (or older "Book") stream of an OLE2 compound file. */
export function readCompoundStream(bytes: Uint8Array, names: readonly string[] = ['Workbook', 'Book']): Uint8Array {
  if (bytes.length < 512 || OLE_SIGNATURE.some((b, i) => bytes[i] !== b)) throw new Error('not an OLE2 compound file (an .xls workbook)')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const sectorSize = 1 << view.getUint16(30, true)
  const miniSectorSize = 1 << view.getUint16(32, true)
  const nFat = view.getUint32(44, true)
  const firstDirSector = view.getUint32(48, true)
  const miniCutoff = view.getUint32(56, true)
  const firstMiniFat = view.getUint32(60, true)
  const nMiniFat = view.getUint32(64, true)
  const firstDifat = view.getUint32(68, true)
  const nDifat = view.getUint32(72, true)
  const sectorOffset = (n: number) => (n + 1) * sectorSize

  // The sectors that hold the FAT: 109 listed in the header, then a chain of DIFAT sectors.
  const fatSectors: number[] = []
  for (let i = 0; i < 109 && fatSectors.length < nFat; i++) fatSectors.push(view.getUint32(76 + i * 4, true))
  let difat = firstDifat
  for (let i = 0; i < nDifat && difat < END_OF_CHAIN; i++) {
    const at = sectorOffset(difat)
    for (let j = 0; j < sectorSize / 4 - 1 && fatSectors.length < nFat; j++) fatSectors.push(view.getUint32(at + j * 4, true))
    difat = view.getUint32(at + sectorSize - 4, true)
  }
  const fat: number[] = []
  for (const s of fatSectors) for (let j = 0; j < sectorSize / 4; j++) fat.push(view.getUint32(sectorOffset(s) + j * 4, true))

  const chain = (start: number, table: number[]): number[] => {
    const out: number[] = []
    for (let s = start; s < END_OF_CHAIN && out.length <= table.length; s = table[s] ?? END_OF_CHAIN) out.push(s)
    return out
  }
  const readChain = (start: number, size: number): Uint8Array => {
    const out = new Uint8Array(size)
    let at = 0
    for (const s of chain(start, fat)) {
      if (at >= size) break
      const part = bytes.subarray(sectorOffset(s), sectorOffset(s) + sectorSize)
      out.set(part.subarray(0, Math.min(part.length, size - at)), at)
      at += sectorSize
    }
    return out
  }

  // Directory entries: 128 bytes each, name in UTF-16LE.
  const dir = readChain(firstDirSector, chain(firstDirSector, fat).length * sectorSize)
  const dv = new DataView(dir.buffer, dir.byteOffset, dir.byteLength)
  type Entry = { name: string; type: number; start: number; size: number }
  const entries: Entry[] = []
  for (let at = 0; at + 128 <= dir.length; at += 128) {
    const nameLength = Math.max(0, dv.getUint16(at + 64, true) - 2)
    entries.push({ name: new TextDecoder('utf-16le').decode(dir.subarray(at, at + nameLength)), type: dir[at + 66]!, start: dv.getUint32(at + 116, true), size: dv.getUint32(at + 120, true) })
  }
  const root = entries.find((e) => e.type === 5)
  const wanted = entries.find((e) => e.type === 2 && names.includes(e.name))
  if (!wanted) throw new Error(`the compound file has no ${names.join(' or ')} stream`)
  if (wanted.size >= miniCutoff) return readChain(wanted.start, wanted.size)

  // A small stream lives in the mini stream (the root entry's data), in 64-byte sectors addressed by the mini FAT.
  if (!root) throw new Error('the compound file has no root entry')
  const mini = readChain(root.start, root.size)
  const miniFatBytes = readChain(firstMiniFat, nMiniFat * sectorSize)
  const mv = new DataView(miniFatBytes.buffer, miniFatBytes.byteOffset, miniFatBytes.byteLength)
  const miniFat: number[] = []
  for (let i = 0; i + 4 <= miniFatBytes.length; i += 4) miniFat.push(mv.getUint32(i, true))
  const out = new Uint8Array(wanted.size)
  let at = 0
  for (const s of chain(wanted.start, miniFat)) {
    if (at >= wanted.size) break
    const part = mini.subarray(s * miniSectorSize, (s + 1) * miniSectorSize)
    out.set(part.subarray(0, Math.min(part.length, wanted.size - at)), at)
    at += miniSectorSize
  }
  return out
}

type Rec = { id: number; start: number; end: number }

const REC = { BOF: 0x0809, EOF: 0x000a, CONTINUE: 0x003c, SST: 0x00fc, BOUNDSHEET: 0x0085, DATEMODE: 0x0022, FORMAT: 0x041e, XF: 0x00e0, LABELSST: 0x00fd, LABEL: 0x0204, RSTRING: 0x00d6, NUMBER: 0x0203, RK: 0x027e, MULRK: 0x00bd, FORMULA: 0x0006, STRING: 0x0207, BOOLERR: 0x0205 }

const CELL_RECORDS = new Set([REC.LABELSST, REC.LABEL, REC.RSTRING, REC.NUMBER, REC.RK, REC.MULRK, REC.BOOLERR, REC.FORMULA])

/** Excel's built-in number format ids that show a date or time (xlrd's fmt_code_ranges). */
function isBuiltinDateFormat(id: number): boolean {
  return (id >= 14 && id <= 22) || (id >= 27 && id <= 36) || (id >= 45 && id <= 47) || (id >= 50 && id <= 58) || (id >= 71 && id <= 81)
}

/** A custom format string shows a date when, outside quotes, brackets and escapes, it has date or time codes. */
function isDateFormatString(format: string): boolean {
  const code = format.replace(/"[^"]*"|\[[^\]]*\]|\\.|_.|\*./g, '')
  return /[dmyhs]/i.test(code) && !/^general$/i.test(code.trim())
}

/** Every sheet of a workbook, in workbook order. */
export function readXls(bytes: Uint8Array): Sheet[] {
  const book = readCompoundStream(bytes)
  const view = new DataView(book.buffer, book.byteOffset, book.byteLength)
  const u16 = (at: number) => view.getUint16(at, true)
  const u32 = (at: number) => view.getUint32(at, true)

  // Records: 2-byte id, 2-byte length, payload.
  const records: Rec[] = []
  for (let at = 0; at + 4 <= book.length; ) {
    const length = u16(at + 2)
    records.push({ id: u16(at), start: at + 4, end: Math.min(at + 4 + length, book.length) })
    at += 4 + length
  }

  /** A BIFF8 unicode string at `at` (length of `lengthBytes` first); returns the text and where it ends. */
  const readString = (at: number, lengthBytes: 1 | 2): { text: string; next: number } => {
    const cch = lengthBytes === 1 ? book[at]! : u16(at)
    let p = at + lengthBytes
    const flags = book[p++]!
    const rich = (flags & 0x08) !== 0 ? u16(p) : 0
    if (flags & 0x08) p += 2
    const ext = (flags & 0x04) !== 0 ? u32(p) : 0
    if (flags & 0x04) p += 4
    const wide = (flags & 0x01) !== 0
    const text = wide ? new TextDecoder('utf-16le').decode(book.subarray(p, p + cch * 2)) : latin1(book.subarray(p, p + cch))
    return { text, next: p + (wide ? cch * 2 : cch) + rich * 4 + ext }
  }

  let dateMode1904 = false
  const formats = new Map<number, string>()
  const xfFormat: number[] = []
  const sheetsMeta: { name: string; position: number; kind: number }[] = []
  let sst: string[] = []

  // Workbook globals: everything before the first worksheet's BOF.
  let i = 0
  for (; i < records.length; i++) {
    const r = records[i]!
    if (r.id === REC.BOF && i > 0) break
    if (r.id === REC.BOF) {
      const version = u16(r.start)
      if (version !== 0x0600) throw new Error(`unsupported .xls version 0x${version.toString(16)}: only Excel 97-2003 (BIFF8) workbooks can be read`)
    } else if (r.id === REC.DATEMODE) dateMode1904 = u16(r.start) === 1
    else if (r.id === REC.FORMAT) formats.set(u16(r.start), readString(r.start + 2, 2).text)
    else if (r.id === REC.XF) xfFormat.push(u16(r.start + 2))
    else if (r.id === REC.BOUNDSHEET) sheetsMeta.push({ position: u32(r.start), kind: book[r.start + 5]!, name: readString(r.start + 6, 1).text })
    else if (r.id === REC.SST) {
      // The table continues in CONTINUE records, which can split a string anywhere.
      const chunks: Rec[] = [r]
      while (records[i + 1]?.id === REC.CONTINUE) chunks.push(records[++i]!)
      sst = readSharedStrings(book, chunks)
    }
  }
  const isDateXf = (xf: number): boolean => {
    const format = xfFormat[xf]
    if (format === undefined) return false
    const custom = formats.get(format)
    return custom !== undefined ? isDateFormatString(custom) : isBuiltinDateFormat(format)
  }
  const toDate = (serial: number): string => excelSerialToIso(dateMode1904 ? serial + 1462 : serial)

  const decodeRk = (rk: number): number => {
    let value: number
    if (rk & 2) value = rk >> 2
    else {
      const buf = new DataView(new ArrayBuffer(8))
      buf.setUint32(4, (rk & 0xfffffffc) >>> 0, true)
      value = buf.getFloat64(0, true)
    }
    return rk & 1 ? value / 100 : value
  }

  const byPosition = new Map(records.map((r, idx) => [r.start - 4, idx]))
  return sheetsMeta
    .filter((m) => m.kind === 0)
    .map((meta) => {
      const rows: Cell[][] = []
      const put = (row: number, col: number, value: Cell) => {
        const line = (rows[row] ??= [])
        line[col] = value
      }
      let pendingFormula: { row: number; col: number } | undefined
      for (let k = byPosition.get(meta.position) ?? records.length; k < records.length; k++) {
        const r = records[k]!
        if (r.id === REC.EOF) break
        if (r.id === REC.STRING) {
          // The text of the formula cell just before it.
          if (pendingFormula) put(pendingFormula.row, pendingFormula.col, readString(r.start, 2).text)
          pendingFormula = undefined
          continue
        }
        if (!CELL_RECORDS.has(r.id) || r.end - r.start < 6) continue
        const row = u16(r.start)
        const col = u16(r.start + 2)
        const xf = u16(r.start + 4)
        switch (r.id) {
          case REC.LABELSST:
            put(row, col, sst[u32(r.start + 6)] ?? null)
            break
          case REC.LABEL:
          case REC.RSTRING:
            put(row, col, readString(r.start + 6, 2).text)
            break
          case REC.NUMBER: {
            const n = view.getFloat64(r.start + 6, true)
            put(row, col, isDateXf(xf) ? toDate(n) : n)
            break
          }
          case REC.RK: {
            const n = decodeRk(u32(r.start + 6))
            put(row, col, isDateXf(xf) ? toDate(n) : n)
            break
          }
          case REC.MULRK: {
            // row, first column, (xf, rk) pairs, last column.
            const last = u16(r.end - 2)
            for (let c = col, p = r.start + 4; c <= last && p + 6 <= r.end - 2; c++, p += 6) {
              const n = decodeRk(u32(p + 2))
              put(row, c, isDateXf(u16(p)) ? toDate(n) : n)
            }
            break
          }
          case REC.BOOLERR:
            put(row, col, book[r.start + 7] === 0 ? book[r.start + 6] === 1 : null)
            break
          case REC.FORMULA: {
            // The cached result: a double, or a flag byte plus 0xFFFF when it is a string, boolean, error or empty.
            if (u16(r.start + 12) === 0xffff) {
              const type = book[r.start + 6]!
              if (type === 0) pendingFormula = { row, col }
              else if (type === 1) put(row, col, book[r.start + 8] === 1)
              else put(row, col, null)
            } else {
              const n = view.getFloat64(r.start + 6, true)
              put(row, col, isDateXf(xf) ? toDate(n) : n)
            }
            break
          }
        }
      }
      return { name: meta.name, rows: Array.from(rows, (line) => (line ? Array.from(line, (c) => c ?? null) : [])) }
    })
}

function latin1(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return s
}

/** The shared string table across its SST and CONTINUE records (xlrd's unpack_SST_table). */
function readSharedStrings(book: Uint8Array, chunks: Rec[]): string[] {
  const view = new DataView(book.buffer, book.byteOffset, book.byteLength)
  let ci = 0
  let p = chunks[0]!.start + 8 // after the total and unique counts
  const unique = view.getUint32(chunks[0]!.start + 4, true)
  const out: string[] = []
  const next = (): boolean => {
    if (++ci >= chunks.length) return false
    p = chunks[ci]!.start
    return true
  }
  /** Bytes still available in the current chunk. */
  const left = () => chunks[ci]!.end - p
  while (out.length < unique && ci < chunks.length) {
    if (left() < 3 && !next()) break
    const cch = view.getUint16(p, true)
    const flags = book[p + 2]!
    p += 3
    const rich = flags & 0x08 ? view.getUint16(p, true) : 0
    if (flags & 0x08) p += 2
    const ext = flags & 0x04 ? view.getUint32(p, true) : 0
    if (flags & 0x04) p += 4
    let wide = (flags & 0x01) !== 0
    let text = ''
    let remaining = cch
    while (remaining > 0) {
      if (left() <= 0) {
        // The characters go on in the next chunk, which starts with its own width flag.
        if (!next()) break
        wide = (book[p]! & 0x01) !== 0
        p += 1
      }
      const take = Math.min(remaining, Math.floor(left() / (wide ? 2 : 1)))
      if (take <= 0) {
        if (!next()) break
        wide = (book[p]! & 0x01) !== 0
        p += 1
        continue
      }
      const part = book.subarray(p, p + take * (wide ? 2 : 1))
      text += wide ? new TextDecoder('utf-16le').decode(part) : latin1(part)
      p += part.length
      remaining -= take
    }
    // Formatting runs (4 bytes each) and the phonetic block follow the characters; either may reach into the next chunk.
    let skip = rich * 4 + ext
    while (skip > 0) {
      const n = Math.min(skip, left())
      p += n
      skip -= n
      if (skip > 0 && !next()) break
    }
    out.push(text)
  }
  return out
}
