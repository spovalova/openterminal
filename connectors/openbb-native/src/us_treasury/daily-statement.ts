// ustreasury/daily_statement, provider us_treasury. Ported from openbb_government_us/treasury/models/daily_treasury_statement.py
// (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { pyFloat, validateModel } from './coerce.js'
import { buildFilters, defaultStartDate, EmptyDataError, getFiscalData, nullTokensToNone, optString, sortedDesc } from './helpers.js'

const ENDPOINT = 'v1/accounting/dts'
const ALL_SUB_TABLES = 'all'
const ALL_BASES = 'all'

const COMMON_FIELDS: Record<string, string> = { record_date: 'date', table_nbr: 'table_number', table_nm: 'table_name', src_line_nbr: 'line_number' }

/** Per table: FiscalData column → OpenBB field. */
const FIELD_MAP: Record<string, Record<string, string>> = {
  operating_cash_balance: { ...COMMON_FIELDS, sub_table_name: 'sub_table_name', account_type: 'account_type', close_today_bal: 'close_today_balance', open_today_bal: 'open_today_balance', open_month_bal: 'open_month_balance', open_fiscal_year_bal: 'open_fiscal_year_balance' },
  deposits_withdrawals_operating_cash: {
    ...COMMON_FIELDS,
    account_type: 'account_type',
    transaction_type: 'transaction_type',
    transaction_catg: 'category',
    transaction_catg_desc: 'category_description',
    transaction_today_amt: 'today_amount',
    transaction_mtd_amt: 'month_to_date_amount',
    transaction_fytd_amt: 'fiscal_year_to_date_amount',
  },
  public_debt_transactions: {
    ...COMMON_FIELDS,
    transaction_type: 'transaction_type',
    security_market: 'security_market',
    security_type: 'security_type',
    security_type_desc: 'security_type_description',
    transaction_today_amt: 'today_amount',
    transaction_mtd_amt: 'month_to_date_amount',
    transaction_fytd_amt: 'fiscal_year_to_date_amount',
  },
  adjustment_public_debt_transactions_cash_basis: {
    ...COMMON_FIELDS,
    sub_table_name: 'sub_table_name',
    transaction_type: 'transaction_type',
    adj_type: 'category',
    adj_type_desc: 'category_description',
    adj_today_amt: 'today_amount',
    adj_mtd_amt: 'month_to_date_amount',
    adj_fytd_amt: 'fiscal_year_to_date_amount',
  },
  debt_subject_to_limit: { ...COMMON_FIELDS, sub_table_name: 'sub_table_name', debt_catg: 'category', debt_catg_desc: 'category_description', close_today_bal: 'close_today_balance', open_today_bal: 'open_today_balance', open_month_bal: 'open_month_balance', open_fiscal_year_bal: 'open_fiscal_year_balance' },
  federal_tax_deposits: {
    ...COMMON_FIELDS,
    sub_table_name: 'sub_table_name',
    tax_deposit_type: 'category',
    tax_deposit_type_desc: 'category_description',
    tax_deposit_today_amt: 'today_amount',
    tax_deposit_mtd_amt: 'month_to_date_amount',
    tax_deposit_fytd_amt: 'fiscal_year_to_date_amount',
  },
  short_term_cash_investments: {
    ...COMMON_FIELDS,
    sub_table_name: 'sub_table_name',
    transaction_type: 'transaction_type',
    transaction_type_desc: 'category_description',
    depositary_type_a_amt: 'depositary_type_a_amount',
    depositary_type_b_amt: 'depositary_type_b_amount',
    depositary_type_c_amt: 'depositary_type_c_amount',
    total_amt: 'total_amount',
  },
  income_tax_refunds_issued: {
    ...COMMON_FIELDS,
    sub_table_name: 'sub_table_name',
    tax_refund_type: 'category',
    tax_refund_type_desc: 'category_description',
    tax_refund_today_amt: 'today_amount',
    tax_refund_mtd_amt: 'month_to_date_amount',
    tax_refund_fytd_amt: 'fiscal_year_to_date_amount',
  },
  inter_agency_tax_transfers: { ...COMMON_FIELDS, sub_table_name: 'sub_table_name', classification: 'category', today_amt: 'today_amount', mtd_amt: 'month_to_date_amount', fytd_amt: 'fiscal_year_to_date_amount' },
}

