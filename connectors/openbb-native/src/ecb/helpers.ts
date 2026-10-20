// Ported from openbb_ecb/utils/{query_builder,data_cache,series_keys,helpers}.py and utils/metadata/_helpers.py
// (OpenBB Platform 5.0.0, Apache-2.0); modified: requests go through ctx.http, the parsed-data disk cache is
// ctx.cache, and the dataflow catalogue is the dimension table in dataflows.json instead of the shipped
// metadata cache (only the dimension order of each dataflow is used).
import { parseSdmxCsv, parseSdmxJson, parseSdmxSeriesKeys, type SdmxJsonMessage, type SdmxRecord } from '../lib/sdmx.js'
import { NativeHttpError } from '../http.js'
import type { NativeCtx } from '../types.js'
import dataflows from './dataflows.json' with { type: 'json' }

export const BASE_URL = 'https://data-api.ecb.europa.eu/service'
const HOUR = 3600 * 1000
const DATA_HEADERS = { Accept: 'application/json', 'User-Agent': 'OpenBB Platform - ECB' }
const CSV_HEADERS = { Accept: 'text/csv', 'User-Agent': 'OpenBB Platform - ECB' }
/** The plain user agent the non-SDMX downloads (calendar page, eligible-assets files) send. */
export const PLAIN_HEADERS = { 'User-Agent': 'OpenBB Platform - ECB' }

/** The ECB dataflows OpenBB knows, each with its dimensions in key order. */
export const DATAFLOWS: Record<string, string[]> = dataflows

/** How long parsed data stays cached, by dataset (`DATASET_TTL`). */
const TTL: Record<string, number> = {
  exr: 6 * HOUR,
  fm: 6 * HOUR,
  estr: 6 * HOUR,
  yield_curve: 6 * HOUR,
  eligible_assets: 12 * HOUR,
  balance_of_payments: 24 * HOUR,
  mfi_interest_rates: 24 * HOUR,
  currency_reference_rates: 3 * HOUR,
  releases: HOUR,
  calendar: HOUR,
  indicators: 6 * HOUR,
  series: 24 * HOUR,
}

class EmptyRecords extends Error {}

/** The records with one more field, for the fetchers that note which item each record belongs to. */
export const withField = (records: SdmxRecord[], name: string, value: string): SdmxRecord[] => records.map((r) => ({ ...r, [name]: value }))

/**
 * Parsed records for `key`, loaded once per TTL (`cached_records`): empty results are not kept, and `useCache: false`
 * loads every time. Callers get their own copies of the records, because the fetchers annotate them.
 */
export async function cachedRecords(ctx: NativeCtx, dataset: string, key: string, useCache: boolean, loader: () => Promise<SdmxRecord[]>): Promise<SdmxRecord[]> {
  if (!useCache) return loader()
  try {
    const records = await ctx.cache(`ecb:${dataset}:${key}`, TTL[dataset] ?? 6 * HOUR, async () => {
      const loaded = await loader()
      if (loaded.length === 0) throw new EmptyRecords()
      return loaded
    })
    return records.map((r) => ({ ...r }))
  } catch (err) {
    if (err instanceof EmptyRecords) return []
    throw err
  }
}

export type DataQuery = { startDate?: string | undefined; endDate?: string | undefined; detail?: string; format?: 'jsondata' | 'csvdata' }

/** An SDMX 2.1 data query URL (`build_data_url`). */
export function buildDataUrl(flow: string, key: string, q: DataQuery = {}): string {
  const params = [`format=${q.format ?? 'jsondata'}`, `detail=${q.detail ?? 'full'}`]
  if (q.startDate) params.push(`startPeriod=${q.startDate}`)
  if (q.endDate) params.push(`endPeriod=${q.endDate}`)
  return `${BASE_URL}/data/${flow}/${key}?${params.join('&')}`
}

/** One SDMX-JSON message, undefined on a 404 (no such data); any other failure is an error (`_request_sdmx`). */
async function requestJson(ctx: NativeCtx, url: string): Promise<SdmxJsonMessage | undefined> {
  const res = await ctx.http.response(url, { headers: DATA_HEADERS })
  if (res.status === 404) return undefined
  if (res.status !== 200) throw new Error(`ECB request failed (${res.status}). URL -> ${url} -> ${(await res.text()).slice(0, 300)}`)
  // A 200 with an empty body (a series with no observations in the window) reads as no message, as aiohttp's json() does.
  const raw = await res.text()
  if (raw.trim() === '') return undefined
  const body: unknown = JSON.parse(raw)
  return body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as SdmxJsonMessage) : undefined
}

/** The `csvdata` response as text, undefined unless it is a 200 (`_request_sdmx_text`). */
async function requestCsv(ctx: NativeCtx, url: string): Promise<string | undefined> {
  const res = await ctx.http.response(url, { headers: CSV_HEADERS })
  return res.status === 200 ? res.text() : undefined
}

/**
 * Observation records of a data query (`fetch_sdmx_data`): the JSON message first, then `csvdata` when the JSON
 * has nothing. An empty answer is an empty list, or an error with `raiseEmpty`.
 */
