import { SIZE_SPANS } from './widget.js'
import type { Size } from './view-options.js'

/** Where one widget sits in the grid: zero-based column and row, and how many of each it spans. */
export type Placement = {
  col: number
  row: number
  cols: number
  rows: number
  /** True when the packer grew the widget beyond its size's span to fill a cell that would have stayed empty. */
  stretched: boolean
  /** True when the size-by-content rule changed the span the size asked for (a six-row table demoted to one row). */
  demoted: boolean
}

/** Grid widths at which the column count steps up: one column below 720, two from 720, three from 960 (v2, was 1100). */
export const TWO_COLUMNS_MIN = 720
export const THREE_COLUMNS_MIN = 960

/** Grid columns for a grid of this width. */
export function columnsFor(width: number): number {
  if (width < TWO_COLUMNS_MIN) return 1
  if (width < THREE_COLUMNS_MIN) return 2
  return 3
}

/** The span a size asks for in a grid of `columns` columns: SIZE_SPANS clamped to the grid width. */
export function spanFor(size: Size, columns: number): { cols: number; rows: number } {
  const s = SIZE_SPANS[size]
  return { cols: Math.min(s.cols, columns), rows: s.rows }
}

/**
 * What a widget will show, so the packer can size by content (PLAN.md section 17, "size by content"):
 * `rows` is the frame's row count when known; `kind` is what the view renders.
 */
export type ContentHint = { rows?: number; kind: 'table' | 'chart' | 'stat' | 'facts' | 'chain'; /** Columns the table shows (taste round: a five-column compare table needs two grid columns). */ columns?: number }

/** A table with this many columns or more keeps its two grid columns: at one column it sheds the symbols it compares. */
export const WIDE_TABLE_COLUMNS = 5
export type LayoutWidget = { size: Size; contentHint?: ContentHint }

/** Tables with this many rows or fewer are one row tall. */
export const SHORT_TABLE_ROWS = 6

/**
 * The span a widget gets: its size's span, then the content rule (taste round, change 1). A table with six rows or
 * fewer, a stat, a facts card and a one-row quote are one row tall, and a stat or a facts card is never the full
 * width of a grid with two or more columns (a row of compact cards or a label:value grid has nothing to put in a
 * third column). A chart is never taller than it is wide: the lg hero is 2x2, an md chart one cell in a
 * three-column grid (two across in a two-column grid), an sm chart one cell; so three charts tile across the
 * Instinct way and no time series renders portrait. Chains keep their size.
 */
export function effectiveSpan(widget: LayoutWidget, columns: number, _widgetCount = 0): { cols: number; rows: number; demoted: boolean } {
  const base = spanFor(widget.size, columns)
  const hint = widget.contentHint
  if (!hint) return { ...base, demoted: false }
  let rows = base.rows
  let cols = base.cols
  switch (hint.kind) {
    case 'stat':
    case 'facts':
      rows = 1
      if (columns >= 2) cols = Math.min(cols, columns - 1)
      break
    case 'table':
      if (hint.rows !== undefined && hint.rows <= SHORT_TABLE_ROWS) rows = 1
      break
    case 'chart':
      if (widget.size === 'md' && columns >= 3) cols = 1
      rows = Math.min(rows, cols)
      break
    case 'chain':
      break
  }
  return { cols, rows, demoted: rows !== base.rows || cols !== base.cols }
}

/** A chart placement this tall for its width reads as portrait: more rows than columns (a 1x2 cell at 340 x 780 px). */
export function isPortraitChart(widget: LayoutWidget, span: { cols: number; rows: number }): boolean {
  return widget.contentHint?.kind === 'chart' && span.rows > span.cols
}

/** A stat row or a facts card stretched across every column of a three-column grid (change 1: "never full width"). */
export function isFullWidthShort(widget: LayoutWidget, span: { cols: number }, columns: number): boolean {
  const kind = widget.contentHint?.kind
  return (kind === 'stat' || kind === 'facts') && columns >= 3 && span.cols >= columns
}

/**
 * True when stretching this widget taller would show blank space: a table with six rows or fewer, a stat, a facts
 * card (the content-short kinds). Charts, chains, long tables and widgets without a hint fill whatever they get.
 */
export function isShortContent(widget: LayoutWidget): boolean {
  const hint = widget.contentHint
  if (!hint) return false
  if (hint.kind === 'stat' || hint.kind === 'facts') return true
  return hint.kind === 'table' && hint.rows !== undefined && hint.rows <= SHORT_TABLE_ROWS
}

