import { columnIndex, type Frame } from './frame.js'

/**
 * Time semantics in one place (PLAN.md section 17, feature 5): the US equity calendar in Eastern Time.
 * Used by the runner, recipes (`{range|start_date}`), the `ot` helpers in transforms, previews and the prompt.
 * Nothing here knows about connectors. US calendar only in v2; per-exchange calendars follow.
 */

export const NY = 'America/New_York'
export const DAY_MS = 86_400_000
export const MS = { second: 1_000, minute: 60_000, hour: 3_600_000, day: DAY_MS } as const

/** The ranges the price recipes take (`ohlcv`, `index`, `macro`), and what `rangeStart` and `baselineFor` understand. */
export const RANGES = ['1d', '5d', '1mo', '3mo', '6mo', '1y', '2y', '5y'] as const
export type Range = (typeof RANGES)[number]
/** The bar intervals the price recipes take; the first four are intraday. */
export const INTERVALS = ['1m', '5m', '15m', '1h', '1d', '1w'] as const
export type Interval = (typeof INTERVALS)[number]
export const INTRADAY_INTERVALS: ReadonlySet<string> = new Set(['1m', '5m', '15m', '1h'])
export function isIntraday(interval: string): boolean {
  return INTRADAY_INTERVALS.has(interval)
}

export type NyParts = { year: number; month: number; day: number; hour: number; minute: number; weekday: number }

