import { toFrame, type Ctx, type Frame, type KindParams } from '@terminal/core'
import type { ChartResultArray, YahooClient } from './client.js'
import { fanOut, normalizeSymbols } from './fanout.js'
import { rangeToPeriod, toYahooInterval } from './time.js'

type Bar = { symbol: string; time: number; open: number | null; high: number | null; low: number | null; close: number | null; volume: number | null }

/** Bars for one symbol. Bars with a null close (gaps, and the live partial bar before its first trade) are dropped. */
export function chartRows(symbol: string, result: ChartResultArray): Bar[] {
  const rows: Bar[] = []
  for (const q of result.quotes) {
    if (q.close === null || q.close === undefined) continue
    rows.push({
      symbol,
      time: q.date.getTime(),
      open: q.open ?? null,
      high: q.high ?? null,
      low: q.low ?? null,
      close: q.close,
      volume: q.volume ?? null,
    })
  }
  return rows
}

export function makeOhlcv(client: () => YahooClient, now: () => Date) {
  return async (params: KindParams<'ohlcv'>, ctx: Ctx<unknown>): Promise<Frame> => {
    const symbols = normalizeSymbols(params.symbols)
    const { period1, period2 } = rangeToPeriod(params.range, now())
    const interval = toYahooInterval(params.interval)
    const perSymbol = await fanOut(
      symbols,
      async (symbol) => chartRows(symbol, await client().chart(symbol, { period1, period2, interval, includePrePost: false })),
      { ctx, kind: 'ohlcv' },
    )
    const rows = perSymbol.flat().sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : a.time - b.time))
    return toFrame('ohlcv', rows, { connector: 'yahoo' })
  }
}
