// fixedincome/bond_indices, mortgage_indices, corporate/{commercial_paper, hqm, spot_rates} and
// government/{tips_yields, yield_curve}, provider fred. Ported from openbb_fred/models/{bond_indices,
// mortgage_indices, commercial_paper, high_quality_market, spot, tips_yields, yield_curve}.py and
// utils/{columns, fred_helpers}.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of DataFrames
// and pydantic models.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import data from './data.json' with { type: 'json' }
import { aliasSnake, apiKey, fredGet, getObservationsMany, joinDates, observationDates, parseDate, publishedValue, releaseTablesUrl, text, toFloat, useCache } from './helpers.js'
import { searchSeries } from './search.js'
import { fetchSeries, present, type SeriesMeta, type SeriesRow } from './series.js'

type Json = Record<string, any>
const D = data as unknown as Json

/** `column_name`: the field a series is carried under (`year15+` → `year_15_plus`, a leading digit gets `year_`). */
export function columnName(label: string): string {
  const slug = label.trim().toLowerCase().replaceAll('+', '_plus').replace(/[^0-9a-zA-Z]+/g, '_').replace(/^_+|_+$/g, '')
  return /^\d/.test(slug) ? `year_${slug}` : slug
}

/** Python's `str(float)`: whole numbers keep their ".0". */
const pyFloat = (n: number): string => (Number.isInteger(n) ? n.toFixed(1) : String(n))

const byDate = (a: Row, b: Row) => (String(a.date) < String(b.date) ? -1 : String(a.date) > String(b.date) ? 1 : 0)

/** Series options shared by the index routes. `aggregation` is the route's own default, not None, where it has one. */
function options(params: NativeParams, aggregation: string | null) {
  return {
    frequency: text(params, 'frequency') ?? null,
    aggregation_method: text(params, 'aggregation_method') ?? aggregation,
    use_cache: useCache(params),
  }
}

/**
 * The columns of a series table that were published, under their new names, in the order of `names`; nulls left out.
 * The names are those of fields the model declares, which the API writes in pydantic's snake case (`year1_year3`
 * is `year_1_year_3`).
 */
function renamed(rows: SeriesRow[], names: Record<string, string>): Row[] {
  const columns = new Set(rows.flatMap((r) => Object.keys(r)))
  const published = Object.keys(names).filter((id) => columns.has(id))
  return rows
    .map((r) => {
      const row: Row = { date: r.date }
      for (const id of published) row[aliasSnake(names[id]!)] = r[id]
      return present(row)
    })
    .sort(byDate)
}

// ---- bond indices ------------------------------------------------------------------------------------------------

const BAML: Record<string, Record<string, any>> = D.baml

export async function bondIndices(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const key = apiKey(ctx)
  // transform_query: which indices of which category, and the series behind them.
  const indexText = text(params, 'index') ?? 'yield_curve'
  const indexType = (text(params, 'index_type') ?? 'yield').toLowerCase()
  let category = text(params, 'category') ?? 'us'
  const newIndex: string[] = []
  const messages: string[] = []
  let index = indexText
  let isYieldCurve = false
  if (indexText.includes('yield_curve')) {
    if (indexText.includes(',')) messages.push("Multiple indices not allowed for: 'yield_curve'.")
    category = 'us'
    index = 'yield_curve'
    newIndex.push('yield_curve')
    isYieldCurve = true
  }
  if (!isYieldCurve) {
    for (const item of indexText.split(',')) {
      if (category === 'us') {
        if (!(item in BAML.us!)) messages.push(`Invalid index, ${item}, for category: 'us'. Must be one of ${Object.keys(BAML.us!).join(', ')}.`)
        else if (item === 'seasoned_corporate' && indexType !== 'yield') messages.push("Invalid index_type for index: 'seasoned_corporate'. Must be 'yield'.")
        else newIndex.push(item)
      }
      if (category === 'high_yield') {
        if (!['us', 'europe', 'emerging'].includes(item)) messages.push(`Invalid index, ${item}, for category: 'high_yield'. Must be one of ${Object.keys(BAML.high_yield!).join(', ')}.`)
        else newIndex.push(item)
      }
      if (category === 'emerging_markets') {
        if (!(item in BAML.emerging_markets!)) messages.push(`Invalid index, ${item}, for category: 'emerging_markets'. Must be one of ${Object.keys(BAML.emerging_markets!).join(', ')}.`)
        else newIndex.push(item)
      }
    }
  }
  if (newIndex.length === 0) throw new Error(`No valid combinations of parameters were found.\n${messages.join(',')}`)
  let symbols: string[]
  if (index.includes('yield_curve')) {
    const buckets = BAML[category]!.yield_curve as Record<string, Record<string, string>>
    symbols = Object.values(buckets).map((ids) => ids[indexType]!)
  } else {
    symbols = indexText.split(',').map((item) => BAML[category]![item]?.[indexType] as string | undefined).filter((s): s is string => !!s)
  }
  if (symbols.length === 0) throw new Error(`Error mapping the provided choices to series ID.\n${messages.join(',')}`)

  const result = await fetchSeries(ctx, key, { symbol: symbols.join(','), start_date: text(params, 'start_date') ?? null, end_date: text(params, 'end_date') ?? null, ...options(params, 'avg') })
  if (result.rows.length === 0) throw new Error('No data found for the given query. Try adjusting the parameters.')

  // index_columns: the series each requested index stands for, and the field it is written under.
  const names: Record<string, string> = {}
  if (index === 'yield_curve') {
    for (const [bucket, ids] of Object.entries(BAML[category]!.yield_curve as Record<string, Record<string, string>>)) names[ids[indexType]!] = columnName(bucket)
  } else {
    for (const item of newIndex.join(',').split(',')) {
      const symbol = BAML[category]![item]?.[indexType] as string | undefined
      if (symbol) names[symbol] = columnName(item)
    }
  }
  return renamed(result.rows, names)
}

