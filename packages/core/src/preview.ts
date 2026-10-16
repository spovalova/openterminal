import type { Column, Frame } from './frame.js'
import { columnIndex } from './frame.js'

/** What the agent sees of a frame. Numbers in a reply must come from here. */
export type Stats = { first: number; last: number; min: number; max: number; changePct: number | null }
export type Preview = {
  columns: Column[]
  rowCount: number
  /** Every row when rowCount <= maxRows, otherwise the first maxRows. */
  rows: unknown[][]
  /** symbol → numeric column → stats. Key is '*' when the frame has no symbol column. */
  stats: Record<string, Record<string, Stats>>
}

export const PREVIEW_MAX_ROWS = 25

export function preview(frame: Frame, opts: { maxRows?: number } = {}): Preview {
  const maxRows = opts.maxRows ?? PREVIEW_MAX_ROWS
  const symIdx = columnIndex(frame, 'symbol')
  const timeIdx = columnIndex(frame, 'time')
  const numeric = frame.columns
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.type === 'number')

  // Group rows by symbol, in time order when a time column exists.
  const groups = new Map<string, unknown[][]>()
  for (const row of frame.rows) {
    const key = symIdx >= 0 ? String(row[symIdx] ?? '') : '*'
    let g = groups.get(key)
    if (!g) groups.set(key, (g = []))
    g.push(row)
  }

  const stats: Preview['stats'] = {}
  for (const [sym, rows] of groups) {
    const ordered = timeIdx >= 0 ? [...rows].sort((a, b) => num(a[timeIdx]) - num(b[timeIdx])) : rows
    const perCol: Record<string, Stats> = {}
    for (const { c, i } of numeric) {
      const values = ordered.map((r) => r[i]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
      if (values.length === 0) continue
      const first = values[0]!
      const last = values[values.length - 1]!
      perCol[c.name] = {
        first,
        last,
        min: Math.min(...values),
        max: Math.max(...values),
        changePct: first === 0 ? null : round(((last - first) / first) * 100),
      }
    }
    stats[sym] = perCol
  }

  return {
    columns: frame.columns,
    rowCount: frame.rows.length,
    rows: frame.rows.length <= maxRows ? frame.rows : frame.rows.slice(0, maxRows),
    stats,
  }
}

function num(v: unknown): number {
  return typeof v === 'number' ? v : Number(v)
}
function round(n: number): number {
  return Math.round(n * 100) / 100
}
