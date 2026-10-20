// Ported from openbb_cboe/utils/helpers.py and openbb_cboe/utils/europe.py (OpenBB Platform 5.0.0, Apache-2.0);
// modified: directories are memoised through ctx.cache instead of an on-disk aiohttp cache, rows are plain objects
// instead of DataFrames, and the Python helpers no route here uses (document downloads, dropdown choices) are left out.
import { NativeHttpError } from '../http.js'
import { parseCsv } from '../lib/csv.js'
import type { NativeCtx, Row } from '../types.js'

export const TICKER_EXCEPTIONS = ['NDX', 'RUT']
const DAY_MS = 24 * 3600 * 1000
const SETTLEMENT_LOOKBACK = 10
const SETTLEMENT_URL = 'https://www.cboe.com/us/futures/market_statistics/settlement/csv'
const INDEX_HISTORY_FILES = 'https://cdn.cboe.com/api/global/us_indices/daily_prices'
const GLOBAL_INDICES_FEED = 'https://cdn.cboe.com/api/global/us_indices/definitions/GlobalIndices.csv'
const AU_INDEX_FILES = 'https://cdn.cboe.com/data/au/equities/sgx_index_200'
const INDEX_FACTSHEETS = 'https://cdn.cboe.com/resources/indices/factsheet'

/** Memoise a directory for a day, or fetch it fresh when the caller passed `use_cache: false`. */
export function cached<T>(ctx: NativeCtx, key: string, useCache: boolean, load: () => Promise<T>): Promise<T> {
  return useCache ? ctx.cache(key, DAY_MS, load) : load()
}

export const useCacheOf = (params: Record<string, unknown>): boolean => params.use_cache !== false

/** The `symbol` param as upper-case symbols: an array, or one comma-separated string. */
export function symbolsOf(params: Record<string, unknown>): string[] {
  const v = params.symbol
  const list = Array.isArray(v) ? v : String(v ?? '').split(',')
  return list.map((s) => String(s).trim().toUpperCase()).filter(Boolean)
}

/** Order two values as Python orders their text: by code point, which is UTF-16 order for the ASCII these fields hold. */
export function compareText(a: unknown, b: unknown): number {
  const [x, y] = [String(a), String(b)]
  return x < y ? -1 : x > y ? 1 : 0
}

/** `asyncio.gather` over requests the way `amake_requests` reads it: failed ones are skipped unless all of them failed. */
export async function gatherSkippingFailures<T>(requests: Promise<T>[]): Promise<T[]> {
  const settled = await Promise.allSettled(requests)
  const ok = settled.flatMap((r) => (r.status === 'fulfilled' && r.value ? [r.value] : []))
  const failed = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected')
  if (ok.length === 0 && failed) throw failed.reason
  return ok
}

// ---- dates ----

/** The date in the America/New_York trading session, as YYYY-MM-DD (`ny_today`). */
export function nyToday(ctx: NativeCtx): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(ctx.now())
}

/** Add whole days to a YYYY-MM-DD date. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/**
 * A datetime string as pydantic serialises it: seconds always, microseconds when there are any, `Z` for UTC and an
 * offset otherwise, no zone for a naive one. Anything that does not look like a datetime comes back unchanged.
 */
export function isoDatetime(value: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2})(?:\.(\d+))?)?\s*(Z|[+-]\d{2}:?\d{2})?$/.exec(value.trim())
  if (!m) return value
  const frac = m[4] ? `.${m[4].padEnd(6, '0').slice(0, 6)}` : ''
  let zone = m[5] ?? ''
  if (zone === '+00:00' || zone === '+0000' || zone === '-00:00') zone = 'Z'
  else if (/^[+-]\d{4}$/.test(zone)) zone = `${zone.slice(0, 3)}:${zone.slice(3)}`
  return `${m[1]}T${m[2]}:${m[3] ?? '00'}${frac}${zone}`
}

// ---- pandas look-alikes ----

/** The strings `pandas.read_csv` reads as missing. */
const NA_VALUES = new Set(['', '#N/A', '#N/A N/A', '#NA', '-1.#IND', '-1.#QNAN', '-NaN', '-nan', '1.#IND', '1.#QNAN', '<NA>', 'N/A', 'NA', 'NULL', 'NaN', 'None', 'n/a', 'nan', 'null'])
export const isNa = (v: string): boolean => NA_VALUES.has(v)

/** `Series.str.contains(pattern, case=False)`: a regular expression search. */
export function containsCI(pattern: string): (value: unknown) => boolean {
  const re = new RegExp(pattern, 'i')
  return (value) => typeof value === 'string' && re.test(value)
}

// ---- company directory ----

