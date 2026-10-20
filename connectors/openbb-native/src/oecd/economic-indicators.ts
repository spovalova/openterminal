// economy/indicators, provider oecd. Ported from openbb_oecd/models/economic_indicators.py (OpenBB Platform 5.0.0,
// Apache-2.0); modified: plain rows instead of pydantic models. Indicator symbols ('DATAFLOW::CODE') are ported;
// presentation tables (a symbol that names a table of the dataflow) and `pivot` are left to the OpenBB API
// (NativeUnsupported), and the dimension values are not checked against the availability constraints (a value the
// dataflow does not have comes back as an empty answer from the data API).
import { flag, text, whole } from '../lib/params.js'
import { NativeUnsupported, type NativeCtx, type NativeParams, type Row } from '../types.js'
import { countryParam, observation } from './common.js'
import { detectIndicatorDimensions, detectTransformDimension } from './helpers.js'
import { dimensionOrder, findDataflow, resolveCountryCodes } from './metadata.js'
import { fetchData, oecdDate, type DimensionValues, type Row as CsvRow } from './query-builder.js'

const FREQ_MAP: Record<string, string> = { annual: 'A', annually: 'A', yearly: 'A', year: 'A', quarter: 'Q', quarterly: 'Q', monthly: 'M', month: 'M' }

const SKIP_DIMS = new Set(['REF_AREA', 'COUNTERPART_AREA', 'JURISDICTION', 'COUNTRY', 'AREA', 'FREQ', 'FREQUENCY', 'TIME_PERIOD', 'UNIT_MEASURE', 'UNIT_MULT', 'TRANSFORMATION', 'ADJUSTMENT', 'DECIMALS', 'CURRENCY', 'PRICE_BASE', 'TABLE_IDENTIFIER', 'REF_YEAR_PRICE', 'CONF_STATUS', 'OBS_STATUS', 'BASE_PER', 'BASE_REF_AREA', 'CURRENCY_DENOM'])
const SKIP_TITLE_DIMS = new Set(['REF_AREA', 'FREQ', 'TIME_PERIOD', 'UNIT_MEASURE', 'UNIT_MULT', 'BASE_REF_AREA', 'DECIMALS', 'CURRENCY', 'TRANSFORMATION', 'ADJUSTMENT', 'PRICE_BASE', 'TABLE_IDENTIFIER', 'REF_YEAR_PRICE', 'CONF_STATUS', 'OBS_STATUS', 'BASE_PER', 'CURRENCY_DENOM'])
const SKIP_TITLE_VALUES = new Set(['not applicable', 'total economy', 'not specified', 'no breakdown', 'all activities', 'total', 'non transformed data'])

/** Python truthiness of a cell: missing, empty text and zero are false. */
const filled = (v: unknown): boolean => v !== null && v !== undefined && v !== '' && v !== 0

/** The transformation or unit param as a dimension and code (`_apply_transform`). */
function applyTransform(transform: string, dataflow: string, into: DimensionValues): void {
  const value = transform.trim().toLowerCase()
  const { transformDim, unitDim, transformLookup, unitLookup } = detectTransformDimension(dataflow)
  let applied = false
  if (transformDim) {
    if (['all', '*'].includes(value)) {
      into[transformDim] = '*'
      applied = true
    } else if (value in transformLookup) {
      into[transformDim] = transformLookup[value]!
      applied = true
    }
  }
  if (!applied && unitDim) {
    if (['all', '*'].includes(value)) {
      into[unitDim] = '*'
      applied = true
    } else if (value in unitLookup) {
      into[unitDim] = unitLookup[value]!
      applied = true
    }
  }
  if (applied) return
  if (!transformDim && !unitDim) throw new Error(`Dataflow '${dataflow}' does not support transform/unit parameter.`)
  const available: string[] = []
  const t = Object.keys(transformLookup).filter((k) => !Object.values(transformLookup).includes(k)).sort()
  const u = Object.keys(unitLookup).filter((k) => !Object.values(unitLookup).includes(k)).sort()
  available.push(...t, ...u)
  throw new Error(`Invalid transform value '${transform}' for dataflow '${dataflow}'. Available options: ${available.length > 0 ? available.join(', ') : 'none'}`)
}

