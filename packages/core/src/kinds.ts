import { z } from 'zod'
import type { Column } from './frame.js'
import { INTERVALS, MS, RANGES, isIntraday } from './clock.js'

/**
 * The kind catalog: the contract from PLAN.md section 7.1.
 * A kind names one contract: a param schema plus the exact columns of the resulting frame.
 * v1 shipped five kinds; v1.2 (PLAN.md section 14) added the rest over the keyless OpenBB routes.
 */

export const KIND_NAMES = [
  // v1
  'search',
  'quote',
  'ohlcv',
  'news',
  'earnings',
  // v1.2: company
  'profile',
  'metrics',
  'financials',
  'estimates',
  'eps_history',
  'dividends',
  // v1.2: ownership and positioning
  'insiders',
  'institutions',
  'short_interest',
  // v1.2: options and volatility
  'options',
  'volatility',
  // v1.2: market-wide (no symbols)
  'calendar',
  'ipos',
  'movers',
  'holdings',
  'macro',
  'yield_curve',
] as const
export const KindNameSchema = z.enum(KIND_NAMES)
export type Kind = z.infer<typeof KindNameSchema>

export const IntervalSchema = z.enum(INTERVALS)
export const RangeSchema = z.enum(RANGES)

/** Macro series answerable without a key (federal_reserve, oecd on the OpenBB side). Rates and yields are percent. */
export const MACRO_SERIES = ['treasury_3m', 'treasury_2y', 'treasury_10y', 'treasury_30y', 'spread_10y_2y', 'fed_funds', 'sofr', 'cpi_yoy', 'unemployment', 'm2'] as const
export const MacroSeriesSchema = z.enum(MACRO_SERIES)
export type MacroSeries = z.infer<typeof MacroSeriesSchema>

export const MOVER_LISTS = ['gainers', 'losers', 'active'] as const
export const OPTION_TYPES = ['call', 'put', 'both'] as const
export const STATEMENT_PERIODS = ['annual', 'quarter'] as const

const SymbolSchema = z.string().trim().min(1).max(16).describe('Ticker symbol, e.g. NVDA')
const SymbolsSchema = z.array(SymbolSchema).min(1).max(50).describe('Ticker symbols')
const IsoDate = z.iso.date().describe('Calendar date, YYYY-MM-DD')
const limit = (max: number, def: number) => z.number().int().min(1).max(max).default(def).describe(`Rows per symbol, newest first (max ${max})`)

const col = (name: string, type: Column['type']): Column => ({ name, type })
const S = (name: string) => col(name, 'string')
const N = (name: string) => col(name, 'number')
const T = (name: string) => col(name, 'time')

export type KindDef<P extends z.ZodType = z.ZodType> = {
  description: string
  params: P
  columns: Column[]
  /** Cache TTL in ms; a function when it depends on params. */
  ttl: number | ((params: z.infer<P>) => number)
}

function def<P extends z.ZodType>(d: KindDef<P>): KindDef<P> {
  return d
}

