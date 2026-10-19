import { useMemo, useState, type FC } from 'react'
import clsx from 'clsx'
import { columnIndex, controlFor, type Column, type Format, type Frame, type TableControl } from '@terminal/core'
import { DataTable, EMPTY_CELL, EmptyState, direction, formatCell, type CellFormat } from '@terminal/ui'
import type { ViewProps } from './types'
import { VirtualTable } from '../components/VirtualTable'
import { FactsCard } from './FactsCard'
import { controlOf, datasetsFor, emptyHintFor, primaryFrame, viewOf } from './fields'

export type SortSpec = { column: string; dir: 'asc' | 'desc' }

/** Rank per column for a DataTable: 0 for the first three in display order, then 3, 4, … so narrow widgets shed the tail. */
export function ranksFor(columns: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {}
  columns.forEach((name, i) => {
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

/** Columns where a lower value is the better one (multiples, leverage, days to cover); every other numeric column reads higher-is-better. */
const LOWER_IS_BETTER = /(^|_)(pe|peg|ps|pb|ev_ebitda|debt|debt_to_equity|days_to_cover|cost|expense|short_interest|iv|iv30|hv30)$/

export type Extremes = Map<unknown[], Record<string, 'best' | 'worst'>>

/** The best and worst value per numeric column (compare tables): max and min, swapped where lower is better. */
export function extremesFor(frame: Pick<Frame, 'columns' | 'rows'>, columns: readonly string[], formats: Record<string, CellFormat>): Extremes {
  const out: Extremes = new Map()
  if (frame.rows.length < 2) return out
  for (const name of columns) {
    const f = formats[name]
    if (!f || f === 'text' || f === 'date' || f === 'time' || f === 'link') continue
    const i = columnIndex(frame, name)
    if (i < 0) continue
    let hi: unknown[] | undefined
    let lo: unknown[] | undefined
    for (const row of frame.rows) {
      const v = row[i]
      if (typeof v !== 'number' || !Number.isFinite(v)) continue
      if (!hi || v > (hi[i] as number)) hi = row
      if (!lo || v < (lo[i] as number)) lo = row
    }
    if (!hi || !lo || hi === lo) continue
    const lower = LOWER_IS_BETTER.test(name)
    const best = lower ? lo : hi
    const worst = lower ? hi : lo
    out.set(best, { ...(out.get(best) ?? {}), [name]: 'best' })
    out.set(worst, { ...(out.get(worst) ?? {}), [name]: 'worst' })
  }
  return out
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
  const formats = useMemo(() => formatsOf(table), [table])
  const extremes = useMemo(() => (projected && table?.extremes ? extremesFor(projected, table.columns, formats) : undefined), [projected, table, formats])
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

  const common = { columns: projected.columns, rows: limited, formats, labels: table.labels, priority: ranksFor(table.columns), sort, onSort }
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
                const text = formatCell(v, f)
                const dir = f === 'change' ? direction(v) : null
                return (
                  <div key={c} className="flex min-w-0 flex-col">
                    <span className="truncate text-fg-3" title={labels[c] ?? c}>
                      {labels[c] ?? c.replace(/_/g, ' ')}
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

/** Cell formats from the control: its formats, with colorized percent columns that read as moves rendered as signed changes. */
function formatsOf(table: TableControl | undefined): Record<string, CellFormat> {
  const out: Record<string, CellFormat> = {}
  if (!table) return out
  for (const c of table.columns) {
    const f = cellFormat(table.formats[c] ?? 'text')
    out[c] = f === 'percent' && table.colorize.includes(c) && SIGNED.test(c) ? 'change' : f
  }
  return out
}
