// equity/fundamental/{balance,cash,income,ratios,filings} and news/company, provider nasdaq. Ported from
// openbb_nasdaq/utils/financials.py and openbb_nasdaq/models/{balance_sheet,cash_flow,income_statement,financial_ratios,
// company_filings,company_news}.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models.
import { NativeUnsupported, type NativeCtx, type NativeParams, type Row } from '../types.js'
import { BASE_URL, compact, getNasdaqData, jsonHeaders, listParam, mdyToIso, parseLooseDate, resolveAssetClass, symbolsOf, toDate, toNumber, truthy, type Dict } from './helpers.js'

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

// --- the statements --------------------------------------------------------------------------------------------

const INCOME_STATEMENT_MAP: Record<string, string> = {
  'Total Revenue': 'revenue',
  'Cost of Revenue': 'cost_of_revenue',
  'Gross Profit': 'gross_profit',
  'Operating Expenses': 'total_operating_expenses',
  'Research and Development': 'research_and_development_expense',
  'Sales, General and Admin.': 'selling_general_and_administrative_expense',
  'Non-Recurring Items': 'non_recurring_items',
  'Other Operating Items': 'other_operating_expenses',
  'Operating Income': 'operating_income',
  "Add'l income/expense items": 'additional_income_expense_items',
  'Earnings Before Interest and Tax': 'ebit',
  'Interest Expense': 'interest_expense',
  'Earnings Before Tax': 'income_before_tax',
  'Income Tax': 'income_tax_expense',
  'Minority Interest': 'minority_interest',
  'Equity Earnings/Loss Unconsolidated Subsidiary': 'equity_earnings',
  'Net Income-Cont. Operations': 'net_income_from_continuing_operations',
  'Net Income': 'consolidated_net_income',
  'Net Income Applicable to Common Shareholders': 'net_income',
}

const BALANCE_SHEET_MAP: Record<string, string> = {
  'Cash and Cash Equivalents': 'cash_and_cash_equivalents',
  'Short-Term Investments': 'short_term_investments',
  'Net Receivables': 'net_receivables',
  Inventory: 'inventory',
  'Other Current Assets': 'other_current_assets',
  'Total Current Assets': 'total_current_assets',
  'Long-Term Investments': 'long_term_investments',
  'Fixed Assets': 'property_plant_equipment_net',
  Goodwill: 'goodwill',
  'Intangible Assets': 'intangible_assets',
  'Other Assets': 'other_non_current_assets',
  'Deferred Asset Charges': 'deferred_asset_charges',
  'Total Assets': 'total_assets',
  'Accounts Payable': 'accounts_payable',
  'Short-Term Debt / Current Portion of Long-Term Debt': 'short_term_debt',
  'Other Current Liabilities': 'other_current_liabilities',
  'Total Current Liabilities': 'total_current_liabilities',
  'Long-Term Debt': 'long_term_debt',
  'Other Liabilities': 'other_non_current_liabilities',
  'Deferred Liability Charges': 'deferred_liability_charges',
  'Misc. Stocks': 'misc_stocks',
  'Minority Interest': 'minority_interest',
  'Total Liabilities': 'total_liabilities',
  'Common Stocks': 'common_stock',
  'Capital Surplus': 'additional_paid_in_capital',
  'Retained Earnings': 'retained_earnings',
  'Treasury Stock': 'treasury_stock',
  'Other Equity': 'other_shareholders_equity',
  'Total Equity': 'total_shareholders_equity',
  'Total Liabilities & Equity': 'total_liabilities_and_shareholders_equity',
}

const CASH_FLOW_MAP: Record<string, string> = {
  'Net Income': 'net_income',
  Depreciation: 'depreciation_and_amortization',
  'Net Income Adjustments': 'other_non_cash_items',
  'Accounts Receivable': 'change_in_receivables',
  'Changes in Inventories': 'change_in_inventory',
  'Other Operating Activities': 'other_operating_activities',
  Liabilities: 'change_in_payables',
  'Net Cash Flow-Operating': 'net_cash_flow_from_operating_activities',
  'Capital Expenditures': 'capital_expenditure',
  Investments: 'purchase_of_investments',
  'Other Investing Activities': 'other_investing_activities',
  'Net Cash Flows-Investing': 'net_cash_flow_from_investing_activities',
  'Sale and Purchase of Stock': 'net_stock_issuance',
  'Net Borrowings': 'net_debt_issuance',
  'Other Financing Activities': 'other_financing_activities',
  'Net Cash Flows-Financing': 'net_cash_flow_from_financing_activities',
  'Effect of Exchange Rate': 'effect_of_exchange_rate_changes_on_cash',
  'Net Cash Flow': 'net_change_in_cash_and_equivalents',
}

