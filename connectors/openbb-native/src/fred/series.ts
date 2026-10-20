// economy/fred_series, provider fred, and the series fetch the other FRED routes are built on. Ported from
// openbb_fred/models/series.py and the standard FRED series model (OpenBB Platform 5.0.0, Apache-2.0); modified:
// plain rows instead of a DataFrame and pydantic models.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { apiKey, buildUrl, fredGet, mapLimit, MAX_IN_FLIGHT, text, useCache } from './helpers.js'

type Json = Record<string, any>

/** A row of a wide series table: the date and one column per series id, null where a series has no value that day. */
export type SeriesRow = { date: string } & Record<string, string | number | null>

export type SeriesMeta = { title?: unknown; units?: unknown; frequency?: unknown; seasonal_adjustment?: unknown; notes?: unknown }

/**
 * FredSeriesQueryParams. A field left `undefined` takes its default (`aggregation_method` eop, `limit` 100000,
 * `use_cache` true); `null` is OpenBB's explicit None, which leaves the parameter out of the request.
 */
export type SeriesQuery = {
  symbol: string
  start_date?: string | null
  end_date?: string | null
  frequency?: string | null
  aggregation_method?: string | null
  transform?: string | null
  limit?: number | null
  use_cache?: boolean
  /** Fields the query model does not declare but keeps (it allows extras); they follow the declared ones in the request. */
  extra?: Record<string, string | number>
}

export type SeriesResult = { rows: SeriesRow[]; metadata: Record<string, SeriesMeta> }

const orDefault = <T>(value: T | null | undefined, fallback: T | null): T | null => (value === undefined ? fallback : value)

/** One series: its observations as {date: value} and its description, or nothing when FRED has no observations for it. */
async function fetchOne(ctx: NativeCtx, key: string, seriesId: string, params: Record<string, string | number | null>, cache: boolean): Promise<{ data: Map<string, number>; meta: SeriesMeta } | undefined> {
  const obsUrl = buildUrl('series/observations', key, { series_id: seriesId, ...params })
  const metaUrl = buildUrl('series', key, { series_id: seriesId })
  const observationsResponse = await fredGet(ctx, obsUrl, { useCache: cache })
  const metadataResponse = await fredGet(ctx, metaUrl, { useCache: cache })

  const isDict = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v)
  let described: Json = {}
  if (isDict(metadataResponse)) {
    const list = metadataResponse.seriess ?? [{}]
    if (!Array.isArray(list) || list.length === 0) throw new Error('list index out of range')
    described = list[0] ?? {}
  }
  const observations: Json[] = (isDict(observationsResponse) ? observationsResponse.observations : []) || []

  // DataFrame(observations)...: a row without realtime dates, or no date or value column at all, is a KeyError → nothing.
  if (observations.length === 0 || observations.some((d) => !('realtime_start' in d) || !('realtime_end' in d))) return undefined
  if (!observations.some((d) => 'date' in d) || !observations.some((d) => 'value' in d)) return undefined
  const data = new Map<string, number>()
  for (const d of observations) {
    const v = d.value
    if (v === undefined || v === null || v === '.') continue
    const n = typeof v === 'number' ? v : Number(String(v).trim())
    if (typeof v !== 'number' && (String(v).trim() === '' || Number.isNaN(n))) throw new Error(`could not convert string to float: '${v}'`)
    if (!Number.isNaN(n)) data.set(String(d.date), n)
  }
  return { data, meta: { title: described.title, units: described.units, frequency: described.frequency, seasonal_adjustment: described.seasonal_adjustment, notes: described.notes } }
}

/** FredSeriesFetcher.fetch_data: the observations and descriptions of one or more series, side by side. */
export async function fetchSeries(ctx: NativeCtx, key: string, q: SeriesQuery): Promise<SeriesResult> {
  const symbol = q.symbol.toUpperCase()
  const ids = symbol.includes(',') ? symbol.split(',') : [symbol]
  // The query model dumps its fields in declaration order, under the names FRED uses (symbol → series_id, start_date →
  // observation_start, end_date → observation_end, transform → units); fields that are None are left out.
  const params: Record<string, string | number | null> = {
    observation_start: q.start_date ?? null,
    observation_end: q.end_date ?? null,
    limit: orDefault(q.limit, 100000),
    frequency: q.frequency ?? null,
    aggregation_method: orDefault(q.aggregation_method, 'eop'),
    units: q.transform ?? null,
    ...q.extra,
  }
  const cache = q.use_cache ?? true
  const results = await mapLimit(ids, MAX_IN_FLIGHT, (id) => fetchOne(ctx, key, id, params, cache))

  // DataFrame(series).filter(items=symbols).sort_index(): one column per series that had data, in the order asked for.
  const byId = new Map<string, Map<string, number>>()
  const metadata: Record<string, SeriesMeta> = {}
  results.forEach((r, i) => {
    if (!r) return
    byId.set(ids[i]!, r.data)
    metadata[ids[i]!] = r.meta
  })
  const columns = [...new Set(ids)].filter((id) => byId.has(id))
  const dates = [...new Set(columns.flatMap((id) => [...byId.get(id)!.keys()]))].sort()
  const rows = dates.map((date) => {
    const row = { date } as SeriesRow
    for (const id of columns) row[id] = byId.get(id)!.get(date) ?? null
    return row
  })
  return { rows, metadata }
}

/** A series row as the API writes it: the nulls left out. */
export function present(row: Record<string, unknown>): Row {
  const out: Row = {}
  for (const [k, v] of Object.entries(row)) if (v !== null && v !== undefined) out[k] = v
  return out
}

function optionalNumber(params: NativeParams, name: string): number | undefined {
  const v = text(params, name)
  return v === undefined ? undefined : Number(v)
}

export async function fredSeries(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const key = apiKey(ctx)
  const symbol = text(params, 'symbol')
  if (!symbol) throw new Error('symbol: Field required')
  const result = await fetchSeries(ctx, key, {
    symbol,
    start_date: text(params, 'start_date') ?? null,
    end_date: text(params, 'end_date') ?? null,
    frequency: text(params, 'frequency') ?? null,
    aggregation_method: text(params, 'aggregation_method') ?? 'eop',
    transform: text(params, 'transform') ?? null,
    limit: optionalNumber(params, 'limit') ?? 100000,
    use_cache: useCache(params),
  })
  return result.rows.map(present)
}
