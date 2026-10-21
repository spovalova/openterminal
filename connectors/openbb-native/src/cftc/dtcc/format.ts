// Python's number formatting, for the swap summary's text: f"{x:,.2f}", f"{x:.4f}" and str(float).
import { pyRound } from '../helpers.js'

/** `f"{x:.{digits}f}"`: the exact binary value rounded half to even, which `toFixed` does not do on a tie. */
export function pyFixed(x: number, digits: number): string {
  if (Number.isNaN(x)) return 'nan'
  if (!Number.isFinite(x)) return x > 0 ? 'inf' : '-inf'
  const rounded = pyRound(x, digits)
  const text = Math.abs(rounded).toFixed(digits)
  return rounded < 0 || Object.is(rounded, -0) ? `-${text}` : text
}

/** `f"{x:,.{digits}f}"`. */
export function pyCommaFixed(x: number, digits: number): string {
  const text = pyFixed(x, digits)
  const sign = text.startsWith('-') ? '-' : ''
  const [whole, fraction] = text.replace('-', '').split('.') as [string, string | undefined]
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${sign}${grouped}${fraction !== undefined ? `.${fraction}` : ''}`
}

/** `str(x)` of a float: the shortest round-trip digits, with a `.0` on a whole number and Python's exponent form. */
export function pyRepr(x: number): string {
  if (Number.isNaN(x)) return 'nan'
  if (!Number.isFinite(x)) return x > 0 ? 'inf' : '-inf'
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0'
  const abs = Math.abs(x)
  if (abs >= 1e16 || abs < 1e-4) {
    const [mantissa, exponent] = x.toExponential().split('e') as [string, string]
    const sign = exponent.startsWith('-') ? '-' : '+'
    const digits = exponent.replace(/^[+-]/, '').padStart(2, '0')
    return `${mantissa}e${sign}${digits}`
  }
  const text = String(x)
  return Number.isInteger(x) ? `${text}.0` : text
}
