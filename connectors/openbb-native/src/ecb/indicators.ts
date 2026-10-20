// economy/available_indicators, economy/indicators and economy/balance_of_payments, provider ecb. Ported from
// openbb_ecb/models/{available_indicators,economic_indicators,balance_of_payments}.py (OpenBB Platform 5.0.0,
// Apache-2.0); modified: plain rows instead of pydantic models and the pandas frame, and the dataflow catalogue is
// the dimension table in dataflows.json instead of the shipped metadata cache.
import type { SdmxRecord } from '../lib/sdmx.js'
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { BPS_COUNTRIES, bpsSeriesIds, type BpsReportType, BPS_REPORT_TYPES } from './bps.js'
import { cachedRecords, DATAFLOWS, fetchSdmxData, fetchSeriesKeys, flag, matchesQuery, parseSearchQuery, text, whole, withField } from './helpers.js'

const GEOGRAPHY_DIMS = ['REF_AREA', 'COUNT_AREA', 'CURRENCY']

// --- economy/available_indicators

export async function availableIndicators(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const dataflow = text(params, 'dataflow')
  const dimensions = dataflow ? DATAFLOWS[dataflow] : undefined
  if (!dataflow || !dimensions) throw new Error('Provide a valid `dataflow` to enumerate its series (indicators). Use `list_dataflows` or `search_dataflows` to find one.')

  // The key narrows the slice by position: FREQ, the first geography dimension, then any 'DIM:VALUE' filter.
  const chosen: Record<string, string> = {}
  const frequency = text(params, 'frequency')
  if (frequency) chosen.FREQ = frequency
  const referenceArea = text(params, 'reference_area')
  if (referenceArea) {
    const geography = dimensions.find((d) => GEOGRAPHY_DIMS.includes(d))
    if (geography) chosen[geography] = referenceArea
  }
  const rawValues = params.dimension_values
  for (const item of Array.isArray(rawValues) ? rawValues : rawValues === undefined ? [] : [String(rawValues)]) {
    for (const rawEntry of String(item).split(',')) {
      const entry = rawEntry.trim()
      if (entry && entry.includes(':')) {
        const at = entry.indexOf(':')
        chosen[entry.slice(0, at).trim()] = entry.slice(at + 1).trim()
      }
    }
  }
  const key = dimensions.map((d) => chosen[d] ?? '').join('.')

  let records = await cachedRecords(ctx, 'series', JSON.stringify({ flow: dataflow, key }), flag(params, 'use_cache', true), () => fetchSeriesKeys(ctx, dataflow, key))
  const query = text(params, 'query')
  if (query) {
    const parsed = parseSearchQuery(query)
    records = records.filter((r) => matchesQuery((r.name as string | undefined) ?? '', parsed))
  }
  if (records.length === 0) throw new Error(`No series found for dataflow '${dataflow}'.`)

  const limit = whole(params, 'limit') ?? 500
  const capped = limit > 0 ? records.slice(0, limit) : records
  return capped.map((record) => {
    const seriesKey = (record.series_key as string | undefined) ?? ''
    const row: Row = { symbol: `${dataflow}::${seriesKey}`, symbol_root: dataflow, dataflow_id: dataflow, series_key: seriesKey }
    if (record.name) row.description = record.name
    const freq = record.FREQ__label || record.FREQ
    if (freq) row.frequency = freq
    if (record.REF_AREA__label) row.country = record.REF_AREA__label
    return row
  })
}

// --- economy/indicators

const FREQ_DIMS = ['FREQ', 'FREQUENCY']
const AREA_DIMS = ['REF_AREA', 'AREA', 'COUNTERPART_AREA', 'COUNTRY']

