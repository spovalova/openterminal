// ustreasury/bulletin, provider us_treasury. Ported from openbb_government_us/treasury/models/treasury_bulletin.py
// (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { toFloatStrict, validateModel } from './coerce.js'
import { BULLETIN_FIELDS } from './fields.js'
import { buildFilters, defaultStartDate, getFiscalData, nullTokensToNone, optString, sortedDesc } from './helpers.js'

const ENDPOINTS: Record<string, string> = {
  pdo1: 'v1/accounting/tb/pdo1_offerings_regular_weekly_treasury_bills',
  pdo2: 'v1/accounting/tb/pdo2_offerings_marketable_securities_other_regular_weekly_treasury_bills',
  ofs1: 'v1/accounting/tb/ofs1_distribution_federal_securities_class_investors_type_issues',
  ofs2: 'v1/accounting/tb/ofs2_estimated_ownership_treasury_securities',
  uscc1: 'v1/accounting/tb/uscc1_amounts_outstanding_circulation',
  uscc2: 'v1/accounting/tb/uscc2_amounts_outstanding_circulation',
  fcp1: 'v1/accounting/tb/fcp1_weekly_report_major_market_participants',
  fcp2: 'v1/accounting/tb/fcp2_monthly_report_major_market_participants',
  fcp3: 'v1/accounting/tb/fcp3_quarterly_report_large_market_participants',
  esf1: 'v1/accounting/tb/esf1_balances',
  esf2: 'v1/accounting/tb/esf2_statement_net_cost',
  ffo5: 'v1/accounting/tb/ffo5_internal_revenue_by_state',
  ffo6: 'v1/accounting/tb/ffo6_customs_border_protection_collections',
}

/** `pdo1` → `PDO-1`. */
const tableCode = (slug: string): string => `${slug.slice(0, -1).toUpperCase()}-${slug.slice(-1)}`

/** Tables pivoted to one row per report date: [label dimensions, value fields]. */
const PIVOT_TABLES: Record<string, [string[], string[]]> = {
  ofs2: [['classification'], ['securities_amount']],
  ofs1: [['classification', 'sub_classification', 'issue_type'], ['securities_amount']],
  esf1: [['classification'], ['activity', 'balance']],
  esf2: [['classification'], ['current_quarter_amount', 'fiscal_year_to_date_amount']],
}

const VALUE_LABELS: Record<string, string> = {
  activity: 'Activity',
  balance: 'Balance',
  current_quarter_amount: 'Current Quarter',
  fiscal_year_to_date_amount: 'Fiscal Year to Date',
}

const COMMON_FIELDS: Record<string, string> = { record_date: 'record_date', src_line_nbr: 'line_number' }
const FCP_COMMON_FIELDS: Record<string, string> = {
  ...COMMON_FIELDS,
  report_date: 'report_date',
  foreign_currency_desc: 'currency',
  spot_fwd_future_purch_amt: 'spot_forward_futures_purchased',
  spot_fwd_future_sold_amt: 'spot_forward_futures_sold',
  exchange_rate: 'exchange_rate',
}
const FCP_MONTHLY_QUARTERLY_FIELDS: Record<string, string> = {
  ...FCP_COMMON_FIELDS,
  assets_amt: 'assets',
  liabilities_amt: 'liabilities',
  call_options_bought_amt: 'call_options_bought',
  call_options_written_amt: 'call_options_written',
  put_options_bought_amt: 'put_options_bought',
  put_options_written_amt: 'put_options_written',
  options_net_delta_amt: 'options_net_delta',
}

