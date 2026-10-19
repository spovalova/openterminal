import { useMemo, useState, type FC } from 'react'
import clsx from 'clsx'
import { columnIndex, controlFor, type Column, type Format, type Frame, type TableControl } from '@terminal/core'
import { DataTable, EMPTY_CELL, EmptyState, direction, displayText, formatCell, type CellFormat } from '@terminal/ui'
import type { ViewProps } from './types'
import { VirtualTable } from '../components/VirtualTable'
import { FactsCard } from './FactsCard'
import { columnLabel } from './labels'
import { controlOf, datasetsFor, emptyHintFor, primaryFrame, viewOf } from './fields'

export type SortSpec = { column: string; dir: 'asc' | 'desc' }

/**
 * Rank per column for a DataTable: 0 for the first three, then 3, 4, … so narrow widgets shed the tail. The column the
 * view sorts by counts as the second, whatever its place: it is what the table ranks (a sectors table sorted by its
 * week change shed that column in a one-column cell and kept two closes).
 */
export function ranksFor(columns: readonly string[], sortedBy?: string): Record<string, number> {
  const order = sortedBy && columns.indexOf(sortedBy) > 0 ? [columns[0]!, sortedBy, ...columns.slice(1).filter((c) => c !== sortedBy)] : columns
  const out: Record<string, number> = {}
  order.forEach((name, i) => {
    out[name] = i < 3 ? 0 : Math.min(i, 15)
  })
  return out
}

/** Direction a column sorts in when first clicked: newest/largest first for time, date and numbers. */
function firstDir(column: Column | undefined): 'asc' | 'desc' {
  if (!column) return 'asc'
  if (column.type === 'time' || column.type === 'number' || column.name === 'date') return 'desc'
  return 'asc'
}

function compare(a: unknown, b: unknown): number {
  if (a == null && b == null) return 0
  if (a == null) return 1 // nulls last regardless of direction
  if (b == null) return -1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b)
  return String(a).localeCompare(String(b), 'en', { numeric: true, sensitivity: 'base' })
}

/** Stable sort of the rows by one column; nulls sink to the bottom in either direction. */
export function sortRows(frame: Pick<Frame, 'columns' | 'rows'>, sort: SortSpec | undefined): unknown[][] {
  if (!sort) return frame.rows
  const i = columnIndex(frame, sort.column)
  if (i < 0) return frame.rows
  const sign = sort.dir === 'asc' ? 1 : -1
  return frame.rows
    .map((row, index) => ({ row, index }))
    .sort((x, y) => {
      const a = x.row[i]
      const b = y.row[i]
      if (a == null || b == null) return compare(a, b) || x.index - y.index
      return sign * compare(a, b) || x.index - y.index
    })
    .map((x) => x.row)
}

/** Core formats as DataTable cell formats (`ratio` renders like a price). */
export function cellFormat(format: Format): CellFormat {
  return format === 'ratio' ? 'price' : format
}

/**
 * Columns where a lower value is the better one (multiples, leverage, days to cover); every other numeric column reads
 * higher-is-better. A multiple may carry a qualifier ("pe_forward", "pe_ttm"), as the pivoted rows already allowed.
 */
const LOWER_IS_BETTER = /(^|_)(pe|peg|ps|pb|ev_ebitda|ev_revenue)($|_)|(^|_)(debt|debt_to_equity|days_to_cover|cost|expense|short_interest|iv|iv30|hv30)$/
/** Multiples where a value under one (or negative: losses) is an artefact, not the best of the group. */
const MULTIPLE = /(^|_)(pe|forward_pe|peg|ps|pb|ev_ebitda|ev_revenue)($|_)/
/** Names that are comparisons (rates, multiples, margins, growth): marked whatever their format. */
const COMPARATIVE = /(^|_)(pe|peg|ps|pb|ev_ebitda|ev_revenue|debt_to_equity|margin|growth|yield|return|roe|roa|upside|surprise|reaction|move|change|pct|cagr|drawdown)($|_)|margin|growth/
/** Absolute levels (prices, counts, amounts): never marked, a "best" EPS estimate or close means nothing (change 6). */
const ABSOLUTE = /(^|_)(eps|close|open|high|low|price|last|market_cap|mktcap|mkt_cap|mcap|revenue|volume|count|analysts|shares|cash|debt_total|fcf|ebitda|income|strike|bid|ask|oi|open_interest)($|_)/

/** Whether a column carries a comparison worth marking best and worst: by its name first, else by its core format. */
export function markable(name: string, format: Format | CellFormat | undefined): boolean {
  if (COMPARATIVE.test(name)) return true
  if (ABSOLUTE.test(name)) return false
  return format === 'ratio' || format === 'percent' || format === 'change'
}

