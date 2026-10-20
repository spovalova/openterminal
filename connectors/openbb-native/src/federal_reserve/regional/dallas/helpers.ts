// Shared by the Dallas Fed routes, provider federal_reserve. Ported from openbb_federal_reserve/utils/dallas.py
// (OpenBB Platform 5.0.0, Apache-2.0); modified: ctx.cache instead of the on-disk cache, and plain arrays instead of pandas frames.
import { BROWSER_UA } from '../../../http.js'
import type { NativeCtx, NativeParams, Row } from '../../../types.js'
import { dateOf, isDateCell, isNa, readFrame, toNumeric, type Cell, type Grid } from '../workbook.js'

const DAY_MS = 24 * 3600 * 1000

export const dateParam = (params: NativeParams, name: 'start_date' | 'end_date'): string | undefined => (typeof params[name] === 'string' && params[name] ? (params[name] as string) : undefined)

/** A workbook download from the Dallas Fed, kept for a day. */
export function download(ctx: NativeCtx, url: string): Promise<Uint8Array> {
  return ctx.cache(`dallas:${url}`, DAY_MS, async () => {
    const bytes = await ctx.http.bytes(url, { headers: { 'user-agent': BROWSER_UA }, timeoutMs: 120_000 })
    if (bytes.length === 0) throw new Error('The request was returned empty.')
    return bytes
  })
}

export function emptyData(): never {
  throw new Error('The request was returned empty.')
}

export const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** `str(x).strip()`, "nan" for a missing cell. */
export const pyStr = (v: unknown): string => (isNa(v) ? 'nan' : String(v).trim())

const QUARTER_LAST_DAY = ['03-31', '06-30', '09-30', '12-31']

/** A `YYYY:QN` (or `YYYY: QN`) label as the quarter-end date (`quarter_to_date`). */
export function quarterToDate(text: unknown): string | undefined {
  const m = /^\s*(\d{4})\s*:\s*Q([1-4])\s*$/.exec(isNa(text) ? 'nan' : String(text))
  return m ? `${m[1]}-${QUARTER_LAST_DAY[Number(m[2]) - 1]}` : undefined
}

/** `re.sub(r"[^a-z0-9]+", "_", re.split(r"[([]", name)[0].strip().lower()).strip("_")` (`clean_key`). */
export function cleanKey(name: unknown): string {
  const base = String(name).split(/[([]/)[0]!
  return base.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

/** A sheet as snake_cased records, blanks left out and all-blank rows dropped (`read_records`). */
export function readRecords(bytes: Uint8Array, sheet: string | number, header = 0): Row[] {
  const frame = readFrame(bytes, sheet, header)
  const keys = frame.columns.map(cleanKey)
  const out: Row[] = []
  for (const row of frame.rows) {
    const record: Row = {}
    keys.forEach((k, i) => {
      if (k && !isNa(row[i])) record[k] = row[i]
    })
    if (Object.keys(record).length > 0) out.push(record)
  }
  return out
}

/** The row of the label cells: the first of the first 30 rows whose first cell equals `marker` (`find_label_row`). */
export function findLabelRow(grid: Grid, marker = 'date'): number {
  const rows = grid.slice(0, 30)
  const at = rows.findIndex((r) => pyStr(r[0]).toLowerCase() === marker)
  return at < 0 ? 0 : at
}

/** `Series.ffill` along an array. */
function ffill(values: Cell[]): Cell[] {
  let last: Cell = null
  return values.map((v) => {
    if (!isNa(v)) last = v
    return last
  })
}

export type Long = { date: string; series: string; value: number | null }

/** A two-level-header, date-indexed sheet as long records (`melt_two_level`). */
export function meltTwoLevel(raw: Grid, labelRow: number, dateKind: 'datetime' | 'quarter' | 'yyyymm', start?: string, end?: string): Long[] {
  const width = raw[0]?.length ?? 0
  if (raw.length <= labelRow + 1) return []
  const group = labelRow >= 1 ? ffill(raw[labelRow - 1]!) : raw[labelRow]!
  const labels = raw[labelRow]!
  const body = raw.slice(labelRow + 1)
  const columnSeries = new Map<number, string>()
  for (let c = 1; c < width; c++) {
    if (isNa(labels[c])) continue
    const label = String(labels[c]).trim()
    if (!label || /^(unnamed|date)/i.test(label)) continue
    const prefix = group[c]
    const p = isNa(prefix) ? '' : String(prefix).trim()
    columnSeries.set(c, p && p !== label ? `${p} - ${label}` : label)
  }
  const dates = body.map((row): string | undefined => {
    const first = row[0]
    if (dateKind === 'quarter') return quarterToDate(first)
    if (dateKind === 'yyyymm') {
      const n = toNumeric(first)
      if (n === null || !Number.isInteger(n)) return undefined
      const m = /^(\d{4})(\d{2})$/.exec(String(n))
      return m && Number(m[2]) >= 1 && Number(m[2]) <= 12 ? `${m[1]}-${m[2]}-01` : undefined
    }
    return isDateCell(first) ? dateOf(first as string) : undefined
  })
  const rows: Long[] = []
  body.forEach((row, position) => {
    const observed = dates[position]
    if (observed === undefined) return
    if ((start && observed < start) || (end && observed > end)) return
    for (const [c, series] of columnSeries) rows.push({ date: observed, series, value: toNumeric(row[c]) })
  })
  return rows
}

/** A DGEI sheet's side-by-side measure blocks as long records (`parse_dgei`). */
export function parseDgei(raw: Grid, start?: string, end?: string): Long[] {
  const width = raw[0]?.length ?? 0
  let labelRow = -1
  for (let i = 0; i < Math.min(15, raw.length); i++) {
    if (pyStr(raw[i]![0]).toLowerCase() === 'date') {
      labelRow = i
      break
    }
  }
  if (labelRow < 0) return []
  const measures = labelRow >= 1 ? raw[labelRow - 1]! : raw[labelRow]!
  const labels = raw[labelRow]!
  const body = raw.slice(labelRow + 1)
  const dateCols = labels.map((l, i) => [l, i] as const).filter(([l]) => pyStr(l).toLowerCase() === 'date').map(([, i]) => i)
  const rows: Long[] = []
  dateCols.forEach((first, block) => {
    const stop = block + 1 < dateCols.length ? dateCols[block + 1]! : width
    let measure = ''
    for (let i = first; i < stop; i++) {
      const candidate = measures[i]
      if (!isNa(candidate) && String(candidate).trim()) {
        measure = String(candidate).trim().split(/[,=]/)[0]!.trim()
        break
      }
    }
    const dates = body.map((r) => (isDateCell(r[first]) ? dateOf(r[first] as string) : undefined))
    for (let i = first + 1; i < stop; i++) {
      if (isNa(labels[i])) continue
      const aggregate = String(labels[i]).trim()
      if (!aggregate || /^(unnamed|date)/i.test(aggregate)) continue
      const series = measure ? `${aggregate} - ${measure}` : aggregate
      body.forEach((row, position) => {
        const observed = dates[position]
        if (observed === undefined) return
        if ((start && observed < start) || (end && observed > end)) return
        rows.push({ date: observed, series, value: toNumeric(row[i]) })
      })
    }
  })
  return rows
}