const FINANCIAL_RATIOS_MAP: Record<string, string> = {
  'Current Ratio': 'current_ratio',
  'Quick Ratio': 'quick_ratio',
  'Cash Ratio': 'cash_ratio',
  'Gross Margin': 'gross_profit_margin',
  'Operating Margin': 'operating_profit_margin',
  'Pre-Tax Margin': 'pretax_profit_margin',
  'Profit Margin': 'net_profit_margin',
  'Pre-Tax ROE': 'pretax_return_on_equity',
  'After Tax ROE': 'return_on_equity',
}

const PERCENT_RATIOS = new Set(['gross_profit_margin', 'operating_profit_margin', 'pretax_profit_margin', 'net_profit_margin', 'pretax_return_on_equity', 'return_on_equity'])

type Table = 'income' | 'balance' | 'cash' | 'ratios'
const TABLE_KEYS: Record<Table, string> = { income: 'incomeStatementTable', balance: 'balanceSheetTable', cash: 'cashFlowTable', ratios: 'financialRatiosTable' }

/** Pivot one Nasdaq statement table into one record per fiscal period, newest first (`parse_statement`). */
function parseStatement(payload: Dict | null | undefined, table: Table, fieldMap: Record<string, string>, symbol: string, period: string): Row[] {
  const statement: Dict = (payload ?? {})[TABLE_KEYS[table]] ?? {}
  const headers: Dict = statement.headers ?? {}
  const rows: Dict[] = statement.rows ?? []
  const results: Row[] = []
  for (const column of Object.keys(headers).filter((c) => c !== 'value1')) {
    const periodEnding = toDate(headers[column])
    if (periodEnding === null) continue
    const record: Row = { symbol: symbol.toUpperCase(), period_ending: periodEnding, fiscal_period: period, fiscal_year: Number(periodEnding.slice(0, 4)) }
    for (const row of rows) {
      const field = fieldMap[String(row.value1 ?? '').trim()]
      if (field === undefined) continue
      const value = toNumber(row[column])
      if (value === null) continue
      record[field] = PERCENT_RATIOS.has(field) ? value / 100 : value
    }
    if (Object.keys(record).length > 4) results.push(record)
  }
  return results.sort((a, b) => cmp(b.period_ending as string, a.period_ending as string))
}

/** One statement route: the symbol and period of the query, the four-table payload, the table's records. */
async function statement(params: NativeParams, ctx: NativeCtx, table: Table, fieldMap: Record<string, string>, what: string): Promise<Row[]> {
  const period = String(params.period ?? 'annual')
  if (period !== 'annual' && period !== 'quarter') throw new NativeUnsupported(`nasdaq has no ${period} ${what}`)
  const symbol = listParam(params, 'symbol').join(',').toUpperCase()
  const frequency = period === 'annual' ? 1 : 2
  const payload = await getNasdaqData(ctx, `company/${symbol.toUpperCase()}/financials?frequency=${frequency}`)
  const records = parseStatement(payload, table, fieldMap, symbol, period)
  if (!records.length) return [] // EmptyDataError
  return (typeof params.limit === 'number' ? records.slice(0, params.limit) : records).map(compact)
}

export const balanceSheet = (params: NativeParams, ctx: NativeCtx): Promise<Row[]> => statement(params, ctx, 'balance', BALANCE_SHEET_MAP, 'balance sheet')
export const cashFlow = (params: NativeParams, ctx: NativeCtx): Promise<Row[]> => statement(params, ctx, 'cash', CASH_FLOW_MAP, 'cash flow statement')
export const incomeStatement = (params: NativeParams, ctx: NativeCtx): Promise<Row[]> => statement(params, ctx, 'income', INCOME_STATEMENT_MAP, 'income statement')
export const financialRatios = (params: NativeParams, ctx: NativeCtx): Promise<Row[]> => statement(params, ctx, 'ratios', FINANCIAL_RATIOS_MAP, 'financial ratios')

// --- equity/fundamental/filings --------------------------------------------------------------------------------

const FORM_GROUPS: Record<string, string> = {
  annual: 'Annual%20Reports',
  quarterly: 'Quarterly%20Reports',
  proxy: 'Proxies%20and%20Info%20Statements',
  insider: 'Insider%20Transactions',
  '8k': '8-K%20Related',
  registration: 'Registration%20Statements',
  comment: 'Comment%20Letters',
}

