// economy/{balance_of_payments, cpi, retail_prices, fred_regional}, commodity/price/spot, provider fred. Ported from
// openbb_fred/models/{balance_of_payments, consumer_price_index, retail_prices, regional, commodity_spot_prices}.py
// and utils/fred_helpers.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of DataFrames and
// pydantic models; the commodity spot price default window is counted from ctx.now() in UTC.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import data from './data.json' with { type: 'json' }
import { apiKey, buildUrl, fredGet, GEO_ROOT_URL, text, today, useCache } from './helpers.js'
import { fetchSeries, present } from './series.js'

type Json = Record<string, any>
const D = data as unknown as Json

const byKey = (...keys: string[]) => (a: Row, b: Row) => {
  for (const k of keys) {
    const x = String(a[k])
    const y = String(b[k])
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

// ---- balance of payments ------------------------------------------------------------------------------------------------

export async function balanceOfPayments(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const key = apiKey(ctx)
  const country = text(params, 'country') ?? 'united_states'
  const code = (D.bopCountries as Record<string, string>)[country] ?? 'USA'
  const series = Object.fromEntries(Object.entries(D.bopSeries as Record<string, string>).map(([name, template]) => [name, template.replace('{c}', code)]))
  const result = await fetchSeries(ctx, key, {
    symbol: Object.values(series).join(','),
    start_date: text(params, 'start_date') ?? null,
    end_date: text(params, 'end_date') ?? null,
    use_cache: useCache(params),
    extra: { country },
  })
  if (result.rows.length === 0) throw new Error(`No data was found for, ${country}.`)
  const names = Object.fromEntries(Object.entries(series).map(([name, id]) => [id, name]))
  // Newest first, each series under the name OpenBB gives it, the date as `period`.
  return [...result.rows]
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    .map((r) => {
      const row: Row = { period: r.date }
      for (const [id, v] of Object.entries(r)) if (id !== 'date') row[names[id] ?? id] = v
      return present(row)
    })
}

// ---- consumer prices ----------------------------------------------------------------------------------------------------------

export async function cpi(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const key = apiKey(ctx)
  const countries = D.cpiCountries as string[]
  const country = (text(params, 'country') ?? 'united_states').replaceAll(' ', '_').split(',').map((v) => {
    if (!countries.includes(v.toLowerCase())) throw new Error(`Invalid country: ${v}. Available countries are: ${countries.join(', ')}`)
    return v.toLowerCase()
  }).join(',')
  const transform = (text(params, 'transform') ?? 'yoy').toLowerCase()
  if (!['index', 'yoy', 'period'].includes(transform)) throw new Error(`Invalid transform: ${transform}. Available transforms are: index, yoy, period`)
  const requested = text(params, 'frequency') ?? 'monthly'
  const frequency = requested === 'quarter' ? 'quarterly' : requested
  const harmonized = params.harmonized === true || params.harmonized === 'true'
  const options = (harmonized ? D.harmonizedCpi : D.cpi) as [string, string, string, string][]
  const unitsFor: Record<string, string> = { period: 'growth_previous', yoy: 'growth_same', index: 'index_2015' }
  const units = transform === 'period' && frequency === 'annual' ? 'growth_same' : unitsFor[transform]
  // `x['country'] in query.country` is a test on the comma-joined text.
  const chosen = options.filter(([c, f, u]) => country.includes(c) && u === units && f === frequency)
  const countryOf = new Map(chosen.map(([c, , , id]) => [id, c]))
  const result = await fetchSeries(ctx, key, { symbol: chosen.map((c) => c[3]).join(','), start_date: text(params, 'start_date') ?? undefined, end_date: text(params, 'end_date') ?? undefined, use_cache: useCache(params) })
  // The columns are renamed to their country in a dict, so when several series stand for one country the last one's
  // value (missing or not) is the one that stays.
  const wide = result.rows.map((r) => {
    const row = new Map<string, number | null>()
    for (const [id, value] of Object.entries(r)) if (id !== 'date') row.set(countryOf.get(id) ?? id, value as number | null)
    return { date: r.date, row }
  })
  const countriesPublished = [...new Set(Object.keys(result.metadata).map((id) => countryOf.get(id) ?? id))]
  const long: Row[] = []
  for (const name of countriesPublished) {
    for (const { date, row } of wide) {
      const value = row.get(name)
      if (value === null || value === undefined) continue
      long.push({ date, country: name, value })
    }
  }
  if (long.length === 0) throw new Error('No data found for the given query. Try adjusting the parameters.')
  return long.sort(byKey('date', 'country'))
}

// ---- commodity spot prices ----------------------------------------------------------------------------------------------------

export async function commoditySpot(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const key = apiKey(ctx)
  const commodity = text(params, 'commodity') ?? 'all'
  const symbols = (D.commodity as Record<string, string>)[commodity]
  if (symbols === undefined) throw new Error(`commodity: Input should be one of ${Object.keys(D.commodity).join(', ')} (got ${commodity})`)
  let result
  try {
    result = await fetchSeries(ctx, key, {
      symbol: symbols,
      // Three years back, in weeks, when no start is given; today when no end is.
      start_date: text(params, 'start_date') ?? today(ctx, -156 * 7),
      end_date: text(params, 'end_date') ?? today(ctx),
      frequency: text(params, 'frequency') ?? null,
      aggregation_method: text(params, 'aggregation_method') ?? 'eop',
      transform: text(params, 'transform') ?? null,
      use_cache: useCache(params),
    })
  } catch (err) {
    throw new Error(`Failed to fetch data from FRED API: ${err instanceof Error ? err.message : String(err)}`, { cause: err })
  }
  if (result.rows.length === 0) throw new Error('The request was returned with no data.')
  const long: Row[] = []
  for (const symbol of Object.keys(result.metadata)) {
    for (const r of result.rows) {
      const price = r[symbol]
      if (price === null || price === undefined) continue
      long.push(present({ date: r.date, symbol, price, commodity: result.metadata[symbol]?.title as string | undefined, unit: result.metadata[symbol]?.units as string | undefined }))
    }
  }
  return long.sort(byKey('date'))
}

// ---- retail prices ------------------------------------------------------------------------------------------------------------

export async function retailPrices(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const key = apiKey(ctx)
  const retail = D.retail as Json
  const frequencies: Record<string, string> = { annual: 'a', quarter: 'q', monthly: 'm' }
  const region = text(params, 'region') ?? 'all_city'
  const symbols = (D.retailSeries as Record<string, Record<string, string>>)[region]
  if (!symbols) throw new Error(`region: Input should be one of ${Object.keys(D.retailSeries).join(', ')} (got ${region})`)
  const item = text(params, 'item') ?? 'fuel'
  const groups: Record<string, string[]> = { beverages: retail.beverages, cereals: retail.cereals, dairy: retail.dairy, fuel: retail.fuel, produce: retail.produce, meats: retail.meats, all_items: retail.allItems }
  const wanted = [...new Set(groups[item] ?? [item])]
  const series: string[] = []
  for (const [id, description] of Object.entries(symbols)) for (const price of wanted) if (description.toLowerCase().includes(price.replaceAll('_', ' '))) series.push(id)
  const result = await fetchSeries(ctx, key, {
    symbol: series.join(','),
    start_date: text(params, 'start_date') ?? null,
    end_date: text(params, 'end_date') ?? null,
    frequency: frequencies[text(params, 'frequency') ?? 'monthly'] ?? null,
    transform: text(params, 'transform') ?? null,
    use_cache: useCache(params),
  })
  if (result.rows.length === 0) throw new Error('No data found for the item and region combination. You may also be experiencing rate limiting. Please adjust the parameters or try again in a few minutes.')
  const long: Row[] = []
  for (const id of Object.keys(result.metadata)) {
    for (const r of result.rows) {
      const value = r[id]
      if (value === null || value === undefined) continue
      long.push({ date: r.date, symbol: id, country: 'united_states', description: (symbols[id] ?? '').trim(), value })
    }
  }
  return long.sort(byKey('date', 'description'))
}

// ---- regional data ------------------------------------------------------------------------------------------------------------

export async function fredRegional(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const key = apiKey(ctx)
  const symbol = text(params, 'symbol')
  if (!symbol) throw new Error('symbol: Field required')
  const isGroup = params.is_series_group === true || params.is_series_group === 'true'
  const frequency = text(params, 'frequency')
  const regionType = text(params, 'region_type')
  const units = text(params, 'units')
  let start = text(params, 'start_date')
  if (isGroup) {
    for (const [name, value] of [['frequency', frequency], ['region_type', regionType], ['units', units]] as const) {
      if (value === undefined) throw new Error(`${name} is a required field missing for series_group.`)
    }
    start ??= '1900-01-01'
  }
  // The query dumps its fields in declaration order under FRED's names (symbol → series_group, transform → transformation).
  const query: Record<string, string | undefined> = {
    series_group: symbol.toUpperCase(),
    start_date: start,
    ...(isGroup ? { region_type: regionType, season: (text(params, 'season') ?? 'nsa').toUpperCase(), units } : {}),
    frequency,
    aggregation_method: text(params, 'aggregation_method') ?? 'eop',
    transformation: text(params, 'transform'),
  }
  const url = isGroup ? buildUrl('regional/data', key, query, GEO_ROOT_URL) : buildUrl('series/data', key, { series_id: symbol.toUpperCase(), ...query }, GEO_ROOT_URL)
  const response = await fredGet(ctx, url, { useCache: useCache(params) })
  if (!response || response.meta === undefined || response.meta === null) throw new Error('No results found. Try adjusting the query parameters.')
  const meta = response.meta as Json
  const end = text(params, 'end_date')
  const rows: Row[] = []
  for (const [date, items] of Object.entries((meta.data ?? {}) as Record<string, Json[]>)) {
    for (const item of items) {
      if (end !== undefined && date > end) continue
      const row: Row = { ...item, date, units: meta.units }
      if (typeof row.value === 'string') {
        const n = Number(row.value)
        if (row.value.trim() === '' || Number.isNaN(n)) throw new Error('value: Input should be a valid number')
        row.value = n
      }
      for (const k of ['region', 'code', 'series_id']) if (row[k] === null || row[k] === undefined) throw new Error(`${k}: Field required`)
      rows.push(present(row))
    }
  }
  return rows
}