const partsFormat = new Intl.DateTimeFormat('en-US', { timeZone: NY, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' })
const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
export const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

/** Wall-clock parts of an instant in New York. weekday is 0 = Sunday. */
export function nyParts(at: Date | number): NyParts {
  const out: Partial<NyParts> = {}
  for (const p of partsFormat.formatToParts(typeof at === 'number' ? new Date(at) : at)) {
    if (p.type === 'year') out.year = Number(p.value)
    else if (p.type === 'month') out.month = Number(p.value)
    else if (p.type === 'day') out.day = Number(p.value)
    else if (p.type === 'hour') out.hour = Number(p.value) % 24
    else if (p.type === 'minute') out.minute = Number(p.value)
    else if (p.type === 'weekday') out.weekday = WEEKDAYS[p.value] ?? 0
  }
  return out as NyParts
}

/** Calendar date of an instant in New York, YYYY-MM-DD. */
export function nyDate(at: Date | number): string {
  const { year, month, day } = nyParts(at)
  return isoOf(year, month, day)
}

/** The instant at which the New York wall clock reads the given date and time (DST aware). */
export function nyWallToUtc(year: number, month: number, day: number, hour = 0, minute = 0): number {
  let guess = Date.UTC(year, month - 1, day, hour, minute, 0)
  for (let i = 0; i < 2; i++) {
    const p = nyParts(guess)
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0)
    guess += Date.UTC(year, month - 1, day, hour, minute, 0) - asUtc
  }
  return guess
}

/** Epoch ms of New York midnight on an ISO date. */
export function nyMidnight(date: string): number {
  const [y, m, d] = splitIso(date)
  return nyWallToUtc(y, m, d)
}

// ---- calendar ----

/** NYSE full-day closures, 2024 through 2027 (including the 2025-01-09 day of mourning). */
export const NYSE_HOLIDAYS: readonly string[] = [
  '2024-01-01', '2024-01-15', '2024-02-19', '2024-03-29', '2024-05-27', '2024-06-19', '2024-07-04', '2024-09-02', '2024-11-28', '2024-12-25',
  '2025-01-01', '2025-01-09', '2025-01-20', '2025-02-17', '2025-04-18', '2025-05-26', '2025-06-19', '2025-07-04', '2025-09-01', '2025-11-27', '2025-12-25',
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
]
const HOLIDAYS = new Set(NYSE_HOLIDAYS)

/** Sessions that close at 13:00 ET: the day after Thanksgiving, Christmas Eve, the day before Independence Day when it falls on a weekday. */
export const NYSE_EARLY_CLOSES: readonly string[] = ['2024-07-03', '2024-11-29', '2024-12-24', '2025-07-03', '2025-11-28', '2025-12-24', '2026-11-27', '2026-12-24', '2027-11-26']
const EARLY = new Set(NYSE_EARLY_CLOSES)

/** First and last year the holiday table covers; dates outside are judged by weekday only. */
export const CALENDAR_YEARS = { from: 2024, to: 2027 } as const

export function isWeekend(date: string): boolean {
  const wd = weekdayOf(date)
  return wd === 0 || wd === 6
}

export function isHoliday(date: string): boolean {
  return HOLIDAYS.has(date)
}

export function isTradingDay(date: string): boolean {
  return !isWeekend(date) && !isHoliday(date)
}

/** 0 = Sunday … 6 = Saturday for an ISO date (calendar arithmetic, no time zone). */
export function weekdayOf(date: string): number {
  const [y, m, d] = splitIso(date)
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}

/** 'Mon', 'Tue', … for an ISO date or an instant (in New York). */
export function weekdayLabel(at: string | number | Date): string {
  const wd = typeof at === 'string' ? weekdayOf(at) : nyParts(at).weekday
  return WEEKDAY_LABELS[wd] ?? ''
}

/** Add calendar days to an ISO date. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = splitIso(date)
  const t = new Date(Date.UTC(y, m - 1, d + days))
  return isoOf(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate())
}

/** Trading days from `start` to `end` inclusive, ascending ISO dates. Empty when end < start. */
export function tradingDays(start: string, end: string): string[] {
  const out: string[] = []
  for (let d = start; d <= end; d = addDays(d, 1)) if (isTradingDay(d)) out.push(d)
  return out
}

export function previousTradingDay(date: string): string {
  let d = addDays(date, -1)
  while (!isTradingDay(d)) d = addDays(d, -1)
  return d
}

export function nextTradingDay(date: string): string {
  let d = addDays(date, 1)
  while (!isTradingDay(d)) d = addDays(d, 1)
  return d
}

/** The trading day `n` sessions before `date` (n = 1 is previousTradingDay). */
export function tradingDaysBack(date: string, n: number): string {
  let d = date
  for (let i = 0; i < n; i++) d = previousTradingDay(d)
  return d
}

// ---- sessions ----

export type Session = 'pre' | 'regular' | 'post' | 'closed'

/** Session boundaries for a date, epoch ms: pre 04:00, open 09:30, close 16:00 (13:00 on early-close days), post ends 20:00. */
export function sessionBounds(date: string): { preStart: number; open: number; close: number; postEnd: number; early: boolean } {
  const [y, m, d] = splitIso(date)
  const early = EARLY.has(date)
  return {
    preStart: nyWallToUtc(y, m, d, 4, 0),
    open: nyWallToUtc(y, m, d, 9, 30),
    close: early ? nyWallToUtc(y, m, d, 13, 0) : nyWallToUtc(y, m, d, 16, 0),
    postEnd: early ? nyWallToUtc(y, m, d, 17, 0) : nyWallToUtc(y, m, d, 20, 0),
    early,
  }
}

/** Which US equity session an instant falls in: pre 04:00–09:30 ET, regular 09:30–16:00, post 16:00–20:00, else closed (and all day on weekends and holidays). */
export function sessionAt(at: Date | number = Date.now()): Session {
  const ms = typeof at === 'number' ? at : at.getTime()
  const date = nyDate(ms)
  if (!isTradingDay(date)) return 'closed'
  const b = sessionBounds(date)
  if (ms < b.preStart) return 'closed'
  if (ms < b.open) return 'pre'
  if (ms < b.close) return 'regular'
  if (ms < b.postEnd) return 'post'
  return 'closed'
}

/** One line for the prompt: "Tuesday 2026-10-20 14:05 ET, regular session". */
export function describeMarketTime(at: Date | number = Date.now()): string {
  const p = nyParts(at)
  const long = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][p.weekday]
  const session = sessionAt(at)
  const label = session === 'closed' ? 'market closed' : `${session === 'regular' ? 'regular' : session === 'pre' ? 'pre-market' : 'after-hours'} session`
  return `${long} ${isoOf(p.year, p.month, p.day)} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')} ET, ${label}`
}

/**
 * The most recent session date as of `now`: today when it is a trading day and the open has passed, else the
 * previous trading day. The date whose close is "the last close".
 */
