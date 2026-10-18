import { toFrame, type Ctx, type Frame, type KindParams } from '@terminal/core'
import type { ChartResultArray, YahooClient } from './client.js'
import { fanOut, normalizeSymbols } from './fanout.js'
import { nyDate } from './time.js'
import { date, num } from './values.js'

/** How far back to ask for dividend events: 60 quarterly payments is 15 years, so 30 covers the catalog's limit for any payer. */
export const DIVIDEND_LOOKBACK_MS = 30 * 365.25 * 86_400_000

type DividendRow = { symbol: string; ex_date: string; amount: number | null }

/** Dividend events, newest first, at most `limit`. Yahoo stamps each at the ex-date's session open, so the New York date is the ex-date. */
export function dividendRows(symbol: string, result: ChartResultArray, limit: number): DividendRow[] {
  const rows: DividendRow[] = []
  for (const d of result.events?.dividends ?? []) {
    const at = date(d.date)
    if (!at) continue
    rows.push({ symbol, ex_date: nyDate(at), amount: num(d.amount) })
  }
  return rows.sort((a, b) => (a.ex_date < b.ex_date ? 1 : a.ex_date > b.ex_date ? -1 : 0)).slice(0, limit)
}

export function makeDividends(client: () => YahooClient, now: () => Date) {
  return async (params: KindParams<'dividends'>, ctx: Ctx<unknown>): Promise<Frame> => {
    const symbols = normalizeSymbols(params.symbols)
    const period2 = now()
    const period1 = new Date(period2.getTime() - DIVIDEND_LOOKBACK_MS)
    // Events come back whatever the bar interval, so monthly bars keep the payload small.
    const perSymbol = await fanOut(
      symbols,
      async (symbol) => dividendRows(symbol, await client().chart(symbol, { period1, period2, interval: '1mo', events: 'div', includePrePost: false }), params.limit),
      { ctx, kind: 'dividends' },
    )
    return toFrame('dividends', perSymbol.flat(), { connector: 'yahoo' })
  }
}