/** Per table: FiscalData column → OpenBB field. */
const FIELD_MAP: Record<string, Record<string, string>> = {
  pdo1: {
    ...COMMON_FIELDS,
    issue_date: 'issue_date',
    maturity_date: 'maturity_date',
    days_to_maturity: 'days_to_maturity',
    bids_tendered_mil_amt: 'bids_tendered',
    bids_acc_total_mil_amt: 'bids_accepted',
    bids_acc_comp_basis_mil_amt: 'bids_accepted_competitive',
    bids_acc_noncomp_basis_mil_amt: 'bids_accepted_noncompetitive',
    high_price_per_hundred: 'high_price_per_hundred',
    high_discount_rate: 'high_discount_rate',
    high_investment_rate: 'high_investment_rate',
  },
  pdo2: {
    ...COMMON_FIELDS,
    auction_date: 'auction_date',
    issue_date: 'issue_date',
    securities_desc: 'security_description',
    period_to_final_maturity: 'period_to_final_maturity',
    tendered_mil_amt: 'bids_tendered',
    acc_mil_amt: 'bids_accepted',
    acc_yield_discount_margin: 'accepted_yield_discount_margin',
    eq_price_for_notes_bonds: 'equivalent_price',
  },
  ofs1: { ...COMMON_FIELDS, end_fiscal_year_or_month: 'report_date', securities_classification: 'classification', investors_classification: 'sub_classification', issues_type: 'issue_type', securities_mil_amt: 'securities_amount' },
  ofs2: { record_date: 'record_date', end_of_month: 'report_date', securities_owner: 'classification', securities_bil_amt: 'securities_amount' },
  uscc1: {
    ...COMMON_FIELDS,
    currency_coins_as_of_date: 'report_date',
    currency_coins_category_desc: 'classification',
    total_currency_coins_amt: 'total_currency_and_coins',
    total_currency_amt: 'total_currency',
    federal_reserve_notes_amt: 'federal_reserve_notes',
    us_notes_amt: 'us_notes',
    currency_no_longer_issued_amt: 'currency_no_longer_issued',
    total_coins_amt: 'total_coins',
    dollar_coins_amt: 'dollar_coins',
    fractional_coins_amt: 'fractional_coins',
  },
  uscc2: {
    ...COMMON_FIELDS,
    currency_as_of_date: 'report_date',
    currency_denom: 'denomination',
    total_currency_amt: 'total_currency',
    federal_reserve_notes_amt: 'federal_reserve_notes',
    us_notes_amt: 'us_notes',
    currency_no_longer_issued_amt: 'currency_no_longer_issued',
    per_capita_amt: 'per_capita',
  },
  fcp1: { ...FCP_COMMON_FIELDS, net_options_positions_amt: 'net_options_position' },
  fcp2: FCP_MONTHLY_QUARTERLY_FIELDS,
  fcp3: FCP_MONTHLY_QUARTERLY_FIELDS,
  esf1: { ...COMMON_FIELDS, report_date: 'report_date', classification_desc: 'classification', activity_thous_amt: 'activity', balance_thous_amt: 'balance' },
  esf2: { ...COMMON_FIELDS, report_date: 'report_date', classification_desc: 'classification', current_quarter_thous_amt: 'current_quarter_amount', fytd_thous_amt: 'fiscal_year_to_date_amount' },
  ffo5: {
    ...COMMON_FIELDS,
    revenue_fiscal_year: 'fiscal_year',
    state_nm: 'state',
    total_rev_collect_thous_amt: 'total_collections',
    business_income_tax_thous_amt: 'business_income_taxes',
    total_indv_tax_thous_amt: 'total_individual_taxes',
    withheld_fica_thous_amt: 'withheld_income_and_fica_taxes',
    not_withheld_seca_thous_amt: 'not_withheld_income_and_seca_taxes',
    unemployment_ins_tax_thous_amt: 'unemployment_insurance_taxes',
    railroad_retire_tax_thous_amt: 'railroad_retirement_taxes',
    estate_trust_tax_thous_amt: 'estate_and_trust_income_taxes',
    estate_tax_thous_amt: 'estate_taxes',
    gift_tax_thous_amt: 'gift_taxes',
    excise_tax_thous_amt: 'excise_taxes',
  },
  ffo6: { ...COMMON_FIELDS, collection_fiscal_year: 'fiscal_year', district_nm: 'district', port_nm: 'port', port_cd: 'port_code', collection_amt: 'total_collections' },
}

/** Amounts the source reports in thousands, millions or billions. */
const SCALE_MAP: Record<string, Record<string, number>> = {
  pdo1: { bids_tendered: 1_000_000, bids_accepted: 1_000_000, bids_accepted_competitive: 1_000_000, bids_accepted_noncompetitive: 1_000_000 },
  pdo2: { bids_tendered: 1_000_000, bids_accepted: 1_000_000 },
  ofs1: { securities_amount: 1_000_000 },
  ofs2: { securities_amount: 1_000_000_000 },
  esf1: { activity: 1_000, balance: 1_000 },
  esf2: { current_quarter_amount: 1_000, fiscal_year_to_date_amount: 1_000 },
  ffo5: {
    total_collections: 1_000,
    business_income_taxes: 1_000,
    total_individual_taxes: 1_000,
    withheld_income_and_fica_taxes: 1_000,
    not_withheld_income_and_seca_taxes: 1_000,
    unemployment_insurance_taxes: 1_000,
    railroad_retirement_taxes: 1_000,
    estate_and_trust_income_taxes: 1_000,
    estate_taxes: 1_000,
    gift_taxes: 1_000,
    excise_taxes: 1_000,
  },
}

