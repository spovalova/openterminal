// equity/estimates/consensus, equity/estimates/price_target and yfinance/estimates/{earnings, revenue, eps_revisions,
// eps_trend, growth, recommendations}, provider yfinance. Independent implementation of OpenBB's output for these
// routes (not derived from openbb_yfinance, which is AGPL); Yahoo endpoints as used by yfinance (Apache-2.0).
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { compact, isRecord, raw, symbolsOf, utcDate } from './helpers.js'
import { quoteSummary } from './quote.js'

const list = (v: unknown): Row[] => (Array.isArray(v) ? v.filter(isRecord) : [])

/** A module's field, unwrapped from Yahoo's `{ raw, fmt }`. */
const field = (o: unknown, key: string): unknown => (isRecord(o) ? raw(o[key]) : undefined)

/** Rows built from each symbol's quoteSummary modules; a symbol Yahoo does not know is left out. */
async function forSymbols(params: NativeParams, ctx: NativeCtx, modules: string[], build: (symbol: string, result: Row) => Row[]): Promise<Row[]> {
  const rows: Row[] = []
  for (const symbol of symbolsOf(params)) {
    const result = await quoteSummary(ctx, symbol, modules)
    if (result) rows.push(...build(symbol, result).map(compact))
  }
  return rows
}

const trendOf = (result: Row): Row[] => list((result.earningsTrend as Row | undefined)?.trend)

export const earningsEstimates = (params: NativeParams, ctx: NativeCtx): Promise<Row[]> =>
  forSymbols(params, ctx, ['earningsTrend'], (symbol, result) =>
    trendOf(result).map((t) => {
      const e = t.earningsEstimate
      return { symbol, period: t.period, mean: field(e, 'avg'), low: field(e, 'low'), high: field(e, 'high'), number_of_analysts: field(e, 'numberOfAnalysts'), year_ago_eps: field(e, 'yearAgoEps'), growth: field(e, 'growth'), currency: isRecord(e) ? e.earningsCurrency : undefined }
    }),
  )

export const revenueEstimates = (params: NativeParams, ctx: NativeCtx): Promise<Row[]> =>
  forSymbols(params, ctx, ['earningsTrend'], (symbol, result) =>
    trendOf(result).map((t) => {
      const e = t.revenueEstimate
      return { symbol, period: t.period, mean: field(e, 'avg'), low: field(e, 'low'), high: field(e, 'high'), number_of_analysts: field(e, 'numberOfAnalysts'), year_ago_revenue: field(e, 'yearAgoRevenue'), growth: field(e, 'growth'), currency: isRecord(e) ? e.revenueCurrency : undefined }
    }),
  )

export const epsRevisions = (params: NativeParams, ctx: NativeCtx): Promise<Row[]> =>
  forSymbols(params, ctx, ['earningsTrend'], (symbol, result) =>
    trendOf(result).map((t) => {
      const r = t.epsRevisions
      const currency = isRecord(t.earningsEstimate) ? t.earningsEstimate.earningsCurrency : undefined
      return { symbol, period: t.period, up_last_7_days: field(r, 'upLast7days'), up_last_30_days: field(r, 'upLast30days'), down_last_7_days: field(r, 'downLast7Days') ?? field(r, 'downLast7days'), down_last_30_days: field(r, 'downLast30days'), currency }
    }),
  )

export const epsTrend = (params: NativeParams, ctx: NativeCtx): Promise<Row[]> =>
  forSymbols(params, ctx, ['earningsTrend'], (symbol, result) =>
    trendOf(result).map((t) => {
      const e = t.epsTrend
      const currency = isRecord(t.earningsEstimate) ? t.earningsEstimate.earningsCurrency : undefined
      return { symbol, period: t.period, current: field(e, 'current'), days_ago_7: field(e, '7daysAgo'), days_ago_30: field(e, '30daysAgo'), days_ago_60: field(e, '60daysAgo'), days_ago_90: field(e, '90daysAgo'), currency }
    }),
  )

/** Growth of the stock and of its index, for each period the index lists (the long-term "LTG" has no stock figure). */
export const growthEstimates = (params: NativeParams, ctx: NativeCtx): Promise<Row[]> =>
  forSymbols(params, ctx, ['earningsTrend', 'indexTrend'], (symbol, result) => {
    const stock = new Map(trendOf(result).map((t) => [t.period, raw(t.growth)]))
    const index = list((result.indexTrend as Row | undefined)?.estimates)
    const periods = [...new Set([...trendOf(result).map((t) => t.period), ...index.map((i) => i.period)])]
    return periods.map((period) => ({ symbol, period, stock_trend: stock.get(period), index_trend: raw(index.find((i) => i.period === period)?.growth) }))
  })

export const recommendationTrend = (params: NativeParams, ctx: NativeCtx): Promise<Row[]> =>
  forSymbols(params, ctx, ['recommendationTrend'], (symbol, result) =>
    list((result.recommendationTrend as Row | undefined)?.trend).map((t) => ({ symbol, period: t.period, strong_buy: t.strongBuy, buy: t.buy, hold: t.hold, sell: t.sell, strong_sell: t.strongSell })),
  )

/** Analyst price targets, rating and recommendation consensus from Yahoo's financial data. */
export const consensus = (params: NativeParams, ctx: NativeCtx): Promise<Row[]> =>
  forSymbols(params, ctx, ['financialData'], (symbol, result) => {
    const f = (result.financialData ?? {}) as Row
    return [{ symbol, target_high: raw(f.targetHighPrice), target_low: raw(f.targetLowPrice), target_consensus: raw(f.targetMeanPrice), target_median: raw(f.targetMedianPrice), recommendation: f.recommendationKey, recommendation_mean: raw(f.recommendationMean), number_of_analysts: raw(f.numberOfAnalystOpinions), current_price: raw(f.currentPrice), currency: f.financialCurrency }]
  })

/** Upgrades, downgrades and price target changes, oldest first. */
export async function priceTarget(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const limit = typeof params.limit === 'number' ? params.limit : undefined
  // The limit is per symbol.
  return forSymbols(params, ctx, ['upgradeDowngradeHistory'], (symbol, result) =>
    list((result.upgradeDowngradeHistory as Row | undefined)?.history)
      .sort((a, b) => Number(raw(a.epochGradeDate)) - Number(raw(b.epochGradeDate)))
      .map((h) => ({
        published_date: typeof raw(h.epochGradeDate) === 'number' ? utcDate(raw(h.epochGradeDate) as number) : undefined,
        symbol,
        analyst_firm: h.firm,
        price_target: raw(h.currentPriceTarget),
        price_target_previous: raw(h.priorPriceTarget),
        rating_current: h.toGrade,
        rating_previous: h.fromGrade,
        action: h.action,
        price_target_action: h.priceTargetAction,
      }))
      .slice(0, limit),
  )
}