export type CompanyListing = { symbol?: string; name?: string; dpm_name?: string; post_station?: string; [column: string]: string | undefined }

/**
 * The US company directory for Cboe options, in file order (`get_company_directory`). pandas keeps the leading
 * spaces of the header cells, so a column the directory does not rename keeps them too. Every value is text, and a
 * blank or "NA" cell is missing: pandas 3's `astype(str)` leaves missing values alone, so such a symbol (Nano Labs'
 * "NA") is never found by a search and a blank DPM name is left out.
 */
export function getCompanyRows(ctx: NativeCtx, useCache = true): Promise<CompanyListing[]> {
  return cached(ctx, 'cboe:company_directory', useCache, async () => {
    const csv = await ctx.http.text('https://www.cboe.com/us/options/symboldir/equity_index_options/?download=csv')
    const [header = [], ...rows] = parseCsv(csv)
    const names = header.map((h) => ({ ' Stock Symbol': 'symbol', ' DPM Name': 'dpm_name', ' Post/Station': 'post_station', 'Company Name': 'name' })[h] ?? h)
    return rows.map((r) => Object.fromEntries(names.flatMap((n, i) => (isNa(r[i] ?? '') ? [] : [[n, r[i]]]))) as CompanyListing)
  })
}

/** The company directory by symbol (`get_company_directory(...).loc`); the last listing of a symbol wins. */
export async function getCompanyDirectory(ctx: NativeCtx, useCache = true): Promise<Map<string, CompanyListing>> {
  return new Map((await getCompanyRows(ctx, useCache)).flatMap((r) => (r.symbol === undefined ? [] : [[r.symbol, r] as const])))
}

// ---- index directory ----

export type IndexListing = { index_symbol: string; name: string; source: string; [key: string]: unknown }

const nonNil = (row: Row): Row => Object.fromEntries(Object.entries(row).filter(([, v]) => v !== null && v !== undefined))

/** Cboe Australia's index definitions on the global directory's schema (`get_au_index_directory`). */
async function getAuIndexRows(ctx: NativeCtx, useCache: boolean): Promise<Row[]> {
  const body = await cached(ctx, 'cboe:au_index_definitions', useCache, () => ctx.http.json<{ data?: Row[] }>('https://cdn.cboe.com/api/global/au_indices/definitions/all-definitions.json'))
  return (body.data ?? []).map((item) => ({
    index_symbol: item.symbol,
    name: item.short_name,
    description: item.long_name,
    currency: 'AUD',
    source: 'au_proprietary_index',
    time_zone: 'Australia/Sydney',
    index_launch_date: item.launch_date,
    index_family: item.series,
  }))
}

/** The Global Indices feed: symbol → agent classification and channel (`get_global_indices_feed`). */
async function getGlobalIndicesFeed(ctx: NativeCtx, useCache: boolean): Promise<Map<string, Row[]>> {
  const csv = await cached(ctx, 'cboe:global_indices_feed', useCache, () => ctx.http.text(GLOBAL_INDICES_FEED))
  const [header = [], ...rows] = parseCsv(csv)
  const col = (name: string) => header.indexOf(name)
  const [symbol, agent, channel] = [col('Symbol'), col('Agent Classification'), col('Channel')]
  const out = new Map<string, Row[]>()
  for (const r of rows) {
    const cell = (i: number) => (i < 0 || isNa(r[i] ?? '') ? undefined : r[i])
    const key = cell(symbol)
    if (key === undefined) continue
    out.set(key, [...(out.get(key) ?? []), { agent_classification: cell(agent), channel: cell(channel) }])
  }
  return out
}

/** The US and European index definitions without the Morningstar-sourced rows, as Cboe publishes them. */
async function getUsIndexRows(ctx: NativeCtx, useCache: boolean): Promise<Row[]> {
  const all = await cached(ctx, 'cboe:all_indices', useCache, () => ctx.http.json<Row[]>('https://cdn.cboe.com/api/global/us_indices/definitions/all_indices.json'))
  return all.filter((r) => r.source !== 'morningstar').map(({ featured: _f, featured_order: _o, display: _d, ...rest }) => rest)
}

/**
 * Cboe's index directory across every jurisdiction, in order (`get_index_directory`): the US and European
 * definitions without the Morningstar-sourced rows, then the Australian ones, each annotated with the Global
 * Indices feed's agent classification and channel (a left merge, so a symbol the feed lists twice appears twice).
 */