export async function economicIndicators(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  if (flag(params, 'pivot', false)) throw new NativeUnsupported('oecd economy/indicators pivot is not ported')
  const symbolParam = text(params, 'symbol')
  if (!symbolParam) throw new Error('Symbol is required.')
  const country = text(params, 'country') ? countryParam(params, '') : undefined
  const frequencyParam = text(params, 'frequency')
  const transform = text(params, 'transform')
  const limit = whole(params, 'limit')
  const startDate = text(params, 'start_date')
  const endDate = text(params, 'end_date')
  // OpenBB's API sends the filters as one comma-joined string, which its validator splits again.
  const dimensionValues = (text(params, 'dimension_values') ?? '').split(',').map((s) => s.trim()).filter(Boolean)

  // Symbols: 'DATAFLOW::CODE', all of one dataflow.
  const parts = symbolParam.split(',').map((s) => s.trim()).filter(Boolean)
  const dataflows = new Set<string>()
  const identifiers: string[] = []
  for (const part of parts) {
    if (part.includes('::')) {
      const at = part.indexOf('::')
      dataflows.add(part.slice(0, at).trim())
      identifiers.push(part.slice(at + 2).trim())
    } else identifiers.push(part)
  }
  if (dataflows.size > 1) throw new Error(`All symbols must be from the same dataflow. Got: ${JSON.stringify([...dataflows])}`)
  if (dataflows.size === 0 && identifiers.length === 0) throw new Error('No valid symbols provided.')
  const dataflow = [...dataflows][0]
  if (!dataflow) throw new Error("Could not determine dataflow from symbol. Use format 'DATAFLOW::INDICATOR'.")
  const meta = findDataflow(dataflow)
  if (identifiers.length === 1 && meta?.tables?.includes(identifiers[0]!)) throw new NativeUnsupported(`oecd presentation table ${dataflow}::${identifiers[0]} is not ported`)

  const extraDimensions: Record<string, string> = {}
  for (const dv of dimensionValues) {
    for (const pair of dv.split(',').map((p) => p.trim()).filter(Boolean)) {
      if (pair.includes(':')) {
        const at = pair.indexOf(':')
        extraDimensions[pair.slice(0, at).trim().toUpperCase()] = pair.slice(at + 1).trim().toUpperCase()
      }
    }
  }

  let countriesStr = ''
  if (country) {
    const countries = resolveCountryCodes(dataflow, country)
    if (countries.length > 0) countriesStr = countries.join('+')
  }
  const frequency = frequencyParam ? (FREQ_MAP[frequencyParam.toLowerCase()] ?? frequencyParam.toUpperCase()) : undefined

  const dimensions: DimensionValues = {}
  if (countriesStr) dimensions.REF_AREA = countriesStr
  if (frequency) dimensions.FREQ = frequency
  if (Object.keys(extraDimensions).length > 0) {
    const dsdDims = dimensionOrder(dataflow)
    const byUpper = new Map(dsdDims.map((d) => [d.toUpperCase(), d] as const))
    const invalid = Object.keys(extraDimensions).filter((k) => !byUpper.has(k))
    if (invalid.length > 0) throw new Error(`Invalid dimension(s) for dataflow '${dataflow}': ${JSON.stringify(invalid)}. Available dimensions: ${JSON.stringify(dsdDims)}`)
    for (const [dim, value] of Object.entries(extraDimensions)) dimensions[byUpper.get(dim)!] = value
  }
  if (transform) applyTransform(transform, dataflow, dimensions)
  for (const [dim, codes] of Object.entries(detectIndicatorDimensions(dataflow, identifiers))) dimensions[dim] = codes.join('+')

  let contentDims: string[]
  try {
    contentDims = dimensionOrder(dataflow).filter((d) => !SKIP_DIMS.has(d.toUpperCase()))
  } catch {
    contentDims = []
  }
  let rows: CsvRow[]
  try {
    rows = await fetchData(ctx, dataflow, { startDate, endDate, limit, dimensions })
  } catch (exc) {
    throw new Error(`OECD data fetch failed: ${exc instanceof Error ? exc.message : String(exc)}`, { cause: exc })
  }

  const result: Row[] = []
  for (const row of rows) {
    const date = oecdDate(row.TIME_PERIOD)
    if (date === undefined) continue
    if (startDate && date < startDate) continue
    if (endDate && date > endDate) continue
    const raw = row.OBS_VALUE
    if (raw === null || raw === undefined || raw === '') continue
    const value = observation(row)
    if (value === undefined || Number.isNaN(value)) continue

    // A symbol made of the content dimensions' codes, and a title made of the dimensions' labels.
    const compoundCode = contentDims.map((d) => row[d]).filter(filled).join('_')
    const titleParts: string[] = []
    for (const [k, v] of Object.entries(row)) {
      if (!k.endsWith('_label') || !filled(v)) continue
      const dimId = k.slice(0, -6)
      if (SKIP_TITLE_DIMS.has(dimId)) continue
      const sv = String(v).trim()
      const rawCode = row[dimId] ?? ''
      if (!SKIP_TITLE_VALUES.has(sv.toLowerCase()) && !['_Z', '_T', '_X'].includes(String(rawCode))) titleParts.push(sv)
    }
    let unit: unknown = 'UNIT_MEASURE_label' in row ? row.UNIT_MEASURE_label : row.UNIT_MEASURE
    if (filled(unit) && String(unit).toLowerCase() === 'nan') unit = undefined
    result.push({
      date,
      symbol: compoundCode ? `${dataflow}::${compoundCode}` : '',
      country: 'REF_AREA_label' in row ? row.REF_AREA_label : (row.REF_AREA ?? ''),
      country_code: row.REF_AREA ?? '',
      value,
      unit,
      title: titleParts.length > 0 ? titleParts.join(' - ') : compoundCode,
    })
  }
  if (result.length === 0) throw new Error('No data remaining after applying date filters. Try adjusting start_date and end_date parameters.')

  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  result.sort((a, b) => {
    const da = str(a.date)
    const db = str(b.date)
    if (da !== db) return da < db ? -1 : 1
    const ca = str(a.country)
    const cb = str(b.country)
    return ca < cb ? -1 : ca > cb ? 1 : 0
  })
  // The data model leaves out what is zero, empty or missing in these fields (its `nan_to_none` validator).
  return result.map((r) => {
    const out: Row = {}
    for (const [k, v] of Object.entries(r)) {
      if (['scale', 'unit', 'title', 'description', 'value', 'unit_multiplier', 'order', 'level'].includes(k)) {
        if (!filled(v) || (typeof v === 'number' && Number.isNaN(v)) || (typeof v === 'string' && v.trim().toLowerCase() === 'nan')) continue
      }
      if (v !== undefined && v !== null) out[k] = v
    }
    return out
  })
}
