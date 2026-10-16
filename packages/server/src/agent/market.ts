/**
 * US equity market state for the system prompt, computed in America/New_York.
 *
 * NYSE sessions (Eastern time, Monday to Friday):
 *   pre      04:00 - 09:30
 *   regular  09:30 - 16:00
 *   post     16:00 - 20:00
 *   closed   otherwise, and all day Saturday and Sunday
 *
 * Exchange holidays and early closes are ignored in v1: on a holiday this reports
 * the weekday session, and the quote frame's own `market_state` column is the
 * source of truth for the model. Add a holiday table here when that bites.
 */
export type MarketState = 'pre' | 'regular' | 'post' | 'closed'

export const MARKET_TZ = 'America/New_York'

export type EasternParts = {
  /** 0 = Sunday … 6 = Saturday */
  weekday: number
  hour: number
  minute: number
  /** YYYY-MM-DD */
  date: string
  /** HH:MM, 24h */
  time: string
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: MARKET_TZ,
  weekday: 'short',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

/** Wall-clock parts of `now` in Eastern time. */
export function easternParts(now: Date): EasternParts {
  const p: Record<string, string> = {}
  for (const part of fmt.formatToParts(now)) p[part.type] = part.value
  const hour = Number(p.hour) % 24 // some ICU builds print 24 for midnight
  const minute = Number(p.minute)
  return {
    weekday: WEEKDAYS[p.weekday ?? ''] ?? 0,
    hour,
    minute,
    date: `${p.year}-${p.month}-${p.day}`,
    time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
  }
}

export function marketState(now: Date): MarketState {
  const { weekday, hour, minute } = easternParts(now)
  if (weekday === 0 || weekday === 6) return 'closed'
  const t = hour * 60 + minute
  if (t >= 4 * 60 && t < 9 * 60 + 30) return 'pre'
  if (t >= 9 * 60 + 30 && t < 16 * 60) return 'regular'
  if (t >= 16 * 60 && t < 20 * 60) return 'post'
  return 'closed'
}

/** YYYY-MM-DD in Eastern time, `days` from now (negative for the past). */
export function easternDate(now: Date, days = 0): string {
  return easternParts(new Date(now.getTime() + days * 86_400_000)).date
}
