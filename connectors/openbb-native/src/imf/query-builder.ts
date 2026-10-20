// IMF SDMX data queries. Ported from openbb_imf/utils/query_builder.py (OpenBB Platform 5.0.0, Apache-2.0); modified:
// the request goes through ctx.http, the XML is read with fast-xml-parser, the metadata is the data file, rows are
// objects in which a column a row lacks is NaN (as the pandas DataFrame OpenBB builds from them), and the dimension
// constraint validation against the availability API is left out (an invalid combination comes back as an empty
// answer from the data API instead).
import { parseSdmxXml, type SdmxXmlData } from '../lib/sdmx.js'
import type { NativeCtx } from '../types.js'
import { extractUnitFromLabel, parseTimePeriod, parseUnitAndScale } from './helpers.js'
import { codelist, indicatorsIn, requireDataflow, translationMaps } from './metadata.js'

const API = 'https://api.imf.org/external/sdmx/3.0'

export type DimensionValue = string | number | string[] | undefined | null

/** Python truthiness for the values these rows hold: NaN is true, like any float, and empty text, 0 and missing are false. */
export const truthy = (v: unknown): boolean => v !== undefined && v !== null && v !== '' && v !== 0 && v !== false

const INDICATOR_ID_CANDIDATES = ['INDICATOR', 'PRODUCTION_INDEX', 'COICOP_1999', 'INDEX_TYPE', 'ACTIVITY', 'PRODUCT', 'SERIES', 'ITEM', 'BOP_ACCOUNTING_ENTRY', 'ACCOUNTING_ENTRY']
const TITLE_EXCLUDE_DIMS = new Set(['COUNTRY', 'REF_AREA', 'TIME_PERIOD', 'SCALE', 'UNIT', 'FREQ', 'FREQUENCY', 'OBS_VALUE', 'OBS_STATUS'])
const SKIPPED_ATTRIBUTES = new Set(['IFS_FLAG', 'OVERLAP', 'OBS_STATUS', 'DECIMALS_DISPLAYED', 'COUNTRY_UPDATE_DATE'])

/** The date a TIME_PERIOD filter takes for a start or an end (`format_date`): the first day of the period after an end. */
function formatDate(dateStr: string, frequency: string, isEnd = false): string {
  const parts = dateStr.split('-')
  let year = Number.parseInt(parts[0]!, 10)
  let month = parts.length >= 2 ? Number.parseInt(parts[1]!, 10) : 1
  const pad = (n: number): string => String(n).padStart(2, '0')
  if (frequency === 'A' || parts.length === 1) return isEnd ? `${year + 1}-01-01` : `${year}-01-01`
  if (isEnd) {
    month += 1
    if (month > 12) {
      month = 1
      year += 1
    }
  }
  return `${year}-${pad(month)}-01`
}

/** The SDMX 3.0 data URL for a dataflow (`build_url`). Keys that are not dimensions become query parameters. */
export function buildUrl(dataflow: string, startDate: string | undefined, endDate: string | undefined, limit: number | undefined, kwargs: Record<string, DimensionValue>): string {
  const df = requireDataflow(dataflow)
  if (!df.agency) throw new Error(`Agency ID not found for dataflow '${dataflow}'.`)
  const dimensionIds = df.urlDims ?? df.dims
  const byLower = new Map(dimensionIds.map((d) => [d.toLowerCase(), d] as const))

  const final = new Map<string, DimensionValue>()
  for (const [key, value] of Object.entries(kwargs)) final.set(byLower.get(key.toLowerCase()) ?? key, value)

  const keyParts = dimensionIds.map((dim) => {
    const value = final.get(dim)
    if (value === undefined || value === null || value === '' || value === '*' || String(value).length > 1500) return '*'
    return Array.isArray(value) ? value.join('+') : String(value)
  })
  let url = `${API}/data/dataflow/${df.agency}/${dataflow}/+/${keyParts.join('.')}`

  const query: [string, string][] = []
  for (const [k, v] of final) if (!dimensionIds.includes(k) && v !== undefined && v !== null) query.push([k, Array.isArray(v) ? v.join('+') : String(v)])
  const frequency = String(final.get('FREQUENCY') || '').toUpperCase()
  const range: string[] = []
  if (startDate) range.push(`ge:${formatDate(startDate, frequency)}`)
  if (endDate) range.push(`le:${formatDate(endDate, frequency, true)}`)
  // The brackets go out percent-encoded, as urllib3 sends them; the IMF server rejects them raw.
  if (range.length > 0) query.push(['c%5BTIME_PERIOD%5D', range.join('+')])
  if (query.length > 0) url += `?${query.map(([k, v]) => `${k}=${v}`).join('&')}`
  url += `${url.includes('?') && !url.endsWith('&') ? '&' : '?'}dimensionAtObservation=TIME_PERIOD&detail=full&includeHistory=false`
  if (limit !== undefined && limit > 0) url += `&lastNObservations=${limit}`
  return url
}