export async function fetchSdmxData(ctx: NativeCtx, flow: string, key: string, q: DataQuery & { raiseEmpty?: boolean } = {}): Promise<SdmxRecord[]> {
  const url = buildDataUrl(flow, key, q)
  const message = await requestJson(ctx, url)
  let records = message ? parseSdmxJson(message) : []
  if (records.length === 0) {
    const text = await requestCsv(ctx, buildDataUrl(flow, key, { ...q, format: 'csvdata' }))
    records = text ? parseSdmxCsv(text, flow) : []
  }
  if (records.length === 0 && q.raiseEmpty) throw new Error(`No data found for the query. URL -> ${url}`)
  return records
}

/** The existing series of a dataflow slice (`fetch_series_keys`). */
export async function fetchSeriesKeys(ctx: NativeCtx, flow: string, key: string): Promise<SdmxRecord[]> {
  const message = await requestJson(ctx, buildDataUrl(flow, key, { detail: 'serieskeysonly' }))
  return message ? parseSdmxSeriesKeys(message) : []
}

// --- series keys (series_keys.py)

export const FREQUENCY_MAP: Record<string, string> = { annual: 'A', business: 'B', daily: 'D', weekly: 'W', monthly: 'M', quarterly: 'Q', semi_annual: 'S' }

/** An EXR key for `currency` against EUR. */
export const exrKey = (currency: string, freq = 'D'): string => `${freq}.${currency.toUpperCase()}.EUR.SP00.A`

export const FM_RATE_CODES: Record<string, string> = { deposit: 'DFR', lending: 'MLFR', refinancing: 'MRR_FR' }

export const EST_BENCHMARK = 'EU000A2X2A25'
export const EST_DATA_TYPES: Record<string, string> = {
  WT: 'rate',
  R25: 'percentile_25',
  R75: 'percentile_75',
  TT: 'volume',
  NT: 'transactions',
  NB: 'number_of_banks',
  VL: 'large_bank_share_of_volume',
}

/** The €STR key that fetches every data type in one request. */
export const estKey = (freq = 'B'): string => `${freq}.${EST_BENCHMARK}.${Object.keys(EST_DATA_TYPES).join('+')}`

/** Curated MFI interest rate series: [BS_ITEM, maturity, counterpart, coverage]. */
export const MIR_SERIES: Record<string, [string, string, string, string]> = {
  household_overnight_deposits: ['L21', 'A', '2250', 'N'],
  household_deposits_with_agreed_maturity: ['L22', 'A', '2250', 'N'],
  household_deposits_redeemable_at_notice: ['L23', 'A', '2250', 'N'],
  household_loans_for_house_purchase: ['A2C', 'A', '2250', 'N'],
  household_loans_for_house_purchase_cost_of_borrowing: ['A2C', 'AM', '2250', 'N'],
  household_consumer_credit: ['A2B', 'A', '2250', 'N'],
  household_other_loans: ['A2D', 'A', '2250', 'N'],
  corporate_overnight_deposits: ['L21', 'A', '2240', 'N'],
  corporate_deposits_with_agreed_maturity: ['L22', 'A', '2240', 'N'],
  corporate_loans: ['A2A', 'A', '2240', 'N'],
  corporate_loans_cost_of_borrowing: ['A2I', 'AM', '2240', 'N'],
  household_loans_outstanding: ['A20', 'A', '2250', 'O'],
  household_house_purchase_outstanding: ['A22', 'A', '2250', 'O'],
  household_consumer_and_other_outstanding: ['A25', 'A', '2250', 'O'],
}

export function mirKey(series: string, refArea = 'U2', freq = 'M'): string {
  const [bsItem, maturity, counterpart, coverage] = MIR_SERIES[series]!
  return `${freq}.${refArea}.B.${bsItem}.${maturity}.R.A.${counterpart}.EUR.${coverage}`
}

// --- search (metadata/_helpers.py)

/** A search string as an OR of ANDs: `|` separates alternatives, `+` or spaces join terms, quotes keep a phrase whole. */
export function parseSearchQuery(query: string): string[][] {
  const q = (query || '').trim().toLowerCase()
  if (!q) return []
  const groups: string[][] = []
  for (const orPart of q.split('|')) {
    const terms: string[] = []
    for (const m of orPart.matchAll(/"([^"]+)"|(\S+)/g)) {
      if (m[1]) terms.push(m[1].trim())
      else if (m[2] && m[2] !== '+') terms.push(...m[2].split('+').filter(Boolean))
    }
    if (terms.length > 0) groups.push(terms)
  }
  return groups
}

export function matchesQuery(haystack: string, parsed: string[][]): boolean {
  if (parsed.length === 0) return true
  const hay = haystack.toLowerCase()
  return parsed.some((group) => group.every((term) => hay.includes(term)))
}

export { flag, localDate, text, whole } from '../lib/params.js'

/** A failed request carries its status; the fetchers that probe several URLs read it. */
export const isHttpError = (err: unknown): err is NativeHttpError => err instanceof NativeHttpError
