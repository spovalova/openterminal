// IMF PortWatch queries: ArcGIS FeatureServer pages and the port directory. Ported from
// openbb_imf/utils/port_watch_helpers.py (OpenBB Platform 5.0.0, Apache-2.0); modified: requests through ctx.http, the
// lru caches are ctx.cache.
import type { NativeCtx } from '../types.js'
import { isoDate } from '../lib/sdmx.js'
import { CHOKEPOINTS_BASE_URL, CONTAINER_METRICS_BASE_URL, DAILY_TRADE_BASE_URL, DAILY_TRADE_REG_BASE_URL, DISRUPTIONS_DATABASE_URL, MONTHLY_TRADENOW_BASE_URL, SANKEY_DATA_URL } from './constants.js'

export type Attributes = Record<string, unknown>

const HOUR = 3600 * 1000

/** Python's `urllib.parse.quote(s, safe="")`. */
export const pyQuote = (s: string): string => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)

/** Python's `urllib.parse.urlencode`: `quote_plus` on keys and values. */
export const pyUrlencode = (entries: [string, string][]): string => entries.map(([k, v]) => `${pyQuote(k).replace(/%20/g, '+')}=${pyQuote(v).replace(/%20/g, '+')}`).join('&')

type Page = { features?: { attributes?: Attributes }[]; exceededTransferLimit?: boolean }

/** Every page of an ArcGIS FeatureServer query as attribute rows (`_arcgis_query`). */
export async function arcgisQuery(ctx: NativeCtx, baseUrl: string, where = '1=1', opts: { orderBy?: string; pageSize?: number; extraParams?: string } = {}): Promise<Attributes[]> {
  const orderClause = opts.orderBy ? `&orderByFields=${pyQuote(opts.orderBy)}` : ''
  const baseQuery = `where=${pyQuote(where)}&outFields=*${orderClause}&returnZ=true&resultRecordCount=${opts.pageSize ?? 1000}&maxRecordCountFactor=5&outSR=&f=json${opts.extraParams ?? ''}`
  const rows: Attributes[] = []
  let offset = 0
  for (;;) {
    const url = `${baseUrl}${baseQuery}&resultOffset=${offset}`
    const res = await ctx.http.response(url, { timeoutMs: 120_000 })
    if (res.status !== 200) throw new Error(`ArcGIS query failed: ${res.status} -> ${url}`)
    const data = (await res.json()) as Page
    const features = data.features ?? []
    for (const feat of features) {
      const attrs = feat.attributes ?? {}
      if (Object.keys(attrs).length > 0) rows.push(attrs)
    }
    if (!data.exceededTransferLimit || features.length === 0) break
    offset += features.length
  }
  return rows
}

/** A millisecond epoch as `YYYY-MM-DD`; text is cut to its date (`_epoch_to_iso_date`). */
export function epochToIsoDate(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value === 'string') return value.slice(0, 10)
  if (typeof value === 'number' && value > 1e10) return new Date(value).toISOString().slice(0, 10)
  return String(value)
}

/** `year`, `month` and `day` folded into `date`, and the row ids dropped (`_normalize_ymd`). */
export function normalizeYmd(row: Attributes): Attributes {
  if ('year' in row && 'month' in row && 'day' in row) {
    const date = isoDate(Math.trunc(Number(row.year)), Math.trunc(Number(row.month)), Math.trunc(Number(row.day)))
    if (date !== undefined) row.date = date
  }
  return Object.fromEntries(Object.entries(row).filter(([k]) => !['year', 'month', 'day', 'ObjectId', 'GlobalID'].includes(k)))
}

/** An ArcGIS `WHERE` clause limiting `field` to a date range (`_date_where_clause`). */
export function dateWhereClause(field: string, startDate?: string, endDate?: string): string {
  const clauses: string[] = []
  if (startDate) clauses.push(`${field} >= TIMESTAMP '${startDate} 00:00:00'`)
  if (endDate) clauses.push(`${field} <= TIMESTAMP '${endDate} 23:59:59'`)
  return clauses.length === 0 ? '1=1' : clauses.join(' AND ')
}

/** `<first>` and, when there is a date clause, `AND (<clause>)`. */
const andDates = (first: string, dateClause: string): string => first + (dateClause === '1=1' ? '' : ` AND (${dateClause})`)

// --- ports

export type Port = { portid: string; portname: string; ISO3: string; countrynoaccents?: string; [key: string]: unknown }

const PORTS_URL = 'https://services9.arcgis.com/weJ1QsnbMYJlCHdG/arcgis/rest/services/PortWatch_ports_database/FeatureServer/0/query?where=1%3D1&outFields=countrynoaccents,portid,lon,lat,portname,ISO3,continent,fullname+&returnGeometry=false&orderByFields=vessel_count_total%20DESC&outSR=&f=json'

