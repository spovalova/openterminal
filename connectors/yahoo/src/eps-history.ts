import { toFrame, type Ctx, type Frame, type KindParams } from '@terminal/core'
import type { QuoteSummaryResult, YahooClient } from './client.js'
import { fanOut, normalizeSymbols } from './fanout.js'
import { utcDate } from './time.js'
import { date, num, pct } from './values.js'

type EpsRow = { symbol: string; date: string; eps_actual: number | null; eps_estimate: number | null; surprise_pct: number | null }

/** Reported quarters, newest first, at most `limit`. Yahoo's earningsHistory covers the last four quarters only. */
export function epsHistoryRows(symbol: string, r: QuoteSummaryResult, limit: number): EpsRow[] | undefined {
  const history = r.earningsHistory?.history
  if (!history) return undefined
  const rows: EpsRow[] = []
  for (const h of history) {
    const quarter = date(h.quarter)
    if (!quarter) continue
    rows.push({ symbol, date: utcDate(quarter), eps_actual: num(h.epsActual), eps_estimate: num(h.epsEstimate), surprise_pct: pct(h.surprisePercent) })
  }
  return rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)).slice(0, limit)
}

export function makeEpsHistory(client: () => YahooClient) {
  return async (params: KindParams<'eps_history'>, ctx: Ctx<unknown>): Promise<Frame> => {
    const symbols = normalizeSymbols(params.symbols)
    const perSymbol = await fanOut(
      symbols,
      async (symbol) => {
        const rows = epsHistoryRows(symbol, await client().quoteSummary(symbol, { modules: ['earningsHistory'] }), params.limit)
        if (!rows) throw new Error('no earnings history on Yahoo')
        return rows
      },
      { ctx, kind: 'eps_history' },
    )
    return toFrame('eps_history', perSymbol.flat(), { connector: 'yahoo' })
  }
}
