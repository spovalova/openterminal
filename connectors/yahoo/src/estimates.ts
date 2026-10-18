import { toFrame, type Ctx, type Frame, type KindParams } from '@terminal/core'
import type { QuoteSummaryModules, QuoteSummaryResult, YahooClient } from './client.js'
import { fanOut, normalizeSymbols } from './fanout.js'
import { num, pct, round, str } from './values.js'

/** financialData carries the recommendation and targets; earningsTrend the EPS estimates by period (0q current quarter, 0y current fiscal year). */
export const ESTIMATES_MODULES: QuoteSummaryModules[] = ['financialData', 'earningsTrend']

/** One estimates row, or undefined when Yahoo returned neither module. upside_pct and eps_growth_y are percent. */
export function estimatesRow(symbol: string, r: QuoteSummaryResult): Record<string, unknown> | undefined {
  const fd = r.financialData
  const trend = r.earningsTrend?.trend
  if (!fd && !trend) return undefined
  const q = trend?.find((t) => t.period === '0q')
  const y = trend?.find((t) => t.period === '0y')
  const price = num(fd?.currentPrice)
  const mean = num(fd?.targetMeanPrice)
  return {
    symbol,
    recommendation: str(fd?.recommendationKey),
    analysts: num(fd?.numberOfAnalystOpinions),
    target_low: num(fd?.targetLowPrice),
    target_consensus: mean,
    target_high: num(fd?.targetHighPrice),
    upside_pct: mean !== null && price !== null && price > 0 ? round(((mean - price) / price) * 100, 4) : null,
    eps_estimate_q: num(q?.earningsEstimate?.avg),
    eps_estimate_y: num(y?.earningsEstimate?.avg),
    eps_growth_y: pct(y?.earningsEstimate?.growth ?? y?.growth),
  }
}

export function makeEstimates(client: () => YahooClient) {
  return async (params: KindParams<'estimates'>, ctx: Ctx<unknown>): Promise<Frame> => {
    const symbols = normalizeSymbols(params.symbols)
    const rows = await fanOut(
      symbols,
      async (symbol) => {
        const row = estimatesRow(symbol, await client().quoteSummary(symbol, { modules: ESTIMATES_MODULES }))
        if (!row) throw new Error('no estimates on Yahoo')
        return row
      },
      { ctx, kind: 'estimates' },
    )
    return toFrame('estimates', rows, { connector: 'yahoo' })
  }
}
