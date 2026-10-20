// The shape most regional Fed models share: download one CSV or workbook, rename columns, parse a date column, filter
// by start and end date, return the rows sorted by date. Ported in spirit from the identical `transform_data` of the
// openbb_federal_reserve/models/regional/*.py models (OpenBB Platform 5.0.0, Apache-2.0); modified: one function
// driven by a spec instead of one pydantic model each.
import type { NativeCtx, NativeHandler, NativeParams, Row } from '../../types.js'
import { readCsv, readSheet, renameColumns, rowOut, toDate, type Frame, type Value } from './frame.js'
import { DAY_MS, EmptyDataError, request, str } from './helpers.js'
import { readWorkbook } from './workbook.js'

export type SeriesSpec = {
  url: string
  /** `csv` (default) or the named worksheet of an xlsx file. */
  sheet?: string
  /** Header row of the worksheet (`read_excel(header=n)`); 0 by default. */
  header?: number
  /** `_COLUMN_MAP`. */
  rename?: Record<string, string>
  /** The column holding the date (named as in the file; after `rename` when `afterRename`). */
  dateColumn: string
  dateFormat?: string
  /** `errors="coerce"` followed by `dropna`: rows whose date does not parse are dropped (otherwise they are an error). */
  coerce?: boolean
  /** Columns of the file that are not part of the output. */
  drop?: string[]
  /** `frame[["date", *columns]]` with `to_numeric(errors="coerce")` on each. */
  numeric?: string[]
  /** `frame[["date", *columns]]`: only these columns (renamed names) besides the date. */
  select?: string[]
  /** Rows to skip at the top of the CSV. */
  skipRows?: number
}

/** `to_numeric(x, errors="coerce")` on an inferred cell. */
export function coerceNumber(v: Value | undefined): number | null {
  if (typeof v === 'number') return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return null
}

export async function loadFrame(ctx: NativeCtx, spec: Pick<SeriesSpec, 'url' | 'sheet' | 'header' | 'skipRows'>): Promise<Frame> {
  if (spec.sheet !== undefined) {
    const bytes = await ctx.cache(`fed:file:${spec.url}`, DAY_MS, () => ctx.http.bytes(spec.url, request({ timeoutMs: 60_000 })))
    const sheet = readWorkbook(bytes).find((s) => s.name === spec.sheet)
    if (!sheet) throw new Error(`Worksheet named '${spec.sheet}' not found`)
    return readSheet(sheet.rows, spec.header ?? 0)
  }
  const text = await ctx.cache(`fed:file:${spec.url}`, DAY_MS, () => ctx.http.text(spec.url, request({ timeoutMs: 60_000 })))
  if (!text) throw new EmptyDataError('The request was returned empty.')
  return readCsv(text, { ...(spec.skipRows ? { skipRows: spec.skipRows } : {}), header: spec.header ?? 0 })
}

/** The rows of a spec's file between the start and end dates, sorted by date. */
export function seriesRows(frame: Frame, spec: SeriesSpec, start: string | undefined, end: string | undefined, dateFormat: string | undefined = spec.dateFormat): Row[] {
  let f = renameColumns(frame, spec.rename ?? {})
  const dateColumn = spec.rename?.[spec.dateColumn] ?? spec.dateColumn
  if (!f.columns.includes(dateColumn)) throw new Error(`KeyError: '${spec.dateColumn}'`)
  const out: { date: string; row: Row }[] = []
  for (const r of f.rows) {
    const raw = r[dateColumn]
    // An xlsx date cell arrives as an ISO date: `to_datetime` leaves a real datetime alone, whatever the format.
    const date = (dateFormat ? toDate(raw, dateFormat) : undefined) ?? toDate(raw)
    if (date === undefined) {
      if (spec.coerce) continue
      throw new Error(`time data "${String(raw)}" doesn't match format "${dateFormat ?? ''}"`)
    }
    if ((start && date < start) || (end && date > end)) continue
    const row: Row = { date }
    for (const c of f.columns) {
      if (c === dateColumn || spec.drop?.includes(c)) continue
      if (spec.numeric && !spec.numeric.includes(c)) continue
      if (spec.select && !spec.select.includes(c)) continue
      row[c] = spec.numeric ? coerceNumber(r[c]) : r[c]
    }
    out.push({ date, row: rowOut(row) })
  }
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  return out.map((o) => o.row)
}

/** A handler for a plain dated series. */
export function seriesHandler(spec: SeriesSpec): NativeHandler {
  return async (params: NativeParams, ctx: NativeCtx) => {
    const frame = await loadFrame(ctx, spec)
    return seriesRows(frame, spec, str(params, 'start_date'), str(params, 'end_date'))
  }
}