/**
 * Lay widgets out in a grid of `columns` columns so that no cell stays empty.
 *
 * Pure. Widgets are placed in order at the first position where their span fits, scanning rows top
 * to bottom and columns left to right, so a later sm widget is pulled up into a gap beside an earlier
 * one (the same rule as CSS `grid-auto-flow: dense`). Then every empty cell is filled by stretching a
 * neighbour: first the widget to its left, then the one above, then the one to its right, then the one
 * below, whichever can grow into the cell without overlapping anything. The result is explicit
 * positions, so the renderer places widgets exactly where the packer put them. Widgets without a
 * `contentHint` are placed by size alone (the v1 behaviour).
 *
 * Two rules keep blank space out of short content (phase 2, from the (d) report of a three-row table stretched to two
 * rows beside the hero): a one-row widget is not pulled up into a slot where the cell under it would be a hole that
 * no later widget can fill (it goes to the next row and the taller neighbour, usually the hero chart, grows across
 * instead); and when a hole has several neighbours that could grow into it, a chart, a chain or a long table grows
 * before a short table, a stat or a facts card, and a short widget grows sideways before it grows taller.
 */
export function packLayout(widgets: readonly LayoutWidget[], columns: number): Placement[] {
  const cols = Math.max(1, Math.floor(columns))
  const base = widgets.map((w) => effectiveSpan(w, cols, widgets.length))
  // Some span sets cannot tile: a hero, a tall one-column chart beside it, another tall chart and a stat leave the
  // stat alone in a band it can only fill by growing taller. The packer then tries the same set with one or more of
  // the tall charts back at their size's own span (an md chart as 2x1) and keeps the layout that stretches no short
  // widget taller, then the fewest rows, then the fewest charts flattened, then the fewest stretches.
  // Each widget may carry one alternative span: a demoted md chart back at its size's span (2x1), and (change 1) a
  // two-column one-row widget (an md stat row, a facts card, a short or long md table) at one column, since two
  // of them cannot share a three-column band and the third cell beside a 2x1 would otherwise be a hole.
  const alternatives: { i: number; span: { cols: number; rows: number; demoted: boolean } }[] = []
  widgets.forEach((w, i) => {
    const kind = w.contentHint?.kind
    const s = base[i]!
    if (kind === 'chart' && s.demoted && w.size === 'md') {
      const b = spanFor(w.size, cols)
      alternatives.push({ i, span: { cols: b.cols, rows: Math.min(b.rows, b.cols), demoted: false } })
    } else if (kind && kind !== 'chart' && kind !== 'chain' && s.cols === 2 && cols >= 3 && s.rows === 1 && !(kind === 'table' && (w.contentHint?.columns ?? 0) >= WIDE_TABLE_COLUMNS)) {
      alternatives.push({ i, span: { cols: 1, rows: 1, demoted: true } })
    }
  })
  const alts = alternatives.slice(0, 7)
  const short = widgets.map(isShortContent)
  let best: Placement[] | undefined
  let bestCost: number[] = []
  for (let mask = 0; mask < 1 << alts.length; mask++) {
    const spans = base.map((s, i) => {
      const k = alts.findIndex((a) => a.i === i)
      if (k < 0 || !((mask >> k) & 1)) return s
      return alts[k]!.span
    })
    const out = packOnce(widgets, spans, cols)
    const rows = out.reduce((n, p) => Math.max(n, p.row + p.rows), 0)
    const tallerShort = out.filter((p, i) => short[i] && p.rows > spans[i]!.rows).length
    // Change 1: a portrait chart or a full-width stat row costs as much as a stretched short widget.
    const portrait = out.filter((p, i) => isPortraitChart(widgets[i]!, p)).length
    const fullWidth = out.filter((p, i) => isFullWidthShort(widgets[i]!, p, cols)).length
    const flattened = alts.filter((_a, k) => (mask >> k) & 1).length
    const stretched = out.filter((p) => p.stretched).length
    const cost = [tallerShort + portrait + fullWidth, rows, flattened, stretched]
    if (!best || lexLess(cost, bestCost)) {
      best = out
      bestCost = cost
    }
  }
  return best ?? []
}

/** Lexicographic less-than over equal-length number tuples. */
function lexLess(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < a.length; i++) {
    if (a[i]! !== b[i]!) return a[i]! < b[i]!
  }
  return false
}

