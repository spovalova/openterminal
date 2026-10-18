import type { Column } from './frame.js'

/**
 * Shape detection (PLAN.md section 17): what a frame has, from its columns and a row sample, so views can
 * declare what they need instead of being wired per kind. Pure.
 */
export type Shape = {
  columns: Column[]
  /** Rows in the sample the shape was detected from. */
  rows: number
  /** The first `time` column. */
  time?: string
  /** The column that splits rows into lines or legend entries: symbol, series, ticker, cusip or name. */
  group?: string
  /** Every number column, in frame order. */
  numeric: string[]
  /** strike + expiration + option_type (or type): an option chain. */
  options: boolean
  /** The group column has no repeated value (one quote per symbol), or the frame is a single row. */
  oneRowPerGroup: boolean
  /** The x-axis field: the time column, else a numeric column that reads as an axis (maturity, strike, dte). */
  x?: string
  xType?: 'time' | 'number'
  /** Open, high, low and close are all present: candles can be drawn. */
  ohlc: boolean
  /** Distinct values of the group column in the sample, in first-seen order (empty without a group). */
  groups: string[]
}

export const GROUP_CANDIDATES = ['symbol', 'series', 'ticker', 'cusip', 'name'] as const
const NUMERIC_X = /^(maturity_years|years|maturity|strike|dte|tenor|days_to_expiration|x)$/i

export function detectShape(columns: Column[], rowsSample: readonly unknown[][] = []): Shape {
  const idx = (name: string) => columns.findIndex((c) => c.name === name)
  const has = (name: string) => idx(name) >= 0
  const time = columns.find((c) => c.type === 'time')?.name
  const numeric = columns.filter((c) => c.type === 'number').map((c) => c.name)

  // The group column: the first candidate with several distinct values; for a single-row frame the first candidate present.
  let group: string | undefined
  let groups: string[] = []
  for (const cand of GROUP_CANDIDATES) {
    const i = idx(cand)
    if (i < 0) continue
    const distinct = distinctValues(rowsSample, i)
    if (distinct.length >= 2 || (rowsSample.length <= 1 && distinct.length <= 1)) {
      group = cand
      groups = distinct
      break
    }
  }

  const options = has('strike') && has('expiration') && (has('option_type') || has('type'))
  const gi = group ? idx(group) : -1
  const oneRowPerGroup = gi >= 0 ? rowsSample.length === new Set(rowsSample.map((r) => String(r[gi] ?? ''))).size : rowsSample.length === 1

  let x: string | undefined = time
  let xType: Shape['xType'] = time ? 'time' : undefined
  if (!time) {
    const nx = numeric.find((n) => NUMERIC_X.test(n))
    if (nx) {
      x = nx
      xType = 'number'
    }
  }
  const ohlc = has('open') && has('high') && has('low') && has('close')
  const shape: Shape = { columns, rows: rowsSample.length, numeric, options, oneRowPerGroup, ohlc, groups }
  if (time) shape.time = time
  if (group) shape.group = group
  if (x) shape.x = x
  if (xType) shape.xType = xType
  return shape
}

function distinctValues(rows: readonly unknown[][], i: number): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const r of rows) {
    const v = r[i]
    if (v === null || v === undefined) continue
    const s = String(v)
    if (!seen.has(s)) {
      seen.add(s)
      out.push(s)
    }
  }
  return out
}

/** What each preset needs of a shape; the editor offers only presets whose requirement the frame meets. */
export const SHAPE_REQUIREMENTS = {
  price: (s: Shape) => !!s.time && s.numeric.length > 0,
  compare: (s: Shape) => !!s.time && s.numeric.length > 0,
  curve: (s: Shape) => s.xType === 'number' && s.numeric.length > 1,
  indicator: (s: Shape) => !!s.time && s.numeric.includes('close'),
  table: () => true,
  stat: (s: Shape) => s.oneRowPerGroup && s.numeric.length > 0,
  facts: (s: Shape) => s.rows === 1 || s.oneRowPerGroup,
  chain: (s: Shape) => s.options,
  heatmap: (s: Shape) => !!s.group && s.numeric.length > 0,
} as const
export type PresetName = keyof typeof SHAPE_REQUIREMENTS
export const PRESET_NAMES = Object.keys(SHAPE_REQUIREMENTS) as PresetName[]

/** Presets a shape supports, in the order the editor lists them. */
export function presetsFor(shape: Shape): PresetName[] {
  return PRESET_NAMES.filter((p) => SHAPE_REQUIREMENTS[p](shape))
}