/** A title made of a record's dimension labels, repeated labels once (`_build_title`). */
function buildTitle(record: SdmxRecord): string {
  const parts: string[] = []
  for (const dim of (record._dim_ids as string[] | undefined) ?? []) {
    if (FREQ_DIMS.includes(dim)) continue
    const label = record[`${dim}__label`]
    if (label) parts.push(String(label))
  }
  return [...new Set(parts)].join(' - ')
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

export async function economicIndicators(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const symbols = (text(params, 'symbol') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const start = text(params, 'start_date')
  const end = text(params, 'end_date')
  const useCache = flag(params, 'use_cache', true)

  const gathered = await Promise.all(
    symbols.map(async (symbol) => {
      if (!symbol.includes('::')) throw new Error(`Invalid ECB symbol '${symbol}'. Use 'FLOW::KEY', e.g. 'EXR::D.USD.EUR.SP00.A'.`)
      const at = symbol.indexOf('::')
      const flow = symbol.slice(0, at)
      const key = symbol.slice(at + 2)
      if (!(flow in DATAFLOWS)) throw new Error(`Unknown ECB dataflow '${flow}'. Use \`available_indicators\` to search the catalogue.`)
      const records = await cachedRecords(ctx, 'indicators', JSON.stringify({ symbol, start, end }), useCache, () => fetchSdmxData(ctx, flow, key, { startDate: start, endDate: end }))
      return withField(records, '_flow', flow)
    }),
  )
  const records = gathered.flat()
  if (records.length === 0) throw new Error('No data found for the requested symbol(s).')

  const results = records.map((record) => {
    const flow = record._flow as string
    const area = AREA_DIMS.find((a) => record[`${a}__label`])
    const freq = FREQ_DIMS.find((d) => record[`${d}__label`])
    const row: Row = { symbol_root: flow, symbol: `${flow}::${(record.series_key as string | undefined) ?? ''}` }
    if (record.date) row.date = record.date
    if (area) row.country = record[`${area}__label`]
    if (record.OBS_VALUE !== null && record.OBS_VALUE !== undefined) row.value = record.OBS_VALUE
    const title = buildTitle(record)
    if (title) row.title = title
    if (freq) row.frequency = record[`${freq}__label`]
    const unit = record.UNIT || record.UNIT_MEASURE
    if (unit) row.unit = unit
    return row
  })
  // Stable sort by symbol, then by the date as text.
  return results.sort((a, b) => byText((a.symbol as string) ?? '', (b.symbol as string) ?? '') || byText(String(a.date), String(b.date)))
}

// --- economy/balance_of_payments

export async function balanceOfPayments(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const frequency = text(params, 'frequency') ?? 'monthly'
  if (frequency !== 'monthly' && frequency !== 'quarterly') throw new Error(`Input should be 'monthly' or 'quarterly', got '${frequency}' (frequency)`)
  const reportType = (text(params, 'report_type') ?? 'main') as BpsReportType
  if (!BPS_REPORT_TYPES.includes(reportType)) throw new Error(`Input should be one of ${BPS_REPORT_TYPES.join(', ')} (report_type)`)
  const country = text(params, 'country')
  if (country !== undefined && !(country in BPS_COUNTRIES)) throw new Error(`Input should be one of ${Object.keys(BPS_COUNTRIES).join(', ')} (country)`)
  const start = text(params, 'start_date')
  const end = text(params, 'end_date')
  const useCache = flag(params, 'use_cache', true)

  const seriesIds = bpsSeriesIds(frequency, reportType, country)
  const batches = await Promise.all(
    Object.entries(seriesIds).map(async ([name, key]) => {
      const records = await cachedRecords(ctx, 'balance_of_payments', JSON.stringify({ key, start, end }), useCache, () => fetchSdmxData(ctx, 'BPS', key, { startDate: start, endDate: end }))
      return withField(records, '_item', name)
    }),
  )
  const data = batches.flat()
  if (data.length === 0) throw new Error('No balance of payments data found.')

  // One column per item, summing the component series on each date; one row per date.
  const items = new Map<string, Map<string, number>>()
  for (const record of data) {
    const value = record.OBS_VALUE
    if (value === null || value === undefined) continue
    let byPeriod = items.get(record._item as string)
    if (!byPeriod) items.set(record._item as string, (byPeriod = new Map()))
    byPeriod.set(record.date as string, (byPeriod.get(record.date as string) ?? 0) + Number(value))
  }
  if (items.size === 0) throw new Error('No balance of payments data found.')
  const periods = [...new Set([...items.values()].flatMap((m) => [...m.keys()]))].sort(byText)
  return periods.map((period) => {
    const row: Row = { period }
    for (const [name, byPeriod] of items) {
      const value = byPeriod.get(period)
      if (value !== undefined && !Number.isNaN(value)) row[name] = value
    }
    return row
  })
}
