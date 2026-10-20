// jodi/gas/{balance,demand,exports,imports,production,stocks}, provider jodi. Ported from openbb_jodi/models/gas_*.py
// (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models, and no AnnotatedResult
// metadata (country, unit and assessment labels travel in OpenBB's `extra`, not its rows).
import type { NativeCtx, NativeHandler, NativeParams, Row } from '../types.js'
import { GAS_BALANCE_FIELDS, GAS_START_YEAR, GAS_UNITS } from './constants.js'
import { buildCountryTable, buildFieldTable, checkDates, countryCodes, getTable, resolveDateRange, selectObservations, token, type Observation } from './helpers.js'

/** `get_filtered_gas`. */
async function filteredGas(params: NativeParams, ctx: NativeCtx, countries: Set<string> | undefined, flows: Set<string>): Promise<Observation[]> {
  const { start, end } = resolveDateRange(params, ctx, GAS_START_YEAR)
  checkDates('Gas', start, end)
  const unit = GAS_UNITS[token(params, 'unit', Object.keys(GAS_UNITS), 'm3')]!
  const table = await getTable(ctx, 'gas_world', params.use_cache !== false)
  return selectObservations(table, { countries, flows, units: new Set([unit]) }, start, end)
}

/** A by-country series of one flow, a column per reporting country. */
function countrySeries(flowCodes: (params: NativeParams) => string): NativeHandler {
  return async (params, ctx) => buildCountryTable(await filteredGas(params, ctx, countryCodes(params, true, undefined), new Set([flowCodes(params)])))
}

const TRADE_FLOWS = { imports: { total: 'TOTIMPSB', pipeline: 'IMPPIP', lng: 'IMPLNG' }, exports: { total: 'TOTEXPSB', pipeline: 'EXPPIP', lng: 'EXPLNG' } }
const tradeFlow = (kind: keyof typeof TRADE_FLOWS) => (params: NativeParams): string => TRADE_FLOWS[kind][token(params, 'flow', ['total', 'pipeline', 'lng'], 'total') as 'total']

export const gasImports = countrySeries(tradeFlow('imports'))
export const gasExports = countrySeries(tradeFlow('exports'))
export const gasProduction = countrySeries(() => 'INDPROD')
export const gasStocks = countrySeries(() => 'CLOSTLV')
export const gasDemand = countrySeries((params) => ({ observed: 'TOTDEMO', calculated: 'TOTDEMC' })[token(params, 'measure', ['observed', 'calculated'], 'observed') as 'observed'])

/** jodi/gas/balance: every flow of natural gas in one country. */
export async function gasBalance(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const obs = await filteredGas(params, ctx, countryCodes(params, false, 'united_states'), new Set(Object.keys(GAS_BALANCE_FIELDS)))
  return buildFieldTable(obs, 'flow', GAS_BALANCE_FIELDS)
}
