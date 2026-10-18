import { SIZE_SPANS, type Size } from './widget.js'

/** Where one widget sits in the grid: zero-based column and row, and how many of each it spans. */
export type Placement = {
  col: number
  row: number
  cols: number
  rows: number
  /** True when the packer grew the widget beyond its size's span to fill a cell that would have stayed empty. */
  stretched: boolean
}

/** Grid columns for a grid of this width: one under 720px, two under 1100px, three from there. */
export function columnsFor(width: number): number {
  if (width < 720) return 1
  if (width < 1100) return 2
  return 3
}

/** The span a size asks for in a grid of `columns` columns: SIZE_SPANS clamped to the grid width. */
export function spanFor(size: Size, columns: number): { cols: number; rows: number } {
  const s = SIZE_SPANS[size]
  return { cols: Math.min(s.cols, columns), rows: s.rows }
}

/**
 * Lay widgets out in a grid of `columns` columns so that no cell stays empty.
 *
 * Pure. Widgets are placed in order at the first position where their span fits, scanning rows top
 * to bottom and columns left to right, so a later sm widget is pulled up into a gap beside an earlier
 * one (the same rule as CSS `grid-auto-flow: dense`). Then every empty cell is filled by stretching a
 * neighbour: first the widget to its left, then the one above, then the one to its right, then the one
 * below, whichever can grow into the cell without overlapping anything. The result is explicit
 * positions, so the renderer places widgets exactly where the packer put them.
 */
export function packLayout(widgets: readonly { size: Size }[], columns: number): Placement[] {
  const cols = Math.max(1, Math.floor(columns))
  const grid: number[][] = [] // grid[row][col] = widget index, -1 when empty
  const rowAt = (r: number) => {
    while (grid.length <= r) grid.push(new Array<number>(cols).fill(-1))
    return grid[r]!
  }
  const free = (r: number, c: number, h: number, w: number) => {
    if (c + w > cols) return false
    for (let y = r; y < r + h; y++) for (let x = c; x < c + w; x++) if (rowAt(y)[x] !== -1) return false
    return true
  }
  const fill = (i: number, r: number, c: number, h: number, w: number) => {
    for (let y = r; y < r + h; y++) for (let x = c; x < c + w; x++) rowAt(y)[x] = i
  }

  // 1. Dense placement in widget order.
  const out: Placement[] = []
  widgets.forEach((wdg, i) => {
    const span = spanFor(wdg.size, cols)
    let placed = false
    for (let r = 0; !placed; r++) {
      for (let c = 0; c < cols; c++) {
        if (free(r, c, span.rows, span.cols)) {
          fill(i, r, c, span.rows, span.cols)
          out.push({ col: c, row: r, cols: span.cols, rows: span.rows, stretched: false })
          placed = true
          break
        }
      }
    }
  })

  // 2. Fill holes by stretching a neighbour that can grow into the cell without overlap.
  const height = grid.length
  const neighbours = (r: number, c: number): number[] => {
    const left = c > 0 ? grid[r]![c - 1]! : -1
    const up = r > 0 ? grid[r - 1]![c]! : -1
    const right = c + 1 < cols ? grid[r]![c + 1]! : -1
    const down = r + 1 < height ? grid[r + 1]![c]! : -1
    return [left, up, right, down].filter((i) => i >= 0)
  }
  const tryGrow = (i: number, r: number, c: number): boolean => {
    const p = out[i]!
    let next: { col: number; row: number; cols: number; rows: number } | undefined
    if (c === p.col + p.cols && r >= p.row && r < p.row + p.rows) next = { ...p, cols: p.cols + 1 } // grow right
    else if (r === p.row + p.rows && c >= p.col && c < p.col + p.cols) next = { ...p, rows: p.rows + 1 } // grow down
    else if (c === p.col - 1 && r >= p.row && r < p.row + p.rows) next = { col: p.col - 1, row: p.row, cols: p.cols + 1, rows: p.rows } // grow left
    else if (r === p.row - 1 && c >= p.col && c < p.col + p.cols) next = { col: p.col, row: p.row - 1, cols: p.cols, rows: p.rows + 1 } // grow up
    if (!next || next.row + next.rows > height) return false
    for (let y = next.row; y < next.row + next.rows; y++) for (let x = next.col; x < next.col + next.cols; x++) if (grid[y]![x] !== -1 && grid[y]![x] !== i) return false
    fill(i, next.row, next.col, next.rows, next.cols)
    out[i] = { ...next, stretched: true }
    return true
  }
  let progress = true
  while (progress) {
    progress = false
    for (let r = 0; r < height; r++) {
      for (let c = 0; c < cols; c++) {
        if (grid[r]![c] !== -1) continue
        for (const n of neighbours(r, c)) {
          if (tryGrow(n, r, c)) {
            progress = true
            break
          }
        }
      }
    }
  }
  return out
}

/** True when some cell of the grid the packer produced stays empty (only possible with zero widgets). */
export function hasHoles(placements: readonly Placement[], columns: number): boolean {
  const cells = new Set<string>()
  let height = 0
  for (const p of placements) {
    height = Math.max(height, p.row + p.rows)
    for (let y = p.row; y < p.row + p.rows; y++) for (let x = p.col; x < p.col + p.cols; x++) cells.add(`${y}:${x}`)
  }
  return cells.size !== height * columns
}

/** Grid rows are at least this tall; fewer rows share the pane's height, more rows scroll. */
export const MIN_ROW_HEIGHT = 240
export const GRID_GAP = 8

/**
 * The row height for `rows` grid rows in a pane `height` px tall, after `chrome` px of padding and
 * controls: rows share the visible height, never shorter than MIN_ROW_HEIGHT. Explicit pixels rather
 * than `1fr`, because fr rows in a scrolling (so indefinite) grid size to their content, and a chart
 * that fills its cell then grows without bound.
 */
export function rowHeightFor(rows: number, height: number, chrome = 0): number {
  if (rows <= 0 || height <= 0) return MIN_ROW_HEIGHT
  return Math.max(MIN_ROW_HEIGHT, Math.floor((height - chrome - GRID_GAP * (rows - 1)) / rows))
}