/**
 * The names a column is judged by: its own in snake case ("trailingPE" is "trailing_pe") and its label in the same
 * vocabulary ("Fwd P/E" is "fwd_pe", "Mkt cap ($B)" is "mkt_cap_b"), so an agent's `fpe` or `mcap_b` column is
 * marked the way its header reads (a forward P/E of 25.4 was marked best, a market cap marked at all).
 */
function columnKeys(name: string, label: string | undefined): string[] {
  const own = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
  return label ? [own, metricKey(label)] : [own]
}

export type Extremes = Map<unknown[], Record<string, 'best' | 'worst'>>

/**
 * The best and worst value per comparative column (compare tables, change 6): max and min, swapped where lower is
 * better; absolute columns (EPS, close, market cap, counts) are never marked, and a multiple under one is skipped.
 * `formats` are the control's core formats (`ratio` is a comparison; a `price` column is a level); `labels` the headers.
 */
export function extremesFor(frame: Pick<Frame, 'columns' | 'rows'>, columns: readonly string[], formats: Record<string, Format | CellFormat>, labels: Record<string, string> = {}): Extremes {
  const out: Extremes = new Map()
  if (frame.rows.length < 2) return out
  for (const name of columns) {
    const f = formats[name]
    if (!f || f === 'text' || f === 'date' || f === 'time' || f === 'link') continue
    const keys = columnKeys(name, labels[name])
    const any = (re: RegExp) => keys.some((k) => re.test(k))
    if (!any(COMPARATIVE) && (any(ABSOLUTE) || !markable(keys[0]!, f))) continue
    const i = columnIndex(frame, name)
    if (i < 0) continue
    const lower = any(LOWER_IS_BETTER)
    const multiple = any(MULTIPLE)
    let hi: unknown[] | undefined
    let lo: unknown[] | undefined
    for (const row of frame.rows) {
      const v = row[i]
      if (typeof v !== 'number' || !Number.isFinite(v)) continue
      if (multiple && v < 1) continue
      if (!hi || v > (hi[i] as number)) hi = row
      if (!lo || v < (lo[i] as number)) lo = row
    }
    if (!hi || !lo || hi === lo) continue
    const best = lower ? lo : hi
    const worst = lower ? hi : lo
    out.set(best, { ...(out.get(best) ?? {}), [name]: 'best' })
    out.set(worst, { ...(out.get(worst) ?? {}), [name]: 'worst' })
  }
  return out
}

/** A metric name as written in a pivoted compare table ("P/E", "Revenue growth %") reduced to the column vocabulary above. */
function metricKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/p\/e/g, 'pe')
    .replace(/p\/s/g, 'ps')
    .replace(/p\/b/g, 'pb')
    .replace(/ev\s*\/\s*revenue/g, 'ev_revenue')
    .replace(/ev\s*\/\s*ebitda/g, 'ev_ebitda')
    .replace(/debt\s*\/\s*equity/g, 'debt_to_equity')
    .replace(/%/g, 'pct')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
}

/**
 * Best and worst across a row of a pivoted compare table (metrics as rows, one column per symbol): the metric's
 * name decides whether it is a comparison and which way is better. Keys are the row and the symbol column.
 */
export function rowExtremesFor(frame: Pick<Frame, 'columns' | 'rows'>, metricColumn: string, valueColumns: readonly string[]): Extremes {
  const out: Extremes = new Map()
  const m = columnIndex(frame, metricColumn)
  if (m < 0 || valueColumns.length < 2) return out
  const idx = valueColumns.map((c) => [c, columnIndex(frame, c)] as const).filter(([, i]) => i >= 0)
  for (const row of frame.rows) {
    const key = metricKey(String(row[m] ?? ''))
    if (!key || !markable(key, undefined) || ABSOLUTE.test(key) && !COMPARATIVE.test(key)) continue
    const lower = LOWER_IS_BETTER.test(key) || /(^|_)(pe|ps|pb|ev_revenue|ev_ebitda|debt)($|_)/.test(key)
    const multiple = MULTIPLE.test(key) || /(^|_)(pe|ps|pb|ev_revenue|ev_ebitda)($|_)/.test(key)
    let hi: string | undefined
    let lo: string | undefined
    let hv = -Infinity
    let lv = Infinity
    for (const [c, i] of idx) {
      const v = row[i]
      if (typeof v !== 'number' || !Number.isFinite(v)) continue
      if (multiple && v < 1) continue
      if (v > hv) [hv, hi] = [v, c]
      if (v < lv) [lv, lo] = [v, c]
    }
    if (!hi || !lo || hi === lo) continue
    out.set(row, { [lower ? lo : hi]: 'best', [lower ? hi : lo]: 'worst' })
  }
  return out
}

