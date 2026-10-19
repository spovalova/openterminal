import { useLayoutEffect, useMemo, useRef, useState, type FC } from 'react'
import clsx from 'clsx'
import { columnWidth, direction, formatCell, inferFormats, isNumericFormat, sortRows, type DataTableProps } from '@openterminal/ui'

export type VirtualTableProps = DataTableProps & {
  /** Fixed row height in px (the DataTable's `h-7` rows are 28px). */
  rowHeight?: number
  /** Rows rendered above and below the viewport. */
  overscan?: number
  /** Below this many rows the whole body renders (no windowing). */
  threshold?: number
  /** Test and SSR hook: the viewport height when the container cannot be measured. */
  viewportHeight?: number
}

const LONG_TEXT = 80

function label(name: string, labels?: Record<string, string>): string {
  return labels?.[name] ?? name.replace(/_/g, ' ')
}

/**
 * The DataTable's API with row virtualisation (PLAN.md section 17, "Virtualised tables"): screener and transform
 * outputs in the thousands of rows render a window of rows plus two spacer rows, so the sticky header, the fixed
 * column widths and the priority ranks behave exactly as in `DataTable`. (d)'s table view can adopt it through a
 * prop or by swapping the import; the props are a superset of `DataTableProps`.
 */
export const VirtualTable: FC<VirtualTableProps> = ({
  columns,
  rows,
  formats,
  sort,
  onSort,
  labels,
  priority,
  stickyHeader = true,
  className,
  now,
  rowHeight = 28,
  overscan = 8,
  threshold = 150,
  viewportHeight,
}) => {
  const [internal, setInternal] = useState<{ column: string; dir: 'asc' | 'desc' } | undefined>(undefined)
  const active = sort ?? internal
  const fmts = useMemo(() => ({ ...inferFormats(columns), ...formats }), [columns, formats])
  const nowMs = now ?? Date.now()
  const ref = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [height, setHeight] = useState(viewportHeight ?? 0)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => setHeight(el.clientHeight || viewportHeight || 0)
    update()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [viewportHeight])

  const sorted = useMemo(() => {
    if (!active) return rows
    const idx = columns.findIndex((c) => c.name === active.column)
    return idx < 0 ? rows : sortRows(rows, idx, active.dir)
  }, [rows, columns, active])

  const click = (name: string) => {
    if (!sort) setInternal((cur) => (cur?.column === name ? (cur.dir === 'asc' ? { column: name, dir: 'desc' } : undefined) : { column: name, dir: 'asc' }))
    onSort?.(name)
  }

  const virtual = sorted.length > threshold
  const visible = virtual ? Math.max(1, Math.ceil((height || rowHeight * 20) / rowHeight)) : sorted.length
  const start = virtual ? Math.max(0, Math.floor(scrollTop / rowHeight) - overscan) : 0
  const end = virtual ? Math.min(sorted.length, start + visible + overscan * 2) : sorted.length
  const topPad = start * rowHeight
  const bottomPad = (sorted.length - end) * rowHeight

  return (
    <div
      ref={ref}
      data-virtual-table=""
      data-virtual={virtual ? '' : undefined}
      data-rendered={end - start}
      className={clsx('data-table h-full w-full overflow-x-hidden overflow-y-auto', className)}
      onScroll={(e) => {
        if (virtual) setScrollTop((e.target as HTMLDivElement).scrollTop)
      }}
    >
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
                  <button type="button" onClick={() => click(c.name)} className={clsx('inline-flex max-w-full items-center gap-1 rounded-sm hover:text-fg', numeric && 'flex-row-reverse', isActive ? 'text-fg' : 'text-fg-3')}>
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
          {topPad > 0 && (
            <tr aria-hidden data-spacer="top">
              <td colSpan={columns.length} style={{ height: topPad, padding: 0, border: 0 }} />
            </tr>
          )}
          {sorted.slice(start, end).map((row, i) => (
            <tr key={start + i} className="hover:bg-surface-2" style={virtual ? { height: rowHeight } : undefined}>
              {columns.map((c, ci) => {
                const f = fmts[c.name] ?? 'text'
                const v = row[ci]
                const text = formatCell(v, f, nowMs)
                const dir = f === 'change' ? direction(v) : null
                const numeric = isNumericFormat(f)
                const mono = numeric || f === 'date' || f === 'time' || c.name === 'symbol' || c.name === 'etf'
                let content: React.ReactNode = text
                if (f === 'text' && typeof v === 'string' && v.length > LONG_TEXT) {
                  content = (
                    <span className="block max-w-[64ch] truncate" title={v}>
                      {text}
                    </span>
                  )
                }
                if (f === 'link' && typeof v === 'string' && v !== '') {
                  content = (
                    <a href={v} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
                      {text}
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
          {bottomPad > 0 && (
            <tr aria-hidden data-spacer="bottom">
              <td colSpan={columns.length} style={{ height: bottomPad, padding: 0, border: 0 }} />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