export function getIndexRows(ctx: NativeCtx, useCache = true): Promise<IndexListing[]> {
  return cached(ctx, 'cboe:index_directory', useCache, async () => {
    const [us, au, feed] = await Promise.all([getUsIndexRows(ctx, useCache), getAuIndexRows(ctx, useCache), getGlobalIndicesFeed(ctx, useCache)])
    const out: IndexListing[] = []
    for (const r of [...us, ...au]) {
      const matches = feed.get(String(r.index_symbol)) ?? [{}]
      for (const extra of matches) out.push(nonNil({ ...r, ...extra }) as IndexListing)
    }
    return out
  })
}

/** The index directory by symbol (`get_index_directory().set_index("index_symbol")`). */
export async function getIndexDirectory(ctx: NativeCtx, useCache = true): Promise<Map<string, IndexListing>> {
  return new Map((await getIndexRows(ctx, useCache)).map((r) => [String(r.index_symbol), r]))
}

/**
 * The directory by symbol without the Australian indices and the Global Indices feed, which add two downloads and
 * columns a quote never reads. Only `equity/price/quote` uses it (its upstream requests are pinned by the openbb
 * connector's native test); a Cboe Australia index has no file at the delayed-quote endpoints, with or without the
 * underscore, so the quote of one fails either way.
 */
export async function getUsIndexDirectory(ctx: NativeCtx, useCache = true): Promise<Map<string, IndexListing>> {
  return new Map((await getUsIndexRows(ctx, useCache)).map((r) => [String(r.index_symbol), r as IndexListing]))
}

/** Cboe's delayed-quote endpoints prefix index symbols with an underscore. */
export function cboeSymbol(symbol: string, indexes: Map<string, IndexListing>): string {
  const s = symbol.replace('^', '')
  return indexes.has(s) || TICKER_EXCEPTIONS.includes(s) ? `_${s}` : s
}

// ---- futures ----

/** The futures roots and their underlying symbols (`list_futures`). */
export async function listFutures(ctx: NativeCtx): Promise<Row[]> {
  const body = await ctx.http.json<{ data: Row[] }>('https://cdn.cboe.com/api/global/delayed_quotes/symbol_book/futures-roots.json')
  return body.data.map(({ sort_order: _s, ...rest }) => rest)
}

/** OpenBB's `to_snake_case`. */
export function toSnakeCase(s: string): string {
  return s
    .replace(/(.)([A-Z][a-z]+)/g, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replaceAll(' ', '_')
    .replaceAll('__', '_')
}

/**
 * `pandas.read_csv` on text: a column whose every present cell is a number becomes numbers, any other column stays
 * text; missing cells are left out. Header cells are used as they are.
 */
export function readCsvFrame(text: string): { columns: string[]; rows: Row[] } {
  const [columns = [], ...cells] = parseCsv(text)
  const numeric = columns.map((_, i) => cells.every((r) => isNa(r[i] ?? '') || /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test((r[i] ?? '').trim())))
  const rows = cells.map((r) => {
    const row: Row = {}
    columns.forEach((c, i) => {
      const raw = r[i] ?? ''
      if (!isNa(raw)) row[c] = numeric[i] ? Number(raw) : raw
    })
    return row
  })
  return { columns, rows }
}

/** One settlement CSV; no rows when the session published none (`_get_settlement_csv`). */
async function getSettlementCsv(ctx: NativeCtx, url: string): Promise<Row[]> {
  const { columns, rows } = readCsvFrame(await ctx.http.text(url))
  if (rows.length === 0) return []
  const names = new Map(columns.map((c) => [c, toSnakeCase(c) === 'expiration_date' ? 'expiration' : toSnakeCase(c)]))
  return rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [names.get(k) ?? k, v])))
}

/**
 * Settlement prices of Cboe futures (`get_settlement_prices`). A date that published nothing falls back to the most
 * recent session within ten days that did; the rows carry that session as `settlement_date`.
 */
export async function getSettlementPrices(
  ctx: NativeCtx,
  opts: { date?: string; options?: boolean; archives?: boolean; finalSettlement?: boolean },
): Promise<Row[]> {
  if (opts.finalSettlement) {
    // Cboe's final-settlement CSV is gone (its URL answers HTTP 404 with a web page); OpenBB answers that call with no data.
    return getSettlementCsv(ctx, 'https://www.cboe.com/us/futures/market_statistics/final_settlement_prices/csv/').catch((err: unknown) => {
      if (err instanceof NativeHttpError && err.status === 404) throw new Error('Cboe no longer publishes final settlement prices: the CSV answers HTTP 404.')
      throw err
    })
  }
  if (opts.archives) return getSettlementCsv(ctx, 'https://cdn.cboe.com/resources/futures/archive/volume-and-price/CFE_FinalSettlement_Archive.csv')
  const query = opts.options ? '?options=t' : ''
  if (!opts.date) {
    const rows = await getSettlementCsv(ctx, SETTLEMENT_URL + query)
    if (rows.length > 0) return rows.map((r) => ({ ...r, settlement_date: nyToday(ctx) }))
  }
  const session = opts.date ?? nyToday(ctx)
  const separator = query ? '&' : '?'
  for (let offset = 0; offset < SETTLEMENT_LOOKBACK; offset++) {
    const day = addDays(session, -offset)
    const rows = await getSettlementCsv(ctx, `${SETTLEMENT_URL}${query}${separator}dt=${day}`)
    if (rows.length > 0) return rows.map((r) => ({ ...r, settlement_date: day }))
  }
  return []
}

