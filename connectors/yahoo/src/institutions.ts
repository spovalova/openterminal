import { toFrame, type Ctx, type Frame, type KindParams } from '@terminal/core'
import type { QuoteSummaryResult, YahooClient } from './client.js'
import { fanOut, normalizeSymbols } from './fanout.js'
import { utcDate } from './time.js'
import { date, num, pct, str } from './values.js'

type InstitutionRow = { symbol: string; date: string; holder: string | null; shares: number | null; change_pct: number | null; value: number | null }

/** The largest holders in Yahoo's order (by position), at most `limit`. Yahoo lists ten. Undefined when the module is missing (funds). */
export function institutionRows(symbol: string, r: QuoteSummaryResult, limit: number): InstitutionRow[] | undefined {
  const list = r.institutionOwnership?.ownershipList
  if (!list) return undefined
  const rows: InstitutionRow[] = []
  for (const o of list) {
    const at = date(o.reportDate)
    if (!at) continue
    rows.push({ symbol, date: utcDate(at), holder: str(o.organization), shares: num(o.position), change_pct: pct(o.pctChange), value: num(o.value) })
  }
  return rows.slice(0, limit)
}

export function makeInstitutions(client: () => YahooClient) {
  return async (params: KindParams<'institutions'>, ctx: Ctx<unknown>): Promise<Frame> => {
    const symbols = normalizeSymbols(params.symbols)
    const perSymbol = await fanOut(
      symbols,
      async (symbol) => {
        const rows = institutionRows(symbol, await client().quoteSummary(symbol, { modules: ['institutionOwnership'] }), params.limit)
        if (!rows) throw new Error('no institutional holders on Yahoo (fund or index?)')
        return rows
      },
      { ctx, kind: 'institutions' },
    )
    return toFrame('institutions', perSymbol.flat(), { connector: 'yahoo' })
  }
}
