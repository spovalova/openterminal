import { useEffect, useMemo, useRef, useState, type FC } from 'react'
import clsx from 'clsx'
import { columnIndex, type Frame, type Kind, type StatControl } from '@terminal/core'
import { EMPTY_CELL, EmptyState, direction, formatCell, type CellFormat } from '@terminal/ui'
import type { ViewProps } from './types'
import { cellFormat } from './TableView'
import { controlOf, kindOf, primaryFrame } from './fields'
import { STAT_SECONDARY, columnLabel, formatsFor } from './legacy'

export { columnLabel }

export type Stat = {
  symbol: string
  /** The key column's value for this symbol. */
  value: number | null
  text: string
  /** The change line: a formatted secondary value, its direction when it is a signed move, and a label. */
  secondary: { text: string; dir: 'up' | 'down' | null; label?: string } | null
  /** quote only: the extended-hours price and move when the market is not in its regular session. */
  extended: { state: string; price: string; change: string; dir: 'up' | 'down' | null } | null
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * One stat per group, in frame order, from the first row of each group (the newest, for kinds with history such
 * as short_interest). `column` is the control's column; the line under the number is the control's `change`
 * column (or the kind's secondary column for a v1 kind), formatted by the field config.
 */
export function statRows(frame: Frame, kind: Kind | undefined, column: string, control?: Pick<StatControl, 'change' | 'format' | 'group'> & { formats?: Record<string, CellFormat> }): Stat[] {
  const group = control?.group ?? 'symbol'
  const iSym = columnIndex(frame, group)
  const iVal = columnIndex(frame, column)
  const formats: Record<string, CellFormat> = { ...(kind ? formatsFor(kind, frame.columns) : {}), ...(control?.formats ?? {}) }
  const format: CellFormat = control?.format ? cellFormat(control.format) : (formats[column] ?? 'price')
  const legacy = kind ? (STAT_SECONDARY as Partial<Record<Kind, { column: string; label?: string }>>)[kind] : undefined
  const secondary = control?.change ? { column: control.change } : legacy
  const iSec = secondary && secondary.column !== column ? columnIndex(frame, secondary.column) : -1
  // The extended-hours print: the v1 quote's `market_state`/`extended_*`, or yahoo's `marketState` with the pre- or
  // post-market price and move (a v2 quote widget has no kind; the columns say what the frame is).
  const iState = first(frame, ['market_state', 'marketState'])
  const iExt = first(frame, ['extended_price'])
  const iExtPct = first(frame, ['extended_change_pct'])
  const iPre = first(frame, ['preMarketPrice'])
  const iPrePct = first(frame, ['preMarketChangePercent'])
  const iPost = first(frame, ['postMarketPrice'])
  const iPostPct = first(frame, ['postMarketChangePercent'])

  const seen = new Set<string>()
  const out: Stat[] = []
  // A time series (a macro rate, a derived P/E) reads newest first: the stat is the latest value per group, whatever
  // order the rows arrived in. Frames without a time column keep their order (quotes, metrics, short interest newest first).
  const iTime = frame.columns.findIndex((c) => c.type === 'time')
  const ordered = iTime >= 0 ? [...frame.rows].sort((a, b) => (num(b[iTime]) ?? -Infinity) - (num(a[iTime]) ?? -Infinity)) : frame.rows
  for (const row of ordered) {
    const symbol = iSym >= 0 ? String(row[iSym] ?? '') : '*'
    if (seen.has(symbol)) continue
    seen.add(symbol)
    const value = iVal >= 0 ? num(row[iVal]) : null
    let sec: Stat['secondary'] = null
    if (iSec >= 0 && secondary) {
      const v = row[iSec]
      const f = formats[secondary.column] ?? (typeof v === 'number' && /pct|percent|change/i.test(secondary.column) ? 'change' : 'text')
      const text = formatCell(v, f)
      if (text !== EMPTY_CELL) sec = { text, dir: f === 'change' ? direction(v) : null, ...(secondary.label ? { label: secondary.label } : {}) }
    }
    let extended: Stat['extended'] = null
    if (iState >= 0) {
      const state = row[iState]
      if (typeof state === 'string' && state && state !== 'REGULAR') {
        const pre = /^PRE/.test(state)
        const iPrice = iExt >= 0 ? iExt : pre ? iPre : iPost
        const iPct = iExt >= 0 ? iExtPct : pre ? iPrePct : iPostPct
        const ext = iPrice >= 0 ? num(row[iPrice]) : null
        if (ext != null) {
          const pct = iPct >= 0 ? row[iPct] : null
          extended = { state: EXTENDED_LABEL[state] ?? state.toLowerCase(), price: formatCell(ext, 'price'), change: formatCell(pct, 'change'), dir: direction(pct) }
        }
      }
    }
    out.push({ symbol, value, text: value == null ? EMPTY_CELL : formatCell(value, format), secondary: sec, extended })
  }
  return out
}

function first(frame: Frame, names: readonly string[]): number {
  for (const n of names) {
    const i = columnIndex(frame, n)
    if (i >= 0) return i
  }
  return -1
}

/** Columns a single-symbol stat card shows under the headline, by name, first match per slot (the v1 quote and yahoo names). */
const DETAIL_SLOTS: { label: string; names: readonly string[]; format: CellFormat }[] = [
  { label: 'Prev close', names: ['prev_close', 'regularMarketPreviousClose', 'previous_close'], format: 'price' },
  { label: 'Open', names: ['open', 'regularMarketOpen'], format: 'price' },
  { label: 'Day high', names: ['high', 'regularMarketDayHigh', 'day_high'], format: 'price' },
  { label: 'Day low', names: ['low', 'regularMarketDayLow', 'day_low'], format: 'price' },
  { label: 'Volume', names: ['volume', 'regularMarketVolume'], format: 'compact' },
  { label: 'Mkt cap', names: ['market_cap', 'marketCap'], format: 'compact' },
  { label: '52w high', names: ['year_high', 'fiftyTwoWeekHigh'], format: 'price' },
  { label: '52w low', names: ['year_low', 'fiftyTwoWeekLow'], format: 'price' },
  { label: 'IV30 high', names: ['iv30_annual_high'], format: 'percent' },
  { label: 'IV30 low', names: ['iv30_annual_low'], format: 'percent' },
  { label: 'HV30 high', names: ['hv30_annual_high'], format: 'percent' },
  { label: 'HV30 low', names: ['hv30_annual_low'], format: 'percent' },
]

export type Detail = { label: string; text: string }

/**
 * For a stat over a time series (a macro rate, a derived P/E): where the series started in the frame's window, its
 * high and low, and the change from start to latest, so the headline has its range beside it. Empty for a frame
 * without a time column or with a single row.
 */
export function seriesDetails(frame: Frame, column: string, format: CellFormat): Detail[] {
  const iTime = frame.columns.findIndex((c) => c.type === 'time')
  const iVal = columnIndex(frame, column)
  if (iTime < 0 || iVal < 0) return []
  const points = frame.rows
    .map((r) => ({ t: num(r[iTime]), v: num(r[iVal]) }))
    .filter((p): p is { t: number; v: number } => p.t != null && p.v != null)
    .sort((a, b) => a.t - b.t)
  if (points.length < 2) return []
  const first = points[0]!.v
  const last = points[points.length - 1]!.v
  const high = Math.max(...points.map((p) => p.v))
  const low = Math.min(...points.map((p) => p.v))
  const change = last - first
  const changeText = format === 'percent' ? `${change > 0 ? '+' : ''}${(change * 100).toFixed(0)} bp` : first !== 0 ? formatCell((change / Math.abs(first)) * 100, 'change') : formatCell(change, format)
  return [
    { label: 'Start', text: formatCell(first, format) },
    { label: 'High', text: formatCell(high, format) },
    { label: 'Low', text: formatCell(low, format) },
    { label: 'Change', text: changeText },
  ]
}

/**
 * Up to six details for a single-symbol card (the first row): the known quote fields in slot order, then any other
 * annotated numeric column (label and format from the field config) so a transform's stat shows its companions too.
 */
export function detailRows(frame: Frame, column: string, change: string | undefined, fields: Record<string, { label?: string; format?: string; hidden?: boolean }> = {}, max = 6): Detail[] {
  const row = frame.rows[0]
  if (!row) return []
  const out: Detail[] = []
  const used = new Set<string>([column, ...(change ? [change] : [])])
  for (const slot of DETAIL_SLOTS) {
    if (out.length >= max) break
    const name = slot.names.find((n) => columnIndex(frame, n) >= 0 && !used.has(n))
    if (!name) continue
    const v = row[columnIndex(frame, name)]
    if (typeof v !== 'number' || !Number.isFinite(v)) continue
    used.add(name)
    out.push({ label: slot.label, text: formatCell(v, slot.format) })
  }
  for (const c of frame.columns) {
    if (out.length >= max) break
    if (c.type !== 'number' || used.has(c.name)) continue
    const f = fields[c.name]
    if (!f?.label || f.hidden) continue
    const v = row[columnIndex(frame, c.name)]
    if (typeof v !== 'number' || !Number.isFinite(v)) continue
    used.add(c.name)
    out.push({ label: f.label, text: formatCell(v, cellFormat((f.format as Parameters<typeof cellFormat>[0] | undefined) ?? 'price')) })
  }
  return out
}

/** The extended-hours print is the pre-market price before the open and the after-hours price after the close (and once the market is closed). */
const EXTENDED_LABEL: Record<string, string> = { PRE: 'pre-market', PREPRE: 'pre-market', POST: 'after hours', POSTPOST: 'after hours', CLOSED: 'after hours' }

type Tick = { n: number; dir: 'up' | 'down' }

/**
 * Remember each symbol's last value and, when a refreshed frame moves it, bump a counter with the
 * direction. The value element is keyed by the counter, so each move remounts it and replays the
 * one-shot highlight (styles.css `[data-tick]`); nothing animates while the number stands still.
 */
function useTicks(stats: Stat[]): Record<string, Tick> {
  const prev = useRef<Map<string, number | null>>(new Map())
  const [ticks, setTicks] = useState<Record<string, Tick>>({})
  useEffect(() => {
    const moved: { symbol: string; dir: 'up' | 'down' }[] = []
    for (const s of stats) {
      const before = prev.current.get(s.symbol)
      if (before != null && s.value != null && s.value !== before) moved.push({ symbol: s.symbol, dir: s.value > before ? 'up' : 'down' })
      prev.current.set(s.symbol, s.value)
    }
    if (moved.length > 0) {
      setTicks((t) => {
        const next = { ...t }
        for (const m of moved) next[m.symbol] = { n: (t[m.symbol]?.n ?? 0) + 1, dir: m.dir }
        return next
      })
    }
  }, [stats])
  return ticks
}

/**
 * `stat` preset: the control's column (the key field, else the first measure) as one big number per group, the
 * group as its label, and a change line under it (quote: the day change, plus the extended-hours price outside
 * the regular session). One group fills the widget; several become a row of compact cards.
 */
export const StatView: FC<ViewProps> = ({ widget, frames }) => {
  const kind = kindOf(widget)
  const control = controlOf(widget, frames)
  const stat = control?.kind === 'stat' ? control : undefined
  const frame = stat ? frames[stat.data] : primaryFrame(widget, frames)
  const column = stat?.column ?? ''
  const stats = useMemo(() => (frame && stat ? statRows(frame, kind, column, stat) : []), [frame, stat, kind, column])
  const ticks = useTicks(stats)

  if (stats.length === 0) {
    return <EmptyState title="No data" hint="The query returned no rows for these symbols." />
  }

  const label = stat?.label && stat.label !== column ? stat.label : columnLabel(column)
  if (stats.length === 1) {
    const s = stats[0]!
    // One symbol fills the card: the headline, then up to six companion figures (prev close, range, volume, cap),
    // so a quote or volatility stat reads like a quote card rather than one number in a blank cell (section 17 fill rule).
    const details = frame ? [...seriesDetails(frame, column, stat ? cellFormat(stat.format) : 'price'), ...detailRows(frame, column, stat?.change, frame.meta.fields ?? {})].slice(0, 6) : []
    return (
      <div data-view="stat" data-column={column} data-count={1} className="flex h-full w-full flex-col justify-center gap-4 overflow-hidden p-3">
        <div>
          <StatBody stat={s} label={label} tick={ticks[s.symbol]} hero />
        </div>
        {details.length > 0 && (
          <div data-details="" className="grid grid-cols-2 gap-x-4 gap-y-2 border-t border-border/60 pt-3 text-xs leading-5 @[420px]/widget:grid-cols-3">
            {details.map((d) => (
              <div key={d.label} className="flex min-w-0 items-baseline justify-between gap-2">
                <span className="truncate text-fg-3">{d.label}</span>
                <span className="num whitespace-nowrap text-fg-2">{d.text}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }
  return (
    <div data-view="stat" data-column={column} data-count={stats.length} className="stat-cards h-full w-full overflow-x-hidden overflow-y-auto p-3">
      {stats.map((s) => (
        <div key={s.symbol} data-symbol={s.symbol} className="flex min-w-0 flex-col justify-center overflow-hidden rounded-md border border-border bg-surface-2/50 px-3 py-2.5">
          <StatBody stat={s} label={label} tick={ticks[s.symbol]} />
        </div>
      ))}
    </div>
  )
}

const dirClass = (dir: 'up' | 'down' | null) => (dir === 'up' ? 'text-up' : dir === 'down' ? 'text-down' : 'text-fg-2')

/** The extended-hours label in a compact card: two or three characters so the price and move stay on one line. */
const EXTENDED_SHORT: Record<string, string> = { 'pre-market': 'pre', 'after hours': 'AH' }

const StatBody: FC<{ stat: Stat; label: string; tick: Tick | undefined; hero?: boolean }> = ({ stat, label, tick, hero }) => (
  <>
    {/* `shrink-0`: in a short card the label and the number never give way to the change line (overflow-hidden flex items otherwise shrink to nothing). */}
    <div className={clsx('flex min-w-0 shrink-0 items-baseline gap-1.5 truncate text-xs leading-4 text-fg-3', hero && 'mb-1')}>
      {stat.symbol !== '*' && (
        <span data-field="symbol" className="num font-semibold text-fg">
          {stat.symbol}
        </span>
      )}
      <span className="truncate">{label}</span>
    </div>
    <div className="min-w-0 shrink-0 truncate">
      <span
        key={tick?.n ?? 0}
        data-field="value"
        data-tick={tick?.dir}
        className={clsx('num -mx-1 inline-block rounded-sm px-1 font-semibold', stat.value == null ? 'text-fg-3' : 'text-fg', hero ? 'stat-hero' : 'stat-card-value')}
      >
        {stat.text}
      </span>
    </div>
    {(stat.secondary || stat.extended) && (
      <div className={clsx('flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 leading-4', hero ? 'mt-1 text-sm' : 'text-xs')}>
        {stat.secondary && (
          <span data-field="secondary" className={clsx('num whitespace-nowrap', dirClass(stat.secondary.dir))}>
            {stat.secondary.text}
            {stat.secondary.label && <span className="ml-1 font-sans text-fg-3">{stat.secondary.label}</span>}
          </span>
        )}
        {stat.extended && (
          <span data-field="extended" className="text-fg-3">
            {hero ? stat.extended.state : (EXTENDED_SHORT[stat.extended.state] ?? stat.extended.state)}{' '}
            <span className="whitespace-nowrap">
              <span className="num text-fg-2">{stat.extended.price}</span> <span className={clsx('num', dirClass(stat.extended.dir))}>{stat.extended.change}</span>
            </span>
          </span>
        )}
      </div>
    )}
  </>
)
