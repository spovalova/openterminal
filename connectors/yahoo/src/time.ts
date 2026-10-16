// Clock helpers. Yahoo's chart endpoint takes period1/period2 instants, and its earnings dates are
// 20:00Z stamps on the US calendar day, so both kinds need America/New_York arithmetic.
import type { Interval, Range } from '@terminal/core'

export const NY = 'America/New_York'

type Parts = { year: number; month: number; day: number; hour: number; minute: number; weekday: number }

const partsFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: NY,
  hourCycle: 'h23',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  weekday: 'short',
})

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

/** Wall-clock parts of an instant in New York. weekday is 0 = Sunday. */
export function nyParts(at: Date): Parts {
  const out: Partial<Parts> = {}
  for (const p of partsFormat.formatToParts(at)) {
    if (p.type === 'year') out.year = Number(p.value)
    else if (p.type === 'month') out.month = Number(p.value)
    else if (p.type === 'day') out.day = Number(p.value)
    else if (p.type === 'hour') out.hour = Number(p.value) % 24
    else if (p.type === 'minute') out.minute = Number(p.value)
    else if (p.type === 'weekday') out.weekday = WEEKDAYS[p.value] ?? 0
  }
  return out as Parts
}

/** Calendar date of an instant in New York, as YYYY-MM-DD. */
export function nyDate(at: Date): string {
  const { year, month, day } = nyParts(at)
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** The instant at which the New York wall clock reads year-month-day 00:00 (DST aware). */
export function nyMidnight(year: number, month: number, day: number): Date {
  // Guess the UTC instant, measure how far NY wall time is from the target, correct, and settle once more for DST edges.
  let guess = Date.UTC(year, month - 1, day, 0, 0, 0)
  for (let i = 0; i < 2; i++) {
    const p = nyParts(new Date(guess))
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0)
    const target = Date.UTC(year, month - 1, day, 0, 0, 0)
    guess += target - asUtc
  }
  return new Date(guess)
}

/**
 * Start (NY midnight) of the most recent regular session as of `now`: today if it is a weekday and the
 * open (09:30 ET) has passed, else the previous weekday. Exchange holidays are not known here; a query
 * during a holiday returns the holiday's empty session.
 */
export function sessionStart(now: Date): Date {
  const p = nyParts(now)
  let { year, month, day } = p
  let back = 0
  if (p.weekday === 6) back = 1
  else if (p.weekday === 0) back = 2
  else if (p.hour < 9 || (p.hour === 9 && p.minute < 30)) back = p.weekday === 1 ? 3 : 1
  if (back > 0) {
    const d = new Date(Date.UTC(year, month - 1, day))
    d.setUTCDate(d.getUTCDate() - back)
    year = d.getUTCFullYear()
    month = d.getUTCMonth() + 1
    day = d.getUTCDate()
  }
  return nyMidnight(year, month, day)
}

function minusMonths(now: Date, months: number): Date {
  const d = new Date(now.getTime())
  const day = d.getUTCDate()
  d.setUTCDate(1)
  d.setUTCMonth(d.getUTCMonth() - months)
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
  d.setUTCDate(Math.min(day, last))
  return d
}

/** Map our range to the chart endpoint's period1/period2, which has no `range` option. */
export function rangeToPeriod(range: Range, now: Date): { period1: Date; period2: Date } {
  const period2 = now
  switch (range) {
    case '1d':
      return { period1: sessionStart(now), period2 }
    case '5d':
      return { period1: new Date(now.getTime() - 7 * 86_400_000), period2 }
    case '1mo':
      return { period1: minusMonths(now, 1), period2 }
    case '3mo':
      return { period1: minusMonths(now, 3), period2 }
    case '6mo':
      return { period1: minusMonths(now, 6), period2 }
    case '1y':
      return { period1: minusMonths(now, 12), period2 }
    case '5y':
      return { period1: minusMonths(now, 60), period2 }
  }
}

export type YahooInterval = '1m' | '5m' | '15m' | '1h' | '1d' | '1wk'

/** Our interval names match Yahoo's except weekly. */
export function toYahooInterval(interval: Interval): YahooInterval {
  return interval === '1w' ? '1wk' : interval
}