/** Dollar amounts the source reports in millions. */
const AMOUNT_FIELDS = new Set([
  'today_amount',
  'month_to_date_amount',
  'fiscal_year_to_date_amount',
  'close_today_balance',
  'open_today_balance',
  'open_month_balance',
  'open_fiscal_year_balance',
  'depositary_type_a_amount',
  'depositary_type_b_amount',
  'depositary_type_c_amount',
  'total_amount',
])

/** The dimensions that label a line item, per table. */
const PIVOT_DIMS: Record<string, string[]> = {
  operating_cash_balance: ['sub_table_name', 'account_type'],
  deposits_withdrawals_operating_cash: ['account_type', 'transaction_type', 'category', 'category_description'],
  public_debt_transactions: ['transaction_type', 'security_market', 'security_type', 'security_type_description'],
  adjustment_public_debt_transactions_cash_basis: ['sub_table_name', 'transaction_type', 'category', 'category_description'],
  debt_subject_to_limit: ['sub_table_name', 'category', 'category_description'],
  federal_tax_deposits: ['sub_table_name', 'category', 'category_description'],
  short_term_cash_investments: ['sub_table_name', 'transaction_type', 'category_description'],
  income_tax_refunds_issued: ['sub_table_name', 'category', 'category_description'],
  inter_agency_tax_transfers: ['sub_table_name', 'category'],
}

const SUB_TABLE_FIELD: Record<string, string> = {
  operating_cash_balance: 'sub_table_name',
  deposits_withdrawals_operating_cash: 'transaction_type',
  public_debt_transactions: 'transaction_type',
  adjustment_public_debt_transactions_cash_basis: 'transaction_type',
  debt_subject_to_limit: 'sub_table_name',
  federal_tax_deposits: 'sub_table_name',
  short_term_cash_investments: 'sub_table_name',
  income_tax_refunds_issued: 'sub_table_name',
  inter_agency_tax_transfers: 'sub_table_name',
}

const DEFAULT_AMOUNT_BASIS: Record<string, string> = { deposits_withdrawals_operating_cash: 'Today', public_debt_transactions: 'Today' }
const DEFAULT_SUB_TABLE: Record<string, string> = { deposits_withdrawals_operating_cash: 'Deposits', public_debt_transactions: 'Issues' }
/** Tables the source stopped publishing: the window is anchored on their last record. */
const LAST_RECORD_DATE: Record<string, string> = { federal_tax_deposits: '2023-02-13', short_term_cash_investments: '2023-02-13' }

const VALUE_LABELS: Record<string, string> = {
  today_amount: 'Today',
  month_to_date_amount: 'Month to Date',
  fiscal_year_to_date_amount: 'Fiscal Year to Date',
  close_today_balance: 'Close Today',
  open_today_balance: 'Open Today',
  open_month_balance: 'Open Month',
  open_fiscal_year_balance: 'Open Fiscal Year',
  depositary_type_a_amount: 'Depositary Type A',
  depositary_type_b_amount: 'Depositary Type B',
  depositary_type_c_amount: 'Depositary Type C',
  total_amount: 'Total',
}

/** `map_records`: source rows onto OpenBB's field names, millions expanded to dollars. */
function mapRecords(table: string, data: Row[]): Row[] {
  const mapping = FIELD_MAP[table]!
  return data.map((row) => {
    const record: Row = {}
    for (const [source, target] of Object.entries(mapping)) {
      if (!(source in row)) continue
      let value = row[source]
      if (AMOUNT_FIELDS.has(target) && value !== null && value !== undefined) {
        const n = typeof value === 'string' ? pyFloat(value) : typeof value === 'number' ? value : undefined
        if (n === undefined) throw new Error(`could not convert string to float: ${JSON.stringify(value)}`)
        value = n * 1_000_000
      }
      record[target] = value
    }
    return record
  })
}

const amountBases = (table: string): string[] => Object.values(FIELD_MAP[table]!).filter((t) => AMOUNT_FIELDS.has(t))

