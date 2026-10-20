// Python string behaviours the html2markdown port relies on (str.strip, str.split, str.isupper, …). JavaScript's
// trim() and \s differ in a few code points (U+FEFF is trimmed by JavaScript only; U+001C-001F and U+0085 are
// whitespace to Python only), so the ports call these instead.

/** The characters Python's `str.isspace()` accepts. */
const PY_SPACE = "\t\n\v\f\r\x1c\x1d\x1e\x1f \x85\xa0\u{1680}\u{2000}\u{2001}\u{2002}\u{2003}\u{2004}\u{2005}\u{2006}\u{2007}\u{2008}\u{2009}\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}"
const SPACE_SET = new Set(PY_SPACE)

export const isSpaceChar = (c: string): boolean => SPACE_SET.has(c)

/** `s.strip()` */
export function strip(s: string): string {
  let a = 0
  let b = s.length
  while (a < b && SPACE_SET.has(s[a]!)) a++
  while (b > a && SPACE_SET.has(s[b - 1]!)) b--
  return s.slice(a, b)
}

/** `s.lstrip()` */
export function lstrip(s: string): string {
  let a = 0
  while (a < s.length && SPACE_SET.has(s[a]!)) a++
  return s.slice(a)
}

/** `s.rstrip()` */
export function rstrip(s: string): string {
  let b = s.length
  while (b > 0 && SPACE_SET.has(s[b - 1]!)) b--
  return s.slice(0, b)
}

/** `s.strip(chars)` */
export function stripChars(s: string, chars: string): string {
  const set = new Set(chars)
  let a = 0
  let b = s.length
  while (a < b && set.has(s[a]!)) a++
  while (b > a && set.has(s[b - 1]!)) b--
  return s.slice(a, b)
}

/** `s.lstrip(chars)` */
export function lstripChars(s: string, chars: string): string {
  const set = new Set(chars)
  let a = 0
  while (a < s.length && set.has(s[a]!)) a++
  return s.slice(a)
}

/** `s.rstrip(chars)` */
export function rstripChars(s: string, chars: string): string {
  const set = new Set(chars)
  let b = s.length
  while (b > 0 && set.has(s[b - 1]!)) b--
  return s.slice(0, b)
}

/** `s.split()`: on runs of whitespace, no empty strings. */
export function split(s: string): string[] {
  const out: string[] = []
  let cur = ''
  for (const c of s) {
    if (SPACE_SET.has(c)) {
      if (cur) out.push(cur)
      cur = ''
    } else cur += c
  }
  if (cur) out.push(cur)
  return out
}

const CASED = /[\p{Lu}\p{Ll}\p{Lt}]/u
const LOWER = /\p{Ll}/u
const UPPER = /[\p{Lu}\p{Lt}]/u

/** `s.isupper()`: at least one cased character and none of them lower case. */
export function isUpper(s: string): boolean {
  return CASED.test(s) && !LOWER.test(s)
}

/** `s.islower()`: at least one cased character and none of them upper case. */
export function isLower(s: string): boolean {
  return CASED.test(s) && !UPPER.test(s)
}

/** `s.isalpha()` */
export function isAlpha(s: string): boolean {
  return s.length > 0 && /^\p{L}+$/u.test(s)
}

/** `s.isdigit()` (decimal digits, which is what filings contain). */
export function isDigit(s: string): boolean {
  return s.length > 0 && /^\p{Nd}+$/u.test(s)
}

/** `s.isalnum()` */
export function isAlnum(s: string): boolean {
  return s.length > 0 && /^[\p{L}\p{Nd}]+$/u.test(s)
}

/** `s.title()` */
export function title(s: string): string {
  let out = ''
  let prevCased = false
  for (const c of s) {
    const cased = CASED.test(c)
    out += cased ? (prevCased ? c.toLowerCase() : c.toUpperCase()) : c
    prevCased = cased
  }
  return out
}

/** `s.capitalize()` */
export function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1).toLowerCase()
}

/** `any(ch.isdigit() for ch in s)` */
export function hasDigit(s: string): boolean {
  return /\p{Nd}/u.test(s)
}

/** `any(ch.isalpha() for ch in s)` */
export function hasAlpha(s: string): boolean {
  return /\p{L}/u.test(s)
}

/** `s.count(sub)` for a non-empty substring (non-overlapping). */
export function count(s: string, sub: string): number {
  if (!sub) return s.length + 1
  let n = 0
  let at = s.indexOf(sub)
  while (at >= 0) {
    n++
    at = s.indexOf(sub, at + sub.length)
  }
  return n
}

/** `re.escape`-free helper: escape a string for use inside a RegExp. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** `list.index`-free membership on arrays, as `x in list`. */
export function inList<T>(x: T, list: readonly T[]): boolean {
  return list.includes(x)
}

/** `int(s)` for a string of decimal digits (optionally signed); NaN when it is not one (Python would raise). */
export function toInt(s: string): number {
  return /^\s*[+-]?\d+\s*$/.test(s) ? parseInt(s, 10) : NaN
}

/** `str.splitlines()` for the line breaks filings contain. */
export function splitLines(s: string): string[] {
  // eslint-disable-next-line no-control-regex -- str.splitlines() breaks on the ASCII separator characters
  const parts = s.split(new RegExp("\\r\\n|[\\n\\r\\v\\f\\x1c\\x1d\\x1e\\x85\\u2028\\u2029]"))
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop()
  return parts
}
