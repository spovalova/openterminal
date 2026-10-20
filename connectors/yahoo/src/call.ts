// Yahoo `descriptors()` and `call(route, params, ctx)` (PLAN.md section 17): the five yahoo-finance2 endpoints
// as routes, plus `news` (the news list of the search module), answered through core's `inferFrame`. No unit
// conversion here: frames carry Yahoo's values (fractions where Yahoo sends fractions) and the annotations say
// what they are.
import { inferFrame, parseDescriptors, type CallHandler, type Descriptor, type Frame, type ValidatedParams } from '@openterminal/core'
// Imported, not read from disk, so the release bundle carries it inline.
import descriptorsJson from './descriptors.json' with { type: 'json' }
import type { ChartOptions, ChartResultArray, OptionsResult, QuoteSummaryModules, QuoteSummaryResult, SearchResult, YahooClient } from './client.js'
import { fanOut, normalizeSymbols } from './fanout.js'
import { nyDate, utcDate } from './time.js'

type Row = Record<string, unknown>

/** Whole days from one YYYY-MM-DD to another. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
}

/**
 * The expiration rule over Yahoo's listed dates (00:00Z stamps, ascending): a requested date snaps to the first
 * listed expiration on or after it; omitted means the nearest at least 7 days out, else the nearest at least 1 day
 * out. Undefined when nothing qualifies. The `options` recipe applies the same rule to a whole chain in pandas; the
 * route needs it here because Yahoo serves one expiration per call.
 */
export function pickExpiration(listed: Date[], today: string, requested?: string): Date | undefined {
  const dates = [...listed].sort((a, b) => a.getTime() - b.getTime())
  if (requested !== undefined) return dates.find((d) => utcDate(d) >= requested)
  return dates.find((d) => daysBetween(today, utcDate(d)) >= 7) ?? dates.find((d) => daysBetween(today, utcDate(d)) >= 1)
}

let memo: Descriptor[] | undefined
/** The five yahoo-finance2 endpoints and `news` as descriptors, from descriptors.json, validated once. */
export function yahooDescriptors(): Descriptor[] {
  return (memo ??= parseDescriptors(descriptorsJson))
}

export const YAHOO_ROUTES = ['search', 'quote', 'chart', 'options', 'quoteSummary', 'news'] as const
export type YahooRoute = (typeof YAHOO_ROUTES)[number]

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' ? v.split(',') : [])

/**
 * Nested objects flattened to dotted keys at any depth (`earningsTrend.earningsEstimate.avg`), arrays of
 * scalars reduced to their first Date or joined text, `maxAge` dropped. What inferFrame's one-level flatten
 * would leave as JSON text in a quoteSummary module.
 */
export function flattenDeep(value: Row, prefix = '', out: Row = {}): Row {
  for (const [k, v] of Object.entries(value)) {
    if (k === 'maxAge') continue
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v)) flattenDeep(v as Row, key, out)
    else if (Array.isArray(v)) {
      if (v.length === 0) out[key] = null
      else if (v.every((x) => x instanceof Date)) out[key] = v[0]
      else if (v.every((x) => x === null || typeof x !== 'object')) out[key] = v.map((x) => (x === null || x === undefined ? '' : String(x))).join(', ')
      else out[key] = JSON.stringify(v).slice(0, 2000)
    } else out[key] = v
  }
  return out
}

/**
 * quoteSummary modules → rows. Scalar modules merge into one base row per symbol under `module.field`; a list
 * module (`{ transactions: [...] }`, `{ ownershipList: [...] }`, `{ history: [...] }`, `{ trend: [...] }`,
 * `{ holdings: [...] }`) gives one row per item, each carrying the base. inferFrame's own flatten then turns
 * `{ financialData: { grossMargins } }` into the `financialData.grossMargins` column the annotations name.
 */
