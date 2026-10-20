// jodi/oil/{balance,demand,demand_by_product,exports,imports,production,stocks}, provider jodi. Ported from
// openbb_jodi/models/oil_*.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models, and
// no AnnotatedResult metadata (country, unit and assessment labels travel in OpenBB's `extra`, not its rows).
import type { NativeCtx, NativeHandler, NativeParams, Row } from '../types.js'
import { OIL_BALANCE_FIELDS, OIL_PRODUCT_FIELDS, OIL_PRODUCTS, OIL_START_YEAR, OIL_UNITS, PRIMARY_PRODUCTS, SECONDARY_PRODUCTS, type OilTable } from './constants.js'
import { buildCountryTable, buildFieldTable, checkDates, countryCodes, getTable, resolveDateRange, selectObservations, token, type Observation } from './helpers.js'

type Slice = { table: OilTable; countries: Set<string> | undefined; products: Set<string>; flows: Set<string>; unit: string }

/** `get_filtered_oil` (every model reads a single table). */
async function filteredOil(params: NativeParams, ctx: NativeCtx, q: Slice): Promise<Observation[]> {
  const { start, end } = resolveDateRange(params, ctx, OIL_START_YEAR)
  checkDates('Oil', start, end)
  const table = await getTable(ctx, `oil_${q.table}`, params.use_cache !== false)
  return selectObservations(table, { countries: q.countries, products: q.products, flows: q.flows, units: new Set([q.unit]) }, start, end)
}

const unitOf = (params: NativeParams, fallback: string): { name: string; code: string } => {
  const name = token(params, 'unit', Object.keys(OIL_UNITS), fallback)
  return { name, code: OIL_UNITS[name]! }
}

/** A by-country series: one flow of one product, a column per reporting country. */
function countrySeries(flow: string, products: readonly string[], defaultProduct: string, defaultUnit: string): NativeHandler {
  return async (params, ctx) => {
    const product = token(params, 'product', products, defaultProduct)
    const unit = unitOf(params, defaultUnit)
    const [code, table] = OIL_PRODUCTS[product]!
    const obs = await filteredOil(params, ctx, { table, countries: countryCodes(params, true, undefined), products: new Set([code]), flows: new Set([flow]), unit: unit.code })
    return buildCountryTable(obs)
  }
}

export const oilProduction = countrySeries('INDPROD', PRIMARY_PRODUCTS, 'crude_oil', 'kbd')
export const oilImports = countrySeries('TOTIMPSB', Object.keys(OIL_PRODUCTS), 'crude_oil', 'kbd')
export const oilExports = countrySeries('TOTEXPSB', Object.keys(OIL_PRODUCTS), 'crude_oil', 'kbd')
export const oilStocks = countrySeries('CLOSTLV', Object.keys(OIL_PRODUCTS), 'crude_oil', 'kbbl')
export const oilDemand = countrySeries('TOTDEMO', SECONDARY_PRODUCTS, 'total_products', 'kbd')

/** jodi/oil/balance: every flow of one product in one country. */
export async function oilBalance(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const product = token(params, 'product', Object.keys(OIL_PRODUCTS), 'crude_oil')
  const unit = unitOf(params, 'kbd')
  const [code, table] = OIL_PRODUCTS[product]!
  const obs = await filteredOil(params, ctx, { table, countries: countryCodes(params, false, 'united_states'), products: new Set([code]), flows: new Set(Object.keys(OIL_BALANCE_FIELDS)), unit: unit.code })
  return buildFieldTable(obs, 'flow', OIL_BALANCE_FIELDS)
}

/** jodi/oil/demand_by_product: demand for each refined product in one country. */
export async function oilDemandByProduct(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const unit = unitOf(params, 'kbd')
  const obs = await filteredOil(params, ctx, { table: 'secondary', countries: countryCodes(params, false, 'united_states'), products: new Set(Object.keys(OIL_PRODUCT_FIELDS)), flows: new Set(['TOTDEMO']), unit: unit.code })
  return buildFieldTable(obs, 'product', OIL_PRODUCT_FIELDS)
}
