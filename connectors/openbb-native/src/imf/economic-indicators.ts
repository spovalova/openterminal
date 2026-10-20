// economy/indicators, provider imf. Ported from openbb_imf/models/economic_indicators.py (OpenBB Platform 5.0.0,
// Apache-2.0); modified: plain rows instead of pydantic models. Indicator symbols ('DATAFLOW::CODE') are ported;
// presentation tables ('DATAFLOW::H_…' symbols) and `pivot` are left to the OpenBB API (NativeUnsupported), and the
// dimension checks against the availability API are not made (an invalid selection comes back empty from the data API).
import { flag, text, whole } from '../lib/params.js'
import { NativeUnsupported, type NativeCtx, type NativeParams, type Row } from '../types.js'
import { compareText, detectIndicatorDimensions, detectTransformDimension, parseTimePeriod, translateErrorMessage } from './helpers.js'
import { codelist, getDataflow } from './metadata.js'
import { fetchImfData, truthy, type DimensionValue, type ImfRow } from './query-builder.js'

const COUNTRY_DIMENSIONS = new Set(['COUNTRY', 'REF_AREA', 'JURISDICTION', 'AREA'])
const FREQUENCY_DIMENSIONS = new Set(['FREQUENCY', 'FREQ'])
const TRANSFORM_DIMENSIONS = new Set(['UNIT_MEASURE', 'UNIT', 'TRANSFORMATION', 'TYPE_OF_TRANSFORMATION'])
const FREQUENCY_MAP: Record<string, string> = { annual: 'A', quarter: 'Q', month: 'M', day: 'D' }

