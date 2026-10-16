// Test support: recorded fixtures replayed through a fake YahooClient. Nothing here touches the network.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Ctx } from '@terminal/core'
import type { ChartResultArray, Quote, QuoteSummaryResult, SearchResult, YahooClient } from '../src/client.js'

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

export const fixtures = {
  search: () => loadFixture<SearchFixture>('search'),
  quote: () => loadFixture<QuoteFixture>('quote'),
  chart: () => loadFixture<ChartFixture>('chart'),
  quoteSummary: () => loadFixture<SummaryFixture>('quoteSummary'),
}

/** Every argument each fake method was called with, for asserting request shapes. */
export type Calls = {
  search: [string, unknown][]
  quote: [string[]][]
  chart: [string, unknown][]
  quoteSummary: [string, unknown][]
}

/**
 * A YahooClient backed by the fixtures. Chart lookups are by `${symbol}-${interval}`; pass `chartKeys`
 * to alias requests onto a recorded key. Override any method to simulate failures.
 */
export function fakeClient(overrides: Partial<YahooClient> & { chartKeys?: Record<string, string> } = {}): YahooClient & { calls: Calls } {
  const search = fixtures.search()
  const quote = fixtures.quote()
  const chart = fixtures.chart()
  const summary = fixtures.quoteSummary()
  const calls: Calls = { search: [], quote: [], chart: [], quoteSummary: [] }
  const { chartKeys = {}, ...methods } = overrides
  const base: YahooClient = {
    async search(term, opts) {
      calls.search.push([term, opts])
      const r = search.byTerm[term]
      if (!r) throw new Error(`no search fixture for ${JSON.stringify(term)}`)
      return r
    },
    async quote(symbols) {
      calls.quote.push([symbols])
      return quote.result.filter((q) => symbols.includes(q.symbol))
    },
    async chart(symbol, opts) {
      calls.chart.push([symbol, opts])
      const key = chartKeys[symbol] ?? `${symbol}-${(opts as { interval?: string }).interval ?? '1d'}`
      const hit = Object.entries(chart.byKey).find(([k]) => k.startsWith(key))
      if (!hit) throw new Error(`no chart fixture for ${key}`)
      return { meta: hit[1].meta, quotes: hit[1].quotes }
    },
    async quoteSummary(symbol, opts) {
      calls.quoteSummary.push([symbol, opts])
      const r = summary.bySymbol[symbol]
      if (!r) throw new Error(`no quoteSummary fixture for ${symbol}`)
      if ('error' in r) throw new Error(String(r.error).replace(/^Error: /, ''))
      return r
    },
  }
  // Overrides still record their calls so tests can assert request shapes on failing paths.
  const recorded: YahooClient = {
    search: (t, o) => { if (methods.search) calls.search.push([t, o]); return (methods.search ?? base.search)(t, o) },
    quote: (s) => { if (methods.quote) calls.quote.push([s]); return (methods.quote ?? base.quote)(s) },
    chart: (s, o) => { if (methods.chart) calls.chart.push([s, o]); return (methods.chart ?? base.chart)(s, o) },
    quoteSummary: (s, o) => { if (methods.quoteSummary) calls.quoteSummary.push([s, o]); return (methods.quoteSummary ?? base.quoteSummary)(s, o) },
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
