// The cross-market instrument directory of the QuoteMedia symbology and equity/search, provider tmx. Ported from
// openbb_tmx/utils/directory.py and openbb_tmx/models/equity_search.py (OpenBB Platform 5.0.0, Apache-2.0); modified:
// plain rows instead of DataFrames, the 24 hour sweep is memoised through ctx.cache.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { boolParam, cached, compact, DAY_MS, mapLimit, numParam, oneOf, qmToken, mintQmToken, strParam, TmxError, urlencode, QM_APP_URL, withoutRouteDefaults } from './helpers.js'

const LOOKUP_TOOL = 'InteractiveChart'
const PHRASE_PAGE = 2000
const ROW_CAP = 20000
const PREFIX_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
const SWEEP_CONCURRENCY = 6
const MAX_PREFIX_LENGTH = 3

function lookupHeaders(): Record<string, string> {
  return {
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-CA,en-US;q=0.7,en;q=0.3',
    Origin: 'https://money.tmx.com',
    Referer: 'https://money.tmx.com/',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  }
}

/** `lookup_symbols`: the symbology's answer for a symbol or name fragment. */
export async function lookupSymbols(ctx: NativeCtx, query: string, limit: number, country: string | undefined, symbolOnly: boolean): Promise<Row[]> {
  if (!query) return []
  let token = await qmToken(ctx, LOOKUP_TOOL)
  for (let attempt = 0; attempt < 2; attempt++) {
    const params: Record<string, string | number> = { q: query, limit, token }
    if (country) params.countryCode = country
    if (symbolOnly) params.searchType = 'symbol'
    let response: unknown
    try {
      response = await ctx.http.json(`${QM_APP_URL}/datatool/lookup.json?${urlencode(params)}`, { headers: lookupHeaders() })
    } catch {
      response = undefined
    }
    if (Array.isArray(response)) {
      if (response.length > 0 || !query.trim().includes(' ')) return response as Row[]
      return lookupPhrase(ctx, query, limit, country, symbolOnly)
    }
    if (attempt === 0) token = await mintQmToken(ctx, LOOKUP_TOOL)
  }
  return []
}

/** `_lookup_phrase`: a multi-word query the symbology cannot answer directly, matched word by word. */
async function lookupPhrase(ctx: NativeCtx, query: string, limit: number, country: string | undefined, symbolOnly: boolean): Promise<Row[]> {
  const words = query.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return []
  const pages = await Promise.all(words.map((word) => lookupSymbols(ctx, word, Math.max(limit, PHRASE_PAGE), country, symbolOnly)))
  const rows = [...new Map(pages.flat().map((row) => [row.symbol, row] as const)).values()]
  const needles = words.map((w) => w.toLowerCase())
  return rows.filter((row) => {
    const hay = `${(row.name as string | null) ?? ''} ${(row.symbol as string | null) ?? ''}`.toLowerCase()
    return needles.every((n) => hay.includes(n))
  }).slice(0, limit)
}

async function sweepPrefix(ctx: NativeCtx, prefix: string, country: string | undefined, results: Map<number, Row>): Promise<void> {
  const rows = await lookupSymbols(ctx, prefix, ROW_CAP, country, true)
  for (const row of rows) if (row.symbolId !== undefined && row.symbolId !== null) results.set(row.symbolId as number, row)
  if (rows.length < ROW_CAP || prefix.length >= MAX_PREFIX_LENGTH) return
  for (const char of PREFIX_ALPHABET) await sweepPrefix(ctx, prefix + char, country, results)
}

/** `get_master_directory`: every instrument of a country, swept prefix by prefix and kept for a day. */
export function masterDirectory(ctx: NativeCtx, country: string | undefined, useCache: boolean): Promise<Row[]> {
  return cached(ctx, useCache, `tmx:directory:${country ?? 'all'}`, DAY_MS, async () => {
    const perPrefix = await mapLimit([...PREFIX_ALPHABET], SWEEP_CONCURRENCY, async (char) => {
      const results = new Map<number, Row>()
      await sweepPrefix(ctx, char, country, results)
      return results
    })
    const all = new Map<number, Row>()
    for (const results of perPrefix) for (const [id, row] of results) all.set(id, row)
    if (all.size === 0) throw new TmxError('The TMX instrument directory came back empty.')
    return [...all.values()]
  })
}

/** `get_directory_frame`: the directory narrowed to some instrument types and exchanges. */
export async function directoryRows(ctx: NativeCtx, country: string | undefined, symbolTypes: string[] | undefined, exchanges: string[] | undefined, useCache: boolean): Promise<Row[]> {
  let rows = await masterDirectory(ctx, country, useCache)
  if (symbolTypes && symbolTypes.length > 0) rows = rows.filter((r) => symbolTypes.includes(r.symbolType as string))
  if (exchanges && exchanges.length > 0) rows = rows.filter((r) => exchanges.includes(r.exchangeShortName as string))
  return rows
}

/** `sort_values`: missing values last, ties in their original order. */
export function sortRows(rows: Row[], column: string, ascending: boolean): Row[] {
  const present: Row[] = []
  const missing: Row[] = []
  for (const r of rows) {
    const v = r[column]
    if (v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v))) missing.push(r)
    else present.push(r)
  }
  const cmp = (a: unknown, b: unknown): number => (a! < b! ? -1 : a! > b! ? 1 : 0)
  const sorted = present.map((r, i) => ({ r, i })).sort((a, b) => (ascending ? cmp(a.r[column], b.r[column]) : cmp(b.r[column], a.r[column])) || a.i - b.i).map((x) => x.r)
  return [...sorted, ...missing]
}

/** `browse_symbols`: the directory by market capitalisation, primary listings only. */
async function browseSymbols(ctx: NativeCtx, limit: number, country: string | undefined, useCache: boolean): Promise<Row[]> {
  const rows = await directoryRows(ctx, country, undefined, undefined, useCache)
  const primary = rows.filter((r) => !String(r.symbol).includes(':'))
  return sortRows(primary, 'marketCap', false).slice(0, limit)
}

/** equity/search: a symbol or name search over the symbology, or the largest listings when there is no query. */
export async function equitySearch(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const given = withoutRouteDefaults(params, { country: 'CA', limit: 200 })
  const country = oneOf(given, 'country', ['CA', 'US', 'GB'] as const, 'CA')
  const limit = numParam(given, 'limit') ?? 200
  const useCache = boolParam(params, 'use_cache', true)
  const query = strParam(params, 'query')
  const results = !query ? await browseSymbols(ctx, limit, country, useCache) : await lookupSymbols(ctx, query, limit, country, boolParam(params, 'symbol_only', false))
  return results.map((d) =>
    compact({
      symbol: d.symbol,
      name: d.name,
      exchange: d.exchangeShortName,
      exchange_code: d.exchangeCode,
      country: d.countryCode,
      security_type: d.symbolType,
      market_cap: d.marketCap,
      optionable: d.optionable,
    }),
  )
}
