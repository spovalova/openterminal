// OECD SDMX data queries. Ported from openbb_oecd/utils/query_builder.py and the URL building of utils/metadata/
// _query_mixin.py (OpenBB Platform 5.0.0, Apache-2.0); modified: requests go through ctx.http, the CSV is read by
// lib/sdmx, and the dimension constraint validation (`validate_dimension_constraints`) is left out: a value the
// dataflow does not have comes back as an empty answer from the data API.
import { parseSdmxCsvLabels, type CsvValue } from '../lib/sdmx.js'
import type { NativeCtx } from '../types.js'
import { findDataflow, resolveDataflow } from './metadata.js'

export const BASE_URL = 'https://sdmx.oecd.org/public/rest/v2'
const DATA_HEADERS = { Accept: 'application/vnd.sdmx.data+csv; version=2.0.0; labels=both', 'User-Agent': 'OpenBB/1.0' }

/** Dataflows and agencies for which the API does not take `lastNObservations`. */
const LASTN_BLOCKED_DATAFLOWS = new Set(['DF_BATIS', 'DF_BIMTS_HS2017_2D', 'DF_BIMTS_CPA_2_1', 'DF_EXTREME_TEMP_DDOWN', 'DF_POP_AGE_DDOWN', 'DF_SDBS_ISIC4', 'DF_STES_REVISIONS', 'DF_TIM_2023', 'DF_TIM_2021', 'DF_TIMBC_2023', 'DF_UOE_FIN_INDIC_SOURCE_NATURE', 'EXT_TEMP_P'])
const LASTN_BLOCKED_AGENCIES = new Set(['OECD.STI', 'OECD.DCD'])

export type Row = Record<string, CsvValue>
export type DimensionValues = Record<string, string | number | null | undefined>

/** A date as the period the API takes: `2024-06-15` → `2024-06`, anything else as it is (`_format_period`). */
export function formatPeriod(date: string): string {
  if (!date) return date
  const parts = date.split('-')
  return parts.length === 3 ? `${parts[0]}-${parts[1]}` : date
}

/** The dot-separated key of a query: a value for each dimension in key order, `*` for the ones not given. */
export function dimensionFilter(dataflow: string, values: DimensionValues): string {
  const df = resolveDataflow(dataflow)
  const byLower = new Map(df.dims.map((d) => [d.toLowerCase(), d] as const))
  const normalised = new Map<string, string>()
  for (const [key, value] of Object.entries(values)) {
    const matched = byLower.get(key.toLowerCase())
    if (matched) normalised.set(matched, value === undefined || value === null ? '*' : String(value))
  }
  return df.dims.map((dim) => normalised.get(dim) || '*').join('.')
}

/** The v2 data URL (`build_url` and `build_data_url`). */
export function buildUrl(dataflow: string, startDate: string | undefined, endDate: string | undefined, limit: number | undefined, values: DimensionValues): string {
  const df = resolveDataflow(dataflow)
  const hasTimeConstraint = Boolean(startDate || endDate)
  const path = `${BASE_URL}/data/dataflow/${df.agency}/${df.id.replace(/@/g, '%40')}/${df.version}/${dimensionFilter(dataflow, values)}`
  const qp: string[] = []
  if (df.time !== false) qp.push('dimensionAtObservation=TIME_PERIOD')
  const shortId = df.id.includes('@') ? df.id.split('@').at(-1)! : df.id
  const agencyPrefix = df.agency.split('.').slice(0, 2).join('.')
  if (limit !== undefined && limit !== null && !LASTN_BLOCKED_DATAFLOWS.has(shortId) && !LASTN_BLOCKED_AGENCIES.has(agencyPrefix)) qp.push(`lastNObservations=${limit}`)
  qp.push(`detail=${hasTimeConstraint ? 'full' : 'dataonly'}`)
  let url = `${path}?${qp.join('&')}`
  // Both bounds in one parameter, and the brackets raw: the API answers 404 to %5B and %5D and ignores a repeated parameter.
  const range: string[] = []
  if (startDate) range.push(`ge:${formatPeriod(startDate)}`)
  if (endDate) range.push(`le:${formatPeriod(endDate)}`)
  if (range.length > 0) url += `&c[TIME_PERIOD]=${range.join(',')}`
  return url
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * One GET, retried when the API says it is being asked too often (429, waiting as long as it asks, 15 to 90 s) and,
 * once or twice, when its server fails for a moment (`_make_request` retries only the first; the OECD API answers a
 * request that arrives together with an identical one with a 500 now and then).
 */
export async function makeRequest(ctx: NativeCtx, url: string): Promise<{ status: number; statusText: string; text: string }> {
  const maxRetries = 5
  let serverErrors = 0
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const res = await ctx.http.response(url, { headers: DATA_HEADERS, timeoutMs: 120_000 })
    if (res.status === 429 && attempt < maxRetries - 1) {
      const retryAfter = Number.parseInt(res.headers.get('Retry-After') ?? '', 10)
      const seconds = Number.isNaN(retryAfter) ? 15 * (attempt + 1) : retryAfter
      await res.text().catch(() => '')
      await sleep(Math.min(Math.max(seconds, 15), 90) * 1000)
      continue
    }
    if (res.status >= 500 && serverErrors < 2) {
      serverErrors++
      await res.text().catch(() => '')
      await sleep(2000 * serverErrors)
      continue
    }
    return { status: res.status, statusText: res.statusText, text: await res.text() }
  }
  throw new Error(`the OECD kept answering 429: ${url}`)
}

