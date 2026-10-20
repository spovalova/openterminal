// equity/shorts/short_interest, provider finra. Ported from openbb_finra/models/equity_short_interest.py (OpenBB
// Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { queryApi } from './client.js'
import { MARKET_CLASSES } from './constants.js'
import { decode, joinParam, splitSymbols } from './helpers.js'

const FIELDS = [
  'settlementDate',
  'symbolCode',
  'issueName',
  'marketClassCode',
  'currentShortPositionQuantity',
  'previousShortPositionQuantity',
  'averageDailyVolumeQuantity',
  'daysToCoverQuantity',
  'changePreviousNumber',
  'changePercent',
  'revisionFlag',
  'stockSplitFlag',
]

/** FINRA field → OpenBB field (`__alias_dict__`, and the camel-case aliases of the rest). */
const NAMES: Record<string, string> = {
  symbolCode: 'symbol',
  marketClassCode: 'market_class',
  currentShortPositionQuantity: 'current_short_position',
  previousShortPositionQuantity: 'previous_short_position',
  averageDailyVolumeQuantity: 'avg_daily_volume',
  daysToCoverQuantity: 'days_to_cover',
  changePreviousNumber: 'change',
  changePercent: 'change_pct',
  revisionFlag: 'revised',
  stockSplitFlag: 'stock_split',
  settlementDate: 'settlement_date',
  issueName: 'issue_name',
}

const text = (v: unknown) => String(v)

export async function shortInterest(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  // Only letters and digits are in a FINRA symbol code: BRK.B is BRKB.
  const symbols = splitSymbols(joinParam(params.symbol)).map((s) => [...s].filter((c) => /[\p{L}\p{N}]/u.test(c)).join(''))
  const rows = await queryApi(ctx, 'otcMarket', 'consolidatedShortInterest', { fields: FIELDS, domainFilters: [{ fieldName: 'symbolCode', values: symbols }] })
  if (rows.length === 0) throw new Error(`FINRA holds no short interest for ${joinParam(params.symbol)}.`)

  return [...rows]
    .sort((a, b) => (text(a.symbolCode) < text(b.symbolCode) ? -1 : text(a.symbolCode) > text(b.symbolCode) ? 1 : text(a.settlementDate) < text(b.settlementDate) ? -1 : text(a.settlementDate) > text(b.settlementDate) ? 1 : 0))
    .map((row) => {
      const out: Row = {}
      for (const [k, v] of Object.entries({ ...row, marketClassCode: decode(MARKET_CLASSES, row.marketClassCode), revisionFlag: Boolean(row.revisionFlag), stockSplitFlag: Boolean(row.stockSplitFlag) })) {
        if (v !== undefined && v !== null) out[NAMES[k] ?? k] = v
      }
      return out
    })
}
