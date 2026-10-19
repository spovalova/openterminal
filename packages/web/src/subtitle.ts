/**
 * The widget sub-header: what the query is about, at a glance, derived from the widget's primary dataset (and its
 * frame once it has landed), written once per built-in recipe. "NVDA · 5m · today, candles", "4 symbols · 1d · 3mo,
 * rebased", "NVDA · Oct 23, 2026 · 4 DTE · underlying 213.75". A route or a transform describes itself by its path
 * or its inputs. Never typed by the agent or the user.
 */
import { DEFAULT_DATASET, columnIndex, describeQuery, type AnyQuery, type AnyWidget, type Frame, type ViewV2 } from '@terminal/core'
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

/** "2026-10-23" → "Oct 23" (this year) or "Oct 23, 2025"; an epoch-ms time is read as a New York date; anything else passes through. */
export function shortDate(value: string | number | null | undefined, now: number): string {
  if (value === null || value === undefined || value === '') return ''
  const iso = typeof value === 'number' ? new Date(value).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) : value
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

/** "last 3h", "last 2 days", from the oldest time in the frame to now; empty without a time column or rows. */
function spanLabel(frame: Frame, now: number): string {
  const i = frame.columns.findIndex((c) => c.type === 'time')
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

/** The first row's cell in the first of these columns that the frame has. */
function cell(frame: Frame | undefined, columns: readonly string[], rowIndex = 0): unknown {
  if (!frame) return undefined
  for (const column of columns) {
    const i = columnIndex(frame, column)
    if (i >= 0) return frame.rows[rowIndex]?.[i]
  }
  return undefined
}

/** The most common non-null value of a string column, for one word about the whole frame (the market state). */
function commonValue(frame: Frame | undefined, columns: readonly string[]): string | undefined {
  if (!frame) return undefined
  const i = columns.map((c) => columnIndex(frame, c)).find((x) => x >= 0) ?? -1
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

type Params = Record<string, unknown>
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? v.split(',').map((s) => s.trim()).filter(Boolean) : [])
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
const numberOf = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/**
 * The sub-header for a recipe dataset: the params that matter for that recipe, then what the frame says once it has
 * landed. `view` adds the chart flags (rebased, candles). Unknown recipes fall back to the param values.
 */
export function subtitleForRecipe(recipe: string, params: Params, view: ViewV2 | undefined, frame: Frame | undefined, now: number): string {
  const rows = frame?.rows.length ?? 0
  const symbols = list(params.symbols)
  const symbol = str(params.symbol) ?? symbols[0] ?? ''
  const limit = numberOf(params.limit)
  const parts: string[] = []
  switch (recipe) {
    case 'search': {
      parts.push(str(params.q) ?? '')
      if (frame) parts.push(count(rows, 'match', 'matches'))
      break
    }
    case 'quote': {
      parts.push(symbolsLabel(symbols))
      const state = commonValue(frame, ['market_state', 'marketState'])
      if (state) parts.push(MARKET_STATE[state] ?? state.toLowerCase())
      break
    }
    case 'ohlcv':
    case 'index': {
      parts.push(recipe === 'index' ? symbol : symbolsLabel(symbols), str(params.interval) ?? '1d')
      const start = str(params.start)
      let range = start ? `since ${shortDate(start, now)}` : (RANGE_LABEL[str(params.range) ?? ''] ?? str(params.range) ?? '3mo')
      if (view?.preset === 'compare' && view.normalize !== false) range += ', rebased'
      else if (view?.preset === 'price' && view.candle) range += ', candles'
      parts.push(range)
      break
    }
    case 'news': {
      parts.push(symbolsLabel(symbols))
      if (frame) {
        parts.push(count(rows, 'headline'))
        const span = spanLabel(frame, now)
        if (span) parts.push(span)
      } else if (limit) parts.push(`up to ${limit}`)
      break
    }
    case 'earnings': {
      parts.push(symbolsLabel(symbols))
      if (str(params.from) && str(params.to)) parts.push(window(str(params.from)!, str(params.to)!, now))
      if (frame) parts.push(count(rows, 'date'))
      break
    }
    case 'profile': {
      parts.push(symbolsLabel(symbols))
      if (frame && symbols.length === 1) {
        for (const c of [['sector'], ['stock_exchange', 'exchange']]) {
          const v = cell(frame, c)
          if (typeof v === 'string' && v) parts.push(v)
        }
      }
      break
    }
    case 'metrics': {
      parts.push(symbolsLabel(symbols), 'multiples and margins')
      break
    }
    case 'financials': {
      parts.push(symbolsLabel(symbols), params.period === 'annual' ? 'annual' : 'quarterly')
      parts.push(frame ? count(rows, 'period') : `last ${limit ?? 4}`)
      break
    }
    case 'estimates': {
      parts.push(symbolsLabel(symbols))
      const analysts = cell(frame, ['number_of_analysts', 'analysts'])
      if (symbols.length === 1 && typeof analysts === 'number') parts.push(count(analysts, 'analyst'))
      else parts.push('consensus')
      break
    }
    case 'eps_history': {
      parts.push(symbolsLabel(symbols), frame ? count(rows, 'report') : `last ${limit ?? 8}`)
      break
    }
    case 'dividends': {
      parts.push(symbolsLabel(symbols), frame ? count(rows, 'payment') : `last ${limit ?? 12}`)
      break
    }
    case 'insiders': {
      parts.push(symbolsLabel(symbols), frame ? count(rows, 'transaction') : `last ${limit ?? 20}`)
      break
    }
    case 'institutions': {
      parts.push(symbolsLabel(symbols), frame ? `top ${count(rows, 'holder')}` : `top ${limit ?? 20}`)
      break
    }
    case 'short_interest': {
      parts.push(symbolsLabel(symbols))
      const latest = cell(frame, ['settlement_date', 'date'])
      if ((typeof latest === 'string' || typeof latest === 'number') && latest) parts.push(`latest ${shortDate(latest, now)}`)
      else parts.push(`last ${count(limit ?? 12, 'report')}`)
      break
    }
    case 'options': {
      parts.push(symbol)
      const expiration = cell(frame, ['expiration'])
      const dte = cell(frame, ['dte'])
      const underlying = cell(frame, ['underlying_price', 'underlyingPrice'])
      if ((typeof expiration === 'string' || typeof expiration === 'number') && expiration) parts.push(shortDate(expiration, now))
      else parts.push(str(params.expiration) ? `on or after ${shortDate(str(params.expiration)!, now)}` : 'nearest expiration')
      if (typeof dte === 'number') parts.push(`${dte} DTE`)
      if (typeof underlying === 'number') parts.push(`underlying ${formatCell(underlying, 'price')}`)
      if (params.type === 'call' || params.type === 'put') parts.push(`${params.type}s only`)
      break
    }
    case 'volatility': {
      parts.push(symbolsLabel(symbols), '30-day IV and realized')
      break
    }
    case 'calendar': {
      if (str(params.from) && str(params.to)) parts.push(window(str(params.from)!, str(params.to)!, now))
      parts.push(str(params.country) ?? 'United States')
      if (frame) parts.push(count(rows, 'event'))
      break
    }
    case 'ipos': {
      if (str(params.from) && str(params.to)) parts.push(window(str(params.from)!, str(params.to)!, now))
      if (frame) parts.push(count(rows, 'IPO'))
      break
    }
    case 'movers': {
      const which = str(params.list) ?? 'gainers'
      parts.push(which === 'active' ? 'most active' : which, `top ${limit ?? 20}`)
      const minPrice = numberOf(params.min_price) ?? 5
      if (minPrice > 0) parts.push(`over $${minPrice}`)
      break
    }
    case 'screener': {
      for (const k of ['sector', 'industry', 'preset']) if (str(params[k])) parts.push(str(params[k])!.replace(/[-_]/g, ' '))
      if (parts.length === 0) parts.push('whole market')
      if (frame) parts.push(count(rows, 'name'))
      break
    }
    case 'holdings': {
      parts.push(symbol, frame ? `top ${count(rows, 'holding')}` : 'top holdings')
      break
    }
    case 'macro': {
      const series = str(params.series) ?? ''
      parts.push(MACRO_LABELS[series] ?? series, str(params.range) ?? '1y')
      break
    }
    case 'yield_curve': {
      const date = cell(frame, ['date'])
      if ((typeof date === 'string' || typeof date === 'number') && date) parts.push(shortDate(date, now))
      else parts.push(str(params.date) ? shortDate(str(params.date)!, now) : 'latest')
      if (frame) parts.push(count(rows, 'maturity', 'maturities'))
      break
    }
    default: {
      parts.push(...Object.values(params).map((v) => (Array.isArray(v) ? symbolsLabel(v.map(String)) : v == null || v === '' ? '' : String(v))))
      if (frame) parts.push(count(rows, 'row'))
    }
  }
  return parts.filter(Boolean).join(SEP)
}

/**
 * The sub-header for a widget: its primary dataset (the one the view names, else `main`, else the first) described as
 * above, plus the other datasets as markers ("earnings markers"). A multi-dataset macro widget lists its series.
 */
export function subtitleForWidget(widget: AnyWidget, frames: Record<string, Frame> = {}, now: number = Date.now()): string {
  const names = Object.keys(widget.data)
  const primary = widget.view.data && widget.view.data in widget.data ? widget.view.data : names.includes(DEFAULT_DATASET) ? DEFAULT_DATASET : names[0]!
  const q = widget.data[primary]!
  const frame = frames[primary] ?? frames[DEFAULT_DATASET] ?? Object.values(frames)[0]
  const extras = names.filter((n) => n !== primary)
  const parts: string[] = []
  const macroSeries = names.map((n) => widget.data[n]).filter((d): d is AnyQuery & { recipe: string; params: Params } => !!d && 'recipe' in d && d.recipe === 'macro')
  if (macroSeries.length > 1 && macroSeries.length === names.length) {
    // one macro dataset per series: "10Y, 2Y, Fed funds · 1y"
    parts.push(macroSeries.map((d) => MACRO_LABELS[String(d.params.series)] ?? String(d.params.series)).join(', '), str(macroSeries[0]!.params.range) ?? '1y')
    return parts.join(SEP)
  }
  parts.push(describeDataset(q, widget.view, frame, now))
  if (extras.length > 0) parts.push([...new Set(extras.map((n) => markerName(widget.data[n]!)))].join(', '))
  return parts.filter(Boolean).join(SEP)
}

/**
 * One dataset at a glance: a recipe by its params and frame ("CRWV · 1d · 3mo", "4 symbols · regular session"), a
 * route by its path and the params that matter, a transform by what it derives from.
 */
export function describeDataset(q: AnyQuery, view?: ViewV2, frame?: Frame, now: number = Date.now()): string {
  const query = q as { recipe?: string; params?: Params; connector?: string; route?: string; inputs?: Record<string, unknown> }
  if (query.recipe) return subtitleForRecipe(query.recipe, query.params ?? {}, view, frame, now)
  if (query.route) {
    const p = Object.entries(query.params ?? {}).filter(([k, v]) => k !== 'provider' && v != null && v !== '')
    const shown = p.slice(0, 3).map(([k, v]) => `${k}=${Array.isArray(v) ? symbolsLabel(v.map(String)) : String(v)}`)
    const parts = [query.route, ...shown]
    if (frame) parts.push(count(frame.rows.length, frame.columns.some((c) => c.type === 'time') ? 'bar' : 'row'))
    return parts.join(SEP)
  }
  if (query.inputs) {
    const ins = Object.values(query.inputs) as { recipe?: string; route?: string; params?: Params }[]
    const syms = [...new Set(ins.flatMap((i) => (Array.isArray(i.params?.symbols) ? (i.params!.symbols as unknown[]).map(String) : typeof i.params?.symbol === 'string' ? [i.params.symbol] : [])))]
    const from = [...new Set(ins.map((i) => i.recipe ?? i.route ?? 'frames'))]
    return `derived from ${from.join(' + ')}${syms.length ? SEP + symbolsLabel(syms) : ''}`
  }
  return describeQuery(q)
}

/** The short name of a secondary dataset in the subtitle: its recipe ("news markers"), route tail or "derived". */
function markerName(q: unknown): string {
  const query = q as { recipe?: string; route?: string; inputs?: unknown }
  if (query.recipe) return `${query.recipe} markers`
  if (query.route) return `${query.route.split('/').pop()} markers`
  return 'derived markers'
}
