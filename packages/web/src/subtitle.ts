/**
 * The widget sub-header: what the query is about, at a glance, derived from the widget's query (and the
 * frame once it has landed) and written once per kind. "NVDA · 5m · today", "4 symbols · 1d · 3mo,
 * rebased", "NVDA · Oct 23, 2026 · 7 DTE · underlying 182.43". Never typed by the agent or the user.
 */
import { columnIndex, describeQuery, isWidgetV2, type AnyWidget, type Frame, type Widget } from '@terminal/core'
import { formatCell } from '@terminal/ui'

/** Short labels for the macro series, shared with the series legend. */
export const MACRO_LABELS: Record<string, string> = {
  treasury_3m: '3M',
  treasury_2y: '2Y',
  treasury_10y: '10Y',
  treasury_30y: '30Y',
  spread_10y_2y: '10Y-2Y',
  fed_funds: 'Fed funds',
  sofr: 'SOFR',
  cpi_yoy: 'CPI YoY',
  unemployment: 'Unemployment',
  m2: 'M2',
}

const SEP = ' · '

/** Up to three symbols are listed; more become a count. */
export function symbolsLabel(symbols: readonly string[]): string {
  if (symbols.length <= 3) return symbols.join(', ')
  return `${symbols.length} symbols`
}

const MARKET_STATE: Record<string, string> = {
  REGULAR: 'regular session',
  PRE: 'pre-market',
  PREPRE: 'pre-market',
  POST: 'after hours',
  POSTPOST: 'after hours',
  CLOSED: 'closed',
}

/** "2026-10-23" → "Oct 23" (this year) or "Oct 23, 2025"; anything else passes through. */
export function shortDate(iso: string | null | undefined, now: number): string {
  if (!iso) return ''
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  if (!m) return iso
  const year = Number(m[1])
  const d = new Date(Date.UTC(year, Number(m[2]) - 1, Number(m[3])))
  const thisYear = new Date(now).getUTCFullYear() === year
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(thisYear ? {} : { year: 'numeric' }), timeZone: 'UTC' })
}

function window(from: string, to: string, now: number): string {
  if (from === to) return shortDate(from, now)
  return `${shortDate(from, now)} to ${shortDate(to, now)}`
}

