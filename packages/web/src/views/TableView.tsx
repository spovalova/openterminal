import { useState, type FC } from 'react'
import type { Column, Frame, Kind } from '@terminal/core'
import { columnIndex } from '@terminal/core'
import { DataTable, EmptyState, type CellFormat } from '@terminal/ui'
import type { ViewProps } from './types'

export type SortSpec = { column: string; dir: 'asc' | 'desc' }

/** Typed cell formats per kind; columns not listed render as text. */
const KIND_FORMATS: Record<Kind, Record<string, CellFormat>> = {
  search: {},
  quote: { price: 'price', change_pct: 'percent', volume: 'integer', extended_price: 'price', extended_change_pct: 'percent' },
  ohlcv: { time: 'time', open: 'price', high: 'price', low: 'price', close: 'price', volume: 'integer' },
  news: { time: 'time', url: 'link' },
  earnings: { date: 'date', eps_estimate: 'price' },
}

/** Default sort per kind; `undefined` keeps the connector's row order. */
const KIND_DEFAULT_SORT: Record<Kind, SortSpec | undefined> = {
  search: undefined,
  quote: { column: 'symbol', dir: 'asc' },
  ohlcv: { column: 'time', dir: 'desc' },
  news: { column: 'time', dir: 'desc' },
  earnings: { column: 'date', dir: 'asc' },
}

/** A format for every column of the frame: the kind's typed formats, text for the rest. */
export function formatsFor(kind: Kind, columns: Column[]): Record<string, CellFormat> {
  const out: Record<string, CellFormat> = {}
  for (const c of columns) out[c.name] = KIND_FORMATS[kind][c.name] ?? 'text'
  return out
}

export function defaultSortFor(kind: Kind): SortSpec | undefined {
  return KIND_DEFAULT_SORT[kind]
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

const EMPTY_HINT: Record<Kind, string> = {
  search: 'No symbols matched the query.',
  quote: 'No quotes came back for these symbols.',
  ohlcv: 'No price bars came back for this range.',
  news: 'No headlines in this window.',
  earnings: 'No earnings dates in this window.',
}

/** `table` view: a DataTable with typed formatting per kind and column sort. */
export const TableView: FC<ViewProps> = ({ widget, frame }) => {
  const kind = widget.query.kind
  const [state, setState] = useState<{ kind: Kind; sort: SortSpec | undefined }>(() => ({ kind, sort: defaultSortFor(kind) }))
  const sort = state.kind === kind ? state.sort : defaultSortFor(kind)

  if (frame.rows.length === 0) {
    return <EmptyState title="No rows" hint={EMPTY_HINT[kind]} />
  }

  const onSort = (column: string) => {
    const next: SortSpec =
      sort && sort.column === column
        ? { column, dir: sort.dir === 'asc' ? 'desc' : 'asc' }
        : { column, dir: firstDir(frame.columns.find((c) => c.name === column)) }
    setState({ kind, sort: next })
  }

  return (
    <div data-view="table" style={{ width: '100%', height: '100%', overflow: 'auto' }}>
      <DataTable columns={frame.columns} rows={sortRows(frame, sort)} formats={formatsFor(kind, frame.columns)} sort={sort} onSort={onSort} />
    </div>
  )
}