export const KINDS = {
  // ---------------------------------------------------------------- v1
  search: def({
    description: 'Resolve free-text names or tickers to symbols. Batch every lookup into one call.',
    params: z.object({ q: z.array(z.string().trim().min(1)).min(1).max(50).describe('Names or tickers to look up') }),
    columns: [S('query'), S('symbol'), S('name'), S('exchange')],
    ttl: MS.day,
  }),
  quote: def({
    description: 'Latest price, day change, volume, market state, and extended-hours price per symbol.',
    params: z.object({ symbols: SymbolsSchema }),
    columns: [S('symbol'), N('price'), N('change_pct'), N('volume'), S('market_state'), N('extended_price'), N('extended_change_pct')],
    ttl: 10 * MS.second,
  }),
  ohlcv: def({
    description: 'Price bars per symbol over a range at an interval. Rows sorted by symbol then time. A range change is measured from the first bar, so ask for one range longer than the period you describe (1mo for "this week") when the baseline matters.',
    params: z.object({ symbols: SymbolsSchema, interval: IntervalSchema, range: RangeSchema }),
    columns: [S('symbol'), T('time'), N('open'), N('high'), N('low'), N('close'), N('volume')],
    ttl: (p) => (isIntraday(p.interval) ? MS.minute : 10 * MS.minute),
  }),
  news: def({
    description: 'Recent headlines per symbol, newest first.',
    params: z.object({ symbols: SymbolsSchema, limit: z.number().int().min(1).max(100).default(20) }),
    columns: [T('time'), S('headline'), S('source'), S('url'), S('symbol')],
    ttl: 2 * MS.minute,
  }),
  earnings: def({
    description: 'Earnings dates per symbol inside a date window. session is bmo, amc, or null.',
    params: z.object({ symbols: SymbolsSchema, from: IsoDate, to: IsoDate }),
    columns: [S('symbol'), S('date'), S('session'), N('eps_estimate')],
    ttl: MS.hour,
  }),

  // ---------------------------------------------------------------- v1.2: company
  profile: def({
    description: 'Who the company is: name, exchange, sector, industry, market cap, employees, beta, one-paragraph description.',
    params: z.object({ symbols: SymbolsSchema }),
    columns: [S('symbol'), S('name'), S('exchange'), S('sector'), S('industry'), N('market_cap'), N('employees'), N('beta'), S('description')],
    ttl: MS.day,
  }),
  metrics: def({
    description: 'Valuation and quality snapshot per symbol: multiples, margins, growth, returns, leverage, yield. Margins, growth, returns and yield are percent; pe, forward_pe, peg, ev_ebitda, ps, pb and debt_to_equity are ratios. ps is price to sales where the source has it, else EV to revenue.',
    params: z.object({ symbols: SymbolsSchema }),
    columns: [
      S('symbol'),
      N('market_cap'),
      N('pe'),
      N('forward_pe'),
      N('peg'),
      N('ev_ebitda'),
      N('ps'),
      N('pb'),
      N('gross_margin'),
      N('operating_margin'),
      N('profit_margin'),
      N('revenue_growth'),
      N('earnings_growth'),
      N('roe'),
      N('debt_to_equity'),
      N('dividend_yield'),
    ],
    ttl: MS.hour,
  }),
  financials: def({
    description: 'Statement lines per fiscal period, newest first: revenue, gross profit, operating income, net income, diluted EPS, operating cash flow, capex, free cash flow, cash, debt, shares. Amounts in the reporting currency, not scaled.',
    params: z.object({ symbols: SymbolsSchema, period: z.enum(STATEMENT_PERIODS).default('quarter'), limit: limit(5, 4) }),
    columns: [
      S('symbol'),
      S('period_ending'),
      N('revenue'),
      N('gross_profit'),
      N('operating_income'),
      N('net_income'),
      N('eps'),
      N('operating_cash_flow'),
      N('capex'),
      N('free_cash_flow'),
      N('cash'),
      N('debt'),
      N('shares'),
    ],
    ttl: MS.day,
  }),
  estimates: def({
    description: 'Analyst consensus per symbol: recommendation, analyst count, price targets with upside to the last price (percent), EPS estimates for the current quarter and year, expected EPS growth (percent).',
    params: z.object({ symbols: SymbolsSchema }),
    columns: [S('symbol'), S('recommendation'), N('analysts'), N('target_low'), N('target_consensus'), N('target_high'), N('upside_pct'), N('eps_estimate_q'), N('eps_estimate_y'), N('eps_growth_y')],
    ttl: MS.hour,
  }),
  eps_history: def({
    description: 'Past earnings per symbol, newest first: reported EPS against the estimate and the surprise (percent). Future dates carry the estimate only.',
    params: z.object({ symbols: SymbolsSchema, limit: limit(20, 8) }),
    columns: [S('symbol'), S('date'), N('eps_actual'), N('eps_estimate'), N('surprise_pct')],
    ttl: MS.day,
  }),
  dividends: def({
    description: 'Dividend history per symbol, newest first: ex-dividend date and cash amount per share.',
    params: z.object({ symbols: SymbolsSchema, limit: limit(60, 12) }),
    columns: [S('symbol'), S('ex_date'), N('amount')],
    ttl: MS.day,
  }),

  // ---------------------------------------------------------------- v1.2: ownership and positioning
  insiders: def({
    description: 'Insider transactions per symbol, newest first. action is buy, sell, grant, or other; value is shares times price.',
    params: z.object({ symbols: SymbolsSchema, limit: limit(100, 20) }),
    columns: [S('symbol'), S('date'), S('name'), S('title'), S('action'), N('shares'), N('price'), N('value'), S('url')],
    ttl: MS.hour,
  }),
  institutions: def({
    description: 'Largest institutional holders per symbol from the latest filings: shares held, change since the prior filing (percent), market value.',
    params: z.object({ symbols: SymbolsSchema, limit: limit(50, 20) }),
    columns: [S('symbol'), S('date'), S('holder'), N('shares'), N('change_pct'), N('value')],
    ttl: MS.day,
  }),
  short_interest: def({
    description: 'Twice-monthly short interest per symbol, newest first: shares short, change from the prior report (percent), average daily volume, days to cover.',
    params: z.object({ symbols: SymbolsSchema, limit: limit(60, 12) }),
    columns: [S('symbol'), S('date'), N('short_interest'), N('change_pct'), N('avg_volume'), N('days_to_cover')],
    ttl: MS.day,
  }),

  // ---------------------------------------------------------------- v1.2: options and volatility
  options: def({
    description:
      'Option chain for one symbol at one expiration: the `strikes` nearest strikes on each side of the underlying price. `expiration` snaps to the first listed expiration on or after that date; omitted means the nearest expiration at least 7 days out. iv is percent; greeks per contract; dte is calendar days.',
    params: z.object({
      symbol: SymbolSchema,
      expiration: IsoDate.optional(),
      strikes: z.number().int().min(1).max(30).default(10).describe('Strikes each side of the underlying price'),
      type: z.enum(OPTION_TYPES).default('both'),
    }),
    columns: [S('symbol'), S('expiration'), S('type'), N('strike'), N('bid'), N('ask'), N('last'), N('volume'), N('open_interest'), N('iv'), N('delta'), N('gamma'), N('theta'), N('vega'), N('underlying_price'), N('dte')],
    ttl: MS.minute,
  }),
  volatility: def({
    description: 'Implied and realized volatility snapshot per symbol: 30-day IV with its one-year high and low, 30-day realized vol range (all percent; hv30 itself is null from the keyless source), iv_rank as a 0-100 position inside the IV range (not a percent), and the 52-week price range in dollars.',
    params: z.object({ symbols: SymbolsSchema }),
    columns: [S('symbol'), N('iv30'), N('iv30_high'), N('iv30_low'), N('iv_rank'), N('hv30'), N('hv30_high'), N('hv30_low'), N('year_high'), N('year_low')],
    ttl: 10 * MS.minute,
  }),

  // ---------------------------------------------------------------- v1.2: market-wide
  calendar: def({
    description: 'Economic calendar inside a date window for one country: scheduled releases and speeches with actual, consensus and previous as the source prints them.',
    params: z.object({ from: IsoDate, to: IsoDate, country: z.string().trim().min(2).default('United States') }),
    columns: [T('time'), S('country'), S('event'), S('actual'), S('consensus'), S('previous')],
    ttl: MS.hour,
  }),
  ipos: def({
    description: 'IPOs priced or expected inside a date window: symbol, date, company, exchange, offer price, amount raised, status.',
    params: z.object({ from: IsoDate, to: IsoDate }),
    columns: [S('symbol'), S('date'), S('name'), S('exchange'), N('price'), N('offer_amount'), S('status')],
    ttl: MS.hour,
  }),
  movers: def({
    description: "Today's top gainers, losers, or most active US stocks: symbol, name, price, day change (percent), volume. min_price drops warrants and sub-dollar names; set it to 0 for the raw list.",
    params: z.object({ list: z.enum(MOVER_LISTS).default('gainers'), limit: z.number().int().min(1).max(50).default(20), min_price: z.number().min(0).default(5).describe('Drop rows priced below this (dollars)') }),
    columns: [S('symbol'), S('name'), N('price'), N('change_pct'), N('volume')],
    ttl: MS.minute,
  }),
  holdings: def({
    description: 'Top holdings of one ETF: constituent symbol, name, and weight (percent of the fund).',
    params: z.object({ symbol: SymbolSchema.describe('ETF ticker, e.g. SMH') }),
    columns: [S('etf'), S('symbol'), S('name'), N('weight')],
    ttl: MS.day,
  }),
  macro: def({
    description: `Macro series over a range, one row per (series, time): ${MACRO_SERIES.join(', ')}. Treasury yields, fed_funds and sofr are daily; cpi_yoy, unemployment and m2 are monthly, so give them 1y or more. Rates, yields, CPI and unemployment are percent (quote moves in points, from stats.change, not changePct); m2 is dollars and must be requested alone. Render with a series view.`,
    params: z
      .object({ series: z.array(MacroSeriesSchema).min(1).max(6), range: RangeSchema.default('1y') })
      .refine((p) => !p.series.includes('m2') || p.series.length === 1, { message: 'm2 is in dollars; chart it alone, not beside percent series', path: ['series'] }),
    columns: [S('series'), T('time'), N('value')],
    ttl: MS.hour,
  }),
  yield_curve: def({
    description: 'US Treasury yield curve on one date (the latest when omitted): maturity label, years, and rate (percent), shortest first.',
    params: z.object({ date: IsoDate.optional() }),
    columns: [S('date'), S('maturity'), N('years'), N('rate')],
    ttl: MS.hour,
  }),
} as const satisfies Record<Kind, KindDef<any>>

