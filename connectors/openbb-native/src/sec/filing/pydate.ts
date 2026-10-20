// Dates as the SEC filing code handles them with pandas, provider sec. Ported from the `to_datetime`, `DateOffset`,
// `MonthEnd`, `MonthBegin` and `strftime` calls of openbb_sec/models/sec_filing.py and sec_financials.py (OpenBB
// Platform 5.0.0, Apache-2.0); modified: calendar dates only, as plain year, month, day numbers.
import { pyStrip } from './pandas-lite.js'

export type YMD = { y: number; m: number; d: number }

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }
const monthOf = (name: string): number | undefined => MONTHS[name.slice(0, 3).toLowerCase()]

export const daysInMonth = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate()
export const isValidDate = ({ y, m, d }: YMD): boolean => m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m)

/** `pandas.to_datetime(text)` for the date forms the SEC pages use; anything else is an error, as in pandas. */
export function parseDate(text: string): YMD {
  const t = pyStrip(text)
  let out: YMD | undefined
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(t)
  if (m) out = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) }
  if (!out && (m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(t))) out = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) }
  if (!out && (m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t))) out = { y: Number(m[3]), m: Number(m[1]), d: Number(m[2]) }
  if (!out && (m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/.exec(t)) && monthOf(m[1]!)) out = { y: Number(m[3]), m: monthOf(m[1]!)!, d: Number(m[2]) }
  if (!out && (m = /^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/.exec(t)) && monthOf(m[2]!)) out = { y: Number(m[3]), m: monthOf(m[2]!)!, d: Number(m[1]) }
  if (!out && (m = /^([A-Za-z]{3,9})\.?,?\s+(\d{4})$/.exec(t)) && monthOf(m[1]!)) out = { y: Number(m[2]), m: monthOf(m[1]!)!, d: 1 }
  if (!out && (m = /^(\d{4})$/.exec(t))) out = { y: Number(m[1]), m: 1, d: 1 }
  if (!out || !isValidDate(out)) throw new Error(`Unknown datetime string format, unable to parse: ${text}`)
  return out
}

/** `strftime("%Y-%m-%d")` */
export const fmtDate = ({ y, m, d }: YMD): string => `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`

/** `ts - DateOffset(months=n)`: the day is clipped to the end of a shorter month. */
export function subMonths({ y, m, d }: YMD, n: number): YMD {
  const total = y * 12 + (m - 1) - n
  const ny = Math.floor(total / 12)
  const nm = (total % 12) + 1
  return { y: ny, m: nm, d: Math.min(d, daysInMonth(ny, nm)) }
}

/** `+ MonthEnd(0)`: roll forward to the last day of the month. */
export const monthEnd = ({ y, m }: YMD): YMD => ({ y, m, d: daysInMonth(y, m) })

/** `+ MonthBegin(1)` from a date that is not a month start: the first day of the next month. */
export const nextMonthBegin = ({ y, m }: YMD): YMD => (m === 12 ? { y: y + 1, m: 1, d: 1 } : { y, m: m + 1, d: 1 })

/** `ts.replace(year=y - 1) + timedelta(days=1)` */
export function sameDayLastYearPlusOne({ y, m, d }: YMD): YMD {
  const prev = { y: y - 1, m, d }
  if (!isValidDate(prev)) throw new Error('day is out of range for month')
  const next = new Date(Date.UTC(prev.y, prev.m - 1, prev.d + 1))
  return { y: next.getUTCFullYear(), m: next.getUTCMonth() + 1, d: next.getUTCDate() }
}

/** The calendar quarter of a date (`Timestamp.quarter`). */
export const quarterOf = ({ m }: YMD): number => Math.floor((m - 1) / 3) + 1
