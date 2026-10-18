import { toFrame, type Ctx, type Frame, type KindParams } from '@terminal/core'
import type { QuoteSummaryResult, YahooClient } from './client.js'
import { fanOut, normalizeSymbols } from './fanout.js'
import { utcDate } from './time.js'
import { date, num, round } from './values.js'

/**
 * The prior month's shares short. yahoo-finance2 types `sharesShortPriorMonth` as a Date, so its validator
 * turns the share count Yahoo sends into a seconds-epoch Date (26,023,190 shares becomes 1970-12-10); this
 * undoes that, and also accepts a plain number should the library fix the schema.
 */
export function priorMonthShares(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  const d = date(v)
  return d ? Math.round(d.getTime() / 1000) : null
}

type ShortRow = { symbol: string; date: string; short_interest: number; change_pct: number | null; avg_volume: number | null; days_to_cover: number | null }

/**
 * The latest settlement only: Yahoo's defaultKeyStatistics carries one report, not the series.
 * avg_volume is recovered from shares short / days to cover, the basis Yahoo used, rounded to whole shares.
 */
export function shortInterestRow(symbol: string, r: QuoteSummaryResult): ShortRow | undefined {
  const ks = r.defaultKeyStatistics
  const settled = date(ks?.dateShortInterest)
  const short = num(ks?.sharesShort)
  if (!ks || !settled || short === null) return undefined
  const prior = priorMonthShares(ks.sharesShortPriorMonth)
  const ratio = num(ks.shortRatio)
  return {
    symbol,
    date: utcDate(settled),
    short_interest: short,
    change_pct: prior !== null && prior > 0 ? round(((short - prior) / prior) * 100, 4) : null,
    avg_volume: ratio !== null && ratio > 0 ? Math.round(short / ratio) : null,
    days_to_cover: ratio,
  }
}

export function makeShortInterest(client: () => YahooClient) {
  return async (params: KindParams<'short_interest'>, ctx: Ctx<unknown>): Promise<Frame> => {
    const symbols = normalizeSymbols(params.symbols)
    const rows = await fanOut(
      symbols,
      async (symbol) => {
        const row = shortInterestRow(symbol, await client().quoteSummary(symbol, { modules: ['defaultKeyStatistics'] }))
        if (!row) throw new Error('no short interest on Yahoo')
        return row
      },
      { ctx, kind: 'short_interest' },
    )
    return toFrame('short_interest', rows, { connector: 'yahoo' })
  }
}
