// famafrench/us_portfolio_returns and famafrench/regional_portfolio_returns, provider famafrench. Ported from
// openbb_famafrench/models/us_portfolio_returns.py and regional_portfolio_returns.py (OpenBB Platform 5.0.0,
// Apache-2.0); modified: plain rows instead of pydantic models and a DataFrame melt.
import type { NativeCtx, NativeHandler, NativeParams, Row } from '../types.js'
import { PORTFOLIO_FILES } from './constants.js'
import { getPortfolioData, isMissingValue, toFloat, type Frame } from './helpers.js'

/** The transform both routes share: drop empty columns, cut the dates, melt to one row per portfolio and date. */
function melt(frame: Frame, measure: string, start: string | undefined, end: string | undefined): Row[] {
  // A column with nothing but missing values goes; the others are numbers from here on.
  const columns = frame.columns.map((c, k) => ({ name: c[0]!, k })).filter(({ k }) => !frame.rows.every((r) => isMissingValue(r[k])))
  const numbers = new Map(columns.map(({ k }) => [k, frame.rows.map((r) => toFloat(r[k]!))]))

  const rows: Row[] = []
  for (const { name, k } of columns) {
    frame.index.forEach((date, r) => {
      if ((start && date < start) || (end && date > end)) return
      const value = numbers.get(k)![r]!
      const row: Row = { date, portfolio: name, measure }
      // replace_missing_values: markers become missing; counts of firms are whole numbers.
      if (!isMissingValue(value)) row.value = measure === 'number_of_firms' ? Math.trunc(value) : value
      rows.push(row)
    })
  }
  return rows
}

function portfolioReturns(slowFrequencies: readonly string[]): NativeHandler {
  return async (params: NativeParams, ctx: NativeCtx): Promise<Row[]> => {
    const portfolio = String(params.portfolio)
    const measure = String(params.measure ?? 'value')
    const dataset = PORTFOLIO_FILES[portfolio] ?? ''
    // Daily (and weekly) files are not split into monthly and annual tables, so no frequency is asked of them.
    const frequency = slowFrequencies.some((f) => dataset.toLowerCase().includes(f)) ? null : String(params.frequency ?? 'monthly')

    const { frames } = await getPortfolioData(ctx, dataset, frequency, measure)
    const frame = frames[0]
    if (!frame) throw new Error('The request was returned empty.')
    const start = typeof params.start_date === 'string' ? params.start_date : undefined
    const end = typeof params.end_date === 'string' ? params.end_date : undefined
    return melt(frame, measure, start, end)
  }
}

export const usPortfolioReturns = portfolioReturns(['daily', 'weekly'])
export const regionalPortfolioReturns = portfolioReturns(['daily'])
