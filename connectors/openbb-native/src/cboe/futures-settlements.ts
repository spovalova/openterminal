// cboe/futures/settlement_prices, provider cboe. Ported from openbb_cboe/models/futures_settlements.py (OpenBB
// Platform 5.0.0, Apache-2.0); modified: plain rows instead of a DataFrame and pydantic models, and a cabinet trade's
// "CAB" price is left empty instead of failing the whole call.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { getSettlementPrices } from './helpers.js'

/**
 * pydantic's `float` field: a number, or text that is one. Where OpenBB raises a validation error for other text,
 * this leaves the price out: Cboe marks cabinet trades in its options settlement CSV with "CAB" instead of a price,
 * which makes OpenBB fail every `options=true` call.
 */
function asFloat(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  const n = typeof value === 'number' ? value : /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/.test(String(value)) ? Number(value) : Number.NaN
  return Number.isNaN(n) ? undefined : n
}

/** The settlement date from ISO or US formatting (`to_datetime(v).date()`). */
function asDate(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const text = String(value).trim()
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text)
  if (us) return `${us[3]}-${us[1]!.padStart(2, '0')}-${us[2]!.padStart(2, '0')}`
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text)
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`
  throw new Error(`settlement_date: cannot parse ${text} as a date`)
}

export async function futuresSettlements(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const rows = await getSettlementPrices(ctx, {
    ...(params.date ? { date: String(params.date) } : {}),
    options: params.options === true,
    archives: params.archives === true,
    finalSettlement: params.final_settlement === true,
  })
  if (rows.length === 0) throw new Error('No settlement prices were published.')
  return rows.map((row) => {
    const out: Row = { ...row }
    for (const f of ['price', 'settlement_price']) if (f in out) out[f] = asFloat(out[f])
    if ('settlement_date' in out) out.settlement_date = asDate(out.settlement_date)
    return out
  })
}
