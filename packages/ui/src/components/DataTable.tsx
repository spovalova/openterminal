import { useMemo, useState, type FC } from 'react'
import clsx from 'clsx'
import type { Column } from '@terminal/core'
import { direction, formatCell, inferFormats, isNumericFormat, sortRows, type CellFormat, type SortDir } from '../format.js'
import { ExternalIcon } from './icons.js'

export type DataTableProps = {
  columns: Column[]
  rows: unknown[][]
  /** Per-column formats by name. Columns not listed fall back to `inferFormats`. */
  formats?: Record<string, CellFormat>
  /** Controlled sort. When omitted the table keeps its own sort state. */
  sort?: { column: string; dir: SortDir }
  onSort?: (column: string) => void
  /** Column header labels by name; defaults to the name with underscores as spaces. */
  labels?: Record<string, string>
  /**
   * Column priority by name: 0 always shows, higher ranks need a wider container (see `[data-rank]`
   * in styles.css, driven by the `widget` container query). Columns not listed are rank 0.
   */
  priority?: Record<string, number>
  /** Sticky header; the table scrolls inside its container. Default true. */
  stickyHeader?: boolean
  className?: string
  /** Reference instant for `time` formatting (defaults to now at render). */
  now?: number
}

/** Strings longer than this are capped at 64ch with an ellipsis and a title tooltip. */
const LONG_TEXT = 80

/**
 * Fixed column widths per format, in px, for `table-layout: fixed`: numbers and dates take a known
 * width and text columns share what is left, so a headline or a name gets the room and nothing scrolls
 * sideways. `symbol` is text but short.
 */
const COLUMN_WIDTH: Partial<Record<CellFormat, number>> = { price: 76, change: 72, integer: 84, compact: 76, percent: 68, date: 88, time: 80, link: 56 }
const SYMBOL_WIDTH = 72

export function columnWidth(name: string, format: CellFormat): number | undefined {
  if (name === 'symbol' || name === 'etf') return SYMBOL_WIDTH
  return COLUMN_WIDTH[format]
}

function label(name: string, labels?: Record<string, string>): string {
  return labels?.[name] ?? name.replace(/_/g, ' ')
}

/**
 * Dense typed table. Sorting: click a header to sort ascending, again for
 * descending. The table sorts its rows itself from `sort` (controlled) or its
 * own state; `onSort(column)` is called on every header click either way.
 */
export const DataTable: FC<DataTableProps> = ({ columns, rows, formats, sort, onSort, labels, priority, stickyHeader = true, className, now }) => {
  const [internal, setInternal] = useState<{ column: string; dir: SortDir } | undefined>(undefined)
  const active = sort ?? internal
  const fmts = useMemo(() => ({ ...inferFormats(columns), ...formats }), [columns, formats])
  const nowMs = now ?? Date.now()

  const sorted = useMemo(() => {
    if (!active) return rows
    const idx = columns.findIndex((c) => c.name === active.column)
    return idx < 0 ? rows : sortRows(rows, idx, active.dir)
  }, [rows, columns, active])

  const click = (name: string) => {
    if (!sort) {
      setInternal((cur) => (cur?.column === name ? (cur.dir === 'asc' ? { column: name, dir: 'desc' } : undefined) : { column: name, dir: 'asc' }))
    }
    onSort?.(name)
  }

  return (
    <div className={clsx('data-table h-full w-full overflow-x-hidden overflow-y-auto', className)}>
      <table className="w-full table-fixed border-collapse text-sm">
        <thead className={clsx(stickyHeader && 'sticky top-0 z-10')}>
          <tr className="bg-surface">
            {columns.map((c) => {
              const f = fmts[c.name] ?? 'text'
              const numeric = isNumericFormat(f)
              const isActive = active?.column === c.name
              const width = columnWidth(c.name, f)
              return (
                <th
                  key={c.name}
                  scope="col"
                  aria-sort={isActive ? (active.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                  data-rank={priority?.[c.name] || undefined}
                  style={width ? { width } : undefined}
                  className={clsx('h-7 border-b border-border px-2 text-xs font-medium whitespace-nowrap select-none', numeric ? 'text-right' : 'text-left')}
                >
                  <button
                    type="button"
                    onClick={() => click(c.name)}
                    className={clsx(
                      'inline-flex max-w-full items-center gap-1 rounded-sm hover:text-fg',
                      numeric && 'flex-row-reverse',
                      isActive ? 'text-fg' : 'text-fg-3',
                    )}
                  >
                    <span className="truncate">{label(c.name, labels)}</span>
                    <span aria-hidden className={clsx('text-[9px] leading-none', isActive ? 'text-accent' : 'opacity-0')}>
                      {active?.dir === 'desc' && isActive ? '▼' : '▲'}
                    </span>
                  </button>
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row, ri) => (
            <tr key={ri} className="hover:bg-surface-2">
              {columns.map((c, ci) => {
                const f = fmts[c.name] ?? 'text'
                const v = row[ci]
                const text = formatCell(v, f, nowMs)
                const dir = f === 'change' ? direction(v) : null
                const numeric = isNumericFormat(f)
                // Numbers, dates, times and tickers are set in the mono stack (the `num` utility); prose stays sans.
                const mono = numeric || f === 'date' || f === 'time' || c.name === 'symbol' || c.name === 'etf'
                let content: React.ReactNode = text
                if (f === 'text' && typeof v === 'string' && v.length > LONG_TEXT) {
                  // max-width is ignored on table cells, so a paragraph (profile.description, a calendar event) is capped inside a block
                  content = (
                    <span className="block max-w-[64ch] truncate" title={v}>
                      {text}
                    </span>
                  )
                }
                if (f === 'link' && typeof v === 'string' && v !== '') {
                  content = (
                    <a
                      href={v}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-accent hover:underline"
                    >
                      {text}
                      <ExternalIcon size={11} />
                    </a>
                  )
                }
                return (
                  <td
                    key={c.name}
                    data-rank={priority?.[c.name] || undefined}
                    className={clsx(
                      'h-7 truncate border-b border-border/60 px-2 whitespace-nowrap',
                      numeric ? 'text-right' : 'text-left',
                      mono && 'num',
                      dir === 'up' && 'text-up',
                      dir === 'down' && 'text-down',
                      text === '—' && 'text-fg-3',
                      c.name === 'symbol' && 'font-medium text-fg',
                    )}
                    title={typeof v === 'string' && v.length > 12 ? v : undefined}
                  >
                    {content}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
