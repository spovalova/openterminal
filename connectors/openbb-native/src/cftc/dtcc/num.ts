// Numeric helpers that reproduce Python's arithmetic where it differs from a plain JavaScript loop.

/** Python 3.12's `sum()` of floats: compensated (Neumaier) summation. */
export function pySum(xs: Iterable<number>): number {
  let f = 0
  let c = 0
  for (const x of xs) {
    const t = f + x
    if (Math.abs(f) >= Math.abs(x)) c += f - t + x
    else c += x - t + f
    f = t
  }
  if (c !== 0 && Number.isFinite(c)) f += c
  return f
}

/** `statistics.median`. */
export function pyMedian(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const n = s.length
  if (n === 0) throw new Error('no median for empty data')
  return n % 2 === 1 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2
}

/** Python's thousands-separated fixed-point format, `f"{x:,.{digits}f}"`. */
export function commaFixed(x: number, digits = 0): string {
  return x.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}
