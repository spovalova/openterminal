// economy/calendar, provider ecb. Ported from openbb_ecb/models/economic_calendar.py and the release-calendar part
// of utils/non_sdmx.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { PLAIN_HEADERS, text } from './helpers.js'

const STATSCAL_URL = 'https://www.ecb.europa.eu/press/calendars/statscal/html/index.en.html'
const DT_DD = /<dt[^>]*>(.*?)<\/dt>\s*<dd[^>]*>(.*?)<\/dd>/gs
const DATE = /(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})/
const DATASET = /\(Dataset:\s*([^)]+)\)/
const REFERENCE_PERIOD = /Reference period:\s*([^.]+?)(?:\s*Includes|\s*$)/
const DATAFLOW_ALIASES: Record<string, string> = { BPS: 'BOP', GFS: 'GST', RAS: 'RA' }

/** Strip tags and collapse whitespace. */
const stripHtml = (s: string): string => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()

export async function economicCalendar(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const html = await ctx.cache('ecb:calendar', 3600 * 1000, () => ctx.http.text(STATSCAL_URL, { headers: PLAIN_HEADERS }))
  const rows: Row[] = []
  for (const [, dtRaw, ddRaw] of html.matchAll(DT_DD)) {
    const dtText = stripHtml(dtRaw!)
    const ddText = stripHtml(ddRaw!)
    const m = DATE.exec(dtText)
    if (!m) continue
    const [, day, month, year, hour, minute] = m
    const dataset = DATASET.exec(ddText)
    const ref = REFERENCE_PERIOD.exec(ddText)
    // `_DATASET_RE.split(dd_text)[0]`: the text before the first "(Dataset: …)", trimmed of a dangling "(".
    const before = ddText.split(DATASET)[0]!.trim().replace(/\(+$/, '').trim()
    const row: Row = { date: `${year}-${month}-${day}T${hour}:${minute}:00`, country: 'Euro Area' }
    if (dataset) row.category = dataset[1]!.trim()
    row.event = before || ddText
    if (ref) row.reference_period = ref[1]!.trim()
    row.source = 'European Central Bank'
    rows.push(row)
  }

  const start = text(params, 'start_date')
  const end = text(params, 'end_date')
  const filtered = rows.filter((row) => {
    const day = (row.date as string).slice(0, 10)
    return (!start || day >= start) && (!end || day <= end)
  })
  if (filtered.length === 0) throw new Error('No ECB calendar releases found for the query.')
  filtered.sort((a, b) => ((a.date as string) < (b.date as string) ? -1 : (a.date as string) > (b.date as string) ? 1 : 0))
  return filtered.map((row) => (typeof row.category === 'string' ? { ...row, category: DATAFLOW_ALIASES[row.category] ?? row.category } : row))
}