function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`
}

/** "last 3h", "last 2 days", from the oldest `time` in the frame to now; empty without a time column or rows. */
function spanLabel(frame: Frame, now: number): string {
  const i = columnIndex(frame, 'time')
  if (i < 0) return ''
  let oldest = Infinity
  for (const row of frame.rows) {
    const t = row[i]
    if (typeof t === 'number' && t < oldest) oldest = t
  }
  if (!Number.isFinite(oldest)) return ''
  const hours = Math.max(1, Math.round((now - oldest) / 3_600_000))
  if (hours < 48) return `last ${hours}h`
  return `last ${count(Math.round(hours / 24), 'day')}`
}

function cell(frame: Frame | undefined, column: string, rowIndex = 0): unknown {
  if (!frame) return undefined
  const i = columnIndex(frame, column)
  if (i < 0) return undefined
  return frame.rows[rowIndex]?.[i]
}

/** The most common non-null value of a string column, for one word about the whole frame (the market state). */
function commonValue(frame: Frame | undefined, column: string): string | undefined {
  if (!frame) return undefined
  const i = columnIndex(frame, column)
  if (i < 0) return undefined
  const tally = new Map<string, number>()
  for (const row of frame.rows) {
    const v = row[i]
    if (typeof v === 'string' && v) tally.set(v, (tally.get(v) ?? 0) + 1)
  }
  let best: string | undefined
  let n = 0
  for (const [v, c] of tally) {
    if (c > n) {
      best = v
      n = c
    }
  }
  return best
}

const RANGE_LABEL: Record<string, string> = { '1d': 'today' }

/** The sub-header for a widget. `frame` is the frame its query produced, when it has landed; `now` is for dates and windows. */
export function subtitleFor(widget: Widget, frame?: Frame, now: number = Date.now()): string {
  const q = widget.query
  const rows = frame?.rows.length ?? 0
  const parts: string[] = []
  switch (q.kind) {
    case 'search': {
      parts.push(count(q.params.q.length, 'query', 'queries'))
      if (frame) parts.push(count(rows, 'match', 'matches'))
      break
    }
    case 'quote': {
      parts.push(symbolsLabel(q.params.symbols))
      const state = commonValue(frame, 'market_state')
      if (state) parts.push(MARKET_STATE[state] ?? state.toLowerCase())
      break
    }
    case 'ohlcv': {
      parts.push(symbolsLabel(q.params.symbols), q.params.interval)
      let range = RANGE_LABEL[q.params.range] ?? q.params.range
      if (widget.view.type === 'series' && widget.view.normalize) range += ', rebased'
      else if (widget.view.type === 'series' && widget.view.candle) range += ', candles'
      parts.push(range)
      break
    }
    case 'news': {
      parts.push(symbolsLabel(q.params.symbols))
      if (frame) {
        parts.push(count(rows, 'headline'))
        const span = spanLabel(frame, now)
        if (span) parts.push(span)
      } else parts.push(`up to ${q.params.limit}`)
      break
    }
    case 'earnings': {
      parts.push(symbolsLabel(q.params.symbols), window(q.params.from, q.params.to, now))
      if (frame) parts.push(count(rows, 'date'))
      break
    }
    case 'profile': {
      parts.push(symbolsLabel(q.params.symbols))
      if (frame && q.params.symbols.length === 1) {
        for (const c of ['sector', 'exchange']) {
          const v = cell(frame, c)
          if (typeof v === 'string' && v) parts.push(v)
        }
      }
      break
    }
    case 'metrics': {
      parts.push(symbolsLabel(q.params.symbols), 'multiples and margins')
      break
    }
    case 'financials': {
      parts.push(symbolsLabel(q.params.symbols), q.params.period === 'annual' ? 'annual' : 'quarterly')
      parts.push(frame ? count(rows, 'period') : `last ${q.params.limit}`)
      break
    }
    case 'estimates': {
      parts.push(symbolsLabel(q.params.symbols))
      const analysts = cell(frame, 'analysts')
      if (q.params.symbols.length === 1 && typeof analysts === 'number') parts.push(count(analysts, 'analyst'))
      else parts.push('consensus')
      break
    }
    case 'eps_history': {
      parts.push(symbolsLabel(q.params.symbols), frame ? count(rows, 'report') : `last ${q.params.limit}`)
      break
    }
    case 'dividends': {
      parts.push(symbolsLabel(q.params.symbols), frame ? count(rows, 'payment') : `last ${q.params.limit}`)
      break
    }
    case 'insiders': {
      parts.push(symbolsLabel(q.params.symbols), frame ? count(rows, 'transaction') : `last ${q.params.limit}`)
      break
    }
    case 'institutions': {
      parts.push(symbolsLabel(q.params.symbols), frame ? `top ${count(rows, 'holder')}` : `top ${q.params.limit}`)
      break
    }
    case 'short_interest': {
      parts.push(symbolsLabel(q.params.symbols))
      const latest = cell(frame, 'date')
      if (typeof latest === 'string' && latest) parts.push(`latest ${shortDate(latest, now)}`)
      else parts.push(`last ${count(q.params.limit, 'report')}`)
      break
    }
    case 'options': {
      parts.push(q.params.symbol)
      const expiration = cell(frame, 'expiration')
      const dte = cell(frame, 'dte')
      const underlying = cell(frame, 'underlying_price')
      if (typeof expiration === 'string' && expiration) parts.push(shortDate(expiration, now))
      else parts.push(q.params.expiration ? `on or after ${shortDate(q.params.expiration, now)}` : 'nearest expiration')
      if (typeof dte === 'number') parts.push(`${dte} DTE`)
      if (typeof underlying === 'number') parts.push(`underlying ${formatCell(underlying, 'price')}`)
      if (q.params.type !== 'both') parts.push(`${q.params.type}s only`)
      break
    }
    case 'volatility': {
      parts.push(symbolsLabel(q.params.symbols), '30-day IV and realized')
      break
    }
    case 'calendar': {
      parts.push(window(q.params.from, q.params.to, now), q.params.country)
      if (frame) parts.push(count(rows, 'event'))
      break
    }
    case 'ipos': {
      parts.push(window(q.params.from, q.params.to, now))
      if (frame) parts.push(count(rows, 'IPO'))
      break
    }
    case 'movers': {
      parts.push(q.params.list === 'active' ? 'most active' : q.params.list, `top ${q.params.limit}`)
      if (q.params.min_price > 0) parts.push(`over $${q.params.min_price}`)
      break
    }
    case 'holdings': {
      parts.push(q.params.symbol, frame ? `top ${count(rows, 'holding')}` : 'top holdings')
      break
    }
    case 'macro': {
      parts.push(q.params.series.map((s) => MACRO_LABELS[s] ?? s).join(', '), q.params.range)
      break
    }
    case 'yield_curve': {
      const date = cell(frame, 'date')
      if (typeof date === 'string' && date) parts.push(shortDate(date, now))
      else parts.push(q.params.date ? shortDate(q.params.date, now) : 'latest')
      if (frame) parts.push(count(rows, 'maturity', 'maturities'))
      break
    }
  }
  return parts.filter(Boolean).join(SEP)
}

/**
 * The sub-header for any widget. A v1 widget (or a v2 widget migrated from one, which keeps its `query`) uses the
 * per-kind rule above over its `main` frame. A native v2 widget describes its datasets (`describeQuery`) and the
 * primary frame's row count; the route summary from the catalog replaces this when (e)'s Data tab lands.
 */
export function subtitleForWidget(widget: AnyWidget, frames: Record<string, Frame> = {}, now: number = Date.now()): string {
  const main = frames.main ?? Object.values(frames)[0]
  if (!isWidgetV2(widget)) return subtitleFor(widget, main, now)
  if (widget.query) return subtitleFor({ ...widget, query: widget.query, view: { type: 'table' } }, main, now)
  const parts = Object.entries(widget.data).map(([name, q]) => (name === 'main' || Object.keys(widget.data).length === 1 ? describeQuery(q) : `${name}: ${describeQuery(q)}`))
  if (main) parts.push(count(main.rows.length, 'row'))
  return parts.filter(Boolean).join(SEP)
}
