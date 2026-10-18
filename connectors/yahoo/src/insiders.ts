import { toFrame, type Ctx, type Frame, type KindParams } from '@terminal/core'
import type { QuoteSummaryResult, YahooClient } from './client.js'
import { fanOut, normalizeSymbols } from './fanout.js'
import { utcDate } from './time.js'
import { date, num, round, str } from './values.js'

export type InsiderAction = 'buy' | 'sell' | 'grant' | 'other'

/** Yahoo describes each filing in prose: "Sale at price 332.01 per share.", "Purchase at price …", "Stock Award(Grant) at price 0.00 per share.", "Stock Gift …", "Conversion of Exercise of derivative security …". */
export function insiderAction(text: string): InsiderAction {
  if (/\bsale\b|\bsold\b|\bsell\b/i.test(text)) return 'sell'
  if (/\bpurchase\b|\bbuy\b|\bbought\b/i.test(text)) return 'buy'
  if (/\bgrant\b|\baward\b/i.test(text)) return 'grant'
  return 'other'
}

const PRICE_RE = /at price\s+([\d,]+(?:\.\d+)?)(?:\s*-\s*([\d,]+(?:\.\d+)?))?\s+per share/i

/** The per-share price: the one quoted in the text, or value / shares when the text gives a range (Yahoo's value is the sum). */
export function insiderPrice(text: string, shares: number | null, value: number | null): number | null {
  const m = PRICE_RE.exec(text)
  if (m && m[2] === undefined) return Number(m[1]!.replace(/,/g, ''))
  if (value !== null && shares !== null && value > 0 && shares > 0) return round(value / shares, 4)
  if (m) return Number(m[1]!.replace(/,/g, ''))
  return null
}

type InsiderRow = { symbol: string; date: string; name: string | null; title: string | null; action: InsiderAction; shares: number | null; price: number | null; value: number | null; url: string | null }

/** Transactions newest first, at most `limit`. Undefined when Yahoo has no insider module for the symbol (funds). */
export function insiderRows(symbol: string, r: QuoteSummaryResult, limit: number): InsiderRow[] | undefined {
  const list = r.insiderTransactions?.transactions
  if (!list) return undefined
  const rows: InsiderRow[] = []
  for (const t of list) {
    const at = date(t.startDate)
    if (!at) continue
    const text = typeof t.transactionText === 'string' ? t.transactionText : ''
    const shares = num(t.shares)
    const value = num(t.value)
    rows.push({
      symbol,
      date: utcDate(at),
      name: str(t.filerName),
      title: str(t.filerRelation),
      action: insiderAction(text),
      shares,
      price: insiderPrice(text, shares, value),
      value,
      url: str(t.filerUrl),
    })
  }
  // Yahoo lists newest first already; the sort is stable so same-day filings keep their order.
  return rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)).slice(0, limit)
}

export function makeInsiders(client: () => YahooClient) {
  return async (params: KindParams<'insiders'>, ctx: Ctx<unknown>): Promise<Frame> => {
    const symbols = normalizeSymbols(params.symbols)
    const perSymbol = await fanOut(
      symbols,
      async (symbol) => {
        const rows = insiderRows(symbol, await client().quoteSummary(symbol, { modules: ['insiderTransactions'] }), params.limit)
        if (!rows) throw new Error('no insider transactions on Yahoo (fund or index?)')
        return rows
      },
      { ctx, kind: 'insiders' },
    )
    return toFrame('insiders', perSymbol.flat(), { connector: 'yahoo' })
  }
}
