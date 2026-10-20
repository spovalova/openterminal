// Python and pandas behaviours the statement engine relies on. Not a port of any one OpenBB file; the helpers keep the
// ported code (openbb_sec/utils/statement_schema/*, company_facts.py, frames.py) line for line with the Python.

const DAY_MS = 86_400_000

/** `datetime.strptime(date, '%Y-%m-%d')` as a day number (days since 1970-01-01); null where Python raises ValueError. */
export function dayNum(date: string): number | null {
  const known = DAY_CACHE.get(date)
  if (known !== undefined) return known
  const n = parseDay(date)
  // A pure function of its argument, memoised because the engine parses the same few thousand dates millions of times.
  if (DAY_CACHE.size < 100_000) DAY_CACHE.set(date, n)
  return n
}

const DAY_CACHE = new Map<string, number | null>()

function parseDay(date: string): number | null {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(date)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  if (mo < 1 || mo > 12 || d < 1) return null
  const t = Date.UTC(y, mo - 1, d)
  const back = new Date(t)
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null
  return Math.round(t / DAY_MS)
}

/** Like `dayNum` where Python has no try/except: an invalid date throws, as strptime does. */
export function mustDay(date: string): number {
  const n = dayNum(date)
  if (n === null) throw new Error(`time data '${date}' does not match format '%Y-%m-%d'`)
  return n
}

/** `(datetime.strptime(end) - datetime.strptime(start)).days`; null where either date is invalid. */
export function daysBetween(end: string, start: string): number | null {
  const a = dayNum(end)
  const b = dayNum(start)
  return a === null || b === null ? null : a - b
}

/** The `YYYY-MM-DD` of a day number. */
export function dayString(n: number): string {
  return new Date(n * DAY_MS).toISOString().slice(0, 10)
}

/** `(datetime + timedelta(days=n)).strftime('%Y-%m-%d')`. */
export function addDays(date: string, n: number): string {
  return dayString(mustDay(date) + n)
}

/** Calendar parts of a `YYYY-MM-DD` string. */
export function dateParts(date: string): { year: number; month: number; day: number } {
  const n = mustDay(date)
  const d = new Date(n * DAY_MS)
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }
}

/** Python's `round(x, ndigits)`: correctly rounded, ties to even. */
export function pyRound(x: number, ndigits = 0): number {
  if (!Number.isFinite(x)) return x
  const abs = Math.abs(x)
  const sign = x < 0 ? -1 : 1
  if (ndigits === 0) {
    const floor = Math.floor(abs)
    const diff = abs - floor
    const r = diff < 0.5 ? floor : diff > 0.5 ? floor + 1 : floor % 2 === 0 ? floor : floor + 1
    return sign * r || 0
  }
  if (ndigits > 0) {
    // toFixed works on the exact binary value, so only exact ties need the even rule.
    const exact = abs.toFixed(Math.min(100, ndigits + 30))
    const [whole, frac = ''] = exact.split('.')
    const kept = frac.slice(0, ndigits)
    const rest = frac.slice(ndigits)
    let digits = `${whole}${kept}`
    const tie = /^50*$/.test(rest)
    const up = rest[0]! > '5' || (rest[0] === '5' && !tie) || (tie && Number(digits[digits.length - 1]) % 2 === 1)
    if (up) digits = (BigInt(digits) + 1n).toString().padStart(digits.length, '0')
    const text = `${digits.slice(0, digits.length - ndigits) || '0'}.${digits.slice(digits.length - ndigits)}`
    return sign * Number(text) || 0
  }
  const f = 10 ** -ndigits
  return sign * pyRound(abs / f, 0) * f || 0
}

/** `math.isclose`. */
export function isclose(a: number, b: number, relTol = 1e-9, absTol = 0): boolean {
  if (a === b) return true
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false
  const diff = Math.abs(b - a)
  return diff <= Math.abs(relTol * b) || diff <= Math.abs(relTol * a) || diff <= absTol
}

/** `statistics.median`. */
export function median(values: Iterable<number>): number {
  const v = [...values].sort((a, b) => a - b)
  if (v.length === 0) throw new Error('no median for empty data')
  const mid = v.length >> 1
  return v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2
}

