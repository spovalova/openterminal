// commodity/psd_data, provider usda (time series for a commodity). Ported from openbb_government_us/usda/models/commodity_psd_data.py
// and utils/psd_data_downloader.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models and
// pandas, the PSD Online API is called with ctx.http.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { nullTokensToNone, optInt, optString } from './helpers.js'
import { optList } from './helpers-c.js'
import { ATTRIBUTES, COMMODITIES, COUNTRIES, COUNTRY_TO_REGION, PSD_REPORT_NAMES, REGIONS, REGION_DISPLAY } from './psd-codes.js'
import { getPsdReportData, type ReportItem } from './psd-reports.js'

const QUERY_URL = 'https://apps.fas.usda.gov/PSDOnlineApi/api/query/RunQuery'
const ATTRIBUTES_URL = 'https://apps.fas.usda.gov/PSDOnlineApi/api/query/GetMultiCommodityAttributes?commodityCodes='
const COUNTRIES_URL = 'https://apps.fas.usda.gov/PSDOnlineApi/api/CompositeVisualization/GetCountries?regionCode=R00&commodityCode='
const BATCH_SIZE = 20

/** Country or region keys the validator accepts: every country but the world, and the regions. */
const COUNTRY_CHOICES: Record<string, string> = { ...Object.fromEntries(Object.entries(COUNTRIES).filter(([k]) => k !== 'world')), ...REGIONS }

type QueryRow = Record<string, unknown>
type Long = { region: string; country: string; commodity: string; attribute: string; marketing_year: string; value: number; unit: string }

const has = (o: object, key: string): boolean => Object.prototype.hasOwnProperty.call(o, key)
const normalize = (s: string): string => s.toLowerCase().replace(/ /g, '_').replace(/-/g, '_')

/** The attribute keys PSD publishes for a commodity (all of them when the lookup fails). */
async function commodityAttributes(ctx: NativeCtx, code: string): Promise<string[]> {
  try {
    const data = await ctx.http.json<{ attributeId?: number }[]>(`${ATTRIBUTES_URL}${code},`)
    const idToKey = new Map(Object.entries(ATTRIBUTES).map(([k, id]) => [id, k]))
    const valid = new Set<string>()
    for (const item of data) {
      const key = item.attributeId ? idToKey.get(item.attributeId) : undefined
      if (key !== undefined) valid.add(key)
    }
    if (valid.size) return [...valid].sort()
  } catch {
    // fall through to every attribute
  }
  return Object.keys(ATTRIBUTES)
}

/** Country name → code for the countries PSD publishes for a commodity ({} when the lookup fails). */
async function commodityCountries(ctx: NativeCtx, code: string): Promise<Map<string, string>> {
  try {
    const data = await ctx.http.json<{ value?: string; text?: string }[]>(`${COUNTRIES_URL}${code}`)
    const out = new Map<string, string>()
    for (const item of data) {
      const name = (item.text ?? '').trim()
      if (item.value && name && item.value !== '00') out.set(name, item.value)
    }
    return out
  } catch {
    return new Map()
  }
}

/** pandas' NaN-last ordering for one sort key. */
function compareKey(a: number | string | null, b: number | string | null, ascending: boolean): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1
  if (a === b) return 0
  const c = a < b ? -1 : 1
  return ascending ? c : -c
}