/** Every port PortWatch lists, busiest first (`list_ports`). */
export function listPorts(ctx: NativeCtx): Promise<Port[]> {
  return ctx.cache('imf:portwatch:ports', HOUR, async () => {
    const res = await ctx.http.response(PORTS_URL)
    if (res.status !== 200) throw new Error(`Failed to fetch ports data: ${res.status} - ${res.statusText}`)
    const data = (await res.json()) as Page
    return (data.features ?? []).map((f) => (f.attributes ?? {}) as Port)
  })
}

/** The ports of a country, as a comma-separated string of their ids (`get_port_ids_by_country`). */
export async function portIdsByCountry(ctx: NativeCtx, countryCode: string): Promise<string> {
  return (await listPorts(ctx)).filter((p) => p.ISO3 === countryCode.toUpperCase()).map((p) => p.portid).join(',')
}

// --- daily data

type Feature = { attributes: Attributes }

/** The features of a daily-data query, paged the way the Python code pages it (`get_daily_chokepoint_data`, `get_daily_port_activity_data`). */
async function pagedFeatures(ctx: NativeCtx, urlAt: (offset: number) => string): Promise<Feature[]> {
  let offset = 0
  const first = await ctx.http.response(urlAt(offset))
  if (first.status !== 200) throw new Error(`Failed to fetch data: ${first.status}`)
  let data = (await first.json()) as { features?: Feature[]; exceededTransferLimit?: boolean }
  if (!('features' in data)) throw new Error("'features'")
  const features = [...(data.features ?? [])]
  while (data.exceededTransferLimit === true) {
    offset += data.features!.length
    const res = await ctx.http.response(urlAt(offset))
    if (res.status !== 200) throw new Error(`Failed to fetch data: ${res.status}`)
    data = (await res.json()) as typeof data
    if ('features' in data) features.push(...data.features!)
  }
  return features
}

/** Rows of daily features: the `date` from year, month and day, the attributes without the date parts and the row id. */
function dailyRows(features: Feature[]): Attributes[] {
  return features.map((f) => {
    const a = f.attributes
    const date = isoDate(Math.trunc(Number(a.year)), Math.trunc(Number(a.month)), Math.trunc(Number(a.day)))
    if (date === undefined) throw new Error('day is out of range for month')
    return { date, ...Object.fromEntries(Object.entries(a).filter(([k]) => !['year', 'month', 'day', 'date', 'ObjectId'].includes(k))) }
  })
}