/** `sum()` of numbers. */
export function sum(values: Iterable<number>): number {
  let s = 0
  for (const v of values) s += v
  return s
}

/** `max(items, key=key)`: the first of the largest. Throws on an empty list, as Python does. */
export function maxBy<T>(items: readonly T[], key: (item: T) => number): T {
  if (items.length === 0) throw new Error('max() arg is an empty sequence')
  let best = items[0]!
  let bestKey = key(best)
  for (let i = 1; i < items.length; i++) {
    const k = key(items[i]!)
    if (k > bestKey) {
      best = items[i]!
      bestKey = k
    }
  }
  return best
}

/** `min(items, key=key)`: the first of the smallest. */
export function minBy<T>(items: readonly T[], key: (item: T) => number): T {
  if (items.length === 0) throw new Error('min() arg is an empty sequence')
  let best = items[0]!
  let bestKey = key(best)
  for (let i = 1; i < items.length; i++) {
    const k = key(items[i]!)
    if (k < bestKey) {
      best = items[i]!
      bestKey = k
    }
  }
  return best
}

/** Python string comparison of two strings (code point order). */
export function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** `max(strings)` / `min(strings)`. */
export function maxStr(items: Iterable<string>): string {
  let best: string | undefined
  for (const s of items) if (best === undefined || s > best) best = s
  if (best === undefined) throw new Error('max() arg is an empty sequence')
  return best
}

export function minStr(items: Iterable<string>): string {
  let best: string | undefined
  for (const s of items) if (best === undefined || s < best) best = s
  if (best === undefined) throw new Error('min() arg is an empty sequence')
  return best
}

/** `x in dict` / `dict.get(k)` for a plain record whose keys are dates and tags. */
export function has<T>(record: Record<string, T>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key)
}

/** A value of the shape `float | None` from JSON. */
export function isNum(v: unknown): v is number {
  return typeof v === 'number'
}

/** Python's whitespace (`str.isspace`) as the body of a regular-expression character class. */
const PY_WS = '\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000'
const STRIP_RE = new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, 'g')
const SPACES_RE = new RegExp(`[${PY_WS}]+`, 'g')

/** `str.strip()`. */
export function pyStrip(s: string): string {
  return s.replace(STRIP_RE, '')
}

/** `re.sub(r"\s+", " ", s)` with Python's notion of whitespace. */
export function spaceCollapse(s: string): string {
  return s.replace(SPACES_RE, ' ')
}

// eslint-disable-next-line no-control-regex -- str.splitlines() breaks on the ASCII separator characters
const LINE_BREAK_RE = new RegExp('\\r\\n|[\\n\\r\\v\\f\\x1c\\x1d\\x1e\\x85\\u2028\\u2029]')

/** `str.splitlines()`: no trailing empty line. */
export function pySplitlines(s: string): string[] {
  const lines = s.split(LINE_BREAK_RE)
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** A number as the exact decimal Python's `Decimal(str(x))` holds: `m * 10**e`. */
function toDecimal(x: number): { m: bigint; e: number } {
  const [mantissa, exponent] = x.toExponential().split('e')
  const negative = mantissa!.startsWith('-')
  const [whole, frac = ''] = mantissa!.replace('-', '').split('.')
  const m = BigInt(`${whole}${frac}`)
  return { m: negative ? -m : m, e: Number(exponent) - frac.length }
}

/** `float(Decimal(str(a)) - sum(Decimal(str(q)) for q in qs))`: exact decimal arithmetic, one rounding at the end. */
export function decimalDifference(a: number, qs: number[]): number {
  const terms = [toDecimal(a), ...qs.map((q) => toDecimal(-q))]
  const emin = Math.min(...terms.map((t) => t.e))
  let total = 0n
  for (const t of terms) total += t.m * 10n ** BigInt(t.e - emin)
  return Number(`${total}e${emin}`)
}

/** `combinations(items, size)`. */
export function combinations<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  const pick = (start: number, acc: T[]) => {
    if (acc.length === size) {
      out.push([...acc])
      return
    }
    for (let i = start; i < items.length; i++) {
      acc.push(items[i]!)
      pick(i + 1, acc)
      acc.pop()
    }
  }
  pick(0, [])
  return out
}
