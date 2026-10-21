// Calendar-date helpers for the DTCC routes: dates are "YYYY-MM-DD" strings and arithmetic runs on whole days since
// the epoch, as Python's `datetime.date` does. Written for the port of openbb_cftc (OpenBB Platform 5.0.0, Apache-2.0).

export type D = string

const MS = 86_400_000

/** Days since 1970-01-01 of an ISO date. */
export const toDays = (d: D): number => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10))) / MS
export const fromDays = (n: number): D => new Date(n * MS).toISOString().slice(0, 10)
export const addDays = (d: D, n: number): D => fromDays(toDays(d) + n)
/** `a - b` in days. */
export const diffDays = (a: D, b: D): number => toDays(a) - toDays(b)
/** Python's `date.toordinal()`. */
export const ordinal = (d: D): number => toDays(d) + 719163
/** Monday is 0. */
export const weekday = (d: D): number => (new Date(toDays(d) * MS).getUTCDay() + 6) % 7

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/

/** `date.fromisoformat(text[:10])`, or null when it is not a real date. */
export function parseIso(text: string | null | undefined): D | null {
  const t = (text ?? '').trim().slice(0, 10)
  const m = ISO.exec(t)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const day = Number(m[3])
  if (y < 1 || mo < 1 || mo > 12 || day < 1) return null
  return new Date(Date.UTC(y, mo - 1, day)).getUTCDate() === day && new Date(Date.UTC(y, mo - 1, day)).getUTCMonth() === mo - 1 ? t : null
}

export const todayOf = (now: Date): D => now.toISOString().slice(0, 10)

export const year = (d: D): number => Number(d.slice(0, 4))
export const month = (d: D): number => Number(d.slice(5, 7))

export const daysInMonth = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate()

/** `date(y, m, d)` with the day clamped to the month's length. */
export const clampedDate = (y: number, m: number, d: number): D => `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(Math.min(d, daysInMonth(y, m))).padStart(2, '0')}`

/** Python's `date.replace(year=...)` is an error on Feb 29; callers that need the clamp use clampedDate. */
export const mk = (y: number, m: number, d: number): D => `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