/** ISO3 codes or country names (`united_states`) as codes; anything else is upper-cased as it is (`validate_country`). */
function normalizeCountries(value: string | undefined): string | undefined {
  if (!value) return undefined
  const items = value.split(',').map((c) => c.trim()).filter(Boolean)
  if (items.length === 0) return undefined
  if (items.length === 1 && ['*', 'all'].includes(items[0]!.toLowerCase())) return '*'
  const countryCodes = codelist('CL_COUNTRY') ?? {}
  const nameToCode = new Map<string, string>()
  for (const [code, name] of Object.entries(countryCodes)) {
    nameToCode.set(name.toLowerCase(), code)
    nameToCode.set(name.toLowerCase().replace(/ /g, '_').replace(/,/g, '').replace(/\./g, '').replace(/'/g, ''), code)
  }
  const result: string[] = []
  for (const item of items) {
    const upper = item.toUpperCase().trim()
    const lower = item.toLowerCase().trim().replace(/ /g, '_')
    if (['*', 'all'].includes(lower)) return '*'
    if (upper in countryCodes) result.push(upper)
    else if (nameToCode.has(lower)) result.push(nameToCode.get(lower)!)
    else if (nameToCode.has(item.toLowerCase())) result.push(nameToCode.get(item.toLowerCase())!)
    else result.push(upper)
  }
  return result.join(',')
}

/** Python's `or`: the first value that is true in Python (NaN is). */
const firstTruthy = (...values: unknown[]): unknown => values.find(truthy) ?? values.at(-1)

const nanToNone = (v: unknown): unknown => (v === undefined || v === null || String(v).toLowerCase() === 'nan' ? undefined : v)

export async function economicIndicators(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  if (flag(params, 'pivot', false)) throw new NativeUnsupported('imf economy/indicators pivot is not ported')
  const symbolParam = text(params, 'symbol')
  if (!symbolParam) throw new Error('symbol is required.')
  let country = normalizeCountries(text(params, 'country'))
  let frequency = text(params, 'frequency')
  let transform = text(params, 'transform')
  const limit = whole(params, 'limit')
  const startDate = text(params, 'start_date')
  const endDate = text(params, 'end_date')

  // A country, frequency or transformation given as a dimension filter moves to its own param.
  // OpenBB's API receives the filters as one comma-joined string, which its model reads as a single filter.
  const joinedDimensions = text(params, 'dimension_values')
  const dimensionValues = joinedDimensions === undefined ? [] : [joinedDimensions]
  const remaining: string[] = []
  for (const dv of dimensionValues) {
    if (!dv.includes(':')) {
      remaining.push(dv)
      continue
    }
    const at = dv.indexOf(':')
    const dimId = dv.slice(0, at).trim().toUpperCase()
    const dimValue = dv.slice(at + 1).trim()
    if (COUNTRY_DIMENSIONS.has(dimId)) country = dimValue
    else if (FREQUENCY_DIMENSIONS.has(dimId)) frequency = dimValue
    else if (TRANSFORM_DIMENSIONS.has(dimId)) transform = dimValue
    else remaining.push(dv)
  }
  if (!country) throw new Error("Country is required. Provide via 'country' parameter or include a country dimension (COUNTRY, REF_AREA, JURISDICTION, AREA) in 'dimension_values'.")

  if (remaining.length > 0) {
    const first = symbolParam.split(',')[0]!.trim()
    const dataflowFirst = first.split('::')[0]!.trim().toUpperCase()
    const dimIds = new Set(getDataflow(dataflowFirst)?.dims ?? [])
    if (dimIds.size > 0) {
      const extra = [...dimIds].filter((d) => !COUNTRY_DIMENSIONS.has(d) && !FREQUENCY_DIMENSIONS.has(d) && !TRANSFORM_DIMENSIONS.has(d) && d !== 'INDICATOR' && d !== 'TIME_PERIOD')
      for (const dv of remaining) {
        if (!dv.includes(':')) continue
        const dimId = dv.slice(0, dv.indexOf(':')).trim().toUpperCase()
        if (!dimIds.has(dimId)) throw new Error(`Unknown dimension '${dimId}' for dataflow '${dataflowFirst}'. Valid extra dimensions: ${[...extra].sort().join(', ') || '(none)'}. Use \`available_indicators()\` to see per-indicator extra_dimensions.`)
      }
    }
  }

  // Symbols: 'DATAFLOW::CODE'. Tables are not ported.
  const indicatorsByDataflow = new Map<string, string[]>()
  const dataflowsSeen = new Set<string>()
  for (const sym of symbolParam.split(',').map((s) => s.trim())) {
    if (!sym.includes('::')) throw new Error(`Invalid symbol format '${sym}'. Expected 'dataflow::identifier'. Use \`available_indicators()\` or \`list_tables()\` to find valid symbols.`)
    const at = sym.indexOf('::')
    const dataflow = sym.slice(0, at).trim().toUpperCase()
    const identifier = sym.slice(at + 2).trim()
    if (!identifier) throw new Error(`Invalid symbol format '${sym}'. Identifier cannot be empty. Expected 'dataflow::identifier'.`)
    dataflowsSeen.add(dataflow)
    const isTable = identifier.startsWith('H_') || (getDataflow(dataflow)?.tables ?? []).some(([id]) => id === identifier)
    if (isTable) throw new NativeUnsupported(`imf presentation table ${sym} is not ported`)
    indicatorsByDataflow.set(dataflow, [...(indicatorsByDataflow.get(dataflow) ?? []), identifier])
  }

  const countries = country.split(',')
  const countriesStr = countries.map((c) => c.toUpperCase()).join('+')
  const mappedFrequency = frequency ? (FREQUENCY_MAP[frequency] ?? frequency) : undefined
  const extraDimensions: Record<string, string> = {}
  for (const dv of remaining) {
    for (const pair of dv.split(',').map((p) => p.trim()).filter(Boolean)) {
      if (pair.includes(':')) {
        const at = pair.indexOf(':')
        extraDimensions[pair.slice(0, at).trim().toUpperCase()] = pair.slice(at + 1).trim().toUpperCase()
      }
    }
  }

  const allData: ImfRow[] = []
  for (const [dataflow, indicatorCodes] of indicatorsByDataflow) {
    const dimensions: Record<string, DimensionValue> = { COUNTRY: countriesStr, FREQUENCY: mappedFrequency, ...extraDimensions }
    if (transform) {
      const value = transform.trim().toLowerCase()
      const { transformDim, unitDim, transformLookup, unitLookup } = detectTransformDimension(dataflow)
      let applied = false
      if (transformDim) {
        if (['all', '*'].includes(value)) {
          dimensions[transformDim] = '*'
          applied = true
        } else if (Object.hasOwn(transformLookup, value)) {
          dimensions[transformDim] = transformLookup[value]!
          applied = true
        }
      }
      if (!applied && unitDim) {
        if (['all', '*'].includes(value)) {
          dimensions[unitDim] = '*'
          applied = true
        } else if (Object.hasOwn(unitLookup, value)) {
          dimensions[unitDim] = unitLookup[value]!
          applied = true
        }
      }
      if (!applied) {
        if (!transformDim && !unitDim) throw new Error(`Dataflow '${dataflow}' does not support transform/unit parameter.`)
        const available = [...Object.keys(transformLookup).filter((k) => !Object.values(transformLookup).includes(k)).sort(), ...Object.keys(unitLookup).filter((k) => !Object.values(unitLookup).includes(k)).sort()]
        throw new Error(`Invalid transform value '${transform}' for dataflow '${dataflow}'. Available options: ${available.join(', ') || 'none'}`)
      }
    }
    if (limit !== undefined) dimensions.lastNObservations = limit
    for (const [dim, codes] of Object.entries(detectIndicatorDimensions(dataflow, indicatorCodes))) dimensions[dim] = codes.join('+')
    try {
      const result = await fetchImfData(ctx, dataflow, { startDate, endDate, dimensions })
      for (const record of result.data) record._dataflow = dataflow
      allData.push(...result.data)
    } catch (e) {
      throw new Error(translateErrorMessage(e instanceof Error ? e.message : String(e)), { cause: e })
    }
  }
  if (allData.length === 0) throw new Error('No data returned for the given query parameters.')

  const NEWROW_SKIP = new Set(['TIME_PERIOD', 'OBS_VALUE', 'value', 'indicator_codes', 'COUNTRY', 'country_code', 'SCALE', 'UNIT', 'unit_multiplier'])
  const TO_EXCLUDE = ['is_category_header', 'hierarchy_node_id', 'parent_id', 'indicator_code', 'parent_code', 'series_id']
  const isUpper = (k: string): boolean => k !== k.toLowerCase() && k === k.toUpperCase()

  const result: Row[] = []
  for (const item of allData) {
    let itemDate = firstTruthy(item.TIME_PERIOD, item.date) as string | undefined
    if (itemDate) itemDate = parseTimePeriod(itemDate)
    if (startDate && itemDate && itemDate < startDate) continue
    if (endDate && itemDate && itemDate > endDate) continue
    const symbol = firstTruthy(item.series_id, item.INDICATOR_code, item.BOP_ACCOUNTING_ENTRY_code, item.SERIES_code, item.ITEM_code, item.indicator_code, item.symbol)
    const countryName = firstTruthy(item.COUNTRY, item.JURISDICTION, item.country)
    const countryCode = firstTruthy(item.country_code, item.COUNTRY_code, item.JURISDICTION_code)
    const title = firstTruthy(item.title, item.INDICATOR, item.label)
    let value = item.OBS_VALUE
    if (value === undefined || value === null) value = item.value
    let scale = firstTruthy(item.scale, item.SCALE)
    if (scale !== undefined && scale !== null) {
      if (String(scale).toLowerCase() === 'nan') scale = undefined
      else if (typeof scale !== 'string') scale = truthy(scale) ? String(scale) : undefined
    }
    let unit = firstTruthy(item.unit, item.UNIT, item.TYPE_OF_TRANSFORMATION)
    if (unit !== undefined && unit !== null) {
      if (String(unit).toLowerCase() === 'nan') unit = undefined
      else if (typeof unit !== 'string') unit = truthy(unit) ? String(unit) : undefined
    }
    const newRow: Row = {
      date: itemDate,
      symbol,
      country: countryName,
      country_code: countryCode,
      value,
      unit,
      unit_multiplier: firstTruthy(item.unit_multiplier, item.UNIT_MULT),
      scale,
      order: item.order,
      level: item.level,
      symbol_root: item.parent_id,
      parent_id: item.parent_id,
      parent_code: item.parent_code,
      hierarchy_node_id: item.hierarchy_node_id,
      title,
      description: item.description,
      series_id: item.series_id,
      is_category_header: item.is_category_header ?? false,
    }
    for (const [key, val] of Object.entries(item)) {
      if (key in newRow || NEWROW_SKIP.has(key)) continue
      if (isUpper(key) || key.endsWith('_code')) newRow[key.toLowerCase()] = val
    }
    result.push(newRow)
  }
  if (result.length === 0) throw new Error('No data remaining after applying date filters. Try adjusting start_date and end_date parameters.')

  const orderOf = (r: Row): number => (typeof r.order === 'number' && !Number.isNaN(r.order) ? r.order : 9999)
  result.sort((a, b) => orderOf(a) - orderOf(b) || compareText(String(a.date ?? ''), String(b.date ?? '')) || compareText(String(a.country || ''), String(b.country || '')))

  const out: Row[] = []
  for (const row of result) {
    if (!row.date) continue
    row.symbol = row.series_id
    for (const field of TO_EXCLUDE) delete row[field]
    // The model's validator turns the text "nan" and missing values of these fields into missing.
    for (const field of ['scale', 'unit', 'title', 'description', 'value']) {
      const v = nanToNone(row[field])
      if (v === undefined) delete row[field]
      else row[field] = v
    }
    out.push(row)
  }
  return out
}