/** `get_timeseries`: the long records, region and country totals ordered the way the PSD Online screen shows them. */
async function getTimeseries(
  ctx: NativeCtx,
  q: { commodity: string; attribute: string[] | undefined; country: string[] | undefined; aggregateRegion: boolean; startYear: number | undefined; endYear: number | undefined },
): Promise<Long[]> {
  const key = normalize(q.commodity)
  if (!has(COMMODITIES, key)) throw new Error(`Unknown commodity: ${q.commodity} -> Valid choices: ${Object.keys(COMMODITIES).join(', ')}`)
  const commodityCode = COMMODITIES[key]!
  const validAttrs = await commodityAttributes(ctx, commodityCode)

  let attrIds: number[]
  if (q.attribute === undefined) attrIds = validAttrs.map((a) => ATTRIBUTES[a]!)
  else {
    attrIds = []
    for (const attr of q.attribute) {
      const attrKey = normalize(attr)
      if (!has(ATTRIBUTES, attrKey)) throw new Error(`Unknown attribute: '${attr}' for ${q.commodity}. Valid attributes: [${validAttrs.join(', ')}]`)
      if (!validAttrs.includes(attrKey)) throw new Error(`Attribute '${attr}' is not available for ${q.commodity}. Valid attributes: [${validAttrs.join(', ')}]`)
      attrIds.push(ATTRIBUTES[attrKey]!)
    }
  }

  const selectedRegionCodes: string[] = []
  const selectedCountryCodes: string[] = []
  const validCountriesMap = await commodityCountries(ctx, commodityCode)
  const validCountryCodes = new Set(validCountriesMap.values())
  const codeToKey = new Map<string, string>()
  for (const [k, code] of Object.entries(COUNTRIES)) if (!codeToKey.has(code)) codeToKey.set(code, k)
  const validCountryKeys = (): string[] => [...validCountryCodes].filter((c) => codeToKey.has(c)).map((c) => codeToKey.get(c)!).sort()

  let countryCodes: string[]
  if (q.country === undefined) countryCodes = validCountryCodes.size ? [...validCountryCodes] : ['ALL']
  else {
    countryCodes = []
    for (const c of q.country) {
      const countryKey = normalize(c)
      if (has(REGION_DISPLAY, c.toUpperCase())) {
        selectedRegionCodes.push(c.toUpperCase())
        countryCodes.push(c.toUpperCase())
      } else if (has(REGIONS, countryKey)) {
        selectedRegionCodes.push(REGIONS[countryKey]!)
        countryCodes.push(REGIONS[countryKey]!)
      } else if (countryKey === 'eu') {
        selectedRegionCodes.push('R05')
        countryCodes.push('R05')
      } else if (has(COUNTRY_TO_REGION, c.toUpperCase()) || has(COUNTRIES, countryKey)) {
        const code = has(COUNTRY_TO_REGION, c.toUpperCase()) ? c.toUpperCase() : COUNTRIES[countryKey]!
        if (validCountryCodes.size && !validCountryCodes.has(code)) throw new Error(`Country '${c}' is not available for ${q.commodity}. Valid countries: [${validCountryKeys().join(', ')}]`)
        selectedCountryCodes.push(code)
        countryCodes.push(code)
      } else {
        const validKeys = [...validCountriesMap.keys()].map((k) => k.toLowerCase().replace(/ /g, '_')).sort()
        throw new Error(`Unknown country/region: '${c}' for ${q.commodity}. Valid countries: [${validKeys.join(', ')}]. Valid regions: [${Object.keys(REGIONS).join(', ')}]`)
      }
    }
  }

  const uniq = (xs: string[]): string[] => [...new Set(xs)]
  if (q.aggregateRegion) {
    if (selectedRegionCodes.includes('R00')) countryCodes = uniq([...Object.values(REGIONS), ...selectedCountryCodes])
    else if (selectedRegionCodes.length) countryCodes = uniq(['R00', ...selectedRegionCodes, ...selectedCountryCodes])
    else if (selectedCountryCodes.length) {
      const regions = new Set(selectedCountryCodes.filter((cc) => has(COUNTRY_TO_REGION, cc)).map((cc) => COUNTRY_TO_REGION[cc]!))
      countryCodes = uniq(['R00', ...regions, ...selectedCountryCodes])
    } else if (q.country === undefined) {
      const regionCodes = new Set(Object.values(REGIONS))
      countryCodes = uniq([...Object.values(REGIONS), ...[...validCountryCodes].filter((c) => !regionCodes.has(c) && c !== 'E4')])
    }
  }

  const currentYear = ctx.now().getFullYear()
  const years: number[] = []
  for (let y = q.startYear || 1960; y <= (q.endYear || currentYear + 1); y++) years.push(y)

  const batches: number[][] = []
  for (let i = 0; i < attrIds.length; i += BATCH_SIZE) batches.push(attrIds.slice(i, i + BATCH_SIZE))
  const fetchBatch = async (batch: number[]): Promise<QueryRow[]> => {
    const payload = {
      queryId: 0,
      commodityGroupCode: null,
      commodities: [commodityCode],
      attributes: batch,
      countries: countryCodes,
      marketYears: years,
      chkCommoditySummary: false,
      chkAttribSummary: false,
      chkCountrySummary: false,
      commoditySummaryText: '',
      attribSummaryText: '',
      countrySummaryText: '',
      optionColumn: 'year',
      chkTopCountry: false,
      topCountryCount: '',
      chkfileFormat: false,
      chkPrevMonth: false,
      chkMonthChange: false,
      chkCodes: false,
      chkYearChange: false,
      queryName: '',
      sortOrder: 'Commodity/Attribute/Country',
      topCountryState: false,
    }
    try {
      const res = await ctx.http.response(QUERY_URL, { method: 'POST', body: payload, timeoutMs: 120_000 })
      if (res.status !== 200) return []
      return ((await res.json()) as { queryResult?: QueryRow[] }).queryResult ?? []
    } catch {
      return []
    }
  }
  const result = (await Promise.all(batches.map(fetchBatch))).flat()
  const failure = `No data available for the given parameters. -> ${q.commodity} | ${q.attribute?.join(',') ?? 'None'} | ${q.country?.join(',') ?? 'None'} | ${q.startYear ?? 'None'}-${q.endYear ?? 'None'}`
  if (result.length === 0) throw new Error(failure)

  // DataFrame(result): the commodity and attribute are only given on the first row of their group (forward-filled).
  const columns: string[] = []
  for (const r of result) for (const k of Object.keys(r)) if (!columns.includes(k)) columns.push(k)
  let lastCommodity: unknown = null
  let lastAttribute: unknown = null
  for (const r of result) {
    if (r.commodity === null || r.commodity === undefined) r.commodity = lastCommodity
    else lastCommodity = r.commodity
    if (r.attribute === null || r.attribute === undefined) r.attribute = lastAttribute
    else lastAttribute = r.attribute
  }
  const yearCols = columns.filter((c) => /^\d{4}/.test(c))
  const nameToCode = new Map([...validCountriesMap].map(([name, code]) => [name.trim(), code]))
  for (const [code, name] of Object.entries(REGION_DISPLAY)) nameToCode.set(name, code)
  const regionNames = new Set(Object.values(REGION_DISPLAY))
  const regionOf = (name: string): string => {
    if (name === 'European Union') return 'European Union'
    const code = nameToCode.get(name)
    return code !== undefined && has(COUNTRY_TO_REGION, code) ? (REGION_DISPLAY[COUNTRY_TO_REGION[code]!] ?? 'Other') : 'Other'
  }
  const isRegion = (name: string): boolean => {
    if (q.aggregateRegion && name === 'European Union') return true
    if (name === 'European Union') return false
    if (name === 'Other') return true
    return regionNames.has(name)
  }

  let long: Long[] = []
  for (const r of result) {
    const countryName = r.country
    if (countryName === null || countryName === undefined || countryName === '') continue
    const name = String(countryName)
    const commodityDisplay = r.commodity ? String(r.commodity) : q.commodity.toLowerCase().replace(/(^|[^a-z])([a-z])/g, (_m, p: string, c: string) => p + c.toUpperCase())
    const attributeDisplay = r.attribute ? String(r.attribute) : ''
    const unit = String(r['unit Description'] ?? '').trim().replace(/^[()]+|[()]+$/g, '')
    for (const yr of yearCols) {
      const val = r[yr]
      if (val === null || val === undefined || (typeof val === 'number' && Number.isNaN(val))) continue
      const region = isRegion(name)
      long.push({ region: region ? name : regionOf(name), country: region ? '--' : name, commodity: commodityDisplay, attribute: attributeDisplay, marketing_year: yr, value: val as number, unit })
    }
  }
  if (long.length === 0) throw new Error(failure)
  if (q.startYear !== undefined || q.endYear !== undefined) {
    long = long.filter((r) => {
      const year = Number(r.marketing_year.split('/')[0])
      return (q.startYear === undefined || year >= q.startYear) && (q.endYear === undefined || year <= q.endYear)
    })
  }

  // Order: with region totals present, regions by their total (World first), each total before its countries.
  const regionTotals = new Map<string, number>()
  for (const r of long) if (r.country === '--') {
    const k = JSON.stringify([r.region, r.attribute, r.marketing_year])
    if (!regionTotals.has(k)) regionTotals.set(k, r.value)
  }
  const withKeys = long.map((r) => ({ r, regionValue: r.region === 'World' ? Infinity : (regionTotals.get(JSON.stringify([r.region, r.attribute, r.marketing_year])) ?? null), aggregate: r.country === '--' ? 1 : 0 }))
  const hasTotals = regionTotals.size > 0
  withKeys.sort(
    (a, b) =>
      compareKey(a.r.commodity, b.r.commodity, true) ||
      compareKey(a.r.attribute, b.r.attribute, true) ||
      compareKey(a.r.marketing_year, b.r.marketing_year, true) ||
      (hasTotals ? compareKey(a.regionValue, b.regionValue, false) || compareKey(a.aggregate, b.aggregate, false) : 0) ||
      compareKey(a.r.value, b.r.value, false),
  )
  return withKeys.map((x) => x.r)
}

