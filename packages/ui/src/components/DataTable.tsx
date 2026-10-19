import { useCallback, useMemo, useState, type FC } from 'react'
import clsx from 'clsx'
import { enumLabel, fieldLabel, type Column } from '@terminal/core'
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
  /** Best and worst marks per cell (compare tables): a 2px up or down bar on the cell's left edge and bold weight. */
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

/** A header in sentence case from its display name (taste round, change 5): an annotated label, else `fieldLabel`, never the raw name. */
export function label(name: string, labels?: Record<string, string>): string {
  const given = labels?.[name]
  if (given) return /^[a-z]/.test(given) && !/[A-Z]/.test(given) ? given.charAt(0).toUpperCase() + given.slice(1) : given
  return fieldLabel(name)
}

/** What a format adds to a header that would otherwise repeat its neighbour's ("Entry" twice becomes "Entry date", "Entry price"). */
const QUALIFIER: Partial<Record<CellFormat, string>> = { date: 'date', time: 'time', price: 'price', percent: '%', change: '%', integer: 'count', compact: 'value' }

/** Header labels for the visible columns with duplicates told apart by their format. */
export function headerLabels(columns: readonly Column[], fmts: Record<string, CellFormat>, labels?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  const seen = new Map<string, number>()
  for (const c of columns) {
    const l = label(c.name, labels)
    out[c.name] = l
    seen.set(l.toLowerCase(), (seen.get(l.toLowerCase()) ?? 0) + 1)
  }
  for (const c of columns) {
    const l = out[c.name]!
    if ((seen.get(l.toLowerCase()) ?? 0) < 2) continue
    const q = QUALIFIER[fmts[c.name] ?? 'text']
    if (q && !l.toLowerCase().endsWith(q)) out[c.name] = `${l} ${q}`
  }
  return out
}

/**
 * One number format per column (change 5): a compact column whose values all sit under a million prints them
 * grouped ("2,310", "619.40"), so "1.94K" never stands beside "2,310"; compact is for millions and billions.
 */
export function uniformFormats(columns: readonly Column[], rows: readonly unknown[][], fmts: Record<string, CellFormat>): Record<string, CellFormat> {
  const out = { ...fmts }
  columns.forEach((c, i) => {
    if (out[c.name] !== 'compact') return
    let max = 0
    let whole = true
    for (const row of rows) {
      const v = row[i]
      if (typeof v !== 'number' || !Number.isFinite(v)) continue
      max = Math.max(max, Math.abs(v))
      if (!Number.isInteger(v)) whole = false
    }
    if (max < 1e6) out[c.name] = whole ? 'integer' : 'price'
  })
  return out
}

/**
 * Content widths for fixed-format columns: the longest formatted value in the mono face plus padding, at least the
 * header's longest word and at most the format's fixed width, so "5.46" does not sit in an 84px column.
 */
export function numberWidths(columns: readonly Column[], rows: readonly unknown[][], fmts: Record<string, CellFormat>, headers: Record<string, string>, now: number): Record<string, number> {
  const out: Record<string, number> = {}
  columns.forEach((c, i) => {
    const f = fmts[c.name] ?? 'text'
    const fixed = columnWidth(c.name, f, headers[c.name])
    if (fixed === undefined || f === 'link') return
    let longest = 0
    for (const row of rows) longest = Math.max(longest, formatCell(row[i], f, now).length)
    const head = headers[c.name] ?? ''
    const word = Math.max(...head.split(/\s+/).map((w) => w.length)) * 7.4 + 30
    // The header on one line when that costs at most 128px ("Op cash flow", "EPS est."), else wrapped at words.
    const line = head.length * 7 + 30
    const content = longest * MONO_CHAR + 20
    out[c.name] = Math.round(Math.max(word, Math.min(Math.max(fixed, 128), Math.max(line, content), Math.max(fixed, line <= 128 ? line : 0, content))))
  })
  return out
}

/**
 * A string cell as people read it (taste round, change 11): an enum by its reading ("after-hours" is "After the
 * close", "not-supplied" an em dash, "strong_buy" "Strong buy"), and a list of tickers capped at three plus "+n".
 */
export function displayText(v: string): string {
  const tickers = v.split(/\s*,\s*/)
  if (tickers.length > 3 && tickers.every((t) => /^[A-Z0-9.^-]{1,8}$/.test(t))) return `${tickers.slice(0, 3).join(', ')} +${tickers.length - 3}`
  if (v === '') return '—'
  return enumLabel(v)
}

/** Average glyph width at the table's 14px: the sans face for names, the mono face for tickers. */
const SANS_CHAR = 7.4
const MONO_CHAR = 8.4
/** A text column whose longest value is under this many characters is sized to it; longer text (headlines) shares what is left. */
const SHORT_TEXT = 48
const TEXT_COLUMN_MAX = 360

/**
 * Content widths for short text columns (names, pairs, metrics, sessions): the longest value or header plus the
 * cell padding, capped. Columns are then left-packed and a filler column takes the rest of the row, so a two-column
 * table never puts 900px between a pair and its value (change 5). Prose columns are left flexible.
 */