/** The text of a successful GET (`raise_for_status` on the rest). */
async function getText(ctx: NativeCtx, url: string): Promise<string> {
  const res = await makeRequest(ctx, url)
  if (res.status < 200 || res.status >= 300) throw new Error(`${res.status} Client Error: ${res.statusText} for url: ${url}`)
  return res.text
}

/**
 * The CSV of a query; when a dimension is given several values (`USA+DEU`) and the combined request fails, one
 * request per value of the first such dimension, with the headerless parts appended (`_fetch_with_multi_value_fallback`).
 */
async function fetchWithMultiValueFallback(ctx: NativeCtx, url: string, dataflow: string, startDate: string | undefined, endDate: string | undefined, limit: number | undefined, values: DimensionValues): Promise<string> {
  try {
    const text = await getText(ctx, url)
    if (text && text.trim()) return text
    throw new Error(`Empty response from OECD for dataflow '${dataflow}'. URL: ${url}`)
  } catch (exc) {
    const multi = Object.entries(values).filter(([, v]) => typeof v === 'string' && v.includes('+'))
    if (multi.length === 0) throw new Error(`OECD data request failed: ${exc instanceof Error ? exc.message : String(exc)}\nURL: ${url}`, { cause: exc })
    const [splitDim, joined] = multi[0]!
    const parts: string[] = []
    let header: string | undefined
    for (const val of (joined as string).split('+')) {
      const single = buildUrl(dataflow, startDate, endDate, limit, { ...values, [splitDim]: val })
      let part: string
      try {
        part = await getText(ctx, single)
      } catch {
        continue
      }
      if (!part || !part.trim()) continue
      const lines = part.trim().split('\n')
      if (header === undefined) {
        header = lines[0]
        parts.push(part.trim())
      } else parts.push(lines.slice(1).join('\n'))
    }
    if (parts.length === 0) throw new Error(`OECD data request failed for all values of '${splitDim}': ${JSON.stringify((joined as string).split('+'))}\nURL: ${url}`, { cause: exc })
    return parts.join('\n')
  }
}

/**
 * The rows of a dataflow query (`fetch_data`): a column per dimension holding the code and `<DIM>_label` the label,
 * `TIME_PERIOD` as sent and `OBS_VALUE` as a number.
 */
export async function fetchData(ctx: NativeCtx, dataflow: string, opts: { startDate?: string | undefined; endDate?: string | undefined; limit?: number | undefined; dimensions?: DimensionValues } = {}): Promise<Row[]> {
  const values = opts.dimensions ?? {}
  const url = buildUrl(dataflow, opts.startDate, opts.endDate, opts.limit, values)
  const text = await fetchWithMultiValueFallback(ctx, url, dataflow, opts.startDate, opts.endDate, opts.limit, values)
  const rows = parseSdmxCsvLabels(text)
  if (rows.length === 0) throw new Error(`No data rows for dataflow '${dataflow}'. URL: ${url}`)
  return rows
}

/** The name of a dataflow, for messages. */
export const dataflowName = (id: string): string => findDataflow(id)?.name ?? id

// --- periods

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** An SDMX period as an ISO date string; unrecognised text comes back unchanged (`parse_time_period`). */
export function parseTimePeriod(time: string): string {
  if (!time) return time
  const s = String(time).trim()
  if (s.length === 10 && s[4] === '-' && s[7] === '-') return s
  if (s.includes('Q')) {
    const parts = s.split('-Q')
    if (parts.length === 2 && /^\d+$/.test(parts[0]!) && /^\d+$/.test(parts[1]!)) return `${parts[0]}-${pad2((Number(parts[1]) - 1) * 3 + 1)}-01`
  }
  if (s.length === 7 && s[4] === '-') return `${s}-01`
  if (s.length === 4 && /^\d+$/.test(s)) return `${s}-01-01`
  return s
}

/** The day of an SDMX period as `YYYY-MM-DD`, undefined for text that is no date (`oecd_date_to_python_date`). */
export function oecdDate(input: unknown): string | undefined {
  const raw = input === undefined || input === null || input === '' ? '' : String(input).trim()
  if (!raw) return undefined
  const s = parseTimePeriod(raw)
  for (const candidate of [s, s.slice(0, 10)]) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(candidate)
    if (m) {
      const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
      const last = new Date(Date.UTC(y, mo, 0)).getUTCDate()
      if (y >= 1 && mo >= 1 && mo <= 12 && d >= 1 && d <= last) return candidate
    }
  }
  return undefined
}
