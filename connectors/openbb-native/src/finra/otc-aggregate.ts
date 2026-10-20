// equity/darkpool/otc, provider finra. Ported from openbb_finra/models/otc_aggregate.py (OpenBB Platform 5.0.0,
// Apache-2.0); modified: plain rows instead of pydantic models.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { queryApi, queryPartitions } from './client.js'
import { EQUITY_PRODUCT_TYPES } from './constants.js'
import { decode, joinParam, splitSymbols } from './helpers.js'

const FIELDS = [
  'weekStartDate',
  'issueSymbolIdentifier',
  'issueName',
  'tierDescription',
  'productTypeCode',
  'totalWeeklyShareQuantity',
  'totalWeeklyTradeCount',
  'totalNotionalSum',
  'initialPublishedDate',
  'lastUpdateDate',
  'lastReportedDate',
]

/** FINRA field → OpenBB field (`__alias_dict__`, and the camel-case aliases of the rest). */
const NAMES: Record<string, string> = {
  issueSymbolIdentifier: 'symbol',
  totalWeeklyShareQuantity: 'share_quantity',
  totalWeeklyTradeCount: 'trade_quantity',
  lastUpdateDate: 'update_date',
  weekStartDate: 'week_start_date',
  tierDescription: 'tier',
  productTypeCode: 'product_type',
  totalNotionalSum: 'total_notional',
  issueName: 'issue_name',
  initialPublishedDate: 'initial_published_date',
  lastReportedDate: 'last_reported_date',
}

const equal = (fieldName: string, fieldValue: string) => ({ compareType: 'EQUAL', fieldName, fieldValue })
const text = (v: unknown) => String(v)

export async function otcAggregate(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const tier = String(params.tier ?? 'T1')
  const base = [equal('summaryTypeCode', params.is_ats === false ? 'OTC_W_SMBL' : 'ATS_W_SMBL'), equal('tierIdentifier', tier)]
  const symbol = joinParam(params.symbol)

  let rows: Row[]
  if (symbol) {
    const symbols = splitSymbols(symbol).map((s) => s.replaceAll('-', '.').replaceAll('/', '.'))
    const pages = await Promise.all(symbols.map((s) => queryApi(ctx, 'otcMarket', 'weeklySummary', { fields: FIELDS, compareFilters: [...base, equal('issueSymbolIdentifier', s)] })))
    rows = pages.flat()
  } else {
    // Without a symbol: the latest published week of the tier, biggest first.
    const weeks = (await queryPartitions(ctx, 'otcMarket', 'weeklySummary')).filter((p) => p.length > 1 && p[1] === tier).map((p) => p[0]!).sort()
    if (weeks.length === 0) throw new Error(`FINRA holds no weeks for tier ${tier}.`)
    rows = await queryApi(ctx, 'otcMarket', 'weeklySummary', { fields: FIELDS, compareFilters: [...base, equal('weekStartDate', weeks[weeks.length - 1]!)], sortFields: ['-totalWeeklyShareQuantity'] })
  }
  rows = rows.filter((r) => r.issueSymbolIdentifier)
  if (rows.length === 0) throw new Error('FINRA reported no OTC volume for the query.')

  const ordered = symbol ? [...rows].sort((a, b) => (text(a.issueSymbolIdentifier) < text(b.issueSymbolIdentifier) ? -1 : text(a.issueSymbolIdentifier) > text(b.issueSymbolIdentifier) ? 1 : text(a.weekStartDate) < text(b.weekStartDate) ? -1 : text(a.weekStartDate) > text(b.weekStartDate) ? 1 : 0)) : rows
  return ordered.map((record) => {
    const out: Row = {}
    for (const [k, v] of Object.entries({ ...record, productTypeCode: decode(EQUITY_PRODUCT_TYPES, record.productTypeCode) })) if (v !== undefined && v !== null) out[NAMES[k] ?? k] = v
    return out
  })
}
