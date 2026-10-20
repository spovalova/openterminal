// ustreasury/debt_to_penny, provider us_treasury. Ported from openbb_government_us/treasury/models/debt_to_penny.py
// (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { type FieldTable, validateModel } from './coerce.js'
import { buildFilters, defaultStartDate, getFiscalData, optString, sortedDesc } from './helpers.js'

const ENDPOINT = 'v2/accounting/od/debt_to_penny'

/** FiscalData column → OpenBB field. */
const FIELD_MAP: Record<string, string> = {
  record_date: 'date',
  tot_pub_debt_out_amt: 'total_public_debt_outstanding',
  debt_held_public_amt: 'debt_held_public',
  intragov_hold_amt: 'intragovernmental_holdings',
}

const FIELDS: FieldTable = { date: 'date!', total_public_debt_outstanding: 'float!', debt_held_public: 'float', intragovernmental_holdings: 'float' }

export async function debtToPenny(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const endDate = optString(params, 'end_date')
  const startDate = defaultStartDate(optString(params, 'start_date'), endDate, 365, ctx)
  const filters = buildFilters([
    ['record_date', 'gte', startDate],
    ['record_date', 'lte', endDate],
  ])
  const data = await getFiscalData(ctx, ENDPOINT, { filters, sort: 'record_date' })

  // Newest business day first.
  const rows = data.map((row) => validateModel(FIELDS, {}, Object.fromEntries(Object.entries(FIELD_MAP).filter(([source]) => source in row).map(([source, target]) => [target, row[source]])), 'DebtToPennyData'))
  return sortedDesc(rows, (r) => [String(r.date)])
}
