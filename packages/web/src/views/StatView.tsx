import { useEffect, useMemo, useRef, useState, type FC } from 'react'
import clsx from 'clsx'
import { columnIndex, numericColumns, statColumn, type Frame, type Kind, type StatKind } from '@terminal/core'
import { EMPTY_CELL, EmptyState, direction, formatCell, type CellFormat } from '@terminal/ui'
import type { ViewProps } from './types'
import { formatsFor } from './TableView'

/** Human labels for the columns a stat is likely to show; anything else is the column name with spaces. */
const COLUMN_LABEL: Record<string, string> = {
  price: 'price',
  change_pct: 'day change',
  volume: 'volume',
  extended_price: 'extended price',
  market_cap: 'market cap',
  pe: 'P/E',
  forward_pe: 'forward P/E',
  peg: 'PEG',
  ev_ebitda: 'EV/EBITDA',
  ps: 'P/S',
  pb: 'P/B',
  gross_margin: 'gross margin',
  operating_margin: 'operating margin',
  profit_margin: 'profit margin',
  revenue_growth: 'revenue growth',
  earnings_growth: 'earnings growth',
  roe: 'ROE',
  debt_to_equity: 'debt to equity',
  dividend_yield: 'dividend yield',
  iv30: 'IV30',
  iv30_high: 'IV30 high',
  iv30_low: 'IV30 low',
  iv_rank: 'IV rank',
  hv30: 'HV30',
  hv30_high: 'HV30 high',
  hv30_low: 'HV30 low',
  year_high: '52w high',
  year_low: '52w low',
  analysts: 'analysts',
  target_low: 'low target',
  target_consensus: 'consensus target',
  target_high: 'high target',
  upside_pct: 'upside',
  eps_estimate_q: 'EPS est. (Q)',
  eps_estimate_y: 'EPS est. (Y)',
  eps_growth_y: 'EPS growth',
  employees: 'employees',
  beta: 'beta',
  short_interest: 'shares short',
  avg_volume: 'avg volume',
  days_to_cover: 'days to cover',
}

export function columnLabel(column: string): string {
  return COLUMN_LABEL[column] ?? column.replace(/_/g, ' ')
}

/**
 * The line under the number, per kind: a signed move where the kind has one, else the column a trader
 * reads next to the key column. Skipped when it is the column already on display.
 */
const SECONDARY: Record<StatKind, { column: string; label?: string }> = {
  quote: { column: 'change_pct' },
  metrics: { column: 'forward_pe', label: 'forward' },
  volatility: { column: 'iv_rank', label: 'IV rank' },
  estimates: { column: 'upside_pct', label: 'upside' },
  profile: { column: 'sector' },
  short_interest: { column: 'change_pct', label: 'vs prior report' },
}

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
 * One stat per symbol, in frame order, from the first row of each symbol (the newest, for kinds with
 * history such as short_interest). `column` is the view's column or the kind's key column.
 */
export function statRows(frame: Frame, kind: Kind, column: string): Stat[] {
  const iSym = columnIndex(frame, 'symbol')
  const iVal = columnIndex(frame, column)
  const formats = formatsFor(kind, frame.columns)
  const format: CellFormat = formats[column] ?? 'price'
  const secondary = (SECONDARY as Partial<Record<Kind, { column: string; label?: string }>>)[kind]
  const iSec = secondary && secondary.column !== column ? columnIndex(frame, secondary.column) : -1
  const iState = kind === 'quote' ? columnIndex(frame, 'market_state') : -1
  const iExt = kind === 'quote' ? columnIndex(frame, 'extended_price') : -1
  const iExtPct = kind === 'quote' ? columnIndex(frame, 'extended_change_pct') : -1

  const seen = new Set<string>()
  const out: Stat[] = []
  for (const row of frame.rows) {
    const symbol = iSym >= 0 ? String(row[iSym] ?? '') : '*'
    if (seen.has(symbol)) continue
    seen.add(symbol)
    const value = iVal >= 0 ? num(row[iVal]) : null
    let sec: Stat['secondary'] = null
    if (iSec >= 0 && secondary) {
      const v = row[iSec]
      const f = formats[secondary.column] ?? 'text'
      const text = formatCell(v, f)
      if (text !== EMPTY_CELL) sec = { text, dir: f === 'change' ? direction(v) : null, ...(secondary.label ? { label: secondary.label } : {}) }
    }
    let extended: Stat['extended'] = null
    if (iState >= 0 && iExt >= 0) {
      const state = row[iState]
      const ext = num(row[iExt])
      if (typeof state === 'string' && state && state !== 'REGULAR' && ext != null) {
        const pct = iExtPct >= 0 ? row[iExtPct] : null
        extended = { state: EXTENDED_LABEL[state] ?? state.toLowerCase(), price: formatCell(ext, 'price'), change: formatCell(pct, 'change'), dir: direction(pct) }
      }
    }
    out.push({ symbol, value, text: value == null ? EMPTY_CELL : formatCell(value, format), secondary: sec, extended })
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
 * `stat` view: the kind's key column as one big number per symbol, the symbol as its label, and a
 * change line under it (quote: the day change, plus the extended-hours price outside the regular
 * session). One symbol fills the widget; several become a row of compact cards.
 */
export const StatView: FC<ViewProps> = ({ widget, frame }) => {
  const kind = widget.query.kind
  const column = statColumn(kind, widget.view) ?? numericColumns(kind)[0] ?? ''
  const stats = useMemo(() => statRows(frame, kind, column), [frame, kind, column])
  const ticks = useTicks(stats)

  if (stats.length === 0) {
    return <EmptyState title="No data" hint="The query returned no rows for these symbols." />
  }

  const label = columnLabel(column)
  if (stats.length === 1) {
    const s = stats[0]!
    return (
      <div data-view="stat" data-column={column} data-count={1} className="flex h-full w-full flex-col justify-center overflow-hidden p-3">
        <StatBody stat={s} label={label} tick={ticks[s.symbol]} hero />
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

const StatBody: FC<{ stat: Stat; label: string; tick: Tick | undefined; hero?: boolean }> = ({ stat, label, tick, hero }) => (
  <>
    <div className={clsx('flex min-w-0 items-baseline gap-1.5 truncate text-xs leading-4 text-fg-3', hero && 'mb-1')}>
      <span data-field="symbol" className="num font-semibold text-fg">
        {stat.symbol}
      </span>
      <span className="truncate">{label}</span>
    </div>
    <div className="min-w-0 truncate">
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
            {stat.extended.state}{' '}
            <span className="whitespace-nowrap">
              <span className="num text-fg-2">{stat.extended.price}</span> <span className={clsx('num', dirClass(stat.extended.dir))}>{stat.extended.change}</span>
            </span>
          </span>
        )}
      </div>
    )}
  </>
)