export async function commodityPsdData(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const commodity = optString(params, 'commodity')
  // Without a commodity the call is for one of the predefined report tables.
  if (commodity === undefined) return pivotRows(await reportData(params, ctx))
  if (!has(COMMODITIES, commodity)) throw new Error(`Invalid commodity '${commodity}'. Valid commodities are: ${Object.keys(COMMODITIES).sort().join(', ')}`)

  let attribute = optList(params, 'attribute')
  if (attribute && attribute.length === 1 && attribute[0]!.includes(',')) attribute = attribute[0]!.split(',')
  const invalidAttrs = (attribute ?? []).filter((a) => !has(ATTRIBUTES, a))
  if (invalidAttrs.length) throw new Error(`Invalid attribute(s) '${invalidAttrs.join(', ')}'. Valid attributes are: ${Object.keys(ATTRIBUTES).sort().join(', ')}`)
  const countryTokens = optList(params, 'country')
  const invalidCountries = (countryTokens ?? []).filter((c) => !Object.values(COUNTRY_CHOICES).includes(c) && !has(COUNTRY_CHOICES, c))
  if (invalidCountries.length) throw new Error(`Invalid country code(s) '${invalidCountries.join(', ')}'. Valid country codes are: ${Object.keys(COUNTRY_CHOICES).sort().join(', ')}`)
  const startYear = optInt(params, 'start_year')
  if (startYear && startYear < 1960) throw new Error('Earliest possible year is 1960.')

  const data = await getTimeseries(ctx, {
    commodity,
    attribute,
    country: countryTokens,
    aggregateRegion: params.aggregate_regions === true || params.aggregate_regions === 'true',
    startYear,
    endYear: optInt(params, 'end_year'),
  })

  return pivotRows(data)
}