export function summaryRows(symbol: string, result: QuoteSummaryResult): Row[] {
  const base: Row = { symbol }
  const items: Row[] = []
  for (const [module, value] of Object.entries(result as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const rest: Row = {}
    for (const [k, v] of Object.entries(value as Row)) if (k !== 'maxAge') rest[k] = v
    const listKey = Object.keys(rest).find((k) => Array.isArray(rest[k]) && (rest[k] as unknown[]).length > 0 && (rest[k] as unknown[]).every((x) => x && typeof x === 'object' && !(x instanceof Date)))
    const othersScalar = Object.keys(rest).every((k) => k === listKey || rest[k] === null || typeof rest[k] !== 'object' || rest[k] instanceof Date)
    if (listKey && othersScalar) {
      for (const item of rest[listKey] as Row[]) items.push({ [module]: flattenDeep(item) })
      continue
    }
    base[module] = flattenDeep(rest)
  }
  return items.length > 0 ? items.map((it) => ({ ...base, ...it })) : [base]
}

/** Bars for one symbol as rows, or its events when `events` was asked for. */
export function chartRowsV2(symbol: string, result: ChartResultArray, events: string | undefined): Row[] {
  if (events) {
    const out: Row[] = []
    for (const d of result.events?.dividends ?? []) out.push({ symbol, date: d.date, dividends: { amount: d.amount } })
    for (const s of result.events?.splits ?? []) out.push({ symbol, date: s.date, splits: { numerator: s.numerator, denominator: s.denominator, splitRatio: s.splitRatio } })
    return out.sort((a, b) => (a.date as Date).getTime() - (b.date as Date).getTime())
  }
  return result.quotes.filter((q) => q.close !== null && q.close !== undefined).map((q): Row => ({ symbol, ...q }))
}

/**
 * One symbol's news from a search result as rows in the OpenBB news routes' columns: `date`, `title`, `publisher`,
 * `url`, and `symbols` (the tickers Yahoo relates to the story, else the symbol asked for).
 */
export function newsRows(symbol: string, result: Pick<SearchResult, 'news'>): Row[] {
  return (result.news ?? []).map((n): Row => ({ date: n.providerPublishTime, title: n.title, publisher: n.publisher, url: n.link, symbols: n.relatedTickers?.length ? n.relatedTickers.join(',') : symbol }))
}

/** Every contract of a chain as rows: `type`, the contract's own fields, the underlying's price. */
export function optionRows(symbol: string, result: OptionsResult): Row[] {
  const underlyingPrice = typeof result.quote?.regularMarketPrice === 'number' ? result.quote.regularMarketPrice : null
  const rows: Row[] = []
  for (const chain of result.options) {
    for (const c of chain.calls) rows.push({ symbol, type: 'call', ...c, expiration: chain.expirationDate, underlyingPrice })
    for (const p of chain.puts) rows.push({ symbol, type: 'put', ...p, expiration: chain.expirationDate, underlyingPrice })
  }
  return rows.sort((a, b) => (a.strike as number) - (b.strike as number) || (a.type === b.type ? 0 : a.type === 'call' ? -1 : 1))
}

export function makeCall(client: () => YahooClient, now: () => Date): CallHandler<unknown> {
  const descriptor = (route: string) => yahooDescriptors().find((d) => d.route === route)
  const frame = (route: string, rows: Row[], only?: readonly string[]): Frame => inferFrame(rows, { connector: 'yahoo' }, { descriptor: descriptor(route), only, dropEmpty: rows.length > 0 })

  return async (route: string, params: ValidatedParams, ctx): Promise<Frame> => {
    switch (route as YahooRoute) {
      case 'search': {
        const q = String(params.q ?? '').trim()
        const result = await client().search(q, { quotesCount: 10, newsCount: 0 })
        return frame('search', result.quotes.map((hit): Row => ({ query: q, ...(hit as unknown as Row) })))
      }
      case 'quote': {
        const symbols = normalizeSymbols(strings(params.symbols))
        const quotes = await client().quote(symbols)
        const bySymbol = new Map(quotes.map((q) => [q.symbol.toUpperCase(), q]))
        const rows: Row[] = []
        for (const s of symbols) {
          const q = bySymbol.get(s)
          if (q) rows.push(q as unknown as Row)
          else ctx.log(`quote: skipped ${s}: not in Yahoo response (unknown or delisted symbol)`)
        }
        if (rows.length === 0) throw new Error(`quote: Yahoo returned no quotes for ${symbols.join(', ')}`)
        // Yahoo's quote object has about 80 keys; the frame keeps the descriptor's.
        return frame('quote', rows, [])
      }
      case 'chart': {
        const symbols = normalizeSymbols(strings(params.symbol))
        const events = typeof params.events === 'string' && params.events ? params.events : undefined
        const opts: ChartOptions = { period1: String(params.period1), interval: (params.interval as ChartOptions['interval']) ?? '1d', includePrePost: params.includePrePost === true }
        if (params.period2 !== undefined) opts.period2 = String(params.period2)
        if (events) opts.events = events
        const perSymbol = await fanOut(symbols, async (symbol) => chartRowsV2(symbol, await client().chart(symbol, opts), events), { ctx, kind: 'chart' })
        return frame('chart', perSymbol.flat())
      }
      case 'options': {
        const symbol = String(params.symbol ?? '').trim().toUpperCase()
        const requested = typeof params.date === 'string' ? params.date : undefined
        const first = await client().options(symbol, {})
        if (first.expirationDates.length === 0) throw new Error(`options: ${symbol} has no listed options on Yahoo`)
        let result = first
        if (requested) {
          const expiration = pickExpiration(first.expirationDates, nyDate(now()), requested)
          if (!expiration) throw new Error(`options: ${symbol} has no expiration on or after ${requested}`)
          const wanted = utcDate(expiration)
          if (!first.options.some((o) => utcDate(o.expirationDate) === wanted)) result = await client().options(symbol, { date: expiration })
        }
        const rows = optionRows(symbol, result)
        if (rows.length === 0) throw new Error(`options: Yahoo returned no contracts for ${symbol}`)
        return frame('options', rows)
      }
      case 'quoteSummary': {
        const symbols = normalizeSymbols(strings(params.symbol))
        const modules = strings(params.modules) as QuoteSummaryModules[]
        const perSymbol = await fanOut(symbols, async (symbol) => summaryRows(symbol, await client().quoteSummary(symbol, { modules })), { ctx, kind: 'quoteSummary' })
        return frame('quoteSummary', perSymbol.flat())
      }
      case 'news': {
        const symbols = normalizeSymbols(strings(params.symbol))
        const limit = Number(params.limit ?? 20)
        const perSymbol = await fanOut(symbols, async (symbol) => newsRows(symbol, await client().search(symbol, { quotesCount: 0, newsCount: limit })), { ctx, kind: 'news' })
        // A story that mentions several of the symbols comes back once per search; keep it once, newest first.
        const at = (r: Row) => (r.date instanceof Date ? r.date.getTime() : 0)
        const rows: Row[] = []
        const seen = new Set<unknown>()
        for (const r of perSymbol.flat().sort((a, b) => at(b) - at(a))) {
          if (seen.has(r.url)) continue
          seen.add(r.url)
          rows.push(r)
        }
        return frame('news', rows)
      }
      default:
        throw new Error(`yahoo does not answer route "${route}" (routes: ${YAHOO_ROUTES.join(', ')})`)
    }
  }
}