const PERCENT_FIELDS = new Set(['accepted_yield_discount_margin', 'high_discount_rate', 'high_investment_rate'])
const FOREIGN_CURRENCY_TABLES = new Set(['fcp1', 'fcp2', 'fcp3'])
const FOREIGN_CURRENCY_UNITS: Record<string, number> = { Millions: 1_000_000, Billions: 1_000_000_000 }
const FOREIGN_CURRENCY_AMOUNT_FIELDS = ['spot_forward_futures_purchased', 'spot_forward_futures_sold', 'net_options_position', 'assets', 'liabilities', 'call_options_bought', 'call_options_written', 'put_options_bought', 'put_options_written', 'options_net_delta']
const ESF2_ARTIFACT_ROWS = new Set(['check', 'from Dec 24 FS', 'Cumulative Income and Expense is equal to Q'])

/** `OmitNoneMixin` over the unified Data model. */
const validate = (row: Row): Row => validateModel(BULLETIN_FIELDS, {}, nullTokensToNone(row), 'TreasuryBulletinData')

/** `_pivot`: a long table as one row per report date, each classification in its own column, newest first. */
function pivot(table: string, records: Row[]): Row[] {
  const [dimensions, values] = PIVOT_TABLES[table]!
  const multiValue = values.length > 1
  const pivoted = new Map<string, Row>()
  const columns: string[] = []
  for (const record of records) {
    const reportDate = record.report_date
    if (reportDate === undefined || reportDate === null) continue
    let row = pivoted.get(String(reportDate))
    if (!row) {
      row = { table_code: record.table_code, report_date: reportDate, record_date: record.record_date }
      pivoted.set(String(reportDate), row)
    }
    if (record.record_date && String(record.record_date) > String(row.record_date)) row.record_date = record.record_date
    const parts: string[] = []
    for (const d of dimensions) {
      const value = record[d]
      if (value === undefined || value === null || value === '' || (parts.length && String(value) === parts[parts.length - 1])) continue
      parts.push(String(value))
    }
    const label = parts.join(' - ')
    for (const v of values) {
      if (record[v] === undefined || record[v] === null) continue
      const column = multiValue ? `${label} (${VALUE_LABELS[v]})` : label
      if (!column) continue
      if (!columns.includes(column)) columns.push(column)
      row[column] = record[v]
    }
  }
  return sortedDesc([...pivoted.values()], (r) => [String(r.report_date)]).map((row) => {
    const payload: Row = { table_code: row.table_code, report_date: row.report_date, record_date: row.record_date }
    for (const column of columns) payload[column] = row[column] ?? null
    return validate(payload)
  })
}

export async function bulletin(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const table = optString(params, 'table') ?? 'ofs2'
  if (!(table in ENDPOINTS)) throw new Error(`Input should be one of: ${Object.keys(ENDPOINTS).join(', ')}: ${table}`)
  const endDate = optString(params, 'end_date')
  const startDate = defaultStartDate(optString(params, 'start_date'), endDate, 365, ctx)
  const filters = buildFilters([
    ['record_date', 'gte', startDate],
    ['record_date', 'lte', endDate],
  ])
  const data = await getFiscalData(ctx, ENDPOINTS[table]!, { filters, sort: 'record_date' })

  const mapping = FIELD_MAP[table]!
  const tableScales = SCALE_MAP[table] ?? {}
  const results: Row[] = []
  for (const row of data) {
    if (table === 'esf2' && ESF2_ARTIFACT_ROWS.has(String(row.classification_desc))) continue
    let scales: Record<string, number> = tableScales
    if (FOREIGN_CURRENCY_TABLES.has(table)) {
      const unit = FOREIGN_CURRENCY_UNITS[String(row.foreign_currency_denom)] ?? 1
      scales = Object.fromEntries(FOREIGN_CURRENCY_AMOUNT_FIELDS.map((f) => [f, unit]))
    }
    const record: Row = { table_code: tableCode(table) }
    for (const [source, target] of Object.entries(mapping)) {
      if (!(source in row)) continue
      let value = row[source]
      if (value !== null && value !== undefined) {
        if (target === 'fiscal_year') {
          const year = Number(String(value).slice(0, 4))
          if (!/^\d+$/.test(String(value).slice(0, 4))) throw new Error(`invalid literal for int() with base 10: '${String(value).slice(0, 4)}'`)
          value = year
        } else if (PERCENT_FIELDS.has(target)) value = toFloatStrict(value) / 100
        else if (target in scales) value = toFloatStrict(value) * scales[target]!
      }
      record[target] = value
    }
    results.push(record)
  }

  if (table in PIVOT_TABLES) return pivot(table, results)
  const validated = results.map(validate)
  // Newest report (else record) date first.
  return sortedDesc(validated, (r) => [String(r.report_date ?? r.record_date), String(r.record_date)])
}
