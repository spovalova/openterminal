// ustreasury/spending_explorer, provider us_treasury. Ported from openbb_government_us/treasury/models/usaspending_explorer.py
// and utils/spending.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { validateModel } from './coerce.js'
import { EXPLORER_FIELDS } from './fields.js'
import { boundedInt, EmptyDataError, literalParam, optInt, optString } from './helpers.js'
import { getUsaspending, postUsaspending, REQUEST_TIMEOUT_MS } from './usaspending.js'

const EARLIEST_FISCAL_YEAR = 2017

const EXPLORER_TYPES = ['budget_function', 'budget_subfunction', 'agency', 'federal_account', 'program_activity', 'object_class', 'recipient', 'award', 'award_category']

/** Breakdowns that stand alone; the rest are too large to return government-wide. */
const ENTRY_TYPES = ['budget_function', 'budget_subfunction', 'agency', 'federal_account', 'object_class']

/** The dimensions a breakdown can be scoped by. */
const DRILL_FIELDS = ['budget_function', 'budget_subfunction', 'agency', 'federal_account', 'program_activity', 'object_class', 'recipient']

/** `latest_submission`: the most recent published fiscal year and period (within `fiscalYear` when given). */
async function latestSubmission(ctx: NativeCtx, fiscalYear: number | undefined): Promise<[number, string]> {
  const response = await getUsaspending(ctx, 'references/submission_periods/', { timeoutMs: REQUEST_TIMEOUT_MS })
  const periods = ((response.available_periods as Row[] | undefined) ?? []).filter((row) => row.submission_fiscal_month && (fiscalYear === undefined || row.submission_fiscal_year === fiscalYear))
  if (periods.length === 0) {
    throw new Error(`No published submission period was found for FY${fiscalYear}. Data begins in FY${EARLIEST_FISCAL_YEAR} Q2 and the most recent year is only published as its periods close.`)
  }
  const latest = periods.reduce((a, b) => {
    const ka = [Number(a.submission_fiscal_year), Number(a.submission_fiscal_month)]
    const kb = [Number(b.submission_fiscal_year), Number(b.submission_fiscal_month)]
    return kb[0]! > ka[0]! || (kb[0] === ka[0] && kb[1]! > ka[1]!) ? b : a
  })
  return [Number(latest.submission_fiscal_year), String(latest.submission_fiscal_month)]
}

export async function spendingExplorer(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const explorerType = literalParam(params, 'explorer_type', EXPLORER_TYPES, 'object_class')
  const fiscalYearParam = optInt(params, 'fiscal_year')
  if (fiscalYearParam !== undefined) boundedInt(params, 'fiscal_year', fiscalYearParam, EARLIEST_FISCAL_YEAR)
  const periodParam = optString(params, 'period') ?? 'latest'
  const scope = Object.fromEntries(DRILL_FIELDS.map((f) => [f, optString(params, f)]))

  // A breakdown too large to return government-wide needs a scope.
  const scoped = DRILL_FIELDS.some((f) => f !== explorerType && scope[f])
  if (!scoped && !ENTRY_TYPES.includes(explorerType)) {
    throw new Error(`A '${explorerType}' breakdown is too large to return government-wide, so it needs a scope. Set one of: ${DRILL_FIELDS.join(', ')}; or choose a dimension that stands alone: ${[...ENTRY_TYPES].sort().join(', ')}.`)
  }

  let fiscalYear = fiscalYearParam
  let period = periodParam
  if (period === 'latest' || fiscalYear === undefined) {
    const [resolvedYear, resolvedPeriod] = await latestSubmission(ctx, fiscalYear)
    fiscalYear = fiscalYear || resolvedYear
    period = period === 'latest' ? resolvedPeriod : period
  }

  const filters: Row = { fy: String(fiscalYear), period }
  for (const field of DRILL_FIELDS) if (scope[field] && field !== explorerType) filters[field] = scope[field]

  const data = await postUsaspending(ctx, 'spending/', { type: explorerType, filters }, { timeoutMs: REQUEST_TIMEOUT_MS })
  const results = (data.results as Row[] | undefined) ?? []
  if (results.length === 0) throw new EmptyDataError(`No '${explorerType}' spending was returned for FY${fiscalYear} period ${period}.`)

  // Each entry's share of the total, as of the end of the period.
  const total = data.total as number | null | undefined
  const asOf = String(data.end_date || '').split('T')[0] || undefined
  return results.map((row) => {
    const amount = row.amount as number | null | undefined
    const id = row.id
    return validateModel(
      EXPLORER_FIELDS,
      {},
      {
        name: row.name,
        amount,
        percent_of_total: amount !== null && amount !== undefined && total ? (amount / total) * 100 : null,
        code: row.code,
        account_number: row.account_number,
        explorer_id: id !== null && id !== undefined && id !== '' && id !== 'None' ? String(id) : null,
        as_of_date: asOf,
      },
      'UsSpendingExplorerData',
    )
  })
}
