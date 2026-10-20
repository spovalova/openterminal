// A minimal reader for legacy .xls workbooks (BIFF8 in an OLE2 compound file), for the USDA ERS downloads that OpenBB reads
// through xlrd. It reads what pandas.read_excel gets from xlrd: worksheet names and cell values (text, numbers, booleans,
// the cached result of formulas), with numbers in date formats as ISO dates like src/lib/xlsx.ts. Not supported: BIFF5/7,
// encrypted workbooks, charts and macro sheets.
import { excelSerialToIso, type Cell, type Sheet } from '../lib/xlsx.js'

const CFB_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]
const END_OF_CHAIN = 0xfffffffe
const FREE_SECTOR = 0xffffffff

/** True for the first bytes of an OLE2 compound file, which is what every .xls is. */
export function isXls(bytes: Uint8Array): boolean {
  return CFB_SIGNATURE.every((b, i) => bytes[i] === b)
}

// ---- OLE2 compound file ----------------------------------------------------------------------------------------------

/** The bytes of the stream called `name` (compared without case) in a compound file. */
export function readCfbStream(bytes: Uint8Array, name: string): Uint8Array | undefined {
  if (!isXls(bytes)) throw new Error('not an OLE2 compound file')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const sectorSize = 1 << view.getUint16(30, true)
  const miniSectorSize = 1 << view.getUint16(32, true)
  const miniCutoff = view.getUint32(56, true)
  const sectorAt = (id: number): Uint8Array => bytes.subarray((id + 1) * sectorSize, (id + 2) * sectorSize)

  // The FAT: sectors named by the header's DIFAT, then by the DIFAT chain.
  const fatSectors: number[] = []
  for (let i = 0; i < 109; i++) {
    const id = view.getUint32(76 + i * 4, true)
    if (id !== FREE_SECTOR) fatSectors.push(id)
  }
  let difat = view.getUint32(68, true)
  for (let n = view.getUint32(72, true); n > 0 && difat !== END_OF_CHAIN && difat !== FREE_SECTOR; n--) {
    const s = sectorAt(difat)
    const sv = new DataView(s.buffer, s.byteOffset, s.byteLength)
    for (let i = 0; i < sectorSize / 4 - 1; i++) {
      const id = sv.getUint32(i * 4, true)
      if (id !== FREE_SECTOR) fatSectors.push(id)
    }
    difat = sv.getUint32(sectorSize - 4, true)
  }
  const fat: number[] = []
  for (const id of fatSectors) {
    const s = sectorAt(id)
    const sv = new DataView(s.buffer, s.byteOffset, s.byteLength)
    for (let i = 0; i < sectorSize / 4; i++) fat.push(sv.getUint32(i * 4, true))
  }

  const chain = (start: number, table: number[]): number[] => {
    const ids: number[] = []
    for (let id = start; id < 0xfffffffa && ids.length <= table.length; id = table[id] ?? END_OF_CHAIN) ids.push(id)
    return ids
  }
  const readChain = (start: number, size?: number): Uint8Array => {
    const ids = chain(start, fat)
    const out = new Uint8Array(ids.length * sectorSize)
    ids.forEach((id, i) => out.set(sectorAt(id), i * sectorSize))
    return size === undefined ? out : out.subarray(0, size)
  }

  // Directory entries: 128 bytes each.
  const dir = readChain(view.getUint32(48, true))
  const dv = new DataView(dir.buffer, dir.byteOffset, dir.byteLength)
  type Entry = { name: string; type: number; start: number; size: number }
  const entries: Entry[] = []
  for (let off = 0; off + 128 <= dir.length; off += 128) {
    const nameLen = dv.getUint16(off + 64, true)
    let entryName = ''
    for (let i = 0; i + 2 <= Math.max(0, nameLen - 2); i += 2) entryName += String.fromCharCode(dv.getUint16(off + i, true))
    entries.push({ name: entryName, type: dir[off + 66]!, start: dv.getUint32(off + 116, true), size: dv.getUint32(off + 120, true) })
  }
  const wanted = entries.find((e) => e.type === 2 && e.name.toLowerCase() === name.toLowerCase())
  if (!wanted) return undefined
  if (wanted.size >= miniCutoff) return readChain(wanted.start, wanted.size)

  // Small streams live in the mini stream, which is the root entry's stream, addressed by the mini FAT.
  const root = entries.find((e) => e.type === 5)
  if (!root) return undefined
  const miniStream = readChain(root.start, root.size)
  const miniFatBytes = readChain(view.getUint32(60, true))
  const mv = new DataView(miniFatBytes.buffer, miniFatBytes.byteOffset, miniFatBytes.byteLength)
  const miniFat: number[] = []
  for (let i = 0; i + 4 <= miniFatBytes.length; i += 4) miniFat.push(mv.getUint32(i, true))
  const ids = chain(wanted.start, miniFat)
  const out = new Uint8Array(ids.length * miniSectorSize)
  ids.forEach((id, i) => out.set(miniStream.subarray(id * miniSectorSize, (id + 1) * miniSectorSize), i * miniSectorSize))
  return out.subarray(0, wanted.size)
}

