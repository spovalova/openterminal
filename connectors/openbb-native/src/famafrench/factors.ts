// famafrench/factors, provider famafrench. Ported from openbb_famafrench/models/factors.py (OpenBB Platform 5.0.0,
// Apache-2.0); modified: plain rows instead of pydantic models; daily and weekly data are answered (OpenBB looks for a
// "daily" or "weekly" table among tables it only ever labels monthly or annual, and fails with an IndexError).
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { FACTOR_REGION_MAP } from './constants.js'
import { getPortfolioData, isMissingValue, toFloat } from './helpers.js'

const FACTORS: Record<string, string> = {
  '5_factors': '5_Factors',
  '3_factors': '3_Factors',
  momentum: 'Momentum',
  st_reversal: 'ST_Reversal',
  lt_reversal: 'LT_Reversal',
}

/** `__alias_dict__`: model field → the column it reads. */
const ALIASES: Record<string, string> = {
  date: 'Date',
  mkt_rf: 'Mkt-RF',
  smb: 'SMB',
  hml: 'HML',
  rmw: 'RMW',
  cma: 'CMA',
  rf: 'RF',
  mom: 'Mom',
  lt_rev: 'LT_Rev',
  st_rev: 'ST_Rev',
  wml: 'WML',
}
const COLUMN_TO_FIELD = Object.fromEntries(Object.entries(ALIASES).map(([field, column]) => [column, field]))

/** The query validator: region, factor and frequency must go together. */
function validate(region: string, factorKey: string, frequency: string): { portfolio: string; interval: string } {
  const factor = FACTORS[factorKey] ?? ''
  if ((factor === 'ST_Reversal' || factor === 'LT_Reversal') && region !== 'america') {
    throw new Error(`Invalid region, '${region}', for factor '${factor}'. Only 'america' is supported.`)
  }
  const regional = FACTOR_REGION_MAP[region]
  if (!regional) throw new Error(`Invalid region: '${region}'. Valid regions are: ${Object.keys(FACTOR_REGION_MAP).join(', ')}`)
  if (!(factor in regional.factors)) throw new Error(`Invalid factor: '${factor}' for region: '${region}'. Valid factors are: ${Object.keys(regional.factors).join(', ')}`)
  const intervals = regional.intervals[factor] ?? {}
  if (frequency && !(frequency in intervals)) {
    throw new Error(`Invalid frequency: '${frequency}' for factor: '${factor}' in region: '${region}'. Valid frequencies are: ${Object.keys(intervals).join(', ')}`)
  }
  return { portfolio: regional.factors[factor]!, interval: intervals[frequency] ?? '' }
}

export async function factors(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const region = String(params.region ?? 'america')
  const frequency = String(params.frequency ?? 'monthly')
  const { portfolio, interval } = validate(region, String(params.factor ?? '3_factors'), frequency)
  const dataset = portfolio + interval
  if (!dataset) throw new Error(`Invalid dataset, ${dataset}`)

  const { frames } = await getPortfolioData(ctx, dataset, frequency === 'daily' || frequency === 'weekly' ? null : frequency)
  const frame = frames[0]
  if (!frame) throw new Error('list index out of range')

  const start = typeof params.start_date === 'string' ? params.start_date : undefined
  const end = typeof params.end_date === 'string' ? params.end_date : undefined
  const rows: Row[] = []
  frame.index.forEach((date, r) => {
    if ((start && date < start) || (end && date > end)) return
    const row: Row = {}
    const put = (column: string, value: string | null): void => {
      // replace_missing_values, then the model: its float fields read the text, anything else is kept as it came.
      if (isMissingValue(value)) return
      const field = COLUMN_TO_FIELD[column]
      row[field ?? column] = field === undefined || field === 'date' ? value : toFloat(value)
    }
    put('Date', date)
    frame.columns.forEach((c, k) => put(c[0]!, frame.rows[r]![k]!))
    rows.push(row)
  })
  return rows
}
