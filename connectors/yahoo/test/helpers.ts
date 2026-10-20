// Test support: recorded fixtures replayed through a fake YahooClient. Nothing here touches the network.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Ctx } from '@openterminal/core'
import type { ChartResultArray, OptionsOptions, OptionsResult, Quote, QuoteSummaryResult, SearchResult, YahooClient } from '../src/client.js'

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/

/** Parse a fixture, reviving ISO strings into Dates the way yahoo-finance2's validator does. */
export function loadFixture<T = any>(name: string): T {
  const text = readFileSync(join(fixtureDir, `${name}.json`), 'utf8')
  return JSON.parse(text, (_k, v) => (typeof v === 'string' && ISO.test(v) ? new Date(v) : v)) as T
}

export type SearchFixture = { recordedAt: Date; byTerm: Record<string, SearchResult> }
export type QuoteFixture = { recordedAt: Date; symbols: string[]; result: Quote[] }
export type ChartFixture = {
  recordedAt: Date
  byKey: Record<string, { request: { symbol: string; interval: string; period1: Date; period2: Date }; count: number; meta: ChartResultArray['meta']; quotes: ChartResultArray['quotes'] }>
}
export type SummaryFixture = { recordedAt: Date; bySymbol: Record<string, QuoteSummaryResult | { error: string }> }
/** v1.2 quoteSummary modules per symbol (MU, NVDA equities; SMH an ETF), trimmed to the fields the handlers read. */
export type SummaryModulesFixture = { recordedAt: Date; bySymbol: Record<string, QuoteSummaryResult> }
/** Option chains keyed by the requested expiration (`default` is the no-date call), each trimmed to 14 strikes a side. */
export type OptionsFixture = {
  recordedAt: Date
  bySymbol: Record<
    string,
    { underlyingSymbol: string; expirationDates: Date[]; quote: Partial<Quote>; byDate: Record<string, { expirationDate: Date; counts: { calls: number; puts: number }; calls: OptionsResult['options'][number]['calls']; puts: OptionsResult['options'][number]['puts'] }> }
  >
}
/** Dividend events from the chart endpoint (bars dropped), last 15 per symbol. */
export type DividendsFixture = { recordedAt: Date; bySymbol: Record<string, { meta: ChartResultArray['meta']; count: number; events: ChartResultArray['events']; quotes: [] }> }

export const fixtures = {
  search: () => loadFixture<SearchFixture>('search'),
  /** Search results asked for news only (`quotesCount: 0, newsCount: 5`): TSLA, NVDA, and a term with none. */
  news: () => loadFixture<SearchFixture>('news'),
  quote: () => loadFixture<QuoteFixture>('quote'),
  chart: () => loadFixture<ChartFixture>('chart'),
  quoteSummary: () => loadFixture<SummaryFixture>('quoteSummary'),
  summaryModules: () => loadFixture<SummaryModulesFixture>('summaryModules'),
  options: () => loadFixture<OptionsFixture>('options'),
  dividends: () => loadFixture<DividendsFixture>('dividends'),
}

/** Every argument each fake method was called with, for asserting request shapes. */
export type Calls = {
  search: [string, unknown][]
  quote: [string[]][]
  chart: [string, unknown][]
  quoteSummary: [string, unknown][]
  options: [string, unknown][]
}

/**
 * A YahooClient backed by the fixtures. Search lookups are by term (the news fixture when `newsCount` asks for news).
 * Chart lookups are by `${symbol}-${interval}` (or the dividends fixture when `events` asks for them); pass `chartKeys`
 * to alias requests onto a recorded key. quoteSummary serves only the requested modules, merged from the
 * calendarEvents and v1.2 fixtures. Override any method to simulate failures.
 */