const FILING_ALIASES: Record<string, string> = {
  filed: 'filing_date',
  period: 'period_ending',
  formType: 'report_type',
  companyName: 'name',
  reportingOwner: 'reporting_owner',
  htmlLink: 'report_url',
  pdfLink: 'pdf_url',
  xlsLink: 'xls_url',
  xbrLink: 'xbr_url',
  docLink: 'doc_link',
}

export async function companyFilings(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const symbol = listParam(params, 'symbol').join(',').toUpperCase()
  if (!symbol) throw new Error('Symbol field is required.')
  const year = typeof params.year === 'number' ? params.year : ctx.now().getUTCFullYear()
  const formGroup = String(params.form_group ?? '8k')
  const group = FORM_GROUPS[formGroup]
  if (group === undefined) throw new NativeUnsupported(`unknown form group ${formGroup}`)
  const headers = jsonHeaders()
  delete headers.Connection
  const url = `${BASE_URL}/company/${symbol}/sec-filings?Year=${year}&limit=100&FormGroup=${group}&sortColumn=filed&sortOrder=desc&IsQuoteMedia=true`
  const first = (await ctx.http.json<Dict>(url, { headers })).data ?? {}
  const rows: Dict[] = first.rows ?? []
  const totalRecords = first.totalRecords ? Number(first.totalRecords) : 0
  if (totalRecords < 1) throw new Error(`No data found for ${symbol} in ${params.year ?? 'None'}, for form group, ${group}.`)
  while (rows.length < totalRecords) {
    const next = ((await ctx.http.json<Dict>(`${url}&offset=${rows.length}`, { headers })).data ?? {}).rows ?? []
    if (!next.length) break
    rows.push(...next)
  }
  if (!rows.length) throw new Error('No reports for the given symbol, year, and form group.')
  return rows.map((item) => {
    const { view, ...rest } = item
    const merged: Dict = { ...rest, ...(view ?? {}) }
    const row: Dict = {}
    // the model drops every empty value before it renames the rest
    for (const [k, v] of Object.entries(merged)) if (truthy(v)) row[FILING_ALIASES[k] ?? k] = v
    if ('filing_date' in row) row.filing_date = parseLooseDate(String(row.filing_date))
    if ('period_ending' in row) {
      const d = mdyToIso(String(row.period_ending))
      if (d === null) throw new Error(`time data '${String(row.period_ending)}' does not match format '%m/%d/%Y'`)
      row.period_ending = d
    }
    return compact(row)
  })
}

// --- news/company ----------------------------------------------------------------------------------------------

export async function companyNews(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const symbols = symbolsOf(params)
  const limit = typeof params.limit === 'number' ? params.limit : undefined
  const batches = await Promise.all(
    symbols.map(async (symbol) => {
      const assetClass = await resolveAssetClass(ctx, symbol)
      try {
        const data = await getNasdaqData(ctx, `news/topic/articlebysymbol?q=${symbol}%7C${assetClass}&offset=0&limit=${limit ?? 'None'}&fallback=true`)
        return ((data ?? {}).rows ?? []).map((row: Dict) => ({ ...row, requested_symbol: symbol }))
      } catch (err) {
        ctx.log(`No news was returned for ${symbol}. ${messageOf(err)}`)
        return []
      }
    }),
  )
  const data: Dict[] = batches.flat()
  if (!data.length) return [] // EmptyDataError
  const start = params.start_date as string | undefined
  const end = params.end_date as string | undefined
  const results: Row[] = []
  const seen = new Set<string>()
  for (const row of data) {
    const url: string = row.url || ''
    const published = toDate(row.created)
    if (seen.has(url) || published === null) continue
    seen.add(url)
    if (start && published < start) continue
    if (end && published > end) continue
    const related: string[] = row.related_symbols ?? []
    const symbolsOfRow = related.map((s) => s.split('|')[0]!.toUpperCase())
    results.push(
      compact({
        date: `${published}T00:00:00`,
        title: row.title,
        excerpt: row.description,
        url: url.startsWith('http') ? url : `https://www.nasdaq.com${url}`,
        symbols: (symbolsOfRow.length ? symbolsOfRow : [row.requested_symbol]).join(','),
        publisher: row.publisher,
        topic: String(row.primarytopic || '').split('|')[0] || null,
        images: row.image ? [{ url: row.image }] : null,
      }),
    )
  }
  results.sort((a, b) => cmp(b.date as string, a.date as string))
  return limit === undefined ? results : results.slice(0, limit)
}