/** `resolve_amount_basis`: the amount fields to spread across the line-item columns. */
function resolveAmountBasis(table: string, amountBasis: string | undefined): string[] {
  const published = amountBases(table)
  if (!amountBasis) {
    const fallback = DEFAULT_AMOUNT_BASIS[table]
    if (!fallback) return published
    const matched = published.filter((f) => VALUE_LABELS[f] === fallback)
    return matched.length ? matched : published
  }
  if (amountBasis === ALL_BASES) return published
  const matched = published.filter((f) => VALUE_LABELS[f] === amountBasis)
  if (matched.length === 0) {
    throw new Error(`Invalid amount_basis: '${amountBasis}'. The ${table} table publishes: ${published.map((f) => `'${VALUE_LABELS[f]}'`).join(', ')}, or '${ALL_BASES}'.`)
  }
  return matched
}

/** `str(value)` for the label parts. */
const pyStr = (v: unknown): string => String(v)

export async function dailyStatement(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const table = optString(params, 'table') ?? 'operating_cash_balance'
  if (!(table in FIELD_MAP)) throw new Error(`Input should be one of: ${Object.keys(FIELD_MAP).join(', ')}: ${table}`)
  const subTableParam = optString(params, 'sub_table')?.trim() || undefined
  const amountBasis = optString(params, 'amount_basis')

  const anchor = LAST_RECORD_DATE[table]
  const endDate = optString(params, 'end_date') ?? anchor
  const startDate = defaultStartDate(optString(params, 'start_date'), endDate, 30, ctx)
  const filters = buildFilters([
    ['record_date', 'gte', startDate],
    ['record_date', 'lte', endDate],
  ])
  const data = await getFiscalData(ctx, `${ENDPOINT}/${table}`, { filters, sort: 'record_date' })

  // The requested sub-table, else the table's default, else all of them.
  const subTable = subTableParam ?? DEFAULT_SUB_TABLE[table] ?? ALL_SUB_TABLES
  let records = mapRecords(table, data)
  if (subTable !== ALL_SUB_TABLES) {
    const field = SUB_TABLE_FIELD[table]!
    const kept = records.filter((r) => r[field] === subTable)
    if (kept.length === 0) {
      const available = [...new Set(records.map((r) => pyStr(r[field] ?? 'None')))].sort()
      throw new EmptyDataError(`No '${subTable}' sub-table in ${table}. Available -> ${available.join(', ')}`)
    }
    records = kept
  }

  // Pivot the long statement rows into one row per statement date, each line item in its own column.
  const dims = PIVOT_DIMS[table]!
  const candidates = (subTable !== ALL_SUB_TABLES ? dims.filter((d) => d !== SUB_TABLE_FIELD[table]) : dims)
  const base = candidates.length ? candidates : dims
  const varying = base.filter((d) => new Set(records.map((r) => r[d]).filter((v) => v !== undefined && v !== null && v !== '' && v !== 0)).size > 1)
  const dimensions = varying.length ? varying : base
  const values = resolveAmountBasis(table, amountBasis)
  const multiBasis = values.length > 1
  const pivoted = new Map<string, Row>()
  const columns: string[] = []
  for (const record of records) {
    const date = record.date
    if (date === undefined || date === null) continue
    let row = pivoted.get(String(date))
    if (!row) {
      row = { date }
      pivoted.set(String(date), row)
    }
    const parts: string[] = []
    for (const d of dimensions) {
      const value = record[d]
      if (value === undefined || value === null || value === '' || (parts.length && pyStr(value) === parts[parts.length - 1])) continue
      parts.push(pyStr(value))
    }
    const label = parts.join(' - ')
    if (!label) continue
    for (const v of values) {
      const amount = record[v]
      if (amount === undefined || amount === null) continue
      const column = multiBasis ? `${label} (${VALUE_LABELS[v]})` : label
      if (!columns.includes(column)) columns.push(column)
      row[column] = amount
    }
  }
  const ordered = sortedDesc([...pivoted.values()], (r) => [String(r.date)])
  return ordered.map((row) => {
    const payload: Row = { date: row.date }
    for (const column of columns) payload[column] = row[column] ?? null
    return validateModel({ date: 'date!' }, {}, nullTokensToNone(payload), 'DailyTreasuryStatementData')
  })
}