/** A pivoted compare table: a text `metric` column first and numeric columns after it, one per symbol. */
export function pivotMetricColumn(frame: Pick<Frame, 'columns' | 'rows'>): string | undefined {
  const first = frame.columns[0]
  if (!first || first.type !== 'string' || !/^(metric|field|item|measure|line)$/i.test(first.name)) return undefined
  // Symbol columns are numbers, or mostly numbers when the pivot carries a row of words (a "Rating" row makes pandas
  // type every symbol column as object).
  const rest = frame.columns.slice(1).map((_, i) => i + 1)
  return rest.length >= 2 && rest.every((i) => frame.columns[i]!.type === 'number' || mostlyNumeric(frame.rows, i)) ? first.name : undefined
}

/** At least four in five of a column's non-empty cells are numbers. */
export function mostlyNumeric(rows: readonly unknown[][], i: number): boolean {
  let n = 0
  let num = 0
  for (const r of rows) {
    const v = r[i]
    if (v == null || v === '') continue
    n++
    if (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)))) num++
  }
  return n > 0 && num / n >= 0.8
}

/** The frame projected onto the control's columns, in its order. */
export function projectFrame(frame: Frame, columns: readonly string[]): Frame {
  const idx = columns.map((c) => columnIndex(frame, c)).filter((i) => i >= 0)
  return { ...frame, columns: idx.map((i) => frame.columns[i]!), rows: frame.rows.map((row) => idx.map((i) => row[i])) }
}

/**
 * `table` preset: a DataTable from the `TableControl` (columns by priority, formats and labels from field config),
 * sort (the control's, else the frame's order; click a header to change), the
 * highlighted row, conditional colour on percent and change columns, and best and worst marks for compare
 * tables. A one-row frame renders the facts card instead (product rule 8).
 */
