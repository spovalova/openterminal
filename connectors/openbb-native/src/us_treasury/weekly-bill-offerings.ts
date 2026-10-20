// ustreasury/weekly_bill_offerings, provider us_treasury. Ported from openbb_government_us/treasury/models/bill_offerings.py
// (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { type FieldTable, toFloatStrict, validateModel } from './coerce.js'
import { buildFilters, defaultStartDate, getFiscalData, optString, sortedDesc } from './helpers.js'

const ENDPOINT = 'v1/accounting/tb/pdo1_offerings_regular_weekly_treasury_bills'

/** FiscalData column → OpenBB field. */
const FIELD_MAP: Record<string, string> = {
  issue_date: 'issue_date',
  maturity_date: 'maturity_date',
  days_to_maturity: 'days_to_maturity',
  bids_tendered_mil_amt: 'bids_tendered',
  bids_acc_total_mil_amt: 'bids_accepted_total',
  bids_acc_comp_basis_mil_amt: 'bids_accepted_competitive',
  bids_acc_noncomp_basis_mil_amt: 'bids_accepted_noncompetitive',
  high_price_per_hundred: 'high_price_per_hundred',
  high_discount_rate: 'high_discount_rate',
  high_investment_rate: 'high_investment_rate',
  record_date: 'record_date',
}

const MILLION_FIELDS = new Set(['bids_tendered', 'bids_accepted_total', 'bids_accepted_competitive', 'bids_accepted_noncompetitive'])
const PERCENT_FIELDS = new Set(['high_discount_rate', 'high_investment_rate'])

const FIELDS: FieldTable = {
  issue_date: 'date!',
  maturity_date: 'date!',
  days_to_maturity: 'int!',
  bids_tendered: 'float!',
  bids_accepted_total: 'float!',
  bids_accepted_competitive: 'float!',
  bids_accepted_noncompetitive: 'float!',
  high_price_per_hundred: 'float!',
  high_discount_rate: 'float!',
  high_investment_rate: 'float!',
  record_date: 'date!',
}

export async function weeklyBillOfferings(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const endDate = optString(params, 'end_date')
  const startDate = defaultStartDate(optString(params, 'start_date'), endDate, 365, ctx)
  const filters = buildFilters([
    ['issue_date', 'gte', startDate],
    ['issue_date', 'lte', endDate],
  ])
  const data = await getFiscalData(ctx, ENDPOINT, { filters, sort: 'issue_date,src_line_nbr' })

  const rows = data.map((row) => {
    const record: Row = {}
    for (const [source, target] of Object.entries(FIELD_MAP)) {
      let value = row[source]
      if (value === undefined) throw new Error(`KeyError: '${source}'`)
      // Amounts come in millions of dollars and rates in percent.
      if (MILLION_FIELDS.has(target)) value = toFloatStrict(value) * 1_000_000
      else if (PERCENT_FIELDS.has(target)) value = toFloatStrict(value) / 100
      record[target] = value
    }
    return validateModel(FIELDS, {}, record, 'TreasuryBillOfferingsData')
  })
  // Newest issue date first, then the longest tenor.
  return sortedDesc(rows, (r) => [String(r.issue_date), Number(r.days_to_maturity)])
}
