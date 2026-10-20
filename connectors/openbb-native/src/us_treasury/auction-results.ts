// ustreasury/auction_results, provider us_treasury. Ported from openbb_government_us/treasury/models/auction_results.py
// (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { toFloatStrict, validateModel } from './coerce.js'
import { AUCTION_RESULTS_ALIASES, AUCTION_RESULTS_FIELDS } from './fields.js'
import { buildFilters, defaultStartDate, getFiscalData, optString, sortedDesc } from './helpers.js'

const ENDPOINT = 'v1/accounting/od/auctions_query'

/** Source columns published in percent; OpenBB serves fractions. */
const PERCENT_FIELDS = [
  'allocation_pctage',
  'avg_med_discnt_rate',
  'avg_med_investment_rate',
  'avg_med_discnt_margin',
  'avg_med_yield',
  'frn_index_determination_rate',
  'high_discnt_rate',
  'high_investment_rate',
  'high_discnt_margin',
  'high_yield',
  'int_rate',
  'low_discnt_rate',
  'low_investment_rate',
  'low_discnt_margin',
  'low_yield',
  'spread',
]

/** The columns the model keeps: its field names and the source names of its aliased fields. */
const FIELDS = new Set([...Object.keys(AUCTION_RESULTS_FIELDS), ...Object.values(AUCTION_RESULTS_ALIASES)])

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()
}

export async function auctionResults(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const endDate = optString(params, 'end_date')
  const securityType = optString(params, 'security_type')
  if (securityType !== undefined && !['bill', 'note', 'bond'].includes(securityType)) throw new Error(`Input should be 'bill', 'note' or 'bond': ${securityType}`)
  const cusipParam = optString(params, 'cusip')

  // A comma-separated CUSIP list becomes an `in` filter.
  let cusipEq: string | undefined
  let cusipIn: string | undefined
  if (cusipParam) {
    const cusips = cusipParam
      .split(',')
      .map((c) => c.trim())
      .join(',')
    if (cusips.includes(',')) cusipIn = `(${cusips})`
    else cusipEq = cusips
  }

  let startDate = optString(params, 'start_date')
  if (startDate === undefined && !cusipParam) startDate = defaultStartDate(undefined, endDate, 365, ctx)
  const filters = buildFilters([
    ['auction_date', 'gte', startDate],
    ['auction_date', 'lte', endDate],
    ['security_type', 'eq', securityType ? capitalize(securityType) : undefined],
    ['cusip', 'eq', cusipEq],
    ['cusip', 'in', cusipIn],
  ])
  const data = await getFiscalData(ctx, ENDPOINT, { filters, sort: 'auction_date' })

  const rows = data.map((row) => {
    const record: Row = Object.fromEntries(Object.entries(row).filter(([k]) => FIELDS.has(k)))
    for (const key of PERCENT_FIELDS) {
      const value = record[key]
      if (value !== undefined && value !== null) record[key] = toFloatStrict(value) / 100
    }
    if (record.auction_format === 'Single Price') record.auction_format = 'Single-Price'
    return validateModel(AUCTION_RESULTS_FIELDS, AUCTION_RESULTS_ALIASES, record, 'TreasuryAuctionResultsData')
  })
  // Newest auction first.
  return sortedDesc(rows, (r) => [String(r.auction_date), String(r.issue_date)])
}