// ---- BIFF8 -----------------------------------------------------------------------------------------------------------

const REC = {
  BOF: 0x0809,
  EOF: 0x000a,
  CONTINUE: 0x003c,
  SST: 0x00fc,
  BOUNDSHEET: 0x0085,
  FORMAT: 0x041e,
  XF: 0x00e0,
  DATEMODE: 0x0022,
  LABELSST: 0x00fd,
  LABEL: 0x0204,
  RSTRING: 0x00d6,
  NUMBER: 0x0203,
  RK: 0x027e,
  MULRK: 0x00bd,
  FORMULA: 0x0006,
  STRING: 0x0207,
  BOOLERR: 0x0205,
  FILEPASS: 0x002f,
} as const

type Record_ = { id: number; data: Uint8Array; /** the CONTINUE records that follow, in order */ continues: Uint8Array[] }

/** The records of a BIFF stream from `start`, with each record's CONTINUE records attached; stops after the closing EOF or at `until`. */
function* records(stream: Uint8Array, start: number): Generator<Record_> {
  const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength)
  let pos = start
  let depth = 0
  let current: Record_ | undefined
  while (pos + 4 <= stream.length) {
    const id = view.getUint16(pos, true)
    const len = view.getUint16(pos + 2, true)
    const data = stream.subarray(pos + 4, pos + 4 + len)
    pos += 4 + len
    if (id === REC.CONTINUE && current) {
      current.continues.push(data)
      continue
    }
    if (current) yield current
    current = { id, data, continues: [] }
    if (id === REC.BOF) depth++
    if (id === REC.EOF && --depth <= 0) break
  }
  if (current) yield current
}

/** Reads strings out of a record followed by CONTINUE records: a string cut by a record boundary starts the next chunk with a flags byte. */
class ChunkReader {
  private chunk = 0
  private pos = 0
  constructor(private readonly chunks: Uint8Array[]) {}

