import { toFrame, type Ctx, type Frame, type KindParams } from '@terminal/core'
import type { QuoteSummaryResult, YahooClient } from './client.js'
import { fanOut, normalizeSymbols } from './fanout.js'
import { nyDate } from './time.js'

export function isNoFundamentals(err: unknown): boolean {
  return err instanceof Error && /no fundamentals data/i.test(err.message)
}

type EarningsRow = { symbol: string; date: string; session: null; eps_estimate: number | null }

/**
 * The next earnings date Yahoo knows for a symbol, or undefined when it has none (ETFs, or nothing scheduled).
 * Yahoo stamps the date at 20:00Z whether or not the hour is known, so `session` is always null here.
 */
export function earningsRow(symbol: string, summary: QuoteSummaryResult): EarningsRow | undefined {
  const e = summary.calendarEvents?.earnings
  const first = e?.earningsDate?.[0]
  if (!(first instanceof Date) || Number.isNaN(first.getTime())) return undefined
  const avg = e?.earningsAverage
  return { symbol, date: nyDate(first), session: null, eps_estimate: typeof avg === 'number' ? avg : null }
}

export function makeEarnings(client: () => YahooClient) {
  return async (params: KindParams<'earnings'>, ctx: Ctx<unknown>): Promise<Frame> => {
    const symbols = normalizeSymbols(params.symbols)
    const maybeRows = await fanOut(
      symbols,
      async (symbol) => {
        let summary: QuoteSummaryResult
        try {
          summary = await client().quoteSummary(symbol, { modules: ['calendarEvents'] })
        } catch (err) {
          // ETFs and indexes have no fundamentals; that is "no earnings", not a failure.
          if (isNoFundamentals(err)) {
            ctx.log(`earnings: ${symbol} has no fundamentals on Yahoo (ETF or index?)`)
            return undefined
          }
          throw err
        }
        const row = earningsRow(symbol, summary)
        if (!row) ctx.log(`earnings: ${symbol} has no earnings date on Yahoo`)
        return row
      },
      { ctx, kind: 'earnings' },
    )
    // ISO dates compare correctly as strings.
    const rows = maybeRows.filter((r): r is EarningsRow => r !== undefined && r.date >= params.from && r.date <= params.to)
    return toFrame('earnings', rows, { connector: 'yahoo' })
  }
}
