// The Toronto Stock Exchange's trading days. Ported from the XTSE calendar of exchange_calendars (Apache-2.0) that
// openbb_tmx/utils/helpers.py `download_eod_chains` asks whether a date is a session; modified: rules computed per year
// instead of a pandas holiday calendar.
import { addDays, weekday } from './helpers.js'

const pad = (n: number): string => String(n).padStart(2, '0')
const ymd = (y: number, m: number, d: number): string => `${y}-${pad(m)}-${pad(d)}`

/** The n-th Monday on or after a day (n counts from 1). */
function nthMonday(y: number, m: number, n: number): string {
  let d = ymd(y, m, 1)
  while (weekday(d) !== 0) d = addDays(d, 1)
  return addDays(d, 7 * (n - 1))
}

/** `weekend_to_monday`: a Saturday or Sunday observance moves to the Monday. */
function weekendToMonday(day: string): string {
  const w = weekday(day)
  return w === 5 ? addDays(day, 2) : w === 6 ? addDays(day, 1) : day
}

/** Easter Sunday (the anonymous Gregorian algorithm). */
function easter(y: number): string {
  const a = y % 19
  const b = Math.floor(y / 100)
  const c = y % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)
  const day = ((h + l - 7 * m + 114) % 31) + 1
  return ymd(y, month, day)
}

/** The weekdays the exchange is closed in a year. */
export function tsxHolidays(y: number): Set<string> {
  const out = new Set<string>()
  out.add(weekendToMonday(ymd(y, 1, 1)))
  if (y >= 2008) out.add(nthMonday(y, 2, 3))
  out.add(addDays(easter(y), -2))
  // Victoria Day: the Monday on or before May 24.
  let victoria = ymd(y, 5, 24)
  while (weekday(victoria) !== 0) victoria = addDays(victoria, -1)
  out.add(victoria)
  out.add(weekendToMonday(ymd(y, 7, 1)))
  out.add(nthMonday(y, 8, 1))
  out.add(nthMonday(y, 9, 1))
  out.add(nthMonday(y, 10, 2))
  out.add(ymd(y, 12, 25))
  out.add(ymd(y, 12, 26))
  for (const day of [ymd(y, 12, 27), ymd(y, 12, 28)]) if (weekday(day) === 0 || weekday(day) === 1) out.add(day)
  if (y === 2001) {
    out.add('2001-09-11')
    out.add('2001-09-12')
  }
  return out
}

/** Whether the exchange trades on a day (`XTSE.sessions`). */
export function isTsxSession(day: string): boolean {
  return weekday(day) < 5 && !tsxHolidays(Number(day.slice(0, 4))).has(day)
}

/** `pandas.tseries.holiday.next_workday` for a weekend; `check_weekday` of the TMX helpers. */
export function nextWeekday(day: string): string {
  let d = day
  if (weekday(d) > 4) {
    d = addDays(d, 1)
    while (weekday(d) > 4) d = addDays(d, 1)
  }
  return d
}