// ---- mortgage indices -----------------------------------------------------------------------------------------------

export async function mortgageIndices(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const key = apiKey(ctx)
  const choicesToId = D.mortgage.choicesToId as Record<string, string>
  // validate_index: unknown names are dropped, none left is an error.
  const indices = (text(params, 'index') ?? 'primary').split(',').filter((i) => i in choicesToId)
  if (indices.length === 0) throw new Error(`No valid indices found. Must be any of: [${Object.keys(choicesToId).map((k) => `'${k}'`).join(', ')}]`)
  const ids = indices.map((i) => choicesToId[i]!)
  const result = await fetchSeries(ctx, key, {
    symbol: ids.join(','),
    start_date: text(params, 'start_date') ?? null,
    end_date: text(params, 'end_date') ?? null,
    transform: text(params, 'transform') ?? null,
    ...options(params, 'avg'),
  })
  if (result.rows.length === 0) throw new Error('The request was returned empty.')
  const idToColumn = Object.fromEntries(Object.entries(choicesToId).filter(([, id]) => !id.includes(',')).map(([choice, id]) => [id, choice]))
  return renamed(result.rows, idToColumn)
}

// ---- commercial paper ----------------------------------------------------------------------------------------------

export async function commercialPaper(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const key = apiKey(ctx)
  const series = D.commercialPaper as Record<string, { maturity: string; asset: string }>
  const idToColumn = Object.fromEntries(Object.entries(series).map(([id, s]) => [id, `${s.asset}_${s.maturity}`]))
  const maturity = text(params, 'maturity') ?? 'all'
  const category = text(params, 'category') ?? 'all'
  let ids: string[]
  if (maturity === 'all' && category === 'all') ids = Object.keys(series)
  else {
    const mat: Record<string, string> = { overnight: '01', '7d': '07', '15d': '15', '30d': '30', '60d': '60', '90d': '90' }
    const cat: Record<string, string> = { asset_backed: 'AAAD', financial: 'FAAD', nonfinancial: 'NAAD', a2p2: 'NA2P2D' }
    let maturities = maturity.split(',')
    let categories = category.split(',')
    if (categories.includes('all')) categories = Object.keys(cat)
    if (maturities.includes('all')) maturities = Object.keys(mat)
    ids = []
    for (const c of categories) for (const m of maturities) ids.push(`RIFSPP${cat[c] ?? 'None'}${mat[m] ?? 'None'}NB`)
  }
  const result = await fetchSeries(ctx, key, {
    symbol: ids.join(','),
    start_date: text(params, 'start_date') ?? '2019-01-01',
    end_date: text(params, 'end_date') ?? null,
    frequency: text(params, 'frequency') ?? null,
    aggregation_method: text(params, 'aggregation_method') ?? null,
    transform: text(params, 'transform') ?? null,
    use_cache: useCache(params),
  })
  if (result.rows.length === 0) throw new Error('The request was returned empty.')
  return renamed(result.rows, idToColumn)
}

// ---- high quality market corporate bonds ------------------------------------------------------------------------------

