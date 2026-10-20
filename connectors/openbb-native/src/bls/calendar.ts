// economy/calendar, provider bls. Ported from openbb_bls/models/economic_calendar.py (OpenBB Platform 5.0.0,
// Apache-2.0); modified: plain rows instead of pydantic models, pages memoised through ctx.cache.
import type { NativeCtx, NativeHandler, NativeParams, Row } from '../types.js'
import { BLS_USER_AGENT, HTML_HEADERS, isoDate, str } from './helpers.js'

const ARCHIVE_EARLIEST = '2000-01-01'
const DAY_MS = 86_400_000

const CELL_RE = /<td[^>]*\bid="d(\d{4})"([^>]*)>(.*?)<\/td>/gis
const BLOCK_RE = /<p>(.*?)<\/p>/gis
const TAG_RE = /<[^>]+>/g
const HREF_RE = /href="([^"]+)"/i
const TIME_RE = /(\d{1,2}):(\d{2})\s*(AM|PM)/i

const pad = (n: number): string => String(n).padStart(2, '0')

/** The (start, end) window, defaulting to two days back and three weeks ahead (`_resolve_window`). */
function resolveWindow(start: string | undefined, end: string | undefined, now: Date): [string, string] {
  const iso = (d: Date): string => d.toISOString().slice(0, 10)
  const startDate = start ?? iso(new Date(now.getTime() - 2 * DAY_MS))
  const endDate = end ?? iso(new Date(now.getTime() + 21 * DAY_MS))
  if (startDate < ARCHIVE_EARLIEST) throw new Error(`BLS archive only goes back to January 2000. start_date ${startDate} is too early.`)
  if (endDate < startDate) throw new Error('end_date must be on or after start_date.')
  return [startDate, endDate]
}

/** One monthly schedule page, or '' when BLS has none (404). requests decodes text/html without a charset as latin-1. */
function fetchSchedule(ctx: NativeCtx, year: number, month: number): Promise<string> {
  const url = `https://www.bls.gov/schedule/${year}/${pad(month)}_sched.htm`
  return ctx.cache(`bls:schedule:${url}`, 3600 * 1000, async () => {
    const res = await ctx.http.response(url, { headers: { ...HTML_HEADERS, 'User-Agent': BLS_USER_AGENT } })
    if (res.status === 404) return ''
    if (res.status !== 200) throw new Error(`BLS returned HTTP ${res.status} fetching ${url}.`)
    const type = res.headers.get('content-type') ?? ''
    const charset = /charset=([\w-]+)/i.exec(type)?.[1]?.toLowerCase()
    return new TextDecoder(charset ?? 'latin1').decode(await res.arrayBuffer())
  })
}

/** "08:30 AM" as (hour, minute) (`_parse_release_time`). */
function parseReleaseTime(text: string | undefined): [number, number] | null {
  if (!text) return null
  const m = TIME_RE.exec(text)
  if (!m) return null
  let hour = Number(m[1])
  const minute = Number(m[2])
  const meridian = m[3]!.toUpperCase()
  if (meridian === 'PM' && hour !== 12) hour += 12
  else if (meridian === 'AM' && hour === 12) hour = 0
  return [hour, minute]
}

/** One `<p><strong>Release</strong><br>Period<br>Time</p>` block (`_parse_release_block`). */
function parseReleaseBlock(body: string, year: number, month: number, day: number): Row | null {
  const href = HREF_RE.exec(body)?.[1]
  const newsUrl = href && href.startsWith('/') ? `https://www.bls.gov${href}` : href
  const cleaned = body
    .split(/<br\s*\/?>/i)
    .map((p) => p.replace(TAG_RE, '').trim())
    .filter(Boolean)
  if (cleaned.length === 0) return null
  const event = cleaned[0]!
  if (!event || event === '&nbsp;') return null
  const timeStr = cleaned[2]
  const parsed = parseReleaseTime(timeStr)
  const date = `${isoDate(year, month, day)}T${parsed ? `${pad(parsed[0])}:${pad(parsed[1])}` : '00:00'}:00`
  return { date, country: 'US', category: null, event, importance: null, source: 'BLS', currency: null, unit: null, consensus: null, previous: null, revised: null, actual: null, period: cleaned[1] ?? null, time: timeStr ?? null, news_release_url: newsUrl ?? null }
}

/** Every release block of one monthly schedule page (`_parse_schedule_page`). */
function parseSchedulePage(html: string, year: number, month: number): Row[] {
  if (!html) return []
  const rows: Row[] = []
  for (const cell of html.matchAll(CELL_RE)) {
    if ((cell[2] ?? '').includes('other-month')) continue
    const cellMonth = Number(cell[1]!.slice(0, 2))
    const cellDay = Number(cell[1]!.slice(2))
    if (cellMonth !== month) continue
    for (const block of cell[3]!.matchAll(BLOCK_RE)) {
      const body = block[1]!
      if (body.includes('class="day"')) continue
      const row = parseReleaseBlock(body, year, cellMonth, cellDay)
      if (row) rows.push(row)
    }
  }
  return rows
}

async function calendar(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const [start, end] = resolveWindow(str(params.start_date), str(params.end_date), ctx.now())
  const rows: Row[] = []
  for (let y = Number(start.slice(0, 4)), m = Number(start.slice(5, 7)); y < Number(end.slice(0, 4)) || (y === Number(end.slice(0, 4)) && m <= Number(end.slice(5, 7))); ) {
    rows.push(...parseSchedulePage(await fetchSchedule(ctx, y, m), y, m))
    if (++m === 13) {
      y++
      m = 1
    }
  }
  const needle = (str(params.release) ?? '').toLowerCase().trim()
  const kept = rows.filter((row) => {
    const day = (row.date as string).slice(0, 10)
    return day >= start && day <= end && (!needle || ((row.event as string) || '').toLowerCase().includes(needle))
  })
  if (kept.length === 0) throw new Error('No BLS releases matched the requested window/filter.')
  // Newest first, ties by event name.
  return kept.sort((a, b) => (a.event === b.event ? 0 : (a.event as string) < (b.event as string) ? -1 : 1)).sort((a, b) => (a.date === b.date ? 0 : (a.date as string) < (b.date as string) ? 1 : -1))
}

export const calendarRoutes: Record<string, NativeHandler> = {
  'economy/calendar': calendar,
}