export function textWidths(columns: readonly Column[], rows: readonly unknown[][], fmts: Record<string, CellFormat>, headers: Record<string, string>): Record<string, number> {
  const out: Record<string, number> = {}
  columns.forEach((c, i) => {
    const f = fmts[c.name] ?? 'text'
    if (f !== 'text' || c.name === 'symbol' || c.name === 'etf') return
    let longest = 0
    for (const row of rows) {
      const v = row[i]
      if (v == null) continue
      longest = Math.max(longest, String(v).length)
      if (longest > SHORT_TEXT) return
    }
    const mono = /^(symbol|ticker|pair|etf)$/i.test(c.name)
    const header = (headers[c.name] ?? c.name).length * 7 + 32
    out[c.name] = Math.min(TEXT_COLUMN_MAX, Math.max(header, Math.ceil(longest * (mono ? MONO_CHAR : SANS_CHAR)) + 24))
  })
  return out
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
export function columnsThatFit(columns: readonly Column[], width: number | undefined, fmts: Record<string, CellFormat>, priority?: Record<string, number>, labels?: Record<string, string>, sized?: Record<string, number>): Column[] {
  if (!width || width <= 0) return [...columns]
  const need = (c: Column) => sized?.[c.name] ?? columnWidth(c.name, fmts[c.name] ?? 'text', label(c.name, labels)) ?? TEXT_COLUMN_MIN
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
  const fmts = useMemo(() => uniformFormats(columns, rows, { ...inferFormats(columns), ...formats }), [columns, rows, formats])
  const nowMs = now ?? Date.now()
  const [width, setWidth] = useState<number | undefined>(undefined)
  const wrap = useCallback((el: HTMLDivElement | null) => {
    if (!el || typeof ResizeObserver === 'undefined') return
    const update = () => setWidth(el.clientWidth)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
  }, [])
  const allHeaders = useMemo(() => headerLabels(columns, fmts, labels), [columns, fmts, labels])
  // Every column at its content width (change 5): numbers at their longest formatted value, short text at its longest value.
  const sized = useMemo(() => ({ ...numberWidths(columns, rows, fmts, allHeaders, nowMs), ...textWidths(columns, rows, fmts, allHeaders) }), [columns, rows, fmts, allHeaders, nowMs])
  const visible = useMemo(() => columnsThatFit(columns, width, fmts, priority, labels, sized), [columns, width, fmts, priority, labels, sized])
  const indexOf = useMemo(() => new Map(columns.map((c, i) => [c.name, i])), [columns])
  const headers = useMemo(() => headerLabels(visible, fmts, labels), [visible, fmts, labels])
  // Left-pack (change 5): when every column has a width (fixed formats and short text sized to content) and they fit,
  // a filler column takes the rest; otherwise prose columns share the remainder as before.
  const widths = useMemo(() => {
    const text = textWidths(columns, rows, fmts, headers)
    const nums = numberWidths(columns, rows, fmts, headers, nowMs)
    const out: Record<string, number | undefined> = {}
    for (const c of visible) out[c.name] = nums[c.name] ?? columnWidth(c.name, fmts[c.name] ?? 'text', headers[c.name]) ?? text[c.name]
    const all = visible.every((c) => out[c.name] !== undefined)
    const sum = visible.reduce((n, c) => n + (out[c.name] ?? 0), 0)
    const fits = width === undefined || sum <= width
    // Short text keeps its content width only when every column is sized and the row fits; otherwise text shares the rest.
    if (!all || !fits) for (const c of visible) if (text[c.name] !== undefined && (fmts[c.name] ?? 'text') === 'text') out[c.name] = undefined
    return { of: out, filler: all && width !== undefined && sum < width }
  }, [columns, rows, fmts, headers, visible, width, nowMs])

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
              const width = widths.of[c.name]
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
                    <span className="line-clamp-2 min-w-0 flex-1 break-normal whitespace-normal">{headers[c.name]}</span>
                    <span aria-hidden className={clsx('text-[9px] leading-none', isActive ? 'text-accent' : 'opacity-0')}>
                      {active?.dir === 'desc' && isActive ? '▼' : '▲'}
                    </span>
                  </button>
                </th>
              )
            })}
            {widths.filler && <th aria-hidden data-filler="" className="border-b border-border p-0" />}
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
                const text = f === 'text' && typeof v === 'string' && c.name !== 'symbol' && c.name !== 'etf' ? displayText(v) : formatCell(v, f, nowMs)
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
                      // Every cell is vertically centred (change 5): a two-line name or a session label sits on the row's middle.
                      prose ? 'min-h-7 py-1 align-middle leading-4 whitespace-normal' : 'h-7 truncate align-middle whitespace-nowrap',
                      numeric ? 'text-right' : 'text-left',
                      mono && 'num',
                      dir === 'up' && 'text-up',
                      dir === 'down' && 'text-down',
                      text === '—' && 'text-fg-3',
                      c.name === 'symbol' && 'font-medium text-fg',
                      // Best and worst as a 2px bar on the cell's left edge and bold weight, never a fill under coloured text (change 6).
                      mark === 'best' && 'font-semibold shadow-[inset_2px_0_0_0_var(--color-up)]',
                      mark === 'worst' && 'font-semibold shadow-[inset_2px_0_0_0_var(--color-down)]',
                    )}
                    title={typeof v === 'string' && v.length > 12 ? v : undefined}
                  >
                    {content}
                  </td>
                )
              })}
              {widths.filler && <td aria-hidden data-filler="" className="border-b border-border/60 p-0" />}
            </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
