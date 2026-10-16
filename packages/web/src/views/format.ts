/**
 * Local formatting helpers for the series legend.
 * Cell formatting in tables belongs to DataTable (@terminal/ui); only price and percent live here.
 */

const price2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const price4 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 })

/** 1234.5 → "1,234.50"; sub-dollar prices keep four decimals. */
export function formatPrice(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '–'
  return Math.abs(n) < 1 ? price4.format(n) : price2.format(n)
}

/** 3.456 → "+3.46%", -0.1 → "-0.10%", null → "–". */
export function formatPercent(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '–'
  const sign = n > 0 ? '+' : n < 0 ? '-' : ''
  return `${sign}${price2.format(Math.abs(n))}%`
}

/** Direction of a change for colouring: 'up', 'down', or 'flat'. */
export function direction(n: number | null | undefined): 'up' | 'down' | 'flat' {
  if (n == null || !Number.isFinite(n) || n === 0) return 'flat'
  return n > 0 ? 'up' : 'down'
}

/** "#rrggbb" (or "#rgb") with an alpha channel as an rgba() string; other inputs pass through. */
export function withAlpha(color: string, alpha: number): string {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim())
  if (!m) return color
  let hex = m[1]!
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('')
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}
