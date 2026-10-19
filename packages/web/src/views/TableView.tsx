import { useMemo, useState, type FC } from 'react'
import { columnIndex, controlFor, type Column, type Format, type Frame, type TableControl } from '@terminal/core'
import { DataTable, EmptyState, type CellFormat } from '@terminal/ui'
import type { ViewProps } from './types'
import { FactsCard } from './FactsCard'
import { controlOf, datasetsFor, kindOf, primaryFrame, viewOf } from './fields'
import { EMPTY_HINT, KIND_PRIORITY, defaultSortFor, formatsFor, type SortSpec } from './legacy'

export { defaultSortFor, formatsFor, type SortSpec }

/** Rank per column for a DataTable: 0 for the first three in display order, then 3, 4, … so narrow widgets shed the tail. */
export function ranksFor(columns: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {}
  columns.forEach((name, i) => {
    out[name] = i < 3 ? 0 : Math.min(i, 15)
  })
  return out
}

/** v1 compatibility: ranks for a kind's columns in its priority order (the first three always show). */
export function priorityFor(kind: Parameters<typeof formatsFor>[0], columns: Column[]): Record<string, number> {
  const listed = KIND_PRIORITY[kind] ?? []
  const names = columns.map((c) => c.name)
  return ranksFor([...listed.filter((n) => names.includes(n)), ...names.filter((n) => !listed.includes(n))])
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
 * sort (the control's, else the kind's default, else the frame's order; click a header to change), the
 * highlighted row, conditional colour on percent and change columns, and best and worst marks for compare
 * tables. A one-row frame renders the facts card instead (product rule 8).
 */
export const TableView: FC<ViewProps> = ({ widget, frames }) => {
  const kind = kindOf(widget)
  const control = tableControlOf(widget, frames)
  const frame = control ? frames[control.data] : primaryFrame(widget, frames)
  const [state, setState] = useState<{ key: string; sort: SortSpec | undefined } | null>(null)
  const table = control?.kind === 'table' ? control : undefined
  const sortKey = `${widget.id}:${table?.data ?? ''}`
  const sort = state?.key === sortKey ? state.sort : (table?.sort ?? (kind ? defaultSortFor(kind) : undefined))

  const projected = useMemo(() => (frame && table ? projectFrame(frame, table.columns) : frame), [frame, table])
  const formats = useMemo(() => formatsOf(table), [table])
  const extremes = useMemo(() => (projected && table?.extremes ? extremesFor(projected, table.columns, formats) : undefined), [projected, table, formats])
  const sorted = useMemo(() => (projected ? sortRows(projected, sort) : []), [projected, sort])

  if (!frame || !projected) return <EmptyState title="No data" hint="The frame has not landed." />
  if (frame.rows.length === 0) return <EmptyState title="No rows" hint={kind ? EMPTY_HINT[kind] : 'The query returned no rows.'} />
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

  return (
    <div data-view="table" data-rows={frame.rows.length} className="h-full w-full overflow-hidden">
      <DataTable
        columns={projected.columns}
        rows={limited}
        formats={formats}
        labels={table.labels}
        priority={ranksFor(table.columns)}
        sort={sort}
        onSort={onSort}
        {...(highlightRow ? { highlightRow } : {})}
        {...(cellMark ? { cellMark } : {})}
      />
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
