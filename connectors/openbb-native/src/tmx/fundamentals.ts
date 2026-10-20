// equity/fundamental/{balance,cash,income}, provider tmx. Ported from openbb_tmx/models/{balance_sheet,cash_flow,
// income_statement}.py and utils/{financials,quotemedia}.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows
// instead of pydantic models (the statements' many `float | None` line items pass through as the numbers QuoteMedia
// sends).
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { applyAliases, compact, normalizeSymbol, numParam, oneOf, optFloat, qmDatatool, statementSnakeCase, TmxError, truthy } from './helpers.js'

const ALL_REPORTS = 500
const STATEMENT_TYPES = ['IncomeStatement', 'BalanceSheet', 'CashFlow']

type Statement = 'income' | 'balance' | 'cash'
const STATEMENT_KEYS: Record<Statement, string> = { income: 'IncomeStatement', balance: 'BalanceSheet', cash: 'CashFlow' }

const BALANCE_ALIASES: Record<string, string> = {
  receivables_adjustments_allowances: 'recievables_adjustments_allowances',
  mortgage_and_consumer_loans: 'mortgage_and_consumerloans',
  securities_agreed_to_be_resold: 'security_agree_to_be_resell',
  total_non_current_liabilities_net_minority_interest: 'total_non_current_liabilities_net_minority_interes',
}

const INCOME_ALIASES: Record<string, string> = {
  trust_fees_by_commissions: 'trust_feesby_commissions',
  other_cost_of_revenue: 'other_costof_revenue',
  other_general_and_administrative: 'other_gand_a',
  restructuring_and_merger_acquisition_income: 'restructring_and_mn_a_income',
  restructuring_and_merger_and_acquisition: 'restructuring_and_mergern_acquisition',
}

const ALIASES: Record<Statement, Record<string, string>> = { income: INCOME_ALIASES, balance: BALANCE_ALIASES, cash: {} }

/** `get_financials`: the reports QuoteMedia holds for a symbol, newest first. */
async function getFinancials(ctx: NativeCtx, symbol: string, period: string, limit: number): Promise<Row[]> {
  const results = await qmDatatool(ctx, 'getFinancialsEnhancedBySymbol.json', 'Financials', {
    symbol,
    lang: 'en',
    reportType: period === 'annual' ? 'A' : 'Q',
    reportOrder: 'D',
    numberOfReports: limit,
    latestfiscaldate: true,
    currency: true,
    typeList: STATEMENT_TYPES.join(','),
  })
  const reports = (results.Company as Row | undefined)?.Report ?? []
  return Array.isArray(reports) ? (reports as Row[]) : [reports as Row]
}

/** `transform_reports`: one row per reporting period, newest first. */
function transformReports(reports: Row[], statement: Statement): Row[] {
  const key = STATEMENT_KEYS[statement]
  const rows: Row[] = []
  for (const report of reports) {
    const lines = report[key] as Row | undefined
    if (!truthy(lines)) continue
    const periodEnding = (report.periodEndDate || report.reportDate) as string | undefined
    if (!periodEnding) continue
    const row: Row = {
      period_ending: periodEnding,
      fiscal_period: report.reportPeriod === 'A' ? 'annual' : `Q${String(report.reportQuarter)}`,
      fiscal_year: report.reportYear,
      reported_currency: report.currency,
    }
    for (const [k, v] of Object.entries(lines as Row)) row[statementSnakeCase(k)] = v
    rows.push(row)
  }
  return rows.sort((a, b) => (String(a.period_ending) < String(b.period_ending) ? 1 : String(a.period_ending) > String(b.period_ending) ? -1 : 0))
}

/** The three statements share everything but the key of the report section and a few line-item names. */
export function statementHandler(statement: Statement) {
  return async (params: NativeParams, ctx: NativeCtx): Promise<Row[]> => {
    const symbol = normalizeSymbol(String(params.symbol).toUpperCase())
    const period = oneOf(params, 'period', ['annual', 'quarter'] as const, 'annual')
    const limit = numParam(params, 'limit') || ALL_REPORTS
    const reports = transformReports(await getFinancials(ctx, symbol, period, limit), statement)
    if (reports.length === 0) return []
    return reports.map((d) => {
      const row = applyAliases(d, ALIASES[statement])
      if (!/^\d{4}-\d{2}-\d{2}/.test(String(row.period_ending))) throw new TmxError(`Input should be a valid date: ${String(row.period_ending)}`)
      row.period_ending = String(row.period_ending).slice(0, 10)
      if ('fiscal_year' in row) row.fiscal_year = optFloat(row.fiscal_year) ?? null
      return compact(row)
    })
  }
}
