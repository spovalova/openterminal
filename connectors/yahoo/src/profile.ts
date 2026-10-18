import { toFrame, type Ctx, type Frame, type KindParams } from '@terminal/core'
import type { QuoteSummaryModules, QuoteSummaryResult, YahooClient } from './client.js'
import { fanOut, normalizeSymbols } from './fanout.js'
import { num, str } from './values.js'

/** assetProfile carries the company facts; price and summaryDetail the listing, market cap and beta; defaultKeyStatistics the fund beta. */
export const PROFILE_MODULES: QuoteSummaryModules[] = ['assetProfile', 'price', 'summaryDetail', 'defaultKeyStatistics']

/** One profile row, or undefined when Yahoo returned none of the modules (unknown symbol). ETFs have no sector, industry, or employees. */
export function profileRow(symbol: string, r: QuoteSummaryResult): Record<string, unknown> | undefined {
  const ap = r.assetProfile
  const p = r.price
  const sd = r.summaryDetail
  if (!ap && !p && !sd) return undefined
  return {
    symbol,
    name: str(p?.longName) ?? str(p?.shortName),
    exchange: str(p?.exchangeName) ?? str(p?.exchange),
    sector: str(ap?.sector),
    industry: str(ap?.industry),
    market_cap: num(p?.marketCap) ?? num(sd?.marketCap),
    employees: num(ap?.fullTimeEmployees),
    beta: num(sd?.beta) ?? num(r.defaultKeyStatistics?.beta3Year),
    description: str(ap?.longBusinessSummary),
  }
}

export function makeProfile(client: () => YahooClient) {
  return async (params: KindParams<'profile'>, ctx: Ctx<unknown>): Promise<Frame> => {
    const symbols = normalizeSymbols(params.symbols)
    const rows = await fanOut(
      symbols,
      async (symbol) => {
        const row = profileRow(symbol, await client().quoteSummary(symbol, { modules: PROFILE_MODULES }))
        if (!row) throw new Error('no profile data on Yahoo')
        return row
      },
      { ctx, kind: 'profile' },
    )
    return toFrame('profile', rows, { connector: 'yahoo' })
  }
}