export async function hqm(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const key = apiKey(ctx)
  const elementId = (text(params, 'yield_curve') ?? 'spot') === 'spot' ? '219299' : '219294'
  const urls = observationDates(params.date).map((date) => releaseTablesUrl('402', elementId, key, date))
  const results: { date: string; rate: number; maturity: string }[] = []
  const payloads = await Promise.all(urls.map((url) => fredGet(ctx, url, { useCache: useCache(params) })))
  for (const payload of payloads) {
    if (!payload || Object.keys(payload).length === 0) continue
    for (const v of Object.values((payload.elements ?? {}) as Record<string, Json>)) {
      const value = v.observation_value
      if (!value) continue
      const date = parseDate(String(v.observation_date))
      if (!date) throw new Error(`Unknown string format: ${v.observation_date}`)
      const parts = String(v.name).toLowerCase().split('-')
      const rate = toFloat(value)
      if (rate === null) throw new Error(`could not convert string to float: '${value}'`)
      results.push({ date, rate, maturity: `${parts[1]}_${parts[0]}`.replaceAll(' ', '') })
    }
  }
  // transform_data: maturities ordered by their number of years or months; one that is not a number fails the request.
  const tenor = results.map((r) => {
    const n = Number(r.maturity.replace('year_', ''))
    if (Number.isNaN(n) || r.maturity.replace('year_', '').trim() === '') throw new Error(`could not convert string to float: '${r.maturity.replace('year_', '')}'`)
    return n
  })
  const order = results.map((r, i) => ({ r, tenor: tenor[i]! }))
  order.sort((a, b) => (a.r.date < b.r.date ? -1 : a.r.date > b.r.date ? 1 : a.tenor - b.tenor))
  return order.map(({ r }) => ({ date: r.date, rate: r.rate, maturity: r.maturity }))
}

// ---- corporate spot rates -------------------------------------------------------------------------------------------------

export async function spotRates(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const key = apiKey(ctx)
  const rates = D.spotRates as [string, string, string][]
  const categories = (text(params, 'category') ?? 'spot_rate').toLowerCase().split(',').map((c) => c.trim()).filter(Boolean)
  const rawMaturity = text(params, 'maturity') ?? '10.0'
  const maturities = rawMaturity.split(',').map((m) => {
    const n = toFloat(m)
    if (n === null) throw new Error('maturity must be a float or a comma-separated string of floats')
    return n
  })
  const years = (m: string) => Number(m.replaceAll('y', ''))
  const published = [...new Set(rates.filter(([, c]) => categories.includes(c)).map(([m]) => years(m)))].sort((a, b) => a - b)
  if (published.length === 0) throw new Error(`No spot rates are published for: ${categories.join(', ')}. Choose from: par_yield, spot_rate.`)
  const unknown = maturities.filter((m) => !published.includes(m))
  if (unknown.length > 0) throw new Error(`Maturity not published for ${categories.join(', ')}: ${unknown.map(pyFloat).join(', ')}. Choose from: ${published.map(pyFloat).join(', ')}.`)
  const series = rates.filter(([m, c]) => maturities.includes(years(m)) && categories.includes(c))
  const observations = await getObservationsMany(ctx, series.map(([, , id]) => id), key, { start: text(params, 'start_date'), end: text(params, 'end_date'), useCache: useCache(params) })
  const out: { date: string; maturity: string; rate: number | null; tenor: number }[] = []
  series.forEach(([m], i) => {
    for (const row of observations[i]!) out.push({ date: row.date, maturity: `year_${m.replace(/y$/, '')}`, rate: publishedValue(row.value), tenor: years(m) })
  })
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.tenor - b.tenor))
  if (out.length === 0) throw new Error('The request was returned empty.')
  return out.map((r) => present({ date: r.date, maturity: r.maturity, rate: r.rate }))
}

// ---- TIPS yields -------------------------------------------------------------------------------------------------------------

/** pandas.to_datetime for the due dates in a TIPS series title (`January 15, 2026`, `Jan 2026`, `01/15/2026`, `2026-01-15`). */
function toDate(textValue: string): string {
  const parsed = parseDate(textValue.trim())
  if (!parsed) throw new Error(`Unknown datetime string format, unable to parse: ${textValue}`)
  return parsed
}

