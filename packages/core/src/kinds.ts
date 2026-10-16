import { z } from 'zod'
import type { Column } from './frame.js'

/**
 * The kind catalog: the v1 contract from PLAN.md section 7.1.
 * A kind names one contract: a param schema plus the exact columns of the resulting frame.
 */

export const KIND_NAMES = ['search', 'quote', 'ohlcv', 'news', 'earnings'] as const
export const KindNameSchema = z.enum(KIND_NAMES)
export type Kind = z.infer<typeof KindNameSchema>

export const IntervalSchema = z.enum(['1m', '5m', '15m', '1h', '1d', '1w'])
export type Interval = z.infer<typeof IntervalSchema>
export const RangeSchema = z.enum(['1d', '5d', '1mo', '3mo', '6mo', '1y', '5y'])
export type Range = z.infer<typeof RangeSchema>

export const INTRADAY_INTERVALS: ReadonlySet<Interval> = new Set(['1m', '5m', '15m', '1h'])
export function isIntraday(interval: Interval): boolean {
  return INTRADAY_INTERVALS.has(interval)
}

const SymbolSchema = z.string().trim().min(1).max(16).describe('Ticker symbol, e.g. NVDA')
const SymbolsSchema = z.array(SymbolSchema).min(1).max(50).describe('Ticker symbols')
const IsoDate = z.iso.date().describe('Calendar date, YYYY-MM-DD')

const col = (name: string, type: Column['type']): Column => ({ name, type })

export const MS = { second: 1_000, minute: 60_000, hour: 3_600_000, day: 86_400_000 } as const

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
  search: def({
    description: 'Resolve free-text names or tickers to symbols. Batch every lookup into one call.',
    params: z.object({ q: z.array(z.string().trim().min(1)).min(1).max(50).describe('Names or tickers to look up') }),
    columns: [col('query', 'string'), col('symbol', 'string'), col('name', 'string'), col('exchange', 'string')],
    ttl: MS.day,
  }),
  quote: def({
    description: 'Latest price, day change, volume, market state, and extended-hours price per symbol.',
    params: z.object({ symbols: SymbolsSchema }),
    columns: [
      col('symbol', 'string'),
      col('price', 'number'),
      col('change_pct', 'number'),
      col('volume', 'number'),
      col('market_state', 'string'),
      col('extended_price', 'number'),
      col('extended_change_pct', 'number'),
    ],
    ttl: 10 * MS.second,
  }),
  ohlcv: def({
    description: 'Price bars per symbol over a range at an interval. Rows sorted by symbol then time.',
    params: z.object({ symbols: SymbolsSchema, interval: IntervalSchema, range: RangeSchema }),
    columns: [
      col('symbol', 'string'),
      col('time', 'time'),
      col('open', 'number'),
      col('high', 'number'),
      col('low', 'number'),
      col('close', 'number'),
      col('volume', 'number'),
    ],
    ttl: (p) => (isIntraday(p.interval) ? MS.minute : 10 * MS.minute),
  }),
  news: def({
    description: 'Recent headlines per symbol, newest first.',
    params: z.object({ symbols: SymbolsSchema, limit: z.number().int().min(1).max(100).default(20) }),
    columns: [col('time', 'time'), col('headline', 'string'), col('source', 'string'), col('url', 'string'), col('symbol', 'string')],
    ttl: 2 * MS.minute,
  }),
  earnings: def({
    description: 'Earnings dates per symbol inside a date window. session is bmo, amc, or null.',
    params: z.object({ symbols: SymbolsSchema, from: IsoDate, to: IsoDate }),
    columns: [col('symbol', 'string'), col('date', 'string'), col('session', 'string'), col('eps_estimate', 'number')],
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

/** Symbols a query is about, if any. `search` has none. */
export function querySymbols(query: Query): string[] {
  return query.kind === 'search' ? [] : query.params.symbols
}
