// What the OECD data routes share: country params, default dates, fetching with OpenBB's error wrapper, and rows.
// Ported from the pieces repeated in openbb_oecd/models/*.py (OpenBB Platform 5.0.0, Apache-2.0).
import { text } from '../lib/params.js'
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { resolveCountryCodes } from './metadata.js'
import { fetchData, oecdDate, type DimensionValues, type Row as CsvRow } from './query-builder.js'

/** The `country` param as the query models validate it: spaces become underscores, lower case. */
export function countryParam(params: NativeParams, fallback: string): string {
  return (text(params, 'country') ?? fallback).replace(/ /g, '_').trim().toLowerCase()
}

/** The year of `ctx.now()` (`date.today().year`). */
export const thisYear = (ctx: NativeCtx): number => ctx.now().getFullYear()

/** The start and end of the window: the params, else a start by whether all countries are asked for, and the end of this year. */
export function dateWindow(params: NativeParams, ctx: NativeCtx, defaults: { all: string; one: string }): { start: string; end: string } {
  const all = text(params, 'country') === 'all'
  return { start: text(params, 'start_date') ?? (all ? defaults.all : defaults.one), end: text(params, 'end_date') ?? `${String(thisYear(ctx)).padStart(4, '0')}-12-31` }
}

/** Country names as the `+`-joined codes of a dataflow's REF_AREA selection, empty for all of them. */
export function countryCodes(dataflow: string, country: string): string {
  return resolveCountryCodes(dataflow, country).join('+')
}

/** A fetch that reports a failure the way the OECD routes do: "Error fetching OECD data: …". */
export async function fetchRows(ctx: NativeCtx, dataflow: string, opts: { start?: string | undefined; end?: string | undefined; dimensions: DimensionValues }): Promise<CsvRow[]> {
  try {
    return await fetchData(ctx, dataflow, { startDate: opts.start, endDate: opts.end, dimensions: opts.dimensions })
  } catch (exc) {
    throw new Error(`Error fetching OECD data: ${exc instanceof Error ? exc.message : String(exc)}`, { cause: exc })
  }
}

/** `YYYY-MM-DD` as the `YYYY-MM` the monthly routes ask for (`strftime("%Y-%m")`). */
export const yearMonth = (isoDate: string): string => isoDate.slice(0, 7)

/** The label of a row's REF_AREA, else its code (`row.get("REF_AREA_label", row.get("REF_AREA", ""))`). */
export function areaLabel(row: CsvRow, fallback: string | null = ''): string | null {
  if ('REF_AREA_label' in row) return row.REF_AREA_label as string | null
  return 'REF_AREA' in row ? (row.REF_AREA as string | null) : fallback
}

/** The sort key of rows by date then country text. */
export function byDateThenCountry(a: Row, b: Row): number {
  const da = a.date as string
  const db = b.date as string
  if (da !== db) return da < db ? -1 : 1
  const ca = (a.country as string | null) || ''
  const cb = (b.country as string | null) || ''
  return ca < cb ? -1 : ca > cb ? 1 : 0
}

/** A row's observation as a number, undefined when there is none (`value is None or value == ""`). */
export function observation(row: CsvRow): number | undefined {
  const v = row.OBS_VALUE
  if (v === null || v === undefined || v === '') return undefined
  return typeof v === 'number' ? v : Number(v)
}

export { oecdDate }