/** A predefined report (`report_id`): its CSV, parsed by the report's template. */
async function reportData(params: NativeParams, ctx: NativeCtx): Promise<ReportItem[]> {
  const reportId = optString(params, 'report_id') ?? 'world_crop_production_summary'
  if (!has(PSD_REPORT_NAMES, reportId)) throw new Error(`Invalid report_id '${reportId}'. Valid report IDs are: ${Object.keys(PSD_REPORT_NAMES).sort().join(', ')}`)
  const report = await getPsdReportData(ctx, PSD_REPORT_NAMES[reportId]!)
  if (report.data.length === 0) throw new Error(`The request was successful but no data was returned. This might be a bug or a network error. -> Report ID: ${reportId}`)
  if (report.error) throw new Error(`Error processing data: ${report.error} -> Report ID: ${reportId}`)
  return report.data
}

/** One wide row per region, country, commodity, attribute and unit, in order of first appearance. */
function pivotRows(data: (Long | ReportItem)[]): Row[] {
  const pivoted = new Map<string, Row>()
  for (const item of data) {
    const key = JSON.stringify([item.region, item.country, item.commodity, item.attribute, item.unit])
    let row = pivoted.get(key)
    if (!row) pivoted.set(key, (row = { region: item.region, country: item.country, commodity: item.commodity, attribute: item.attribute, unit: item.unit }))
    row[item.marketing_year] = item.value
  }
  return [...pivoted.values()].map(nullTokensToNone)
}