export function lastTradingDay(now: Date | number = Date.now()): string {
  const ms = typeof now === 'number' ? now : now.getTime()
  const today = nyDate(ms)
  if (isTradingDay(today) && ms >= sessionBounds(today).open) return today
  return previousTradingDay(today)
}

/** The previous Monday-to-Friday week in New York: its first and last calendar dates and its trading days. */
export function lastWeek(now: Date | number = Date.now()): { start: string; end: string; days: string[] } {
  const today = nyDate(now)
  const wd = weekdayOf(today)
  const thisMonday = addDays(today, -((wd + 6) % 7))
  const start = addDays(thisMonday, -7)
  const end = addDays(start, 4)
  return { start, end, days: tradingDays(start, end) }
}

/** The Monday-to-Friday week containing `now`, up to today. */
export function thisWeek(now: Date | number = Date.now()): { start: string; end: string; days: string[] } {
  const today = nyDate(now)
  const wd = weekdayOf(today)
  const start = addDays(today, -((wd + 6) % 7))
  const end = addDays(start, 4)
  return { start, end, days: tradingDays(start, end <= today ? end : today) }
}

// ---- ranges and baselines ----

export const RANGE_MONTHS: Partial<Record<Range, number>> = { '1mo': 1, '3mo': 3, '6mo': 6, '1y': 12, '2y': 24, '5y': 60 }

function minusMonths(at: number, months: number): string {
  const p = nyParts(at)
  const d = new Date(Date.UTC(p.year, p.month - 1, 1))
  d.setUTCMonth(d.getUTCMonth() - months)
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
  return isoOf(d.getUTCFullYear(), d.getUTCMonth() + 1, Math.min(p.day, last))
}

/** The first calendar date a range covers: the last session for 1d, seven days back for 5d, whole months otherwise. */
export function rangeStart(range: Range, now: Date | number = Date.now()): string {
  const ms = typeof now === 'number' ? now : now.getTime()
  if (range === '1d') return lastTradingDay(ms)
  if (range === '5d') return nyDate(ms - 7 * DAY_MS)
  return minusMonths(ms, RANGE_MONTHS[range] ?? 1)
}

/**
 * The session whose close is the baseline for a period change: the last trading day strictly before the period
 * starts (bench v1's TSMC finding: a 1mo change is measured from the close before the month, not the first bar).
 */
export function baselineFor(range: Range, now: Date | number = Date.now()): string {
  return previousTradingDay(rangeStart(range, now))
}

/**
 * The previous close per group from a frame with a time column: the last `close` (or `value`) strictly before the
 * New York date of the group's latest row. For intraday bars that is yesterday's close; for daily bars the bar
 * before the last. `null` when the group has no earlier value.
 */
export function prevClose(frame: Frame, opts: { value?: string; group?: string } = {}): Record<string, number | null> {
  const ti = columnIndex(frame, 'time')
  const vi = columnIndex(frame, opts.value ?? (columnIndex(frame, 'close') >= 0 ? 'close' : 'value'))
  const gi = columnIndex(frame, opts.group ?? (columnIndex(frame, 'symbol') >= 0 ? 'symbol' : 'series'))
  const out: Record<string, number | null> = {}
  if (ti < 0 || vi < 0) return out
  const byGroup = new Map<string, { t: number; v: number }[]>()
  for (const r of frame.rows) {
    const t = r[ti]
    const v = r[vi]
    if (typeof t !== 'number' || typeof v !== 'number' || !Number.isFinite(v)) continue
    const g = gi >= 0 ? String(r[gi] ?? '') : '*'
    const list = byGroup.get(g) ?? []
    list.push({ t, v })
    byGroup.set(g, list)
  }
  for (const [g, list] of byGroup) {
    list.sort((a, b) => a.t - b.t)
    const lastDate = nyDate(list[list.length - 1]!.t)
    let prev: number | null = null
    for (const { t, v } of list) {
      if (nyDate(t) < lastDate) prev = v
      else break
    }
    out[g] = prev
  }
  return out
}

// ---- helpers ----

function splitIso(date: string): [number, number, number] {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date)
  if (!m) throw new Error(`not an ISO date: ${date}`)
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

function isoOf(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}
