import { useCallback, useEffect, useMemo, useRef, useState, type FC } from 'react'
import clsx from 'clsx'
import { DENSE_LINE_HEIGHT, STAT_CARD_HEIGHT, cardsPerRow, columnIndex, denseStat, type Frame, type StatControl } from '@openterminal/core'
import { EMPTY_CELL, EmptyState, direction, formatCell, type CellFormat } from '@openterminal/ui'
import type { ViewProps } from './types'
import { cellFormat } from './TableView'
import { controlOf, primaryFrame } from './fields'
import { columnLabel } from './labels'
import { FieldGrid } from './FieldGrid'

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

/** Headline columns whose change has no good or bad side: implied and realized volatility, rates and yields, oscillators. */
export const NEUTRAL_READING = /(^|_)(iv|iv30|iv_rank|hv|hv30|vol|volatility|rate|yield|rsi|macd|spread)(_|$)|^(iv|hv)\d/i

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * One stat per group, in frame order, from the newest row of each group (a time series reads newest first; frames
 * without a time column keep their order). `column` is the control's column; the line under the number is the
 * control's `change` column, formatted by the field config.
 */
export function statRows(frame: Frame, column: string, control?: Pick<StatControl, 'change' | 'format' | 'group'> & { formats?: Record<string, CellFormat> }): Stat[] {
  const group = control?.group ?? 'symbol'
  const iSym = columnIndex(frame, group)
  const iVal = columnIndex(frame, column)
  const formats: Record<string, CellFormat> = { ...(control?.formats ?? {}) }
  const format: CellFormat = control?.format ? cellFormat(control.format) : (formats[column] ?? 'price')
  const secondary = control?.change ? { column: control.change, label: undefined as string | undefined } : undefined
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
      // A reading that is not a price (IV, a rate, an oscillator) moves without a side: its change is neutral (round 2,
      // change 4: falling IV under the volatility hero read as a red loss).
      if (text !== EMPTY_CELL) sec = { text, dir: f === 'change' && !NEUTRAL_READING.test(column) ? direction(v) : null, ...(secondary.label ? { label: secondary.label } : {}) }
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

/** A bar's or a quote's own fields, by name: what a non-price stat (IV30, RSI) must not borrow as companions. */
const QUOTE_FIELD = /^(open|high|low|close|adj_close|volume|vwap|bid|ask|bid_size|ask_size|last|last_price|price|change|change_percent|prev_close|previous_close)$/i

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
 * The price slots (prev close, the day's range, 52-week range) stand only under a price: under IV30 the card carries
 * the IV and HV ranges, under an RSI or MACD reading the series' own start, high and low, never "Open 551.97".
 * `headline` is the stat's own format when the field config has no unit (the volatility recipe's `iv30`).
 */
export function detailRows(frame: Frame, column: string, change: string | undefined, fields: Record<string, { label?: string; format?: string; hidden?: boolean; unit?: string }> = {}, max = 6, headline?: CellFormat): Detail[] {
  // Over a time series the companions come from the newest row, like the headline ("Close 145.89" from two years ago
  // sat under today's P/E).
  const it = frame.columns.findIndex((c) => c.type === 'time')
  const row = it < 0 ? frame.rows[0] : frame.rows.reduce<unknown[] | undefined>((best, r) => (best === undefined || (r[it] as number) > (best[it] as number) ? r : best), undefined)
  if (!row) return []
  const unit = fields[column]?.unit
  const headlineFormat: CellFormat = unit === 'percent' || unit === 'fraction' || headline === 'percent' ? 'percent' : unit === 'shares' || unit === 'count' ? 'compact' : 'price'
  // The test the stat control uses for its change line (core presets): a price, a close, a last, a level, a dollar field.
  const priceHeadline = headlineFormat === 'price' && (/price|close|last|value|rate|nav$/i.test(column) || unit === 'usd')
  const out: (Detail & { slot?: CellFormat })[] = []
  const used = new Set<string>([column, ...(change ? [change] : [])])
  for (const slot of DETAIL_SLOTS) {
    if (!priceHeadline && (slot.format === 'price' || slot.format !== headlineFormat)) continue
    const name = slot.names.find((n) => columnIndex(frame, n) >= 0 && !used.has(n))
    if (!name) continue
    const v = row[columnIndex(frame, name)]
    if (typeof v !== 'number' || !Number.isFinite(v)) continue
    used.add(name)
    out.push({ label: slot.label, text: formatCell(v, slot.format), slot: slot.format })
  }
  for (const c of frame.columns) {
    if (c.type !== 'number' || used.has(c.name)) continue
    const f = fields[c.name]
    if (!f?.label || f.hidden) continue
    // Under a reading that is not a price the stock's own quote fields are noise: bid and ask under IV30, the open, high
    // and volume an RSI transform carried through from its bars ("High 554.41" beside the RSI's own "High 88.94"). A
    // transform's own columns stay (the straddle, strike and underlying under an implied move).
    if (!priceHeadline && (QUOTE_FIELD.test(c.name) || DETAIL_SLOTS.some((s) => s.names.includes(c.name)))) continue
    const v = row[columnIndex(frame, c.name)]
    if (typeof v !== 'number' || !Number.isFinite(v)) continue
    used.add(c.name)
    out.push({ label: f.label, text: formatCell(v, cellFormat((f.format as Parameters<typeof cellFormat>[0] | undefined) ?? 'price')) })
  }
  // Companions that share the headline's unit come first, sorted before the cut (the cut used to come first, so six
  // price slots filled a volatility card before IV30 high and low were reached).
  // Under a price the volume and the cap belong with the day's range (the quote card reads as before).
  const same = (d: { slot?: CellFormat }) => {
    const f = d.slot ?? headlineFormat
    return f === headlineFormat || (headlineFormat === 'price' && f === 'compact')
  }
  return out
    .map((d, i) => ({ d, i }))
    .sort((a, b) => Number(same(b.d)) - Number(same(a.d)) || a.i - b.i)
    .slice(0, max)
    .map(({ d }) => ({ label: d.label, text: d.text }))
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
 * The symbols the widget asked for, in the user's order (a quote recipe's `symbols`): the
 * cards keep that order rather than the provider's (change 2: "NVDA, AMD, MU, TSLA, AAPL" came back scrambled).
 */
export function symbolOrder(widget: ViewProps['widget']): string[] {
  const queries: unknown[] = Object.values(widget.data)
  for (const q of queries) {
    const params = (q as { params?: { symbols?: unknown } } | undefined)?.params
    if (params && Array.isArray(params.symbols)) return params.symbols.map(String)
  }
  return []
}

/** Stats in the order the widget asked for its symbols; symbols the query did not name keep their frame order after them. */
export function orderStats(stats: Stat[], order: readonly string[]): Stat[] {
  if (order.length === 0) return stats
  const rank = new Map(order.map((s, i) => [s.toUpperCase(), i]))
  return stats.map((s, i) => ({ s, i, r: rank.get(s.symbol.toUpperCase()) ?? order.length + i })).sort((a, b) => a.r - b.r).map((x) => x.s)
}

/**
 * `stat` preset: the control's column (the key field, else the first measure) as one number per group, the group
 * as its label, and a change line under it (quote: the day change, plus the extended-hours price outside the
 * regular session). One group is a quote card: the number capped at 32px with its companions in a 3x2 grid
 * (change 2); several are a row of compact 80px cards that fills or centres, never full-width slabs.
 */
export const StatView: FC<ViewProps> = ({ widget, frames }) => {
  const control = controlOf(widget, frames)
  const stat = control?.kind === 'stat' ? control : undefined
  const frame = stat ? frames[stat.data] : primaryFrame(widget, frames)
  const column = stat?.column ?? ''
  const stats = useMemo(() => (frame && stat ? orderStats(statRows(frame, column, stat), symbolOrder(widget)) : []), [frame, stat, column, widget])
  const ticks = useTicks(stats)
  const [sizeRef, size] = useSize()
  // Taste round 2: the card is as tall as its content, so the choice between cards and the dense list is the width's
  // alone (more than four symbols in a column that holds two cards across), never the cell's height.
  const dense = stats.length > 1 && size != null && denseStat(stats.length, size.width)

  if (stats.length === 0) {
    return <EmptyState title="No data" hint="The query returned no rows for these symbols." />
  }

  const raw = stat?.label && stat.label !== column ? stat.label : columnLabel(column)
  const label = raw.charAt(0).toUpperCase() + raw.slice(1) // sentence case (change 11); a v1 kind table wrote "forward P/E"
  if (stats.length === 1) {
    const s = stats[0]!
    // One symbol is a quote card: the headline, then up to six companion figures (prev close, range, volume, cap) in
    // a two- or three-column label:value grid, so a quote or volatility stat reads like a quote card at body size.
    const details = frame
      ? [...seriesDetails(frame, column, stat ? cellFormat(stat.format) : 'price'), ...detailRows(frame, column, stat?.change, frame.meta.fields ?? {}, 6, stat ? cellFormat(stat.format) : undefined)]
          .filter((d, i, all) => all.findIndex((x) => x.label === d.label) === i) // one "High": the series' own
          .slice(0, 6)
      : []
    return (
      // Round 2: the card is as tall as its content (hero, 8px, the fields), the grid ends its track there.
      <div data-view="stat" data-column={column} data-count={1} className="flex w-full flex-col overflow-hidden p-3">
        <div className="flex flex-col gap-2">
          <div>
            <StatBody stat={s} label={label} tick={ticks[s.symbol]} hero />
          </div>
          {details.length > 0 && <FieldGrid fields={details.map((d) => ({ key: d.label, label: d.label, text: d.text, tone: 'text-fg-2' }))} />}
        </div>
      </div>
    )
  }
  if (dense) {
    // More than four symbols in a column that holds two cards across: one line per symbol, ticker · value · change,
    // each line 26px, the list as tall as its lines (round 2: the grid ends the track there).
    return (
      <div ref={sizeRef} data-view="stat" data-column={column} data-count={stats.length} data-dense="" className="flex w-full flex-col overflow-x-hidden px-3 py-1.5">
        <div className="flex flex-col">
          {stats.map((s) => (
            <div key={s.symbol} data-symbol={s.symbol} className="flex min-w-0 items-center gap-3 border-b border-border/50 text-sm leading-5 last:border-b-0" style={{ height: DENSE_LINE_HEIGHT }}>
              <span data-field="symbol" className="num w-14 shrink-0 truncate font-semibold text-fg">
                {s.symbol}
              </span>
              <span key={ticks[s.symbol]?.n ?? 0} data-field="value" data-tick={ticks[s.symbol]?.dir} className={clsx('num ml-auto font-semibold', s.value == null ? 'text-fg-3' : 'text-fg')}>
                {s.text}
              </span>
              <span data-field="secondary" className={clsx('num w-20 shrink-0 text-right', dirClass(s.secondary?.dir ?? null))}>
                {s.secondary?.text ?? ''}
              </span>
            </div>
          ))}
        </div>
      </div>
    )
  }
  return (
    <div ref={sizeRef} data-view="stat" data-column={column} data-count={stats.length} className="flex w-full flex-col overflow-x-hidden p-2">
      <div className="stat-cards">
        {balancedRows(stats, size ? cardsPerRow(size.width) : stats.length).map((row) => (
          <div key={row[0]!.symbol} className="stat-card-row">
            {row.map((s) => (
              <div key={s.symbol} data-symbol={s.symbol} className="stat-card flex min-w-0 flex-col justify-center overflow-hidden rounded-md border border-border bg-surface-2/50 px-3 py-2" style={{ height: STAT_CARD_HEIGHT }}>
                <StatBody stat={s} label={label} tick={ticks[s.symbol]} />
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

export { cardsPerRow }

/**
 * The cards in rows of near-equal length, longer rows first: seven cards four and three rather than six and one, three
 * and two and two rather than three, three and one (change 2: a short last row is centred, never one orphaned card).
 */
export function balancedRows<T>(items: readonly T[], perRow: number): T[][] {
  if (items.length === 0) return []
  const rows = Math.ceil(items.length / Math.max(1, perRow))
  const base = Math.floor(items.length / rows)
  const extra = items.length % rows
  const out: T[][] = []
  let at = 0
  for (let r = 0; r < rows; r++) {
    const n = base + (r < extra ? 1 : 0)
    out.push(items.slice(at, at + n))
    at += n
  }
  return out
}

/** The element's content size, measured (undefined until the first layout, so tests and server rendering keep the cards). */
function useSize(): [(el: HTMLDivElement | null) => void, { width: number; height: number } | undefined] {
  const [size, setSize] = useState<{ width: number; height: number } | undefined>(undefined)
  const ref = useCallback((el: HTMLDivElement | null) => {
    if (!el || typeof ResizeObserver === 'undefined') return
    const update = () => setSize((prev) => (prev && prev.width === el.clientWidth && prev.height === el.clientHeight ? prev : { width: el.clientWidth, height: el.clientHeight }))
    update()
    new ResizeObserver(update).observe(el)
  }, [])
  return [ref, size]
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
