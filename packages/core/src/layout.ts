import { SIZE_SPANS } from './widget.js'
import type { Size } from './view-options.js'

/**
 * Where one widget sits in the grid: zero-based column and track, and how many of each it spans. Rows are grid
 * tracks, two per row of a size span (`TRACKS_PER_ROW`): a chart, a long table or a chain is two tracks tall per row
 * of its size, a stat, a facts card or a short table one track (taste round 2), so two short widgets can share the
 * height of one chart beside them.
 */
export type Placement = {
  col: number
  row: number
  cols: number
  rows: number
  /** True when the packer grew the widget beyond its size's span to fill a cell that would have stayed empty. */
  stretched: boolean
  /** True when the size-by-content rule changed the span the size asked for (a six-row table demoted to one track). */
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

/** Grid tracks per row of a size span (round 2): a short widget is one track, so it takes half the height of a chart. */
export const TRACKS_PER_ROW = 2

/** The span a size asks for in a grid of `columns` columns, in tracks: SIZE_SPANS clamped to the grid width. */
export function spanFor(size: Size, columns: number): { cols: number; rows: number } {
  const s = SIZE_SPANS[size]
  return { cols: Math.min(s.cols, columns), rows: s.rows * TRACKS_PER_ROW }
}

/**
 * What a widget will show, so the packer can size by content (PLAN.md section 17, "size by content"):
 * `rows` is the frame's row count when known; `kind` is what the view renders. The rest is optional and only sharpens
 * the round 2 rules: how wide the content is (a narrow table takes one column), how many cards a stat draws, how tall
 * a card's content is, and whether a chart needs a taller plot.
 */
export type ContentHint = {
  rows?: number
  kind: 'table' | 'chart' | 'stat' | 'facts' | 'chain'
  /** Columns the table shows (taste round: a five-column compare table needs two grid columns). */
  columns?: number
  /** px the content needs across: a table's columns at their content widths. A table this narrow takes one grid column. */
  width?: number
  /** px the columns a table never sheds need (the first three and the one it is sorted by): it may take one column when these fit. */
  minWidth?: number
  /** Cards a stat draws (one per symbol). */
  items?: number
  /** Fields under a card's hero (a quote's companions, a facts card's label:value pairs). */
  fields?: number
  /** A chart that compares several series or has indicator panes: its plot needs 160px at least (round 2). */
  dense?: boolean
}

/** A table with this many columns or more keeps its two grid columns: at one column it sheds the symbols it compares. */
export const WIDE_TABLE_COLUMNS = 5
export type LayoutWidget = { size: Size; contentHint?: ContentHint }

/** Tables with this many rows or fewer are one track tall (short content). */
export const SHORT_TABLE_ROWS = 6

/** Pixel geometry the packer may use to choose between layouts and to size narrow tables (round 2). */
export type LayoutOptions = {
  /** Width of one grid column in px. */
  columnWidth?: number
  /** Height the grid has before it scrolls, in px. */
  height?: number
  /** Gap between grid cells in px. */
  gap?: number
}

/** True when stretching this widget taller would show blank space: a table with six rows or fewer, a stat, a facts card. */
export function isShortContent(widget: LayoutWidget): boolean {
  const hint = widget.contentHint
  if (!hint) return false
  if (hint.kind === 'stat' || hint.kind === 'facts') return true
  return hint.kind === 'table' && hint.rows !== undefined && hint.rows <= SHORT_TABLE_ROWS
}

/** Columns a content this wide needs in a grid of `columnWidth` px columns. */
function columnsForWidth(width: number, columnWidth: number, gap: number): number {
  let c = 1
  while (c < 3 && width > c * columnWidth + (c - 1) * gap) c++
  return c
}

/**
 * The span a widget gets, in columns and tracks: its size's span, then the content rule (taste rounds 1 and 2).
 * A stat, a facts card and a table with six rows or fewer are one track tall; a facts card and a one-symbol stat are
 * one column wide (round 2: "a card is never wider than one column"), and no stat row is the full width of a grid with
 * two or more columns. A table whose content is narrower than one column (pairs, reactions, trades, a calendar of four
 * names) takes one column. A chart is never taller than it is wide: the lg hero is two columns by four tracks, an md
 * chart one column by two tracks in a three-column grid. Chains keep their size.
 */
export function effectiveSpan(widget: LayoutWidget, columns: number, opts: LayoutOptions = {}): { cols: number; rows: number; demoted: boolean } {
  const base = spanFor(widget.size, columns)
  const hint = widget.contentHint
  if (!hint) return { ...base, demoted: false }
  let rows = base.rows
  let cols = base.cols
  const gap = opts.gap ?? GRID_GAP
  switch (hint.kind) {
    case 'facts':
      rows = 1
      cols = 1
      break
    case 'stat':
      rows = 1
      if ((hint.items ?? 0) === 1) cols = 1
      else if (columns >= 2) cols = Math.min(cols, columns - 1)
      break
    case 'table': {
      if (hint.rows !== undefined && hint.rows <= SHORT_TABLE_ROWS) rows = 1
      if (hint.width !== undefined && opts.columnWidth) cols = Math.min(cols, columnsForWidth(hint.width, opts.columnWidth, gap))
      break
    }
    case 'chart':
      if (widget.size === 'md' && columns >= 3) cols = 1
      rows = Math.min(rows, cols * TRACKS_PER_ROW)
      break
    case 'chain':
      break
  }
  return { cols, rows, demoted: rows !== base.rows || cols !== base.cols }
}

/**
 * A chart placement this tall for its width reads as portrait: more than two tracks per column plus one (a one-column
 * chart over two rows of charts; one short track more is a card's height, not a portrait).
 */
export function isPortraitChart(widget: LayoutWidget, span: { cols: number; rows: number }): boolean {
  return widget.contentHint?.kind === 'chart' && span.rows > span.cols * TRACKS_PER_ROW + 1
}

/** A card (a facts card, a one-symbol stat) grown past one column (round 2: "a card is never wider than one column"). */
export function isWideCard(widget: LayoutWidget, span: { cols: number }): boolean {
  const hint = widget.contentHint
  return !!hint && (hint.kind === 'facts' || (hint.kind === 'stat' && (hint.items ?? 0) === 1)) && span.cols > 1
}

/** A stat row or a facts card stretched across every column of a three-column grid (change 1: "never full width"). */
export function isFullWidthShort(widget: LayoutWidget, span: { cols: number }, columns: number): boolean {
  const kind = widget.contentHint?.kind
  return (kind === 'stat' || kind === 'facts') && columns >= 3 && span.cols >= columns
}

// ---------- heights (round 2: cards end where their content ends, the page fills) ----------

/** Widget header: title, one line of sub-header, padding and the rule under it. */
export const FRAME_HEADER = 50
/** One compact stat card and the gap between card rows. */
export const STAT_CARD_HEIGHT = 72
/** One line of the dense stat list. */
export const DENSE_LINE_HEIGHT = 26
/** One table row and the header row. */
export const TABLE_ROW_HEIGHT = 29
export const TABLE_HEAD_HEIGHT = 32
/** One label:value line of a card's field grid. */
export const FIELD_LINE_HEIGHT = 24
/** A card's hero block: label over a 32px number (and its change line for a quote). */
export const HERO_HEIGHT = 52
/** Every chart's plot gets this much at least; a comparison or an oscillator chart its own minimum (round 2: 160px of plot). */
export const CHART_MIN_HEIGHT = 240
export const DENSE_CHART_MIN_HEIGHT = 300
/** A long table or a chain shows eight rows at least. */
export const TABLE_MIN_HEIGHT = FRAME_HEADER + TABLE_HEAD_HEIGHT + 8 * TABLE_ROW_HEIGHT + 4

/** How many compact cards (136px wide at least, 8px gaps, 8px padding) one row of a cell this wide holds. */
export function cardsPerRow(width: number): number {
  return Math.max(1, Math.floor((width - 16 + 8) / (136 + 8)))
}

/** Fields per line of a card's field grid at this width: pairs of at most 180px, two or three across. */
export function fieldsPerLine(width: number): number {
  return width >= 520 ? 3 : 2
}

/** Whether a stat of `items` cards draws the dense one-line-per-symbol list at this width (more than four in one column). */
export function denseStat(items: number, width: number): boolean {
  return items > 4 && cardsPerRow(width) <= 2
}

/**
 * The height a short widget's content needs at `width` px, header included (the card ends there and the spare
 * height goes to its neighbours). An estimate from the hint for choosing a layout; the grid measures the real one.
 * Undefined for content that fills whatever it gets (charts, long tables, chains).
 */
export function naturalHeight(hint: ContentHint | undefined, width: number): number | undefined {
  if (!hint) return undefined
  const lines = (n: number) => Math.ceil(n / fieldsPerLine(width))
  switch (hint.kind) {
    case 'facts': {
      const fields = hint.fields ?? 6
      return FRAME_HEADER + 24 + HERO_HEIGHT + 8 + 9 + lines(fields) * FIELD_LINE_HEIGHT
    }
    case 'stat': {
      const items = hint.items ?? 1
      if (items <= 1) {
        const fields = hint.fields ?? 6
        return FRAME_HEADER + 24 + HERO_HEIGHT + 20 + (fields > 0 ? 8 + 9 + lines(fields) * FIELD_LINE_HEIGHT : 0)
      }
      if (denseStat(items, width)) return FRAME_HEADER + 12 + items * DENSE_LINE_HEIGHT
      const rows = Math.ceil(items / cardsPerRow(width))
      return FRAME_HEADER + 16 + rows * STAT_CARD_HEIGHT + (rows - 1) * 8
    }
    case 'table': {
      const rows = hint.rows
      if (rows === undefined || rows > SHORT_TABLE_ROWS) return undefined
      if (rows <= 3) {
        // Two or three rows are cards, one per row, wrapping at 200px: a heading over label-over-value pairs, two across.
        const perRow = Math.max(1, Math.floor((width - 24 + 8) / 208))
        const cardRows = Math.ceil(rows / Math.min(perRow, rows))
        const card = 20 + 26 + Math.ceil((hint.fields ?? 4) / 2) * 36
        return FRAME_HEADER + 24 + cardRows * card + (cardRows - 1) * 8
      }
      return FRAME_HEADER + TABLE_HEAD_HEIGHT + rows * TABLE_ROW_HEIGHT + 4
    }
    default:
      return undefined
  }
}

/** The least height a widget may get, header included: its content for a short widget, a usable plot for a chart. */
export function minHeight(hint: ContentHint | undefined, width: number): number {
  if (!hint) return CHART_MIN_HEIGHT
  const natural = naturalHeight(hint, width)
  if (natural !== undefined) return natural
  // A chart two or three columns wide keeps a landscape plot rather than shrinking to a strip when the page scrolls.
  if (hint.kind === 'chart') return Math.max(hint.dense ? DENSE_CHART_MIN_HEIGHT : CHART_MIN_HEIGHT, Math.round(width * 0.5))
  // A long table shows eight rows at least (all of them when it has fewer), so a compare table is never four rows and a scrollbar.
  if (hint.kind === 'table' && hint.rows !== undefined) return Math.min(FRAME_HEADER + TABLE_HEAD_HEIGHT + hint.rows * TABLE_ROW_HEIGHT + 4, TABLE_MIN_HEIGHT)
  return TABLE_MIN_HEIGHT
}

/** One widget as the track sizer sees it: short content has a natural height and never wants more. */
export type TrackItem = { short: boolean; natural?: number | undefined; min: number }

/**
 * Track heights for a packed grid (round 2): a track that only short widgets occupy on their own is as tall as the
 * tallest of them; the other tracks share what is left of `available`, so the page fills (no bottom third left
 * empty) and the spare height of a short card goes to the chart or table beside it. Every widget gets at least its
 * minimum (a compare chart's 160px plot, a card's content), even when that means the grid scrolls. When every track
 * is content-sized the leftover is shared by all of them rather than left as empty canvas.
 */
export function trackHeights(placements: readonly Placement[], items: readonly TrackItem[], available: number, gap = GRID_GAP): number[] {
  const n = placements.reduce((m, p) => Math.max(m, p.row + p.rows), 0)
  if (n === 0) return []
  const h = new Array<number>(n).fill(0)
  const flex = new Array<boolean>(n).fill(true)
  const alone = new Array<boolean>(n).fill(false)
  for (const p of placements) if (p.rows === 1) alone[p.row] = true
  for (let t = 0; t < n; t++) {
    if (!alone[t]) continue
    const occupants = placements.flatMap((p, i) => (p.rows === 1 && p.row === t ? [items[i]!] : []))
    if (occupants.every((it) => it.short)) {
      flex[t] = false
      h[t] = Math.max(...occupants.map((it) => it.natural ?? it.min))
    }
  }
  // Each widget gets its need across the tracks it spans: shortfalls go to the flexible tracks in its span first.
  const need = (i: number) => {
    const it = items[i]!
    return it.short ? (it.natural ?? it.min) : it.min
  }
  for (let pass = 0; pass < 4; pass++) {
    let changed = false
    placements.forEach((p, i) => {
      const span = Array.from({ length: p.rows }, (_, k) => p.row + k)
      const total = span.reduce((s, t) => s + h[t]!, 0) + gap * (p.rows - 1)
      const short = need(i) - total
      if (short <= 0.5) return
      const grow = span.filter((t) => flex[t]).length > 0 ? span.filter((t) => flex[t]) : span
      for (const t of grow) h[t] = h[t]! + short / grow.length
      changed = true
    })
    if (!changed) break
  }
  // The leftover fills the page: water-fill the flexible tracks (the shortest first), else every track.
  let left = available - (h.reduce((s, v) => s + v, 0) + gap * (n - 1))
  const pool = flex.some(Boolean) ? h.map((_, t) => t).filter((t) => flex[t]) : h.map((_, t) => t)
  while (left > 0.5 && pool.length > 0) {
    const low = Math.min(...pool.map((t) => h[t]!))
    const lowest = pool.filter((t) => h[t]! - low < 0.5)
    const next = Math.min(...pool.map((t) => h[t]!).filter((v) => v - low >= 0.5), Infinity)
    const step = Math.min(left / lowest.length, next - low)
    for (const t of lowest) h[t] = h[t]! + step
    left -= step * lowest.length
  }
  return h.map((v) => Math.floor(v))
}

/** The height a placement gets from the track heights, gaps included. */
export function placementHeight(p: Pick<Placement, 'row' | 'rows'>, tracks: readonly number[], gap = GRID_GAP): number {
  let s = 0
  for (let t = p.row; t < p.row + p.rows; t++) s += tracks[t] ?? 0
  return s + gap * (p.rows - 1)
}

// ---------- packing ----------

/**
 * Lay widgets out in a grid of `columns` columns so that no cell stays empty.
 *
 * Pure. Widgets are placed in order at the first position where their span fits, scanning tracks top to bottom and
 * columns left to right, so a later one-column widget is pulled up into a gap beside an earlier one (the same rule as
 * CSS `grid-auto-flow: dense`). Then every empty cell is filled by stretching a neighbour: first the widget to its
 * left, then the one above, then the one to its right, then the one below, whichever can grow into the cell without
 * overlapping anything. The result is explicit positions in columns and tracks.
 *
 * Several span sets are tried (an md chart one column or two, a two-column short widget or narrow table at one
 * column) and the best kept: no portrait chart, no full-width stat and no short widget stretched taller when anything
 * else tiles; then, when the grid's height is known (`opts.height`, round 2), the layout that fills the page with the
 * least scrolling, the least blank space inside short cards and the least portrait charts; then the fewest tracks.
 */
export function packLayout(widgets: readonly LayoutWidget[], columns: number, opts: LayoutOptions = {}): Placement[] {
  const cols = Math.max(1, Math.floor(columns))
  const gap = opts.gap ?? GRID_GAP
  const base = widgets.map((w) => effectiveSpan(w, cols, opts))
  const alternatives: { i: number; span: { cols: number; rows: number; demoted: boolean } }[] = []
  widgets.forEach((w, i) => {
    const hint = w.contentHint
    const kind = hint?.kind
    const s = base[i]!
    // A table narrowed to one column must still show the columns it never sheds (the first three, the sort column).
    const keep = hint?.minWidth ?? hint?.width
    const fitsOne = kind !== 'table' || (keep !== undefined ? !!opts.columnWidth && keep <= opts.columnWidth : (hint?.columns ?? 0) < WIDE_TABLE_COLUMNS)
    if (kind === 'chart' && s.demoted && w.size === 'md') {
      // A demoted md chart back at its size's span: two columns by two tracks.
      const b = spanFor(w.size, cols)
      alternatives.push({ i, span: { cols: b.cols, rows: Math.min(b.rows, b.cols * TRACKS_PER_ROW), demoted: false } })
    } else if (kind && kind !== 'chart' && kind !== 'chain' && s.cols === 2 && cols >= 3 && fitsOne && !(kind === 'table' && w.size === 'lg')) {
      // (The lg table is the answer: it keeps its two columns unless all of it fits in one.)
      // A two-column stat row or table at one column: two of them cannot share a three-column band.
      alternatives.push({ i, span: { cols: 1, rows: s.rows, demoted: true } })
    } else if (kind === 'table' && s.cols === 1 && cols >= 3 && s.rows > 1 && spanFor(w.size, cols).cols >= 2) {
      // A long table narrowed to one column may also take its two (a news table beside a chart).
      alternatives.push({ i, span: { cols: 2, rows: s.rows, demoted: false } })
    }
  })
  const alts = alternatives.slice(0, 7)
  const short = widgets.map(isShortContent)
  const sized = opts.height !== undefined && opts.height > 0 && opts.columnWidth !== undefined && opts.columnWidth > 0
  // Placement orders (round 2): as given; the short widgets right after the hero (a stat beside the hero, the charts
  // under it); the short widgets last (under the column of charts beside the hero, which then grows down to them).
  const index = widgets.map((_w, i) => i)
  const head = index.slice(0, 1)
  const rest = index.slice(1)
  const orders = [index, [...head, ...rest.filter((i) => short[i]), ...rest.filter((i) => !short[i])], [...head, ...rest.filter((i) => !short[i]), ...rest.filter((i) => short[i])]].filter(
    (o, k, all) => all.findIndex((x) => x.join() === o.join()) === k,
  )
  let best: Placement[] | undefined
  let bestCost: number[] = []
  // With the page's size known the strand rule is one candidate among others: the px cost judges a card grown taller.
  const variants = orders.flatMap((order) => (sized ? [{ order, avoid: true }, { order, avoid: false }] : [{ order, avoid: true }]))
  for (const [oi, { order, avoid }] of variants.entries()) {
    for (let mask = 0; mask < 1 << alts.length; mask++) {
      const spans = base.map((s, i) => {
        const k = alts.findIndex((a) => a.i === i)
        if (k < 0 || !((mask >> k) & 1)) return s
        return alts[k]!.span
      })
      const placed = packOnce(
        order.map((i) => widgets[i]!),
        order.map((i) => spans[i]!),
        cols,
        avoid,
      )
      const out: Placement[] = new Array<Placement>(widgets.length)
      order.forEach((i, k) => (out[i] = placed[k]!))
      const tracks = out.reduce((n, p) => Math.max(n, p.row + p.rows), 0)
      const tallerShort = out.filter((p, i) => short[i] && p.rows > spans[i]!.rows).length
      const portrait = out.filter((p, i) => isPortraitChart(widgets[i]!, p)).length
      const fullWidth = out.filter((p, i) => isFullWidthShort(widgets[i]!, p, cols) || isWideCard(widgets[i]!, p)).length
      const flattened = alts.filter((_a, k) => (mask >> k) & 1).length
      const stretched = out.filter((p) => p.stretched).length
      // Three widgets side by side in some track (the Instinct rhythm, round 2) is worth about 120px of other cost.
      const px = sized ? pixelCost(widgets, out, opts.columnWidth!, opts.height!, gap) + (cols >= 3 && widgets.length >= 3 && !threeAcross(out, cols) ? 15 : 0) : 0
      // With the page's size known a short widget grown taller costs its blank space in px; without it, it is a fault.
      const cost = [hasHoles(out, cols) ? 1 : 0, (sized ? 0 : tallerShort) + portrait + fullWidth, px, tracks, oi, flattened, stretched]
      if (!best || lexLess(cost, bestCost)) {
        best = out
        bestCost = cost
      }
    }
  }
  return best ?? []
}

/**
 * How badly a packing uses the page, in px (round 2): the scroll it causes beyond `height`, the blank space inside
 * short cards (a facts card in a tall track), a chart's height past 1.4 times its width (portrait) and the canvas left
 * empty under the grid. Heights are the estimates of `naturalHeight`; the grid sizes its tracks from measured ones.
 */
export function pixelCost(widgets: readonly LayoutWidget[], placements: readonly Placement[], columnWidth: number, height: number, gap = GRID_GAP): number {
  const widthOf = (p: Placement) => p.cols * columnWidth + (p.cols - 1) * gap
  const items: TrackItem[] = placements.map((p, i) => {
    const hint = widgets[i]!.contentHint
    const w = widthOf(p)
    const natural = naturalHeight(hint, w)
    return { short: isShortContent(widgets[i]!), natural, min: minHeight(hint, w) }
  })
  const tracks = trackHeights(placements, items, height, gap)
  const total = tracks.reduce((s, v) => s + v, 0) + gap * Math.max(0, tracks.length - 1)
  let cost = Math.max(0, total - height) + Math.max(0, height - total)
  placements.forEach((p, i) => {
    const h = placementHeight(p, tracks, gap)
    const it = items[i]!
    if (it.short && it.natural !== undefined) cost += Math.max(0, h - it.natural)
    if (widgets[i]!.contentHint?.kind === 'chart') cost += Math.max(0, h - 1.4 * widthOf(p))
    // The lg chart or table is the hero or the answer: it keeps most of the page's height.
    if (widgets[i]!.size === 'lg' && !it.short) cost += 2 * Math.max(0, 0.6 * height - h)
    // The agent lists the hero and the answer first: the first three widgets show at least 200px above the fold.
    if (i < 3) {
      const top = tracks.slice(0, p.row).reduce((s, v) => s + v + gap, 0)
      cost += 2 * Math.max(0, top + Math.min(200, h) - height)
    }
  })
  return Math.round(cost / 8)
}

/** True when some track holds `cols` different widgets side by side (three across in a three-column grid). */
export function threeAcross(placements: readonly Placement[], cols: number): boolean {
  const tracks = placements.reduce((n, p) => Math.max(n, p.row + p.rows), 0)
  for (let t = 0; t < tracks; t++) {
    const here = placements.filter((p) => p.row <= t && t < p.row + p.rows)
    if (here.length >= cols) return true
  }
  return false
}

/** Lexicographic less-than over equal-length number tuples. */
function lexLess(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < a.length; i++) {
    if (a[i]! !== b[i]!) return a[i]! < b[i]!
  }
  return false
}

/** One packing with the spans given (see `packLayout`, which chooses between span sets). */
function packOnce(widgets: readonly LayoutWidget[], spans: readonly { cols: number; rows: number; demoted: boolean }[], cols: number, avoidStrands = true): Placement[] {
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
    if (isPortraitChart(widgets[i]!, g) || isFullWidthShort(widgets[i]!, g, cols) || isWideCard(widgets[i]!, g)) return 3
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

  // 1. Dense placement in widget order, skipping slots that would strand a short widget beside a hole.
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
        if (avoidStrands && r < limit && strandsAShortWidget(i, r, c, span.rows, span.cols)) {
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

/** Before the pane is measured every track is this tall. */
export const MIN_ROW_HEIGHT = 120
export const GRID_GAP = 8