export async function tipsYields(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const key = apiKey(ctx)
  // The TIPS series are the series of release 72 whose title is not discontinued, ordered by the date they fall due.
  let listed: Row[]
  try {
    listed = await searchSeries(ctx, key, { release_id: 72 })
  } catch (err) {
    throw new Error(err instanceof Error && err.message ? err.message : 'FRED request failed (Error).', { cause: err })
  }
  const tips = listed
    .filter((s) => !String(s.title ?? '').includes('DISCONTINUED'))
    .map((s) => ({ id: String(s.series_id), title: String(s.title), due: toDate(String(s.title).split('Due ').at(-1)!.trim()) }))
    .sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : 0))
  let ids = tips.map((t) => t.id)
  const maturity = text(params, 'maturity')
  if (maturity) ids = ids.filter((i) => i.split('DTP').at(-1)!.startsWith(maturity))
  const dueOf = new Map(tips.map((t) => [t.id, t.due]))
  const titleOf = new Map(tips.map((t) => [t.id, t.title.replaceAll('Treasury Inflation-Indexed', 'TIPS').replaceAll('  ', ' ').trim()]))

  let result: { rows: SeriesRow[]; metadata: Record<string, SeriesMeta> }
  try {
    result = await fetchSeries(ctx, key, {
      symbol: ids.join(','),
      ...(text(params, 'start_date') ? { start_date: text(params, 'start_date')! } : {}),
      ...(text(params, 'end_date') ? { end_date: text(params, 'end_date')! } : {}),
      ...(text(params, 'frequency') ? { frequency: text(params, 'frequency')! } : {}),
      ...(text(params, 'aggregation_method') ? { aggregation_method: text(params, 'aggregation_method')! } : {}),
      ...(text(params, 'transform') ? { transform: text(params, 'transform')! } : {}),
      use_cache: useCache(params),
    })
  } catch (err) {
    throw new Error(err instanceof Error && err.message ? err.message : 'FRED request failed (Error).', { cause: err })
  }
  // melt, drop the missing, order by date and due date.
  const long: Row[] = []
  const columns = Object.keys(result.metadata)
  for (const symbol of columns) {
    for (const r of result.rows) {
      const value = r[symbol]
      if (value === null || value === undefined) continue
      long.push({ date: r.date, due: dueOf.get(symbol), symbol, name: titleOf.get(symbol), value })
    }
  }
  long.sort((a, b) => (String(a.date) < String(b.date) ? -1 : String(a.date) > String(b.date) ? 1 : String(a.due ?? '') < String(b.due ?? '') ? -1 : String(a.due ?? '') > String(b.due ?? '') ? 1 : 0))
  if (long.length === 0) throw new Error('There was an error with the request and was returned empty.')
  return long.map(present)
}

// ---- yield curves ---------------------------------------------------------------------------------------------------------------

/** The `maturity_years` that YieldCurveData computes from `month_3`, `year_10`, `year_1_month_6`. */
function maturityYears(maturity: string): number | null {
  if (!maturity.includes('_')) return null
  const parts = maturity.split('_')
  let months = 0
  for (let i = 0; i < parts.length; i += 2) months += Number(parts[i + 1]) * (parts[i] === 'year' ? 12 : 1)
  return months / 12
}

export async function yieldCurve(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const key = apiKey(ctx)
  const type = text(params, 'yield_curve_type') ?? 'nominal'
  const curve = (D.yieldCurves as Record<string, Record<string, string>>)[type]
  if (!curve) throw new Error(`yield_curve_type: Input should be one of ${Object.keys(D.yieldCurves).join(', ')} (got ${type})`)
  const dateText = joinDates(text(params, 'date'))
  const result = await fetchSeries(ctx, key, { symbol: Object.keys(curve).join(','), use_cache: useCache(params) })
  if (result.rows.length === 0) throw new Error('The request was returned empty.')

  // The observation at or before each requested date (the latest one when none is asked for).
  const available = result.rows.map((r) => r.date)
  const requested = dateText ? dateText.split(',') : [available.at(-1)!]
  const selected = [...new Set(requested.map((d) => [...available].reverse().find((a) => a <= d)).filter((d): d is string => d !== undefined))].sort()
  const columns = new Set(result.rows.flatMap((r) => Object.keys(r)))
  const maturities = Object.entries(curve).filter(([id]) => columns.has(id))
  const out: Row[] = []
  for (const date of selected) {
    const row = result.rows.find((r) => r.date === date)!
    for (const [id, maturity] of maturities) {
      const rate = row[id]
      out.push(present({ date, maturity, rate, maturity_years: maturityYears(maturity) }))
    }
  }
  return out
}
