import type { Column } from '@terminal/core'

/**
 * How a cell renders.
 * - percent: a level that happens to be a percent (margin, yield, IV, weight): "36.90%", unsigned, uncoloured.
 * - change: a signed move (change_pct, upside_pct, surprise_pct, growth): "+1.23%", coloured up/down.
 * - compact: a large amount (market cap, revenue, shares, M2): "1.23B", "456.7M", "12.3K".
 */
export type CellFormat = 'text' | 'price' | 'percent' | 'change' | 'integer' | 'compact' | 'time' | 'date' | 'link'

/** Rendered for null, undefined, NaN, and empty strings. */
export const EMPTY_CELL = '—'

const price = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const integer = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })

function asNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

function sameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

/** Local HH:mm when the instant falls on the same local day as `now`, else YYYY-MM-DD. */
export function formatTime(ms: number, now: number = Date.now()): string {
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return EMPTY_CELL
  if (sameLocalDay(d, new Date(now))) return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/** Short label for a URL: its host without a leading "www.". */
export function linkLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/** Signed percent with two decimals: "+1.23%", "-0.45%", "0.00%". The `change` format. */
export function formatPercent(n: number): string {
  const fixed = price.format(n)
  return n > 0 ? `+${fixed}%` : `${fixed}%`
}

const COMPACT_UNITS: [number, string][] = [
  [1e12, 'T'],
  [1e9, 'B'],
  [1e6, 'M'],
  [1e3, 'K'],
]

/**
 * Large amounts in three or four figures: 1.23B, 45.6B, 456.7M, 12.3K. Two decimals when the
 * mantissa is below 10, one otherwise; below a thousand the plain number with up to two decimals.
 * Negative amounts keep a leading minus.
 */
export function formatCompact(n: number): string {
  if (!Number.isFinite(n)) return EMPTY_CELL
  const abs = Math.abs(n)
  const sign = n < 0 ? '-' : ''
  for (const [unit, suffix] of COMPACT_UNITS) {
    if (abs >= unit) {
      const m = abs / unit
      return `${sign}${m < 10 ? m.toFixed(2) : m.toFixed(1)}${suffix}`
    }
  }
  return `${sign}${new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(abs)}`
}

/**
 * Format one cell as text. Pure; the DataTable uses it and wraps links in an anchor.
 * `now` only affects `time` (same-day → HH:mm).
 */
export function formatCell(value: unknown, format: CellFormat = 'text', now: number = Date.now()): string {
  if (value === null || value === undefined || value === '') return EMPTY_CELL
  switch (format) {
    case 'price': {
      const n = asNumber(value)
      return n === null ? EMPTY_CELL : price.format(n)
    }
    case 'percent': {
      const n = asNumber(value)
      return n === null ? EMPTY_CELL : `${price.format(n)}%`
    }
    case 'change': {
      const n = asNumber(value)
      return n === null ? EMPTY_CELL : formatPercent(n)
    }
    case 'integer': {
      const n = asNumber(value)
      return n === null ? EMPTY_CELL : integer.format(Math.round(n))
    }
    case 'compact': {
      const n = asNumber(value)
      return n === null ? EMPTY_CELL : formatCompact(n)
    }
    case 'time': {
      const n = asNumber(value)
      if (n !== null) return formatTime(n, now)
      const t = new Date(String(value)).getTime()
      return Number.isNaN(t) ? String(value) : formatTime(t, now)
    }
    case 'date':
      return String(value)
    case 'link':
      return linkLabel(String(value))
    case 'text':
    default:
      return String(value)
  }
}

/** 'up' | 'down' | null for a signed value (`change` cells are colored by this). */
export function direction(value: unknown): 'up' | 'down' | null {
  const n = asNumber(value)
  if (n === null || n === 0) return null
  return n > 0 ? 'up' : 'down'
}

/** Formats that right-align (numeric). */
export function isNumericFormat(format: CellFormat): boolean {
  return format === 'price' || format === 'percent' || format === 'change' || format === 'integer' || format === 'compact'
}

const PRICE_COLUMNS = new Set(['price', 'open', 'high', 'low', 'close', 'extended_price', 'eps_estimate'])

/**
 * Default formats for a frame's columns by name and type, matching the kind
 * catalog: *_pct → change, time → time, volume → integer, url → link, date → date.
 */
export function inferFormats(columns: Column[]): Record<string, CellFormat> {
  const out: Record<string, CellFormat> = {}
  for (const c of columns) {
    if (c.type === 'time') out[c.name] = 'time'
    else if (c.name.endsWith('_pct')) out[c.name] = 'change'
    else if (c.name === 'url') out[c.name] = 'link'
    else if (c.name === 'date') out[c.name] = 'date'
    else if (c.name === 'volume') out[c.name] = 'integer'
    else if (PRICE_COLUMNS.has(c.name)) out[c.name] = 'price'
    else if (c.type === 'number') out[c.name] = 'price'
    else out[c.name] = 'text'
  }
  return out
}

/** "840ms", "1.2s", "12s", "2m 05s". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = ms / 1000
  if (s < 10) return `${s.toFixed(1)}s`
  if (s < 60) return `${Math.round(s)}s`
  const m = Math.floor(s / 60)
  return `${m}m ${pad2(Math.round(s - m * 60))}s`
}

export type SortDir = 'asc' | 'desc'

/** Stable sort of rows by a column index. Nulls last in both directions. */
export function sortRows(rows: unknown[][], columnIndex: number, dir: SortDir): unknown[][] {
  const sign = dir === 'asc' ? 1 : -1
  return rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => {
      const x = a.row[columnIndex]
      const y = b.row[columnIndex]
      const xn = x === null || x === undefined || x === ''
      const yn = y === null || y === undefined || y === ''
      if (xn && yn) return a.i - b.i
      if (xn) return 1
      if (yn) return -1
      let c: number
      if (typeof x === 'number' && typeof y === 'number') c = x - y
      else if (typeof x === 'boolean' && typeof y === 'boolean') c = Number(x) - Number(y)
      else c = String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: 'base' })
      return c === 0 ? a.i - b.i : c * sign
    })
    .map((p) => p.row)
}