/** Python's `int(text)`; NaN where Python raises ValueError. */
const pyInt = (s: string): number => (/^\s*[+-]?\d+\s*$/.test(s) ? Number(s) : Number.NaN)

export type ImfRow = Record<string, unknown>
export type ImfData = { data: ImfRow[] }

/**
 * The observations of a dataflow query as rows (`fetch_data`): the series' dimensions as display labels and as
 * `<DIM>_code`, scale and unit translated, a title from the dimension labels, `series_id`, `TIME_PERIOD` as the date the
 * period ends, `OBS_VALUE` as a number, `description` of the indicator.
 */
export async function fetchImfData(ctx: NativeCtx, dataflow: string, opts: { startDate?: string | undefined; endDate?: string | undefined; limit?: number | undefined; dimensions?: Record<string, DimensionValue> } = {}): Promise<ImfData> {
  const df = requireDataflow(dataflow)
  const url = buildUrl(dataflow, opts.startDate, opts.endDate, opts.limit, opts.dimensions ?? {})
  const res = await ctx.http.response(url, { headers: { Accept: 'application/xml', 'Cache-Control': 'no-cache', 'User-Agent': 'Open Data Platform - IMF Data Fetcher' } })
  if (!res.ok) throw new Error(`An error occurred during the HTTP request: ${url} -> HTTP ${res.status} -> ${(await res.text().catch(() => '')).slice(0, 500)}`)
  const parsed: SdmxXmlData | undefined = parseSdmxXml(await res.text())
  if (!parsed) throw new Error(`No data found in the response. URL: ${url}`)

  const translations = translationMaps(dataflow)
  const unitList = df.unit ? codelist(df.unit) : undefined
  const scaleList = df.scale ? codelist(df.scale) : undefined
  const clUnit = codelist('CL_UNIT') ?? {}
  const clUnitMult = codelist('CL_UNIT_MULT') ?? {}
  const dimOrder = new Map(df.dims.map((d, i) => [d, i] as const))
  const indicatorDimensionOrder = new Map<string, number>()
  df.dims.forEach((dim, idx) => {
    if (dim && (INDICATOR_ID_CANDIDATES.includes(dim) || ['INDICATOR', 'ACCOUNTING_ENTRY', 'ENTRY'].some((k) => dim.includes(k)))) indicatorDimensionOrder.set(dim, idx)
  })
  const display = (dim: string, code: string): string => translations[dim]?.get(code) ?? code

  /** The scale text and multiplier of a SCALE code. */
  const scaleOf = (code: string): { scale: string; multiplier?: number } => {
    const n = pyInt(code)
    if (Number.isNaN(n)) return { scale: code }
    const multiplier = n === 0 ? 1 : 10 ** n
    if (scaleList) return { scale: scaleList[code] ?? `10^${code}`, multiplier }
    if (Object.keys(clUnitMult).length > 0) return { scale: clUnitMult[code] ?? `10^${code}`, multiplier }
    return { scale: `10^${code}`, multiplier }
  }
  const unitOf = (code: string): string => (unitList ? (unitList[code] ?? code) : (clUnit[code] ?? code))

  const rows: ImfRow[] = []

  for (const series of parsed.series) {
    const meta: ImfRow = {}
    let indicatorCode: string | undefined
    const indicatorCodesList: [string, string][] = []
    const titleParts: [number, string, string][] = []

    for (const [name, value] of Object.entries(series.attributes)) {
      if (INDICATOR_ID_CANDIDATES.includes(name) || name.includes('INDICATOR')) {
        indicatorCode = value
        indicatorCodesList.push([name, value])
        const shown = display(name, value)
        meta[name] = shown
        meta[`${name}_code`] = value
        titleParts.push([dimOrder.get(name) ?? 999, name, shown])
      } else if (name === 'COUNTRY') {
        meta[name] = display(name, value)
        meta.country_code = value
      } else if (name === 'COUNTERPART_COUNTRY') {
        const shown = display(name, value)
        meta[name] = shown
        meta.counterpart_country_code = value
        titleParts.push([dimOrder.get(name) ?? 999, name, shown])
      } else if (name === 'SCALE') {
        const { scale, multiplier } = scaleOf(value)
        if (multiplier !== undefined) meta.unit_multiplier = multiplier
        meta.scale = scale
      } else if (name === 'UNIT') {
        meta.unit = unitOf(value)
      } else if (translations[name]?.has(value)) {
        const shown = translations[name]!.get(value)!
        meta[name] = shown
        meta[`${name}_code`] = value
        if (!TITLE_EXCLUDE_DIMS.has(name)) titleParts.push([dimOrder.get(name) ?? 999, name, shown])
      } else if (!SKIPPED_ATTRIBUTES.has(name)) {
        meta[name] = value
        meta[`${name}_code`] = value
        if (!TITLE_EXCLUDE_DIMS.has(name)) titleParts.push([dimOrder.get(name) ?? 999, name, value])
      }
    }

    if (indicatorCodesList.length > 0) meta.indicator_codes = indicatorCodesList
    if (titleParts.length > 0) {
      const sorted = [...titleParts].sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
      meta.title = sorted.map((p) => p[2]).join(' - ')
    }

    // The unit and scale the indicator's group carries, where the series itself has none.
    const group = indicatorCode !== undefined ? parsed.groups[indicatorCode] : undefined
    if (group) {
      for (const [attrId, attrValue] of Object.entries(group)) {
        if (attrId === 'UNIT' && !('unit' in meta)) meta.unit = unitOf(attrValue)
        else if (attrId === 'SCALE' && !('scale' in meta)) {
          const { scale, multiplier } = scaleOf(attrValue)
          if (multiplier !== undefined) meta.unit_multiplier = multiplier
          meta.scale = scale
        } else if (!(attrId in meta)) {
          if (translations[attrId]?.has(attrValue)) {
            meta[attrId] = translations[attrId]!.get(attrValue)
            meta[`${attrId}_code`] = attrValue
          } else meta[attrId] = attrValue
        }
      }
    }

    // No unit yet: read it off the transformation, the indicator code or a label.
    if (!('unit' in meta)) {
      const transform = meta.TYPE_OF_TRANSFORMATION as string | undefined
      if (transform) {
        if (['Index', 'Weight', 'Ratio'].includes(transform)) meta.unit = transform
        else if (transform.toLowerCase().includes('percent change')) {
          meta.unit = 'Percent change'
          if (transform.toLowerCase().includes('year-over-year')) meta.scale = 'Year-over-year'
          else if (transform.toLowerCase().includes('period-over-period')) meta.scale = 'Period-over-period'
        } else if (transform.includes(', ')) {
          const last = transform.slice(transform.lastIndexOf(', ') + 2).trim()
          meta.unit = ['Index', 'Percent', 'Weight', 'Ratio'].includes(last) ? last : transform
        } else meta.unit = transform
      }
      const indicatorLabel = meta.INDICATOR as string | undefined
      let extractedUnit: string | undefined
      let extractedScale: string | undefined
      if (indicatorLabel) {
        const extracted = extractUnitFromLabel(indicatorLabel)
        if (extracted) [extractedUnit, extractedScale] = parseUnitAndScale(extracted)
      }
      if (!('unit' in meta)) {
        const indCode = meta.INDICATOR_code as string | undefined
        if (indCode && indCode.includes('_')) {
          const unitCode = indCode.slice(indCode.lastIndexOf('_') + 1)
          if (unitCode in clUnit && !['ALL', 'FE', 'RFI', 'REXFI'].includes(unitCode)) meta.unit = clUnit[unitCode]
        }
      }
      if (extractedScale) {
        const current = meta.scale as string | undefined
        if (current === undefined || current === '' || current === 'Units' || current === 'units' || !current) meta.scale = extractedScale
      }
      if (!('unit' in meta) && extractedUnit) meta.unit = extractedUnit
      if (!('unit' in meta)) {
        for (const label of [meta.title, meta.PRODUCTION_INDEX, meta.INDEX_TYPE] as (string | undefined)[]) {
          if (label) {
            const extracted = extractUnitFromLabel(label)
            if (extracted) {
              const [unit, scale] = parseUnitAndScale(extracted)
              if (unit) meta.unit = unit
              if (scale && !('scale' in meta)) meta.scale = scale
              break
            }
          }
        }
      }
    }

    if (indicatorCodesList.length > 0) {
      const sorted = [...indicatorCodesList].sort((a, b) => (indicatorDimensionOrder.get(a[0]) ?? 999) - (indicatorDimensionOrder.get(b[0]) ?? 999) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      meta.series_id = `${dataflow}::${sorted.map(([, code]) => code).join('_')}`
    }

    for (const obs of series.observations) {
      const row: ImfRow = { ...meta }
      row.TIME_PERIOD = obs.TIME_PERIOD || obs.TIME || obs.time || ''
      const value = obs.OBS_VALUE || obs.OBSERVATION
      const obsUnit = obs.UNIT
      if (obsUnit) row.unit = unitOf(obsUnit)
      const obsScale = obs.SCALE
      if (obsScale) {
        const { scale, multiplier } = scaleOf(obsScale)
        if (multiplier !== undefined) row.unit_multiplier = multiplier
        row.scale = scale
      }
      if (value !== undefined && value !== '' && value !== 'D') {
        row.value = value
        rows.push(row)
      }
    }
  }

  if (rows.length === 0) {
    const info = Object.entries(opts.dimensions ?? {}).filter(([, v]) => truthy(v)).map(([k, v]) => `${k}=${String(v)}`).join(', ')
    throw new Error(`No data rows found for dataflow '${dataflow}' with parameters: ${info}. The IMF constraints API reports this combination as valid, but no actual observations were returned in the data. URL -> ${url}`)
  }

  // A DataFrame of the rows: every column in every row (NaN where a row has none), OBS_VALUE a number, periods as dates.
  const columns: string[] = []
  const seen = new Set<string>()
  for (const r of rows) {
    for (const k of Object.keys(r)) {
      if (seen.has(k)) continue
      seen.add(k)
      columns.push(k)
    }
  }
  const descriptions = new Map<string, string>()
  try {
    for (const item of indicatorsIn(dataflow)) descriptions.set(item.indicator, item.description)
  } catch {
    // a dataflow without indicators has no descriptions
  }
  const indicatorColumn = columns.find((c) => c.endsWith('_code') && ['INDICATOR', 'BOP_ACCOUNTING_ENTRY', 'ACCOUNTING_ENTRY', 'SERIES', 'ITEM'].includes(c.replace('_code', '')))
  const data = rows.map((r) => {
    const out: ImfRow = {}
    for (const c of columns) out[c] = c in r ? r[c] : Number.NaN
    const raw = out.value
    delete out.value
    const n = typeof raw === 'string' ? Number(raw) : Number.NaN
    out.OBS_VALUE = typeof raw === 'string' && raw.trim() !== '' && !Number.isNaN(n) ? n : Number.NaN
    if ('TIME_PERIOD' in out) out.TIME_PERIOD = parseTimePeriod(String(out.TIME_PERIOD))
    out.description = indicatorColumn ? (descriptions.get(String(out[indicatorColumn])) ?? Number.NaN) : ''
    return out
  })
  return { data }
}
