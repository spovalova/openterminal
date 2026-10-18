import { toFrame, type Ctx, type Frame, type KindParams } from '@terminal/core'
import type { QuoteSummaryModules, QuoteSummaryResult, YahooClient } from './client.js'
import { fanOut, normalizeSymbols } from './fanout.js'
import { num, pct, round } from './values.js'

/** Multiples and yield live in summaryDetail and defaultKeyStatistics, margins, growth, returns and leverage in financialData; price is for the yield cross-check. */
export const METRICS_MODULES: QuoteSummaryModules[] = ['summaryDetail', 'defaultKeyStatistics', 'financialData', 'price']

type Yieldy = { dividendYield?: unknown; yield?: unknown; dividendRate?: unknown; trailingAnnualDividendYield?: unknown }

/**
 * Dividend yield as a percent. Yahoo has shipped `dividendYield` both as a fraction (0.0063) and as a
 * percent (0.63), so the reading is checked against a reference yield (dividendRate / price, else the
 * trailing yield, both reliably fractions) and whichever scale lands closer wins. Funds carry `yield` instead.
 */
export function dividendYieldPct(sd: Yieldy | undefined, price: number | null): number | null {
  const y = num(sd?.dividendYield) ?? num(sd?.yield)
  const rate = num(sd?.dividendRate)
  const ref = rate !== null && price !== null && price > 0 ? rate / price : num(sd?.trailingAnnualDividendYield)
  if (y === null) return ref === null ? null : pct(ref)
  if (ref === null || ref <= 0) return pct(y)
  return Math.abs(y - ref * 100) < Math.abs(y * 100 - ref * 100) ? round(y, 4) : pct(y)
}

/** One metrics row, or undefined when Yahoo returned none of the modules. Fractions become percent; debtToEquity (percent on Yahoo) becomes a ratio. */
export function metricsRow(symbol: string, r: QuoteSummaryResult): Record<string, unknown> | undefined {
  const sd = r.summaryDetail
  const ks = r.defaultKeyStatistics
  const fd = r.financialData
  if (!sd && !ks && !fd) return undefined
  const d2e = num(fd?.debtToEquity)
  return {
    symbol,
    market_cap: num(sd?.marketCap) ?? num(r.price?.marketCap),
    pe: num(sd?.trailingPE),
    forward_pe: num(sd?.forwardPE) ?? num(ks?.forwardPE),
    peg: num(ks?.pegRatio),
    ev_ebitda: num(ks?.enterpriseToEbitda),
    ps: num(sd?.priceToSalesTrailing12Months),
    pb: num(ks?.priceToBook),
    gross_margin: pct(fd?.grossMargins),
    operating_margin: pct(fd?.operatingMargins),
    profit_margin: pct(fd?.profitMargins ?? ks?.profitMargins),
    revenue_growth: pct(fd?.revenueGrowth),
    earnings_growth: pct(fd?.earningsGrowth),
    roe: pct(fd?.returnOnEquity),
    debt_to_equity: d2e === null ? null : round(d2e / 100, 4),
    dividend_yield: dividendYieldPct(sd, num(r.price?.regularMarketPrice) ?? num(fd?.currentPrice)),
  }
}

export function makeMetrics(client: () => YahooClient) {
  return async (params: KindParams<'metrics'>, ctx: Ctx<unknown>): Promise<Frame> => {
    const symbols = normalizeSymbols(params.symbols)
    const rows = await fanOut(
      symbols,
      async (symbol) => {
        const row = metricsRow(symbol, await client().quoteSummary(symbol, { modules: METRICS_MODULES }))
        if (!row) throw new Error('no metrics data on Yahoo')
        return row
      },
      { ctx, kind: 'metrics' },
    )
    return toFrame('metrics', rows, { connector: 'yahoo' })
  }
}