/** An absent bound filled in: a start without an end runs to today, an end without a start begins in 2019. */
function windowOf(ctx: NativeCtx, startDate?: string, endDate?: string): [string | undefined, string | undefined] {
  if (startDate !== undefined && endDate === undefined) {
    const now = ctx.now()
    endDate = `${String(now.getFullYear()).padStart(4, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  }
  if (startDate === undefined && endDate !== undefined) startDate = '2019-01-01'
  return [startDate, endDate]
}

/** The daily transit counts of one chokepoint (`get_daily_chokepoint_data`). */
export function dailyChokepointData(ctx: NativeCtx, chokepointId: string, startDate?: string, endDate?: string): Promise<Attributes[]> {
  return ctx.cache(`imf:portwatch:chokepoint:${chokepointId}:${startDate}:${endDate}`, HOUR, async () => {
    const [start, end] = windowOf(ctx, startDate, endDate)
    const id = chokepointId.toUpperCase()
    const urlAt = (offset: number): string =>
      start !== undefined && end !== undefined
        ? `${CHOKEPOINTS_BASE_URL}where=portid%20%3D%20%27${id}%27AND%20date%20>%3D%20TIMESTAMP%20%27${start}%2000%3A00%3A00%27%20AND%20date%20<%3D%20TIMESTAMP%20%27${end}%2000%3A00%3A00%27&outFields=*&orderByFields=date&returnZ=true&resultOffset=${offset}&resultRecordCount=1000&maxRecordCountFactor=5&outSR=&f=json`
        : `${CHOKEPOINTS_BASE_URL}where=portid%20%3D%20%27${id}%27&outFields=*&orderByFields=date&returnZ=true&resultOffset=${offset}&resultRecordCount=1000&maxRecordCountFactor=5&outSR=&f=json`
    return dailyRows(await pagedFeatures(ctx, urlAt))
  })
}

/** The daily transit counts of all 24 chokepoints (`get_all_daily_chokepoint_activity_data`). */
export async function allDailyChokepointData(ctx: NativeCtx, startDate?: string, endDate?: string): Promise<Attributes[]> {
  const ids = Array.from({ length: 24 }, (_, i) => `chokepoint${i + 1}`)
  const batches = await Promise.all(
    ids.map(async (id) => {
      try {
        return await dailyChokepointData(ctx, id, startDate, endDate)
      } catch (e) {
        throw new Error(`Failed to fetch data for ${id}: ${e instanceof Error ? e.message : String(e)}`, { cause: e })
      }
    }),
  )
  const data = batches.flat()
  if (data.length === 0) throw new Error('All requests were returned empty.')
  return data
}

/** The daily activity of one port (`get_daily_port_activity_data`). */
export function dailyPortActivityData(ctx: NativeCtx, portId: string, startDate?: string, endDate?: string): Promise<Attributes[]> {
  return ctx.cache(`imf:portwatch:port:${portId}:${startDate}:${endDate}`, HOUR, async () => {
    const [start, end] = windowOf(ctx, startDate, endDate)
    const id = portId.toUpperCase()
    const urlAt = (offset: number): string =>
      start === undefined && end === undefined
        ? `${DAILY_TRADE_BASE_URL}where=portid%20%3D%20%27${id}%27&outFields=*&orderByFields=date&returnZ=true&resultOffset=${offset}&resultRecordCount=1000&maxRecordCountFactor=5&outSR=&f=json`
        : `${DAILY_TRADE_BASE_URL}where=portid%20%3D%20%27${id}%27%20AND%20date%20>%3D%20TIMESTAMP%20%27${start}%2000%3A00%3A00%27%20AND%20date%20<%3D%20TIMESTAMP%20%27${end}%2000%3A00%3A00%27&outFields=*&orderByFields=date&returnZ=true&resultOffset=${offset}&resultRecordCount=1000&maxRecordCountFactor=5&outSR=&f=json`
    return dailyRows(await pagedFeatures(ctx, urlAt))
  })
}

// --- country, trade, containers, disruptions

export async function countryDailyActivity(ctx: NativeCtx, iso3: string, startDate?: string, endDate?: string): Promise<Attributes[]> {
  const where = andDates(`ISO3 = '${iso3.trim().toUpperCase()}'`, dateWhereClause('date', startDate, endDate))
  return (await arcgisQuery(ctx, DAILY_TRADE_REG_BASE_URL, where, { orderBy: 'date' })).map(normalizeYmd)
}

export async function monthlyTrade(ctx: NativeCtx, iso3: string, startDate?: string, endDate?: string): Promise<Attributes[]> {
  const where = andDates(`ISO3 = '${iso3.trim().toUpperCase()}'`, dateWhereClause('date', startDate, endDate))
  const rows = await arcgisQuery(ctx, MONTHLY_TRADENOW_BASE_URL, where, { orderBy: 'date' })
  return rows.map((r) => {
    r.date = epochToIsoDate(r.date)
    return normalizeYmd(r)
  })
}

const CONTAINER_SKIP = new Set(['OBJECTID', 'OBJECTID_1', 'METRIC', 'DATE', 'DATE_IN', 'GLOBALID', 'YEAR', 'MONTH', 'DAY'])

/** Container metrics in long format: `{metric, portid, date, value}` per port column (`get_container_metrics`). */
export async function containerMetrics(ctx: NativeCtx, metric?: string, startDate?: string, endDate?: string): Promise<Attributes[]> {
  let where = dateWhereClause('date_in', startDate, endDate)
  if (metric) where = andDates(`metric = '${metric}'`, where)
  const rows = await arcgisQuery(ctx, CONTAINER_METRICS_BASE_URL, where, { orderBy: 'date_in' })
  const out: Attributes[] = []
  for (const r of rows) {
    const date = epochToIsoDate(r.date || r.date_in)
    for (const [col, val] of Object.entries(r)) {
      const up = col.toUpperCase()
      if (CONTAINER_SKIP.has(up) || !up.startsWith('PORT')) continue
      if (val === null || val === undefined) continue
      out.push({ metric: r.metric, portid: up, date, value: val })
    }
  }
  return out
}

/** Disruption events, newest first (`get_disruption_events`). */
export async function disruptionEvents(ctx: NativeCtx, f: { iso3?: string; eventtype?: string; alertlevel?: string; activeOnly?: boolean; startDate?: string; endDate?: string } = {}): Promise<Attributes[]> {
  const clauses: string[] = []
  if (f.iso3) clauses.push(`country = '${f.iso3.trim().toUpperCase()}'`)
  if (f.eventtype) clauses.push(`eventtype = '${f.eventtype}'`)
  if (f.alertlevel) clauses.push(`alertlevel = '${f.alertlevel.toUpperCase()}'`)
  if (f.activeOnly) clauses.push('(todate IS NULL OR todate >= CURRENT_TIMESTAMP)')
  const dateClause = dateWhereClause('fromdate', f.startDate, f.endDate)
  if (dateClause !== '1=1') clauses.push(dateClause)
  const where = clauses.length > 0 ? clauses.join(' AND ') : '1=1'
  const rows = await arcgisQuery(ctx, DISRUPTIONS_DATABASE_URL, where, { orderBy: 'fromdate DESC' })
  for (const r of rows) for (const field of ['fromdate', 'todate', 'editdate']) if (field in r) r[field] = epochToIsoDate(r[field])
  return rows
}

/** The spillover edges of a disruption event (`get_disruption_sankey_edges`). */
export async function disruptionSankeyEdges(ctx: NativeCtx, eventId: number): Promise<Attributes[]> {
  return arcgisQuery(ctx, SANKEY_DATA_URL, `eventid = ${Math.trunc(eventId)}`)
}