  private get cur(): Uint8Array {
    return this.chunks[this.chunk] ?? new Uint8Array(0)
  }
  /** Moves to the next chunk when this one is used up. */
  private advanceIfDone(): void {
    while (this.pos >= this.cur.length && this.chunk < this.chunks.length - 1) {
      this.chunk++
      this.pos = 0
    }
  }
  get done(): boolean {
    this.advanceIfDone()
    return this.pos >= this.cur.length
  }
  u8(): number {
    this.advanceIfDone()
    return this.cur[this.pos++] ?? 0
  }
  u16(): number {
    return this.u8() | (this.u8() << 8)
  }
  u32(): number {
    return (this.u16() | (this.u16() << 16)) >>> 0
  }
  skip(n: number): void {
    while (n > 0) {
      this.advanceIfDone()
      const take = Math.min(n, this.cur.length - this.pos)
      if (take <= 0) return
      this.pos += take
      n -= take
    }
  }
  /** `cch` characters of a string whose option flags say how wide they are, continuing across chunks. */
  chars(cch: number, wide: boolean): string {
    let out = ''
    let remaining = cch
    while (remaining > 0) {
      const atEnd = this.pos >= this.cur.length
      if (atEnd && this.chunk < this.chunks.length - 1) {
        this.chunk++
        this.pos = 0
        wide = (this.u8() & 1) === 1
      }
      const width = wide ? 2 : 1
      const available = Math.floor((this.cur.length - this.pos) / width)
      if (available <= 0) break
      const take = Math.min(available, remaining)
      for (let i = 0; i < take; i++) {
        out += String.fromCharCode(wide ? this.cur[this.pos]! | (this.cur[this.pos + 1]! << 8) : this.cur[this.pos]!)
        this.pos += width
      }
      remaining -= take
    }
    return out
  }
  /** An XLUnicodeRichExtendedString (SST entries, with a 2-byte length). */
  richString(): string {
    const cch = this.u16()
    return this.stringBody(cch)
  }
  /** The part of a unicode string after its length: flags, optional run and phonetic counts, the characters, then the runs and phonetic data. */
  stringBody(cch: number): string {
    const flags = this.u8()
    const rich = (flags & 0x08) !== 0
    const ext = (flags & 0x04) !== 0
    const runs = rich ? this.u16() : 0
    const extSize = ext ? this.u32() : 0
    const text = this.chars(cch, (flags & 1) === 1)
    this.skip(runs * 4 + extSize)
    return text
  }
}

/** An RK number: a 30-bit integer or the top 30 bits of a double, optionally divided by 100. */
function decodeRk(rk: number): number {
  let value: number
  if (rk & 2) value = rk >> 2
  else {
    const buf = new DataView(new ArrayBuffer(8))
    buf.setUint32(4, (rk & 0xfffffffc) >>> 0, true)
    value = buf.getFloat64(0, true)
  }
  return rk & 1 ? value / 100 : value
}

/** xlrd's classification of number formats as dates or times: the built-in ids, and a scan of custom format codes. */
function isDateFormat(id: number, code: string | undefined): boolean {
  if ((id >= 14 && id <= 22) || (id >= 27 && id <= 36) || (id >= 45 && id <= 47) || (id >= 50 && id <= 58) || (id >= 71 && id <= 81)) return true
  if (code === undefined) return false
  const stripped = code.replace(/"[^"]*"|\\.|\[[^\]]*\]|_.|\*./g, '')
  if (/^general$/i.test(stripped.trim())) return false
  return /[dmyhs]/i.test(stripped)
}