/** One packing with the spans given (see `packLayout`, which chooses between span sets). */
function packOnce(widgets: readonly LayoutWidget[], spans: readonly { cols: number; rows: number; demoted: boolean }[], cols: number): Placement[] {
  const grid: number[][] = [] // grid[row][col] = widget index, -1 when empty
  const rowAt = (r: number) => {
    while (grid.length <= r) grid.push(new Array<number>(cols).fill(-1))
    return grid[r]!
  }
  const cell = (r: number, c: number) => (r < 0 || c < 0 || c >= cols || r >= grid.length ? -1 : grid[r]![c]!)
  const free = (r: number, c: number, h: number, w: number) => {
    if (c < 0 || r < 0 || c + w > cols) return false
    for (let y = r; y < r + h; y++) for (let x = c; x < c + w; x++) if (rowAt(y)[x] !== -1) return false
    return true
  }
  const fill = (i: number, r: number, c: number, h: number, w: number) => {
    for (let y = r; y < r + h; y++) for (let x = c; x < c + w; x++) rowAt(y)[x] = i
  }
  const clear = (r: number, c: number, h: number, w: number) => {
    for (let y = r; y < r + h; y++) for (let x = c; x < c + w; x++) grid[y]![x] = -1
  }
  const short = widgets.map(isShortContent)
  const out: Placement[] = []

  type Growth = { col: number; row: number; cols: number; rows: number; vertical: boolean }
  /** How placed widget `i` would grow to cover cell (r, c), or undefined when it cannot without overlapping. */
  const growth = (i: number, r: number, c: number, height: number): Growth | undefined => {
    const p = out[i]!
    let next: Growth | undefined
    if (c === p.col + p.cols && r >= p.row && r < p.row + p.rows) next = { col: p.col, row: p.row, cols: p.cols + 1, rows: p.rows, vertical: false } // grow right
    else if (r === p.row + p.rows && c >= p.col && c < p.col + p.cols) next = { col: p.col, row: p.row, cols: p.cols, rows: p.rows + 1, vertical: true } // grow down
    else if (c === p.col - 1 && r >= p.row && r < p.row + p.rows) next = { col: p.col - 1, row: p.row, cols: p.cols + 1, rows: p.rows, vertical: false } // grow left
    else if (r === p.row - 1 && c >= p.col && c < p.col + p.cols) next = { col: p.col, row: p.row - 1, cols: p.cols, rows: p.rows + 1, vertical: true } // grow up
    if (!next || next.row + next.rows > height || next.col + next.cols > cols) return undefined
    for (let y = next.row; y < next.row + next.rows; y++) for (let x = next.col; x < next.col + next.cols; x++) if (cell(y, x) !== -1 && cell(y, x) !== i) return undefined
    return next
  }
  const neighbours = (r: number, c: number): number[] => [cell(r, c - 1), cell(r - 1, c), cell(r, c + 1), cell(r + 1, c)].filter((i) => i >= 0)
  /**
   * Lower is better: anything that fills its height, then a short widget growing sideways, then one growing taller;
   * a chart growing portrait or a stat row growing to the full width (change 1) last of all, taken only when nothing
   * else can fill the cell.
   */
  const rank = (i: number, g: Growth) => {
    if (isPortraitChart(widgets[i]!, g) || isFullWidthShort(widgets[i]!, g, cols)) return 3
    return !short[i] ? 0 : g.vertical ? 2 : 1
  }

  /** Could one of the widgets after `after` be placed over cell (r, c) on the grid as it stands? */
  const fillableLater = (r: number, c: number, after: number): boolean => {
    for (let j = after + 1; j < widgets.length; j++) {
      const s = spans[j]!
      for (let y = r - s.rows + 1; y <= r; y++) for (let x = c - s.cols + 1; x <= c; x++) if (free(y, x, s.rows, s.cols)) return true
    }
    return false
  }
  /**
   * A free cell that only a short widget growing taller could ever fill: no later widget fits over it and every
   * neighbour that can grow into it is a short table, stat or facts card growing vertically.
   */
  const freeCell = (r: number, c: number) => r >= 0 && c >= 0 && c < cols && r < grid.length && grid[r]![c] === -1
  const stranded = (r: number, c: number, placing: number, height: number): boolean => {
    if (fillableLater(r, c, placing)) return false
    // A free row neighbour decides this cell's fate too: a sideways growth that reaches it continues into this one.
    if (freeCell(r, c - 1) || freeCell(r, c + 1)) return false
    for (const n of neighbours(r, c)) {
      const g = growth(n, r, c, height)
      if (g && rank(n, g) < 2) return false
    }
    return true
  }
  /** Placing widget `i` at (r, c) leaves a stranded cell near it (within the rows already in use). */
  const strandsAShortWidget = (i: number, r: number, c: number, h: number, w: number): boolean => {
    fill(i, r, c, h, w)
    out.push({ col: c, row: r, cols: w, rows: h, stretched: false, demoted: false })
    const used = out.reduce((n, p) => Math.max(n, p.row + p.rows), 0)
    let bad = false
    for (let y = Math.max(0, r - 1); y < Math.min(used, r + h + 1) && !bad; y++) {
      for (let x = Math.max(0, c - 1); x <= Math.min(cols - 1, c + w) && !bad; x++) {
        if (cell(y, x) === -1 && stranded(y, x, i, used)) bad = true
      }
    }
    out.pop()
    clear(r, c, h, w)
    return bad
  }

  // 1. Dense placement in widget order, skipping slots that would strand a one-row widget beside a hole.
  widgets.forEach((_wdg, i) => {
    const span = spans[i]!
    let placed = false
    let fallback: { r: number; c: number } | undefined
    const limit = widgets.reduce((n, _w, k) => n + spans[k]!.rows, 0) + 2
    for (let r = 0; !placed; r++) {
      // Every slot inside the used rows stranded a short widget: take the first of them rather than a fresh row past
      // the limit (which left the rows between as holes for the hero to swallow: the 3x4 hero of the taste round).
      if (r >= limit && fallback) {
        fill(i, fallback.r, fallback.c, span.rows, span.cols)
        out.push({ col: fallback.c, row: fallback.r, cols: span.cols, rows: span.rows, stretched: false, demoted: span.demoted })
        break
      }
      for (let c = 0; c < cols; c++) {
        if (!free(r, c, span.rows, span.cols)) continue
        if (r < limit && strandsAShortWidget(i, r, c, span.rows, span.cols)) {
          fallback ??= { r, c }
          continue
        }
        fill(i, r, c, span.rows, span.cols)
        out.push({ col: c, row: r, cols: span.cols, rows: span.rows, stretched: false, demoted: span.demoted })
        placed = true
        break
      }
    }
  })
  // Probing extends the grid past the last placed row; those rows are not holes.
  while (grid.length > 0 && grid[grid.length - 1]!.every((x) => x === -1)) grid.pop()

  // 2. Fill holes by stretching the neighbour that can grow into the cell with the least blank space.
  const height = grid.length
  let progress = true
  while (progress) {
    progress = false
    for (let r = 0; r < height; r++) {
      for (let c = 0; c < cols; c++) {
        if (grid[r]![c] !== -1) continue
        const options = neighbours(r, c).flatMap((n) => {
          const g = growth(n, r, c, height)
          return g ? [{ n, g, rank: rank(n, g) }] : []
        })
        if (options.length === 0) continue
        const best = options.reduce((a, b) => (b.rank < a.rank ? b : a))
        fill(best.n, best.g.row, best.g.col, best.g.rows, best.g.cols)
        out[best.n] = { col: best.g.col, row: best.g.row, cols: best.g.cols, rows: best.g.rows, stretched: true, demoted: out[best.n]!.demoted }
        progress = true
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
export function rowHeightFor(rows: number, height: number, chrome = 0, columnWidth = 0): number {
  if (rows <= 0 || height <= 0) return MIN_ROW_HEIGHT
  const share = Math.max(MIN_ROW_HEIGHT, Math.floor((height - chrome - GRID_GAP * (rows - 1)) / rows))
  if (columnWidth <= 0) return share
  // Change 1: a row is never taller than about two thirds of a column, so a one-cell chart and the 2x2 hero both
  // sit near 0.66 x width (a 1920 pane with two rows otherwise made 500 x 480 cells); never under the minimum.
  return Math.min(share, Math.max(MIN_ROW_HEIGHT, Math.round(columnWidth * MAX_ROW_ASPECT)))
}

/** Row height as a fraction of the column width, the cap `rowHeightFor` applies when it knows the column width. */
export const MAX_ROW_ASPECT = 0.66
