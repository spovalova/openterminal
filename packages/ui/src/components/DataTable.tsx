import { useCallback, useMemo, useState, type FC } from 'react'
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
  /** The row to highlight (the table control's `highlight`): an accent wash and `data-highlight`. */
  highlightRow?: (row: unknown[]) => boolean
  /** Best and worst marks per cell (compare tables): a faint up or down wash under the cell's own colour. */
  cellMark?: (row: unknown[], column: string) => 'best' | 'worst' | undefined
}

/** Strings longer than this are capped at 64ch with an ellipsis and a title tooltip. */
const LONG_TEXT = 80

/**
 * Fixed column widths per format, in px, for `table-layout: fixed`: numbers and dates take a known
 * width and text columns share what is left, so a headline or a name gets the room and nothing scrolls
 * sideways. `symbol` is text but short.
 */
// A YYYY-MM-DD in the mono stack at the table's size is 84px plus the cell padding, so date and time take 104
// (the bench v2 "2026-10…" defect); the number widths leave room for a two-word header.
const COLUMN_WIDTH: Partial<Record<CellFormat, number>> = { price: 84, change: 96, integer: 88, compact: 80, percent: 88, date: 104, time: 104, link: 112 }
const SYMBOL_WIDTH = 72

export function columnWidth(name: string, format: CellFormat, header?: string): number | undefined {
  const base = name === 'symbol' || name === 'etf' ? SYMBOL_WIDTH : COLUMN_WIDTH[format]
  if (base === undefined) return undefined
  // A fixed column is at least as wide as its header's longest word plus the sort arrow and padding, so "Correlation"
  // and "Peak weekly close" are never broken mid-word or pushed past the cell. Measured in the browser: "weekly" is
  // 64px in the header's 12px medium face, about 11px a character.
  const longest = header ? Math.max(...header.split(/\s+/).map((w) => w.length)) : 0
  return Math.max(base, longest * 11 + 32)
}

function label(name: string, labels?: Record<string, string>): string {
  return labels?.[name] ?? name.replace(/_/g, ' ')
}

/**
 * Dense typed table. Sorting: click a header to sort ascending, again for
 * descending. The table sorts its rows itself from `sort` (controlled) or its
 * own state; `onSort(column)` is called on every header click either way.
 */
/** What a text column needs before the fixed ones take the rest (a headline, a name). */
const TEXT_COLUMN_MIN = 120

/**
 * The columns that fit a container of `width` px: every column when the width is unknown (server rendering, tests),
 * else the lowest-priority columns are dropped, highest rank first, until the fixed widths plus a minimum per text
 * column fit. The container queries in styles.css approximate this per rank; the measurement is exact, so a
 * `table-layout: fixed` table never has its columns shrunk below their widths (which cut a six-letter header in two).
 */
export function columnsThatFit(columns: readonly Column[], width: number | undefined, fmts: Record<string, CellFormat>, priority?: Record<string, number>, labels?: Record<string, string>): Column[] {
  if (!width || width <= 0) return [...columns]
  const need = (c: Column) => columnWidth(c.name, fmts[c.name] ?? 'text', label(c.name, labels)) ?? TEXT_COLUMN_MIN
  const total = (cols: readonly Column[]) => cols.reduce((n, c) => n + need(c), 0)
  const visible = [...columns]
  while (visible.length > 1 && total(visible) > width) {
    // The highest rank goes first; among equal ranks the last column in display order.
    let drop = -1
    let rank = -1
    visible.forEach((c, i) => {
      const r = priority?.[c.name] ?? 0
      if (r >= rank) {
        rank = r
        drop = i
      }
    })
    if (rank <= 0) break // only rank-0 columns left: they always show, the table scrolls rather than loses them
    visible.splice(drop, 1)
  }
  return visible
}

