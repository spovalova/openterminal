// famafrench/country_portfolio_returns and famafrench/international_index_returns, provider famafrench. Ported from
// openbb_famafrench/models/country_portfolio_returns.py and international_index_returns.py (OpenBB Platform 5.0.0,
// Apache-2.0); modified: plain rows instead of pydantic models; start_date and end_date cut the Date level of the
// index (OpenBB compares the whole (Date, Mkt) tuple with a string and fails with a TypeError on every table with a
// Mkt column).
import type { NativeCtx, NativeHandler, NativeParams, Row } from '../types.js'
import { getInternationalPortfolio, isMissingValue, toFloat, type Frame, type FrameMeta, type InternationalOptions } from './helpers.js'

/** `__alias_dict__` inverted: column → model field. */
const FIELDS: Record<string, string> = {
  Date: 'date',
  Mkt: 'mkt',
  Firms: 'firms',
  'B/M': 'bm',
  'BE/ME High': 'be_me_high',
  'BE/ME Low': 'be_me_low',
  'E/P': 'ep',
  'E/P High': 'e_p_high',
  'E/P Low': 'e_p_low',
  'CE/P': 'ce_p',
  'CE/P High': 'ce_p_high',
  'CE/P Low': 'ce_p_low',
  Yld: 'yld',
  'Yld High': 'yld_high',
  'Yld Low': 'yld_low',
  'Yld Zero': 'yld_zero',
}

/** The model's value for a column: `firms` is a whole number, `date` text, the others floats; unknown columns stay text. */
function modelValue(column: string, value: string | number): unknown {
  const field = FIELDS[column]
  if (field === undefined || field === 'date') return value
  const n = typeof value === 'number' ? value : toFloat(value)
  if (field === 'firms' && !Number.isInteger(n)) throw new Error(`Input should be a valid integer, got a number with a fractional part: ${n}`)
  return n
}

/** The transform both routes share. */
function transform(found: { frames: Frame[]; metas: FrameMeta[] }, start: string | undefined, end: string | undefined): Row[] {
  const frame = found.frames[0]
  if (!frame) throw new Error('The request was returned empty.')
  // `meta[0]` is read for the description: a list of frames longer than the list of descriptions fails there.
  if (found.metas.length === 0) throw new Error('list index out of range')

  const kept = frame.columns.map((c, k) => ({ name: c.filter((level) => level !== '').join(' '), k })).filter(({ k }) => !frame.rows.every((r) => isMissingValue(r[k])))
  const rows: Row[] = []
  frame.index.forEach((date, r) => {
    if ((start && date < start) || (end && date > end)) return
    const row: Row = {}
    const put = (column: string, value: string | number | null): void => {
      if (!isMissingValue(value)) row[FIELDS[column] ?? column] = modelValue(column, value as string | number)
    }
    put('Date', date)
    if (frame.mkt) put('Mkt', frame.mkt[r]!)
    for (const { name, k } of kept) put(name, frame.rows[r]![k] === null ? null : toFloat(frame.rows[r]![k]!))
    rows.push(row)
  })
  return rows
}

function international(subject: 'country' | 'index'): NativeHandler {
  return async (params: NativeParams, ctx: NativeCtx): Promise<Row[]> => {
    const measure = String(params.measure ?? 'usd')
    // Ratios exist only as annual figures.
    const frequency = measure === 'ratios' ? 'annual' : String(params.frequency ?? 'monthly')
    const options: InternationalOptions = {
      ...(subject === 'country' ? { country: String(params.country) } : { index: String(params.index ?? 'all') }),
      measure,
      frequency,
      dividends: typeof params.dividends === 'boolean' ? params.dividends : true,
      allDataItemsRequired: typeof params.all_data_items_required === 'boolean' ? params.all_data_items_required : true,
    }
    const found = await getInternationalPortfolio(ctx, options)
    return transform(found, typeof params.start_date === 'string' ? params.start_date : undefined, typeof params.end_date === 'string' ? params.end_date : undefined)
  }
}

export const countryPortfolioReturns = international('country')
export const internationalIndexReturns = international('index')