// ---- indices ----

/** A DictReader over CSV text: records keyed by the header cells. */
function dictRows(text: string): { fields: string[]; rows: Record<string, string>[] } {
  const [header = [], ...rows] = parseCsv(text)
  return { fields: header, rows: rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? '']))) }
}

/** Constituents and weights of a Cboe Australia index (`get_au_index_constituents`). */
export async function getAuIndexConstituents(ctx: NativeCtx, symbol: string, session: string): Promise<Record<string, string>[]> {
  const prefix = session === 'eod' ? 'AT' : 'PREDICT'
  const text = await ctx.http.text(`${AU_INDEX_FILES}/${prefix}_${symbol}.csv`)
  const lines = text.split(/\r\n|\r|\n/)
  const header = lines.findIndex((line) => line.startsWith('Constituent Name'))
  if (header < 0) throw new Error(`No constituent data was returned for ${symbol}.`)
  // The block is followed by dividend annotation rows that carry only a name.
  return dictRows(lines.slice(header).join('\n')).rows.filter((r) => r.Weight)
}

/** The published daily history of a Cboe index (`get_index_history`), as text records keyed by lower-case column. */
export async function getIndexHistory(ctx: NativeCtx, symbol: string, useCache = true): Promise<Record<string, string>[]> {
  const s = symbol.replace('^', '').toUpperCase()
  const text = await cached(ctx, `cboe:index_history:${s}`, useCache, () => ctx.http.text(`${INDEX_HISTORY_FILES}/${s}_History.csv`))
  if (!text || !text.trimStart().toUpperCase().startsWith('DATE')) throw new Error(`No published history was found for ${s}.`)
  const { fields, rows } = dictRows(text)
  const columns = new Map(fields.map((c) => [c, c.toLowerCase()]))
  columns.set(s, 'close')
  const out = rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => k).map(([k, v]) => [columns.get(k) ?? k.toLowerCase(), v]))).filter((r) => r.date)
  if (out.length === 0) throw new Error(`No published history was found for ${s}.`)
  return out
}

export type IndexDocument = { category: string; title: string; url: string; symbols?: string[] }

/** The per-symbol factsheet, when Cboe publishes one (`get_index_documents`' probe). */
export async function factsheetOf(ctx: NativeCtx, symbol: string): Promise<IndexDocument | undefined> {
  const url = `${INDEX_FACTSHEETS}/CboeGlobalIndices_${symbol}-Index.pdf`
  try {
    const res = await ctx.http.response(url)
    if (res.status !== 200) return undefined
    await res.arrayBuffer()
    return { category: 'Factsheet', title: `${symbol} Index Factsheet`, url }
  } catch {
    return undefined
  }
}

// ---- Cboe Europe ----

const EU_MARKETS = ['bxe', 'cxe', 'dxe', 'sis']
const EU_BOOK_VIEWER = 'https://www.cboe.com/europe/equities/market_statistics/book_viewer/'
const EU_LOOKUP_URL = 'https://ww2.cboe.com/europe/equities/market_statistics/book_viewer_2/symbol_lookup_data/?mkt='

/** Every Cboe Europe symbol's company name, across the venues; a venue that fails adds nothing (`get_eu_company_names`). */
export async function getEuCompanyNames(ctx: NativeCtx, useCache = true): Promise<Map<string, string>> {
  const headers = {
    Accept: 'application/json',
    Referer: EU_BOOK_VIEWER,
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  }
  const one = async (market: string): Promise<Row[]> => {
    try {
      const body = await cached(ctx, `cboe:eu_symbols:${market}`, useCache, () => ctx.http.json<{ symbolsLookupData?: Row[] }>(`${EU_LOOKUP_URL}${market}`, { headers }))
      return body.symbolsLookupData ?? []
    } catch {
      return []
    }
  }
  const names = new Map<string, string>()
  for (const listings of await Promise.all(EU_MARKETS.map(one))) {
    for (const l of listings) if (l.name && l.company_name && !names.has(String(l.name))) names.set(String(l.name), String(l.company_name))
  }
  return names
}
