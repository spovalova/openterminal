// Shared by the Cleveland Fed routes, provider federal_reserve. Ported from the downloads in
// openbb_federal_reserve/models/regional/cleveland_*.py (OpenBB Platform 5.0.0, Apache-2.0); modified: ctx.cache instead
// of the on-disk cache, and plain arrays instead of pandas frames.
import { BROWSER_UA } from '../../../http.js'
import type { NativeCtx, NativeParams, Row } from '../../../types.js'
import { pivotWide, roundValue } from '../workbook.js'

export const CLEVELAND_WEBCHARTS = 'https://www.clevelandfed.org/-/media/files/webcharts'
const DAY_MS = 24 * 3600 * 1000

/** A text download (CSV, JSON), kept for a day. */
export function downloadText(ctx: NativeCtx, key: string, url: string): Promise<string> {
  return ctx.cache(`cleveland:${key}`, DAY_MS, async () => {
    const text = await ctx.http.text(url, { headers: { 'user-agent': BROWSER_UA } })
    if (!text) throw new Error('The request was returned empty.')
    return text
  })
}

/** A workbook download, kept for a day. */
export function downloadWorkbook(ctx: NativeCtx, key: string, url: string): Promise<Uint8Array> {
  return ctx.cache(`cleveland:${key}`, DAY_MS, async () => {
    const bytes = await ctx.http.bytes(url, { headers: { 'user-agent': BROWSER_UA } })
    if (bytes.length === 0) throw new Error('The request was returned empty.')
    return bytes
  })
}

export const dateParam = (params: NativeParams, name: 'start_date' | 'end_date'): string | undefined => (typeof params[name] === 'string' && params[name] ? (params[name] as string) : undefined)

/**
 * The melt, filter, sort and pivot the CSV routes share: columns of `labels` (in its order) become series, dates are
 * filtered, values rounded with `round_value`, rows sorted by (date, series) and pivoted to one row per date.
 */
export function meltAndPivot(rows: { date: string; values: Record<string, number | null> }[], labels: Record<string, string>, start?: string, end?: string): Row[] {
  const records: Row[] = []
  for (const { date, values } of rows) {
    if (start && date < start) continue
    if (end && date > end) continue
    for (const [column, series] of Object.entries(labels)) {
      if (!(column in values)) continue
      const v = values[column]
      records.push({ date, series, value: v === null || v === undefined ? null : roundValue(v) })
    }
  }
  records.sort((a, b) => (a.date === b.date ? ((a.series as string) < (b.series as string) ? -1 : (a.series as string) > (b.series as string) ? 1 : 0) : (a.date as string) < (b.date as string) ? -1 : 1))
  return pivotWide(records, 'date', 'series', 'value')
}