/** Every worksheet of a legacy .xls workbook, in workbook order. */
export function readXls(bytes: Uint8Array): Sheet[] {
  const book = readCfbStream(bytes, 'Workbook') ?? readCfbStream(bytes, 'Book')
  if (!book) throw new Error('no Workbook stream: not an Excel 97-2003 workbook')
  // Workbook globals: the shared strings, number formats, cell formats and the sheet list.
  const sst: string[] = []
  const formats = new Map<number, string>()
  const xfFormat: number[] = []
  const sheetInfo: { name: string; offset: number; type: number }[] = []
  let date1904 = false
  for (const rec of records(book, 0)) {
    const d = rec.data
    const dv = new DataView(d.buffer, d.byteOffset, d.byteLength)
    if (rec.id === REC.BOF && d.length >= 2 && dv.getUint16(0, true) < 0x0600) throw new Error('only Excel 97-2003 (BIFF8) workbooks are supported')
    if (rec.id === REC.FILEPASS) throw new Error('encrypted workbooks are not supported')
    else if (rec.id === REC.DATEMODE) date1904 = dv.getUint16(0, true) === 1
    else if (rec.id === REC.SST) {
      const r = new ChunkReader([d.subarray(8), ...rec.continues])
      for (let n = dv.getUint32(4, true); n > 0 && !r.done; n--) sst.push(r.richString())
    } else if (rec.id === REC.FORMAT) {
      const r = new ChunkReader([d.subarray(2), ...rec.continues])
      formats.set(dv.getUint16(0, true), r.richString())
    } else if (rec.id === REC.XF) xfFormat.push(dv.getUint16(2, true))
    else if (rec.id === REC.BOUNDSHEET) {
      const r = new ChunkReader([d.subarray(6)])
      const cch = r.u8()
      sheetInfo.push({ offset: dv.getUint32(0, true), type: d[5]!, name: r.stringBody(cch) })
    }
  }
  const isDateXf = (xf: number): boolean => {
    const id = xfFormat[xf]
    return id !== undefined && isDateFormat(id, formats.get(id))
  }
  const withDate = (xf: number, n: number): Cell => (isDateXf(xf) ? excelSerialToIso(date1904 ? n + 1462 : n) : n)

  const sheets: Sheet[] = []
  for (const info of sheetInfo) {
    if (info.type !== 0) continue
    const cells: Cell[][] = []
    const put = (row: number, col: number, value: Cell): void => {
      const line = (cells[row] ??= [])
      line[col] = value
    }
    let formulaCell: [number, number] | undefined
    for (const rec of records(book, info.offset)) {
      const d = rec.data
      const dv = new DataView(d.buffer, d.byteOffset, d.byteLength)
      switch (rec.id) {
        case REC.LABELSST:
          put(dv.getUint16(0, true), dv.getUint16(2, true), sst[dv.getUint32(6, true)] ?? null)
          break
        case REC.LABEL:
        case REC.RSTRING: {
          const r = new ChunkReader([d.subarray(6), ...rec.continues])
          put(dv.getUint16(0, true), dv.getUint16(2, true), r.richString())
          break
        }
        case REC.NUMBER:
          put(dv.getUint16(0, true), dv.getUint16(2, true), withDate(dv.getUint16(4, true), dv.getFloat64(6, true)))
          break
        case REC.RK:
          put(dv.getUint16(0, true), dv.getUint16(2, true), withDate(dv.getUint16(4, true), decodeRk(dv.getUint32(6, true))))
          break
        case REC.MULRK: {
          const row = dv.getUint16(0, true)
          const first = dv.getUint16(2, true)
          const count = (d.length - 6) / 6
          for (let i = 0; i < count; i++) put(row, first + i, withDate(dv.getUint16(4 + i * 6, true), decodeRk(dv.getUint32(6 + i * 6, true))))
          break
        }
        case REC.BOOLERR: {
          // An error cell reads as missing, as pandas reads it.
          put(dv.getUint16(0, true), dv.getUint16(2, true), d[7] === 0 ? d[6] === 1 : null)
          break
        }
        case REC.FORMULA: {
          const row = dv.getUint16(0, true)
          const col = dv.getUint16(2, true)
          formulaCell = undefined
          if (dv.getUint16(12, true) === 0xffff) {
            // A string, boolean, error or empty result: the type is in the first result byte.
            const kind = d[6]
            if (kind === 0) formulaCell = [row, col]
            else if (kind === 1) put(row, col, d[8] === 1)
            else if (kind === 2) put(row, col, null)
            else put(row, col, null)
          } else put(row, col, withDate(dv.getUint16(4, true), dv.getFloat64(6, true)))
          break
        }
        case REC.STRING:
          if (formulaCell) {
            const r = new ChunkReader([d, ...rec.continues])
            put(formulaCell[0], formulaCell[1], r.richString())
            formulaCell = undefined
          }
          break
        default:
          break
      }
    }
    const width = cells.reduce((w, line) => Math.max(w, line?.length ?? 0), 0)
    const rows: Cell[][] = Array.from({ length: cells.length }, (_, r) => Array.from({ length: width }, (_, c) => cells[r]?.[c] ?? null))
    sheets.push({ name: info.name, rows })
  }
  return sheets
}
