// Yahoo's quote data for one ticker: the quoteSummary modules and the v7 quote merged into one flat record, the way
// yfinance's `Ticker.info` presents them. Independent implementation of OpenBB's output for the routes that read it
// (not derived from openbb_yfinance, which is AGPL); Yahoo endpoints as used by yfinance (Apache-2.0).
import { NativeHttpError } from '../http.js'
import type { NativeCtx, Row } from '../types.js'
import { isRecord, Q1, yahooJson } from './helpers.js'

/** quoteSummary modules for one symbol, `formatted=false` (plain numbers); undefined when Yahoo has no such symbol. */
export async function quoteSummary(ctx: NativeCtx, symbol: string, modules: string[]): Promise<Row | undefined> {
  try {
    const body = await yahooJson<{ quoteSummary?: { result?: Row[] | null } }>(ctx, `${Q1}/v10/finance/quoteSummary/${encodeURIComponent(symbol)}`, {
      crumb: true,
      query: { modules: modules.join(','), corsDomain: 'finance.yahoo.com', formatted: 'false', symbol, lang: 'en-US', region: 'US' },
    })
    return body.quoteSummary?.result?.[0] ?? undefined
  } catch (err) {
    // 404 is an unknown symbol; Yahoo also answers 500 for a module it has no data for.
    if (err instanceof NativeHttpError && (err.status === 404 || err.status === 500)) return undefined
    throw err
  }
}

/** The v7 quote for symbols (plain numbers), by symbol. */
export async function v7Quote(ctx: NativeCtx, symbols: string[]): Promise<Map<string, Row>> {
  const body = await yahooJson<{ quoteResponse?: { result?: Row[] | null } }>(ctx, `${Q1}/v7/finance/quote`, { crumb: true, query: { symbols: symbols.join(','), formatted: 'false', lang: 'en-US', region: 'US' } })
  return new Map((body.quoteResponse?.result ?? []).map((r) => [String(r.symbol), r]))
}

const INFO_MODULES = ['financialData', 'quoteType', 'defaultKeyStatistics', 'assetProfile', 'summaryDetail']

/** Values flattened one level (each module's fields side by side), nulls dropped, `{raw}` wrappers unwrapped. */
export function flattenModules(result: Row | undefined): Row {
  const out: Row = {}
  for (const module of Object.values(result ?? {})) {
    if (!isRecord(module)) continue
    for (const [k, x] of Object.entries(module)) if (x !== null && x !== undefined) out[k] = unwrap(x)
  }
  return out
}

function unwrap(v: unknown): unknown {
  if (isRecord(v) && 'raw' in v) return v.raw
  if (Array.isArray(v)) return v.map(unwrap)
  if (isRecord(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unwrap(x)]))
  return typeof v === 'string' ? v.replace(/ /g, ' ') : v
}

/** What yfinance's `Ticker.info` holds: the five modules, then the v7 quote's own fields over them. */
export async function tickerInfo(ctx: NativeCtx, symbol: string): Promise<Row | undefined> {
  const [summary, quotes] = await Promise.all([quoteSummary(ctx, symbol, INFO_MODULES), v7Quote(ctx, [symbol])])
  const quote = quotes.get(symbol)
  if (!summary && !quote) return undefined
  const info = flattenModules(summary)
  if (quote) for (const [k, v] of Object.entries(quote)) if (v !== null && v !== undefined) info[k] = unwrap(v)
  info.symbol = symbol
  return info
}

export type TimeseriesPoint = { asOfDate: string; periodType?: string; currencyCode?: string; value: number }

/**
 * Fundamentals time series (statement lines and valuation ratios) for one symbol: for each type asked, its points
 * oldest first. Types are Yahoo's names, e.g. `annualTotalRevenue` or `trailingPegRatio`.
 */
export async function fundamentalsTimeseries(ctx: NativeCtx, symbol: string, types: string[], period1: number, period2: number): Promise<Map<string, TimeseriesPoint[]>> {
  const body = await yahooJson<{ timeseries?: { result?: Row[] | null } }>(ctx, `${Q1}/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(symbol)}`, {
    query: { symbol, type: types.join(','), period1, period2, lang: 'en-US', region: 'US' },
  })
  const out = new Map<string, TimeseriesPoint[]>()
  for (const entry of body.timeseries?.result ?? []) {
    for (const type of types) {
      const list = entry[type]
      if (!Array.isArray(list)) continue
      const points: TimeseriesPoint[] = []
      for (const p of list) {
        if (!isRecord(p)) continue
        const value = (isRecord(p.reportedValue) ? p.reportedValue.raw : undefined) as unknown
        if (typeof value !== 'number') continue
        points.push({ asOfDate: String(p.asOfDate), ...(typeof p.periodType === 'string' ? { periodType: p.periodType } : {}), ...(typeof p.currencyCode === 'string' ? { currencyCode: p.currencyCode } : {}), value })
      }
      out.set(type, [...(out.get(type) ?? []), ...points].sort((a, b) => a.asOfDate.localeCompare(b.asOfDate)))
    }
  }
  return out
}

/** The latest trailing PEG ratio, which Yahoo keeps in the time series rather than in the quote modules. */
export async function trailingPegRatio(ctx: NativeCtx, symbol: string): Promise<number | undefined> {
  const day = 86_400
  const now = Math.floor(ctx.now().getTime() / 1000)
  const points = (await fundamentalsTimeseries(ctx, symbol, ['trailingPegRatio'], now - 182 * day, now + day)).get('trailingPegRatio')
  return points?.at(-1)?.value
}