export const TableView: FC<ViewProps> = ({ widget, frames }) => {
  const control = tableControlOf(widget, frames)
  const frame = control ? frames[control.data] : primaryFrame(widget, frames)
  const [state, setState] = useState<{ key: string; sort: SortSpec | undefined } | null>(null)
  const table = control?.kind === 'table' ? control : undefined
  const sortKey = `${widget.id}:${table?.data ?? ''}`
  const sort = state?.key === sortKey ? state.sort : table?.sort

  const projected = useMemo(() => (frame && table ? projectFrame(frame, table.columns) : frame), [frame, table])
  const formats = useMemo(() => {
    const out = formatsOf(table)
    // An object column of numbers (a pivot with a row of words) reads as numbers: right-aligned, two decimals (change 5).
    if (projected) projected.columns.forEach((c, i) => {
      if (out[c.name] === 'text' && c.type === 'string' && c.name !== projected.columns[0]?.name && mostlyNumeric(projected.rows, i)) out[c.name] = 'price'
    })
    return out
  }, [table, projected])
  const extremes = useMemo(() => {
    if (!projected || !table) return undefined
    // A pivoted compare table (metrics as rows) marks across each row whether or not the control asked (the compare recipe's shape).
    const metric = pivotMetricColumn(projected)
    if (metric) return rowExtremesFor(projected, metric, table.columns.filter((c) => c !== metric))
    return table.extremes ? extremesFor(projected, table.columns, { ...formats, ...table.formats }, table.labels) : undefined
  }, [projected, table, formats])
  const sorted = useMemo(() => (projected ? sortRows(projected, sort) : []), [projected, sort])

  if (!frame || !projected) return <EmptyState title="No data" hint="The frame has not landed." />
  if (frame.rows.length === 0) return <EmptyState title="No rows" hint={emptyHintFor(widget)} />
  if (frame.rows.length === 1) return <FactsCard widget={widget} frames={frames} />
  if (!table) return <EmptyState title="No table" hint="The view has no table control for this frame." />

  const limited = table.limit ? sorted.slice(0, table.limit) : sorted
  const onSort = (column: string) => {
    const next: SortSpec = sort && sort.column === column ? { column, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { column, dir: firstDir(projected.columns.find((c) => c.name === column)) }
    setState({ key: sortKey, sort: next })
  }
  const hi = table.highlight
  const hiIndex = hi ? columnIndex(projected, hi.column) : -1
  const highlightRow = hi && hiIndex >= 0 ? (row: unknown[]) => String(row[hiIndex]) === String(hi.value) : undefined
  const cellMark = extremes ? (row: unknown[], column: string) => extremes.get(row)?.[column] : undefined

  const common = { columns: projected.columns, rows: limited, formats, labels: table.labels, priority: ranksFor(table.columns, table.sort?.column), sort, onSort }
  // Two or three rows cannot fill a grid row as a table (the (d) note: 28px rows in a 240px cell); each row becomes a
  // card of label-over-value facts, the key column as its heading, so the cell reads full and every column shows.
  if (limited.length <= ROW_CARDS_MAX) return <RowCards frame={projected} rows={limited} formats={formats} labels={table.labels} columns={table.columns} />
  return (
    <div data-view="table" data-rows={frame.rows.length} data-virtual={limited.length > VIRTUAL_ROWS ? '' : undefined} className="h-full w-full overflow-hidden">
      {limited.length > VIRTUAL_ROWS ? (
        // Screener and transform outputs in the thousands of rows: (e)'s windowed table, same API without the marks.
        <VirtualTable {...common} />
      ) : (
        <DataTable {...common} {...(highlightRow ? { highlightRow } : {})} {...(cellMark ? { cellMark } : {})} />
      )}
    </div>
  )
}

/** Above this many rows the table windows its rows (VirtualTable); below it every row renders with highlight and marks. */
export const VIRTUAL_ROWS = 150
/** Up to this many rows a table renders as one card per row (a one-row frame is the facts card; two or three are row cards). */
export const ROW_CARDS_MAX = 3

/**
 * Two or three rows as cards: the first text column (symbol, name) heads each card and the other columns follow as
 * label over value, the same formats as the table; signed changes coloured. Each card takes a column of the cell.
 */
const RowCards: FC<{ frame: Frame; rows: unknown[][]; formats: Record<string, CellFormat>; labels: Record<string, string>; columns: readonly string[] }> = ({ frame, rows, formats, labels, columns }) => {
  const names = frame.columns.map((c) => c.name)
  const head = columns.find((c) => names.includes(c) && frame.columns[columnIndex(frame, c)]!.type === 'string') ?? columns[0]!
  const rest = columns.filter((c) => c !== head && names.includes(c))
  return (
    <div data-view="table" data-rows={frame.rows.length} data-cards="" className="row-cards h-full w-full overflow-x-hidden overflow-y-auto p-3">
      {rows.map((row, ri) => {
        const headText = String(row[columnIndex(frame, head)] ?? '')
        return (
          <div key={ri} data-row={ri} className="flex min-w-0 flex-col gap-1.5 rounded-md border border-border bg-surface-2/50 px-3 py-2.5">
            <div className="num truncate text-sm font-semibold text-fg" title={headText}>
              {headText || '—'}
            </div>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs leading-4">
              {rest.map((c) => {
                const v = row[columnIndex(frame, c)]
                const f = formats[c] ?? 'text'
                const text = f === 'text' && typeof v === 'string' ? displayText(v) : formatCell(v, f)
                const dir = f === 'change' ? direction(v) : null
                return (
                  <div key={c} className="flex min-w-0 flex-col">
                    {/* Display names, wrapped at words rather than cut (change 11: "num estimates", "previous report date"). */}
                    <span className="line-clamp-2 break-words text-fg-3" title={labels[c] ?? columnLabel(c)}>
                      {labels[c] ?? columnLabel(c)}
                    </span>
                    <span className={clsx('line-clamp-2 break-words', f !== 'text' && 'num', text === EMPTY_CELL ? 'text-fg-3' : dir === 'up' ? 'text-up' : dir === 'down' ? 'text-down' : 'text-fg')} title={typeof v === 'string' ? v : undefined}>
                      {text}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** The table control for a widget: its own when it is a table view, else the frame as a plain table (the table is the floor and always renders). */
export function tableControlOf(widget: ViewProps['widget'], frames: Record<string, Frame>): TableControl | undefined {
  const view = viewOf(widget)
  const control = view.preset === 'table' ? controlOf(widget, frames) : controlFor({ preset: 'table', ...(view.data ? { data: view.data } : {}) }, datasetsFor(widget, frames))
  return control?.kind === 'table' ? control : undefined
}

/** Percent columns that are signed moves rather than levels: coloured when the control colorizes them. */
const SIGNED = /_pct$|^change|growth|return|surprise|upside|reaction|_chg$/

/** Columns whose sign is fixed by what they measure (distance below a high, move to breakeven, a put's delta, a drawdown). */
export const ONE_SIGNED = /vs_?52w|52w_high_pct|from_(52w_)?high|off_(the_)?(high|peak)|below_high|to_be|breakeven|move_to|be_pct|(^|_)delta($|_)|drawdown/

/** Cell formats from the control: its formats, with colorized percent columns that read as moves rendered as signed changes. */
function formatsOf(table: TableControl | undefined): Record<string, CellFormat> {
  const out: Record<string, CellFormat> = {}
  if (!table) return out
  for (const c of table.columns) {
    const f = cellFormat(table.formats[c] ?? 'text')
    const signed = f === 'percent' && table.colorize.includes(c) && SIGNED.test(c) ? 'change' : f
    // A column negative (or positive) by construction carries no direction in its colour: neutral (change 7).
    out[c] = signed === 'change' && ONE_SIGNED.test(c) ? 'percent' : signed
  }
  return out
}