export const DataTable: FC<DataTableProps> = ({ columns, rows, formats, sort, onSort, labels, priority, stickyHeader = true, className, now, highlightRow, cellMark }) => {
  const [internal, setInternal] = useState<{ column: string; dir: SortDir } | undefined>(undefined)
  const active = sort ?? internal
  const fmts = useMemo(() => ({ ...inferFormats(columns), ...formats }), [columns, formats])
  const nowMs = now ?? Date.now()
  const [width, setWidth] = useState<number | undefined>(undefined)
  const wrap = useCallback((el: HTMLDivElement | null) => {
    if (!el || typeof ResizeObserver === 'undefined') return
    const update = () => setWidth(el.clientWidth)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
  }, [])
  const visible = useMemo(() => columnsThatFit(columns, width, fmts, priority, labels), [columns, width, fmts, priority, labels])
  const indexOf = useMemo(() => new Map(columns.map((c, i) => [c.name, i])), [columns])

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
    <div ref={wrap} className={clsx('data-table h-full w-full overflow-x-hidden overflow-y-auto', className)}>
      {/* `h-full`: a table shorter than its cell shares the height between its rows (an 11-row hero in a two-row cell, a
          4-row table in a tall 1920 row) instead of leaving the bottom blank; a longer table scrolls as before. */}
      <table className="h-full w-full table-fixed border-collapse text-sm">
        <thead className={clsx(stickyHeader && 'sticky top-0 z-10')}>
          <tr className="bg-surface">
            {visible.map((c) => {
              const f = fmts[c.name] ?? 'text'
              const numeric = isNumericFormat(f)
              const isActive = active?.column === c.name
              const width = columnWidth(c.name, f, label(c.name, labels))
              return (
                <th
                  key={c.name}
                  scope="col"
                  aria-sort={isActive ? (active.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                  data-rank={priority?.[c.name] || undefined}
                  style={width ? { width } : undefined}
                  className={clsx('min-h-7 border-b border-border px-2 py-1 align-bottom text-xs leading-4 font-medium select-none', numeric ? 'text-right' : 'text-left')}
                >
                  <button
                    type="button"
                    onClick={() => click(c.name)}
                    className={clsx(
                      'inline-flex max-w-full items-end gap-1 rounded-sm text-left hover:text-fg',
                      numeric && 'flex-row-reverse text-right',
                      isActive ? 'text-fg' : 'text-fg-3',
                    )}
                  >
                    {/* Two lines at most, wrapped at words: a header is never cut mid-word (section 17 checklist). */}
                    <span className="line-clamp-2 min-w-0 flex-1 break-normal whitespace-normal">{label(c.name, labels)}</span>
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
          {sorted.map((row, ri) => {
            const highlighted = highlightRow?.(row) ?? false
            return (
            <tr key={ri} data-highlight={highlighted ? '' : undefined} className={clsx('hover:bg-surface-2', highlighted && 'bg-accent/10 hover:bg-accent/15')}>
              {visible.map((c) => {
                const f = fmts[c.name] ?? 'text'
                const v = row[indexOf.get(c.name)!]
                const text = formatCell(v, f, nowMs)
                const dir = f === 'change' ? direction(v) : null
                const mark = cellMark?.(row, c.name)
                const numeric = isNumericFormat(f)
                // Numbers, dates, times and tickers are set in the mono stack (the `num` utility); prose stays sans.
                const mono = numeric || f === 'date' || f === 'time' || c.name === 'symbol' || c.name === 'etf'
                let content: React.ReactNode = text
                const prose = f === 'text' && typeof v === 'string' && c.name !== 'symbol' && c.name !== 'etf'
                if (prose && v.length > 12) {
                  // Prose wraps to two lines at word boundaries instead of truncating mid-word (section 17 checklist); a
                  // paragraph (profile.description, a calendar event) is still capped at 64ch per line with the full text on hover.
                  content = (
                    <span className={clsx('line-clamp-2 break-words whitespace-normal', v.length > LONG_TEXT && 'max-w-[64ch]')} title={v}>
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
                    data-mark={mark}
                    className={clsx(
                      'border-b border-border/60 px-2',
                      prose ? 'min-h-7 py-1 align-top leading-4 whitespace-normal' : 'h-7 truncate whitespace-nowrap',
                      numeric ? 'text-right' : 'text-left',
                      mono && 'num',
                      dir === 'up' && 'text-up',
                      dir === 'down' && 'text-down',
                      text === '—' && 'text-fg-3',
                      c.name === 'symbol' && 'font-medium text-fg',
                      mark === 'best' && 'bg-up/15 font-semibold',
                      mark === 'worst' && 'bg-down/15 font-semibold',
                    )}
                    title={typeof v === 'string' && v.length > 12 ? v : undefined}
                  >
                    {content}
                  </td>
                )
              })}
            </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
