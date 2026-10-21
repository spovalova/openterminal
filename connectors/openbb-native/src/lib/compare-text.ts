// Python's ordering of two strings, for ports that sort text the way `sorted()` does.

const SURROGATE = /[\ud800-\udfff]/

/**
 * Python compares strings by code point. UTF-16 order is the same unless one of the strings has characters beyond
 * U+FFFF, where a surrogate pair would sort below a character in U+E000-U+FFFF.
 */
export function compareText(a: string, b: string): number {
  if (a === b) return 0
  if (!SURROGATE.test(a) && !SURROGATE.test(b)) return a < b ? -1 : 1
  const [x, y] = [Array.from(a), Array.from(b)]
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const [p, q] = [x[i]!.codePointAt(0)!, y[i]!.codePointAt(0)!]
    if (p !== q) return p < q ? -1 : 1
  }
  return x.length - y.length
}