export function fakeClient(overrides: Partial<YahooClient> & { chartKeys?: Record<string, string> } = {}): YahooClient & { calls: Calls } {
  const search = fixtures.search()
  const news = fixtures.news()
  const quote = fixtures.quote()
  const chart = fixtures.chart()
  const summary = fixtures.quoteSummary()
  const modules = fixtures.summaryModules()
  const options = fixtures.options()
  const dividends = fixtures.dividends()
  const calls: Calls = { search: [], quote: [], chart: [], quoteSummary: [], options: [] }
  const { chartKeys = {}, ...methods } = overrides
  const base: YahooClient = {
    async search(term, opts) {
      calls.search.push([term, opts])
      // A search that asks for news is the news route's; the other one is the symbol lookup's.
      const r = ((opts.newsCount ?? 0) > 0 ? news : search).byTerm[term]
      if (!r) throw new Error(`no search fixture for ${JSON.stringify(term)}`)
      return r
    },
    async quote(symbols) {
      calls.quote.push([symbols])
      return quote.result.filter((q) => symbols.includes(q.symbol))
    },
    async chart(symbol, opts) {
      calls.chart.push([symbol, opts])
      if (/div/.test((opts as { events?: string }).events ?? '')) {
        const d = dividends.bySymbol[symbol]
        if (!d) throw new Error(`no dividends fixture for ${symbol}`)
        return { meta: d.meta, events: d.events, quotes: [] }
      }
      const key = chartKeys[symbol] ?? `${symbol}-${(opts as { interval?: string }).interval ?? '1d'}`
      const hit = Object.entries(chart.byKey).find(([k]) => k.startsWith(key))
      if (!hit) throw new Error(`no chart fixture for ${key}`)
      return { meta: hit[1].meta, quotes: hit[1].quotes }
    },
    async quoteSummary(symbol, opts) {
      calls.quoteSummary.push([symbol, opts])
      const recorded = summary.bySymbol[symbol]
      const merged: Record<string, unknown> = { ...(recorded && !('error' in recorded) ? recorded : {}), ...(modules.bySymbol[symbol] ?? {}) }
      const out: Record<string, unknown> = {}
      for (const m of opts.modules) if (m in merged) out[m] = merged[m]
      if (Object.keys(out).length > 0) return out as QuoteSummaryResult
      if (recorded && 'error' in recorded) throw new Error(String(recorded.error).replace(/^Error: /, ''))
      throw new Error(`no quoteSummary fixture for ${symbol} (${opts.modules.join(', ')})`)
    },
    async options(symbol, opts) {
      calls.options.push([symbol, opts])
      const o = options.bySymbol[symbol]
      if (!o) throw new Error(`no options fixture for ${symbol}`)
      const date = (opts as OptionsOptions).date
      const key = date === undefined ? 'default' : new Date(date).toISOString()
      const chain = o.byDate[key]
      if (!chain) throw new Error(`no options fixture for ${symbol} at ${key}`)
      return {
        underlyingSymbol: o.underlyingSymbol,
        expirationDates: o.expirationDates,
        strikes: [],
        hasMiniOptions: false,
        quote: o.quote as Quote,
        options: [{ expirationDate: chain.expirationDate, hasMiniOptions: false, calls: chain.calls, puts: chain.puts }],
      }
    },
  }
  // Overrides still record their calls so tests can assert request shapes on failing paths.
  const recorded: YahooClient = {
    search: (t, o) => { if (methods.search) calls.search.push([t, o]); return (methods.search ?? base.search)(t, o) },
    quote: (s) => { if (methods.quote) calls.quote.push([s]); return (methods.quote ?? base.quote)(s) },
    chart: (s, o) => { if (methods.chart) calls.chart.push([s, o]); return (methods.chart ?? base.chart)(s, o) },
    quoteSummary: (s, o) => { if (methods.quoteSummary) calls.quoteSummary.push([s, o]); return (methods.quoteSummary ?? base.quoteSummary)(s, o) },
    options: (s, o) => { if (methods.options) calls.options.push([s, o]); return (methods.options ?? base.options)(s, o) },
  }
  return { ...recorded, calls }
}

/** A handler context whose log lines are captured. */
export function testCtx(): Ctx<Record<string, never>> & { logs: string[] } {
  const logs: string[] = []
  return {
    http: { get: async () => { throw new Error('http.get is not used by the yahoo connector') } },
    config: {},
    log: (m) => logs.push(m),
    logs,
  }
}

/** Rows as objects keyed by column name. */
export function objects(frame: { columns: { name: string }[]; rows: unknown[][] }): Record<string, unknown>[] {
  return frame.rows.map((r) => Object.fromEntries(frame.columns.map((c, i) => [c.name, r[i]])))
}

/** Friday 2026-10-16 16:40 ET (20:40Z), after the close: the moment the fixtures were recorded. */
export const RECORDED_AT = new Date('2026-10-16T20:40:00.000Z')

/** Sunday 2026-10-18 08:00 ET: the day after the v1.2 fixtures were recorded (Saturday evening ET), used as "today" for option expirations. */
export const V12_NOW = new Date('2026-10-18T12:00:00.000Z')
