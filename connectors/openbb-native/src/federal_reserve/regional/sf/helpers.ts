// Shared by the San Francisco Fed routes, provider federal_reserve. Ported from the downloads in
// openbb_federal_reserve/models/regional/san_francisco_*.py (OpenBB Platform 5.0.0, Apache-2.0); modified: ctx.cache
// instead of the on-disk cache, and plain arrays instead of pandas frames.
import { BROWSER_UA } from '../../../http.js'
import type { NativeCtx, NativeParams, Row } from '../../../types.js'
import { isNa, toDate, type Cell, type Frame } from '../workbook.js'

export const SF_UPLOADS = 'https://www.frbsf.org/wp-content/uploads'
const DAY_MS = 24 * 3600 * 1000

/** A workbook download, kept for a day. */
export function downloadWorkbook(ctx: NativeCtx, key: string, url: string): Promise<Uint8Array> {
  return ctx.cache(`sf:${key}`, DAY_MS, async () => {
    const bytes = await ctx.http.bytes(url, { headers: { 'user-agent': BROWSER_UA }, timeoutMs: 120_000 })
    if (bytes.length === 0) throw new Error('The request was returned empty.')
    return bytes
  })
}

export const dateParam = (params: NativeParams, name: 'start_date' | 'end_date'): string | undefined => (typeof params[name] === 'string' && params[name] ? (params[name] as string) : undefined)

/** The index of a column of the frame, or a KeyError like pandas'. */
export function column(frame: Frame, name: string): number {
  const at = frame.columns.indexOf(name)
  if (at < 0) throw new Error(`'${name}'`)
  return at
}

/** `df.rename(columns=…)` then keeping every column (or only `keep`), as the label of each column position. */
export function renamed(frame: Frame, rename: Record<string, string>): string[] {
  return frame.columns.map((c) => rename[c] ?? c)
}

/**
 * The wide rows of a dated sheet: `dateOf` turns the date column's cell into a date (undefined drops the row), the
 * rows are filtered to the window and sorted by date, and every other column of `labels` becomes a field when not missing.
 */
export function datedRows(frame: Frame, labels: string[], dateColumn: number, dateOf: (cell: Cell) => string | undefined, start?: string, end?: string, keep?: string[]): Row[] {
  const dated = frame.rows.flatMap((row) => {
    const date = dateOf(row[dateColumn] ?? null)
    return date === undefined ? [] : [{ row, date }]
  })
  dated.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  const out: Row[] = []
  for (const { row, date } of dated) {
    if (start && date < start) continue
    if (end && date > end) continue
    const record: Row = {}
    labels.forEach((label, i) => {
      if (i !== dateColumn && !isNa(row[i]) && (!keep || keep.includes(label))) record[label] = row[i]
    })
    record.date = date
    out.push(record)
  }
  return out
}

/** `to_datetime(cell, errors="coerce")` of a date column. */
export const dateCell = (cell: Cell): string | undefined => toDate(cell)

/** `to_datetime(str(cell).strip(), format="%Ym%m", errors="coerce")`: "1988m01". */
export function monthCell(cell: Cell): string | undefined {
  if (isNa(cell)) return undefined
  const m = /^(\d{4})m(\d{1,2})$/.exec(String(cell).trim())
  if (!m) return undefined
  const month = Number(m[2])
  return month >= 1 && month <= 12 ? `${m[1]}-${String(month).padStart(2, '0')}-01` : undefined
}