export type Kinds = typeof KINDS
/** Validated (output) params for a kind, defaults applied. */
export type KindParams<K extends Kind> = z.output<Kinds[K]['params']>
/** Params as a caller may pass them (defaults optional). */
export type KindParamsInput<K extends Kind> = z.input<Kinds[K]['params']>

/** A query is a kind plus params. Widgets hold queries; connectors answer them. */
export const QuerySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('search'), params: KINDS.search.params }),
  z.object({ kind: z.literal('quote'), params: KINDS.quote.params }),
  z.object({ kind: z.literal('ohlcv'), params: KINDS.ohlcv.params }),
  z.object({ kind: z.literal('news'), params: KINDS.news.params }),
  z.object({ kind: z.literal('earnings'), params: KINDS.earnings.params }),
  z.object({ kind: z.literal('profile'), params: KINDS.profile.params }),
  z.object({ kind: z.literal('metrics'), params: KINDS.metrics.params }),
  z.object({ kind: z.literal('financials'), params: KINDS.financials.params }),
  z.object({ kind: z.literal('estimates'), params: KINDS.estimates.params }),
  z.object({ kind: z.literal('eps_history'), params: KINDS.eps_history.params }),
  z.object({ kind: z.literal('dividends'), params: KINDS.dividends.params }),
  z.object({ kind: z.literal('insiders'), params: KINDS.insiders.params }),
  z.object({ kind: z.literal('institutions'), params: KINDS.institutions.params }),
  z.object({ kind: z.literal('short_interest'), params: KINDS.short_interest.params }),
  z.object({ kind: z.literal('options'), params: KINDS.options.params }),
  z.object({ kind: z.literal('volatility'), params: KINDS.volatility.params }),
  z.object({ kind: z.literal('calendar'), params: KINDS.calendar.params }),
  z.object({ kind: z.literal('ipos'), params: KINDS.ipos.params }),
  z.object({ kind: z.literal('movers'), params: KINDS.movers.params }),
  z.object({ kind: z.literal('holdings'), params: KINDS.holdings.params }),
  z.object({ kind: z.literal('macro'), params: KINDS.macro.params }),
  z.object({ kind: z.literal('yield_curve'), params: KINDS.yield_curve.params }),
])
export type Query = z.output<typeof QuerySchema>
export type QueryInput = z.input<typeof QuerySchema>
export type QueryFor<K extends Kind> = Extract<Query, { kind: K }>

/** Validate and normalize a query (applies defaults). Throws ZodError. */
export function parseQuery(input: unknown): Query {
  return QuerySchema.parse(input)
}

/** Cache TTL for a validated query. */
export function ttlFor(query: Query): number {
  const d = KINDS[query.kind] as KindDef
  return typeof d.ttl === 'function' ? d.ttl(query.params) : d.ttl
}

/** Symbols a query is about: `symbols[]`, a single `symbol`, or none (search and the market-wide kinds). */
export function querySymbols(query: Query): string[] {
  const p = query.params as { symbols?: string[]; symbol?: string }
  if (Array.isArray(p.symbols)) return p.symbols
  if (typeof p.symbol === 'string') return [p.symbol]
  return []
}

/** Kinds whose series view makes sense: a time column plus one numeric column per group. */
export const SERIES_KINDS: ReadonlySet<Kind> = new Set<Kind>(['ohlcv', 'macro'])
/** The column that groups rows into lines or legend entries for a kind (`symbol` for most, `series` for macro). */
export function groupColumn(kind: Kind): 'symbol' | 'series' {
  return kind === 'macro' ? 'series' : 'symbol'
}
