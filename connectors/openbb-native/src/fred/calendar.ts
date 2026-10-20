// economy/calendar, provider fred. Ported from openbb_fred/models/economic_calendar.py (OpenBB Platform 5.0.0,
// Apache-2.0); modified: the calendar pages' HTML tables are read with node-html-parser instead of
// pandas.read_html, and "today" is the UTC date of ctx.now(). This route needs no key: it reads the public
// releases calendar on fred.stlouisfed.org.
import { parse } from 'node-html-parser'
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { fredGet, fredGetMany, requestHeaders, text, useCache } from './helpers.js'

type Json = Record<string, any>

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']

/** `datetime.isoformat()` of a naive datetime, microseconds only when there are any. */
function isoformat(d: Date): string {
  const iso = d.toISOString()
  const ms = iso.slice(20, 23)
  return ms === '000' ? iso.slice(0, 19) : `${iso.slice(0, 19)}.${ms}000`
}

const addDays = (d: Date, days: number) => new Date(d.getTime() + days * 86400_000)

/** Local US Central offset in minutes for a wall-clock time, refusing the hour that does not exist and the one that happens twice. */
function centralOffset(y: number, m: number, d: number, h: number, min: number): number {
  const nthSunday = (month: number, n: number) => {
    const first = new Date(Date.UTC(y, month, 1)).getUTCDay()
    return 1 + ((7 - first) % 7) + (n - 1) * 7
  }
  const start = nthSunday(2, 2) // second Sunday of March
  const end = nthSunday(10, 1) // first Sunday of November
  const local = Date.UTC(y, m - 1, d, h, min)
  const springForward = Date.UTC(y, 2, start, 2, 0)
  const fallBack = Date.UTC(y, 10, end, 2, 0)
  if (local >= springForward && local < springForward + 3600_000) throw new Error(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')} ${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}:00 is a nonexistent time due to daylight savings time. Try using the 'nonexistent' argument.`)
  if (local >= fallBack - 3600_000 && local < fallBack) throw new Error(`Cannot infer dst time from ${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')} ${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}:00, try using the 'ambiguous' argument`)
  return local >= springForward + 3600_000 && local < fallBack - 3600_000 ? -300 : -360
}

/** `2026-10-14 1:00 am` (or just the date) as a datetime in US/Central, the way pandas writes it. */
function centralTime(date: string, time: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  let hour = 0
  let minute = 0
  if (time) {
    const t = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i.exec(time.trim())
    if (!t) throw new Error(`Unknown datetime string format, unable to parse: ${date} ${time}`)
    hour = Number(t[1]) % 12 + (t[3]!.toLowerCase() === 'pm' ? 12 : 0)
    minute = Number(t[2] ?? 0)
  }
  const offset = centralOffset(y, m, d, hour, minute)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${y}-${pad(m)}-${pad(d)}T${pad(hour)}:${pad(minute)}:00-${pad(Math.abs(offset) / 60)}:00`
}

/** A heading row's date, `Wednesday October 14, 2026 Updated` → `2026-10-14`. */
function headingDate(label: string): string {
  const m = /([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/.exec(label)
  const month = m ? MONTHS.indexOf(m[1]!.toLowerCase()) : -1
  if (!m || month < 0) throw new Error(`Unknown datetime string format, unable to parse: ${label}`)
  return `${m[3]}-${String(month + 1).padStart(2, '0')}-${m[2]!.padStart(2, '0')}`
}

type Event = { date: string; event: string; release_id: string }

/** One page of the calendar: its table as events, each with the date and time of the heading and cell above it (`process_pager`). */
function processPager(html: string, day: string): Event[] {
  const table = parse(html).querySelector('table')
  if (!table) throw new Error('No tables found')
  const body = table.querySelectorAll('tbody tr')
  const cells = (tr: (typeof body)[number]) => {
    const tds = tr.querySelectorAll('td')
    const clean = (s: string) => s.replace(/\s+/g, ' ').trim()
    const first = tds[0]
    // A cell spanning both columns reads the same in both.
    const second = tds[1] ?? tds[0]
    return {
      date: first ? clean(first.text).replace('N/A', '') || null : null,
      event: second ? clean(second.text) : '',
      link: second ? (second.querySelector('a')?.getAttribute('href') ?? null) : null,
    }
  }
  const rows = body.map(cells).map((r) => ({ ...r, releaseId: r.link ? r.link.split('rid=').at(-1)! : null }))
  const isHeader = rows.map((r) => r.releaseId === null)
  const events: Event[] = []
  if (isHeader.some(Boolean)) {
    let lastDate: string | null = null
    let lastTime = ''
    rows.forEach((r, i) => {
      if (isHeader[i]) {
        lastDate = headingDate(String(r.date ?? '').replace(/\s*(Updated|Revised)\s*$/, '').trim())
        return
      }
      if (r.date !== null) lastTime = r.date
      if (lastDate === null) throw new Error('Cannot localize a missing date')
      events.push({ date: centralTime(lastDate, lastTime), event: r.event, release_id: r.releaseId! })
    })
  } else {
    // No headings: every row is an event of `day`, with the time of the last row that had one.
    let lastTime: string | null = null
    for (const r of rows) {
      if (r.date !== null) lastTime = r.date
      events.push({ date: centralTime(day.slice(0, 10), lastTime ?? ''), event: r.event, release_id: r.releaseId! })
    }
  }
  return events
}

export async function economicCalendar(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const cache = useCache(params)
  const headers = requestHeaders()
  const startParam = text(params, 'start_date')
  const endParam = text(params, 'end_date')
  const now = new Date(ctx.now().getTime())
  const start = startParam ?? isoformat(addDays(now, -1))
  const end = endParam ?? (startParam ? addDays(new Date(`${startParam}T00:00:00Z`), 7).toISOString().slice(0, 10) : isoformat(addDays(now, 1)))
  const rid = text(params, 'release_id') ?? ''

  const fetchDatePages = async (from: string, to = ''): Promise<Event[]> => {
    to = to || from
    const base = `https://fred.stlouisfed.org/releases/calendar?po=1&ptic=0&vs=${from}&ve=${to}&rid=${rid}`
    const first: Json = await fredGet(ctx, base, { useCache: cache, headers, raw: true })
    const count = first.ptic ?? 0
    if (count === 0) return []
    const events = processPager(first.pager, from)
    if (events.length >= count) return events
    const pages = Math.ceil(count / 50)
    const urls = Array.from({ length: Math.max(0, pages - 1) }, (_, i) => `${base}&pageID=${i + 2}`)
    const more = await fredGetMany(ctx, urls, { useCache: cache, headers, raw: true })
    return [...events, ...more.flatMap((page: Json) => processPager(page.pager, from))]
  }

  let events: Event[]
  try {
    if (rid) events = await fetchDatePages(start, end)
    else {
      // One request per day in the range (pandas.date_range keeps the time of day of its start).
      const days: string[] = []
      const first = new Date(`${start.slice(0, 10)}T${start.slice(11, 19) || '00:00:00'}Z`)
      const last = new Date(`${end.slice(0, 10)}T${end.slice(11, 19) || '00:00:00'}Z`)
      for (let d = first; d <= last; d = addDays(d, 1)) days.push(d.toISOString().slice(0, 10))
      const pages = await Promise.all(days.map((d) => fetchDatePages(d)))
      events = pages.flat().sort((a, b) => Date.parse(a.date) - Date.parse(b.date))
    }
  } catch (err) {
    throw new Error((err instanceof Error && err.message) || 'FRED request failed (Error).', { cause: err })
  }
  if (events.length === 0) throw new Error('The requested returned no data. Check the parameters and try again.')
  return events.map((e) => ({ date: e.date, event: e.event, release_id: Number(e.release_id) }))
}
