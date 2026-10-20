// equity/fundamental/{balance,cash,income}[_growth], provider sec. Ported from openbb_sec/models/{balance_sheet,cash_flow,
// income_statement}[_growth].py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models (a
// field the period lacks is omitted, as the serialised NaN is null), and the validation warnings are logged.
import type { NativeCtx, NativeParams, Row } from '../../types.js'
import { getStandardizedFinancials, type PeriodType, type StatementRecord } from './company-facts.js'
import {
  BALANCE_SHEET_FIELDS,
  BALANCE_SHEET_GROWTH_FIELDS,
  BALANCE_SHEET_GROWTH_INT_FIELDS,
  BALANCE_SHEET_INT_FIELDS,
  CASH_FLOW_FIELDS,
  CASH_FLOW_GROWTH_FIELDS,
  CASH_FLOW_GROWTH_INT_FIELDS,
  CASH_FLOW_INT_FIELDS,
  INCOME_STATEMENT_FIELDS,
  INCOME_STATEMENT_GROWTH_FIELDS,
  INCOME_STATEMENT_GROWTH_INT_FIELDS,
  INCOME_STATEMENT_INT_FIELDS,
} from './model-fields.js'
import type { StatementName } from './types.js'

type StatementModel = { statement: StatementName; fields: readonly string[]; intFields: readonly string[]; growth: boolean; defaultLimit: number | null }

const MODELS = {
  balance: { statement: 'balance_sheet', fields: BALANCE_SHEET_FIELDS, intFields: BALANCE_SHEET_INT_FIELDS, growth: false, defaultLimit: null },
  cash: { statement: 'cash_flow', fields: CASH_FLOW_FIELDS, intFields: CASH_FLOW_INT_FIELDS, growth: false, defaultLimit: 5 },
  income: { statement: 'income_statement', fields: INCOME_STATEMENT_FIELDS, intFields: INCOME_STATEMENT_INT_FIELDS, growth: false, defaultLimit: null },
  balanceGrowth: { statement: 'balance_sheet', fields: BALANCE_SHEET_GROWTH_FIELDS, intFields: BALANCE_SHEET_GROWTH_INT_FIELDS, growth: true, defaultLimit: null },
  cashGrowth: { statement: 'cash_flow', fields: CASH_FLOW_GROWTH_FIELDS, intFields: CASH_FLOW_GROWTH_INT_FIELDS, growth: true, defaultLimit: null },
  incomeGrowth: { statement: 'income_statement', fields: INCOME_STATEMENT_GROWTH_FIELDS, intFields: INCOME_STATEMENT_GROWTH_INT_FIELDS, growth: true, defaultLimit: null },
} satisfies Record<string, StatementModel>

/** `period` of the growth routes → the period the standardized statements are built for. */
const GROWTH_PERIOD: Record<string, PeriodType> = { annual: 'yoy', quarterly: 'pop', quarterly_yoy: 'yoy_quarterly', ttm: 'pop' }

async function statementRows(model: StatementModel, params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const symbol = String(params.symbol ?? '').toUpperCase()
  const period = String(params.period ?? 'annual')
  const allowed = model.growth ? Object.keys(GROWTH_PERIOD) : ['annual', 'quarterly', 'ttm']
  if (!allowed.includes(period)) throw new Error(`Input should be ${allowed.map((p) => `'${p}'`).join(', ')}; got '${period}'`)
  const limit = params.limit === undefined || params.limit === null ? model.defaultLimit : Number(params.limit)

  const result = await getStandardizedFinancials(ctx, {
    symbol,
    period: model.growth ? GROWTH_PERIOD[period]! : (period as PeriodType),
    useCache: params.use_cache === undefined ? true : Boolean(params.use_cache),
    includePreliminary: Boolean(params.include_preliminary ?? false),
    pitMode: Boolean(params.pit_mode ?? false),
  })

  const records: StatementRecord[] = result[model.statement]
  if (records.length === 0) throw new Error('The request was returned empty.')

  // Group records by period_ending to pivot from long to wide format.
  const periods = new Map<string, Record<string, unknown>>()
  for (const rec of records) {
    if (!periods.has(rec.period_ending)) {
      periods.set(rec.period_ending, { period_ending: rec.period_ending, fiscal_period: rec.fiscal_period, fiscal_year: rec.fiscal_year, reported_currency: rec.currency })
    }
    periods.get(rec.period_ending)![model.growth ? `growth_${rec.tag}` : rec.tag] = rec.value
  }

  // normalize_period_fields: every period carries the model's fields that any period has (the rest are dropped).
  const allTags = new Set<string>()
  for (const d of periods.values()) for (const k of Object.keys(d)) allTags.add(k)
  const orderedTags = model.fields.filter((f) => allTags.has(f))

  // Sort by period_ending descending (most recent first).
  let sorted = [...periods.values()].sort((a, b) => ((a.period_ending as string) < (b.period_ending as string) ? 1 : (a.period_ending as string) > (b.period_ending as string) ? -1 : 0))
  if (limit !== null) sorted = sorted.slice(0, limit)

  const ints = new Set(model.intFields)
  return sorted.map((d) => {
    const row: Row = {}
    for (const tag of orderedTags) {
      const v = d[tag]
      if (v === undefined || v === null) continue
      if (typeof v === 'number') {
        if (Number.isNaN(v)) continue
        // pydantic: an int field takes a float only when it has no fractional part.
        if (ints.has(tag) && !Number.isInteger(v)) throw new Error(`${tag}: Input should be a valid integer, got a number with a fractional part`)
      }
      row[tag] = v
    }
    return row
  })
}

export const balanceSheet = (params: NativeParams, ctx: NativeCtx) => statementRows(MODELS.balance, params, ctx)
export const cashFlow = (params: NativeParams, ctx: NativeCtx) => statementRows(MODELS.cash, params, ctx)
export const incomeStatement = (params: NativeParams, ctx: NativeCtx) => statementRows(MODELS.income, params, ctx)
export const balanceSheetGrowth = (params: NativeParams, ctx: NativeCtx) => statementRows(MODELS.balanceGrowth, params, ctx)
export const cashFlowGrowth = (params: NativeParams, ctx: NativeCtx) => statementRows(MODELS.cashGrowth, params, ctx)
export const incomeStatementGrowth = (params: NativeParams, ctx: NativeCtx) => statementRows(MODELS.incomeGrowth, params, ctx)
