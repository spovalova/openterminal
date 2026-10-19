// Clock helpers. Yahoo stamps option expirations, fiscal quarters and filing dates at 00:00Z and its intraday
// bars in exchange time, so the connector needs both a New York calendar and a UTC date.

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
 * Calendar date of a midnight-UTC stamp, as YYYY-MM-DD. Yahoo stamps filing dates, fiscal quarters,
 * short-interest settlement dates and option expirations at 00:00Z, which in New York is still the
 * evening before, so these must not go through `nyDate`.
 */
export function utcDate(at: Date): string {
  return at.toISOString().slice(0, 10)
}
