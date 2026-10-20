// Ported from openbb_nasdaq/utils/helpers.py and utils/constants.py (OpenBB Platform 5.0.0, Apache-2.0); modified: requests
// go through ctx.http with one fixed browser user agent instead of a random one, there is no on-disk response cache
// (listing downloads are memoised through ctx.cache), and only the parts the ported routes use are here.
import { BROWSER_UA } from '../http.js'
import { parseCsv } from '../lib/csv.js'
import type { NativeCtx, NativeParams, Row } from '../types.js'

export const BASE_URL = 'https://api.nasdaq.com/api'
export const SYMBOL_DIRECTORY_FILES = 'https://www.nasdaqtrader.com/dynamic/SymDir'

const NA_VALUES = new Set(['', 'N/A', 'NA', '--', '-', 'null', 'None', 'NM'])
const HOUR_MS = 3600 * 1000
const DAY_MS = 24 * HOUR_MS

/** Nasdaq asset classes, in the order a symbol is probed when the listing directory does not identify it. */
const PROBE_ORDER = ['stocks', 'etf', 'index', 'mutualfunds', 'crypto']

export type Dict = Record<string, any>

/** Replace each tag with a space (`remove_html_tags`). */
export function removeHtmlTags(text: string): string {
  return text.replace(/<.*?>/g, ' ')
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', ndash: '\u2013', mdash: '\u2014', lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d',
  sbquo: '\u201a', bdquo: '\u201e', hellip: '\u2026', bull: '\u2022', middot: '\u00b7', copy: '\u00a9', reg: '\u00ae', trade: '\u2122', deg: '\u00b0', plusmn: '\u00b1',
  euro: '\u20ac', pound: '\u00a3', yen: '\u00a5', cent: '\u00a2', sect: '\u00a7', para: '\u00b6', laquo: '\u00ab', raquo: '\u00bb', times: '\u00d7', divide: '\u00f7',
  eacute: '\u00e9', egrave: '\u00e8', ecirc: '\u00ea', euml: '\u00eb', aacute: '\u00e1', agrave: '\u00e0', acirc: '\u00e2', auml: '\u00e4', aring: '\u00e5', aelig: '\u00e6',
  ccedil: '\u00e7', iacute: '\u00ed', icirc: '\u00ee', iuml: '\u00ef', ntilde: '\u00f1', oacute: '\u00f3', ocirc: '\u00f4', ouml: '\u00f6', oslash: '\u00f8', uacute: '\u00fa',
  ucirc: '\u00fb', uuml: '\u00fc', szlig: '\u00df', Eacute: '\u00c9', Aring: '\u00c5', Auml: '\u00c4', Ouml: '\u00d6', Oslash: '\u00d8', Uuml: '\u00dc', AElig: '\u00c6',
}

/** `html.unescape`: numeric and the common named character references. */
export function htmlUnescape(s: string): string {
  return s.replace(/&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([A-Za-z][A-Za-z0-9]*));/g, (whole, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (dec) return String.fromCodePoint(+dec)
    if (hex) return String.fromCodePoint(parseInt(hex, 16))
    return NAMED_ENTITIES[name!] ?? whole
  })
}

/** The headers api.nasdaq.com requires (`get_headers('json')`): it drops requests without a browser-like set. */
export function jsonHeaders(): Record<string, string> {
  return {
    Accept: 'application/json, text/plain, */*',
    'Accept-Encoding': 'gzip',
    'Accept-Language': 'en-CA,en-US;q=0.7,en;q=0.3',
    Origin: 'https://www.nasdaq.com',
    Referer: 'https://www.nasdaq.com/',
    'User-Agent': BROWSER_UA,
    Connection: 'keep-alive',
  }
}

/** The headers for pages and downloads (`get_headers('text')`). */
export function textHeaders(): Record<string, string> {
  return {
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Encoding': 'gzip',
    'Accept-Language': 'en-CA,en-US;q=0.7,en;q=0.3',
    'User-Agent': BROWSER_UA,
    Connection: 'keep-alive',
  }
}

/** Drop what OpenBB would leave out of a row: null, undefined and NaN. */
export function compact(row: Dict): Row {
  const out: Row = {}
  for (const [k, v] of Object.entries(row)) {
    if (v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v))) continue
    out[k] = v
  }
  return out
}

/** Python's `x or y`: the first when truthy (not null, '', 0, false, empty list or object). */
export function truthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === '') return false
  if (Array.isArray(v)) return v.length > 0
  if (typeof v === 'object') return Object.keys(v as object).length > 0
  return true
}

/** Run `fn` over `items` with at most `limit` in flight; results keep the order of `items`. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i]!, i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

/** The comma-separated list a param carries, as OpenBB's `symbol.split(",")` sees it. */
export function listParam(params: NativeParams, name: string): string[] {
  const v = params[name]
  if (v === undefined || v === null) return []
  return Array.isArray(v) ? v.map(String) : String(v).split(',')
}

/** `[s.strip().upper() for s in symbol.split(",") if s.strip()]` */
export function symbolsOf(params: NativeParams, name = 'symbol'): string[] {
  return listParam(params, name)
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
}

// --- dates -----------------------------------------------------------------------------------------------------

const pad = (n: number, w = 2) => String(n).padStart(w, '0')
/** "YYYY-MM-DD" of a Date's UTC fields. */
export const isoDay = (d: Date): string => `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
/** Today's date, from ctx.now(). */
export const today = (ctx: NativeCtx): string => isoDay(ctx.now())

export function addDays(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return isoDay(d)
}

/** Each date from `start` to `end`, inclusive (`date_range`). */
export function dateRange(start: string, end: string): string[] {
  const out: string[] = []
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d)
  return out
}

/** 0 = Monday … 6 = Sunday, as Python's `date.weekday()`. */
export function weekday(day: string): number {
  return (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7
}

/** A clock time and zone name after a date ('2:53 PM ET'): dateutil reads the date and ignores them. */
const TIME_TAIL = '(?:\\s+\\d{1,2}:\\d{2}(?::\\d{2})?(?:\\s*[AaPp][Mm])?(?:\\s+[A-Za-z]{1,5})?)?'
const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }
const validDay = (y: number, m: number, d: number): string | null => {
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? `${pad(y, 4)}-${pad(m)}-${pad(d)}` : null
}

/** A "MM/DD/YYYY" string as "YYYY-MM-DD" (`datetime.strptime(v, "%m/%d/%Y").date()`); null when it does not fit. */
export function mdyToIso(v: string): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v.trim())
  return m ? validDay(+m[3]!, +m[1]!, +m[2]!) : null
}

/**
 * The formats Nasdaq emits, as `dateutil.parser.parse(...).date()` reads them: ISO dates (with an optional time),
 * "MM/DD/YYYY", "Mon DD, YYYY", "DD Mon YYYY", with an optional weekday name in front.
 */
export function parseLooseDate(value: string): string | null {
  const s = value.trim().replace(/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s+/i, '')
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(s)
  if (m) return validDay(+m[1]!, +m[2]!, +m[3]!)
  m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(s)
  if (m) return validDay(+m[1]!, +m[2]!, +m[3]!)
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})(?:\s.*)?$/.exec(s)
  if (m) return validDay(m[3]!.length === 2 ? 2000 + +m[3]! : +m[3]!, +m[1]!, +m[2]!)
  m = new RegExp(`^([A-Za-z]{3,9})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})${TIME_TAIL}$`).exec(s)
  if (m && MONTHS[m[1]!.slice(0, 3).toLowerCase()]) return validDay(+m[3]!, MONTHS[m[1]!.slice(0, 3).toLowerCase()]!, +m[2]!)
  m = new RegExp(`^(\\d{1,2})\\s+([A-Za-z]{3,9})\\.?,?\\s+(\\d{4})${TIME_TAIL}$`).exec(s)
  if (m && MONTHS[m[2]!.slice(0, 3).toLowerCase()]) return validDay(+m[3]!, MONTHS[m[2]!.slice(0, 3).toLowerCase()]!, +m[1]!)
  return null
}

/** `to_date`: a Nasdaq date string to "YYYY-MM-DD", or null when the cell carries no date. */
export function toDate(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const s = value.trim()
  if (!s || NA_VALUES.has(s)) return null
  return parseLooseDate(s)
}

// --- numbers ---------------------------------------------------------------------------------------------------

/** Python's `float(s)` for the plain decimal and exponent forms; null when it would raise. */
export function pyFloat(s: string): number | null {
  const t = s.trim()
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return null
  return Number(t)
}

/** `clean_value`: strips currency symbols, thousands separators and percent signs; placeholders become null. */
export function cleanValue(value: unknown): unknown {
  if (value === null || value === undefined || typeof value !== 'string') return value
  let cleaned = value.trim()
  if (NA_VALUES.has(cleaned)) return null
  cleaned = cleaned.replaceAll('$', '').replaceAll(',', '').replaceAll('%', '').trim()
  if (cleaned.startsWith('(') && cleaned.endsWith(')')) cleaned = `-${cleaned.slice(1, -1)}`
  return cleaned || null
}

/** `to_number`: a Nasdaq display string as a number, or null when the cell carries no value. */
export function toNumber(value: unknown): number | null {
  const cleaned = cleanValue(value)
  if (cleaned === null || cleaned === undefined) return null
  if (typeof cleaned === 'number') return cleaned
  if (typeof cleaned === 'boolean') return Number(cleaned)
  if (typeof cleaned !== 'string') return null
  return pyFloat(cleaned)
}

/** `to_percent`: '+3.53%' as 0.0353. */
export function toPercent(value: unknown): number | null {
  const n = toNumber(value)
  return n === null ? null : n / 100
}

/** Python's `round(x, ndigits)`: round half to even on the decimal expansion. */
export function pyRound(x: number, ndigits = 0): number {
  const f = 10 ** ndigits
  const y = x * f
  const r = Math.round(y)
  // exact halves go to the even neighbour
  const out = Math.abs(y - Math.trunc(y)) === 0.5 && r % 2 !== 0 ? r - 1 : r
  return out / f
}

// --- requests --------------------------------------------------------------------------------------------------

/**
 * Request an api.nasdaq.com path and unwrap the response envelope (`get_nasdaq_data`); throws when the envelope's
 * `rCode` is not 200.
 */
export async function getNasdaqData(ctx: NativeCtx, path: string): Promise<any> {
  const url = `${BASE_URL}/${path.replace(/^\/+/, '')}`
  const res = await ctx.http.response(url, { headers: jsonHeaders() })
  const text = await res.text()
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    body = undefined
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error(`Unexpected Nasdaq response for '${path}'.`)
  const status = ((body as Dict).status ?? {}) as Dict
  if (status.rCode !== 200) {
    const messages = status.bCodeMessage
    const detail = Array.isArray(messages) && messages.length ? (messages[0]?.errorMessage ?? '') : ''
    throw new Error(`Nasdaq request failed for '${path}'. ${detail}`.trim())
  }
  return (body as Dict).data
}

/** The row list from any of the Nasdaq table envelopes (`rows_from_table`). */
export function rowsFromTable(table: unknown): Dict[] {
  if (typeof table !== 'object' || table === null || Array.isArray(table)) return []
  const t = table as Dict
  if (Array.isArray(t.rows)) return t.rows
  const nested = t.table
  if (typeof nested === 'object' && nested !== null && Array.isArray((nested as Dict).rows)) return (nested as Dict).rows
  return []
}

// --- the listing directory -------------------------------------------------------------------------------------

/** The strings pandas reads as missing (`read_csv` defaults). */
const PANDAS_NA = new Set(['', '#N/A', '#N/A N/A', '#NA', '-1.#IND', '-1.#QNAN', '-NaN', '-nan', '1.#IND', '1.#QNAN', '<NA>', 'N/A', 'NA', 'NULL', 'NaN', 'None', 'n/a', 'nan', 'null'])

export type Cell = string | number | null

/**
 * `pandas.read_csv(StringIO(text), sep=...)` as records: pandas' missing-value strings become null (the symbol "NA"
 * included), and a column whose every present cell is a plain number becomes numeric.
 */
export function readPandasCsv(text: string, sep: string): { columns: string[]; rows: Record<string, Cell>[] } {
  const [header, ...raw] = parseCsv(text, sep)
  if (!header) return { columns: [], rows: [] }
  const columns = header
  const numeric = columns.map((_, i) => {
    let any = false
    for (const r of raw) {
      const v = r[i] ?? ''
      if (PANDAS_NA.has(v)) continue
      if (pyFloat(v) === null || /^[+-]?inf/i.test(v)) return false
      any = true
    }
    return any
  })
  const rows = raw.map((r) => {
    const row: Record<string, Cell> = {}
    columns.forEach((c, i) => {
      const v = r[i] ?? ''
      row[c] = PANDAS_NA.has(v) ? null : numeric[i] ? Number(v) : v
    })
    return row
  })
  return { columns, rows }
}

/** A Nasdaq symbol directory file ('nasdaqtraded', 'nasdaqlisted', 'otherlisted') as text (`get_nasdaq_directory`). */
export function getNasdaqDirectory(ctx: NativeCtx, listing = 'nasdaqtraded'): Promise<string> {
  return ctx.cache(`nasdaq:directory:${listing}`, DAY_MS, async () => {
    try {
      return await ctx.http.text(`${SYMBOL_DIRECTORY_FILES}/${listing}.txt`, { headers: { 'User-Agent': BROWSER_UA } })
    } catch (err) {
      throw new Error(`Failed to download the Nasdaq ${listing} directory.`, { cause: err })
    }
  })
}

/** The listing directory by symbol, mapping to 'stocks' or 'etf' (`_directory_index`); empty when unreachable. */
function directoryIndex(ctx: NativeCtx): Promise<Map<string, string>> {
  return ctx.cache('nasdaq:directory-index', DAY_MS, async () => {
    const out = new Map<string, string>()
    try {
      const text = await getNasdaqDirectory(ctx, 'nasdaqtraded')
      const { rows } = readPandasCsv(text, '|')
      for (const r of rows) {
        const symbol = r.Symbol
        if (String(r['Nasdaq Traded'] ?? '').startsWith('File Creation')) continue
        if (symbol === undefined || symbol === null) {
          // pandas turns the symbol 'NA' into a missing value; str(nan).upper() is 'NAN'
          if (!out.has('NAN')) out.set('NAN', String(r.ETF ?? '').trim() === 'Y' ? 'etf' : 'stocks')
          continue
        }
        out.set(String(symbol).toUpperCase(), String(r.ETF ?? '').trim() === 'Y' ? 'etf' : 'stocks')
      }
    } catch {
      return new Map<string, string>()
    }
    return out
  })
}

/**
 * Work out which Nasdaq asset class a symbol belongs to (`resolve_asset_class`): the listing directory settles stocks
 * versus ETFs; anything else is probed against the quote endpoint, once per symbol.
 */
export function resolveAssetClass(ctx: NativeCtx, symbol: string): Promise<string> {
  const ticker = symbol.trim().toUpperCase()
  return ctx.cache(`nasdaq:asset-class:${ticker}`, DAY_MS, async () => {
    const listing = (await directoryIndex(ctx)).get(ticker)
    if (listing !== undefined) return listing
    for (const assetClass of PROBE_ORDER) {
      try {
        await getNasdaqData(ctx, `quote/${ticker}/info?assetclass=${assetClass}`)
      } catch {
        continue
      }
      return assetClass
    }
    return 'stocks'
  })
}

// --- prices ----------------------------------------------------------------------------------------------------

export class EmptyDataError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EmptyDataError'
  }
}

/** The daily OHLCV history for one Nasdaq-quoted symbol (`get_historical_prices`), oldest first. */
export async function getHistoricalPrices(ctx: NativeCtx, symbol: string, assetClass: string, startDate?: string, endDate?: string, limit = 10000): Promise<Row[]> {
  const end = endDate || today(ctx)
  const start = startDate || addDays(end, -365)
  const data = await getNasdaqData(ctx, `quote/${symbol.toUpperCase()}/historical?assetclass=${assetClass}&fromdate=${start}&todate=${end}&limit=${limit}`)
  const rows = rowsFromTable((data ?? {}).tradesTable)
  if (!rows.length) throw new EmptyDataError(`No historical prices were found for ${symbol}.`)
  const results: Row[] = []
  for (const row of rows) {
    const session = toDate(row.date)
    if (session === null) continue
    results.push({ date: session, open: toNumber(row.open), high: toNumber(row.high), low: toNumber(row.low), close: toNumber(row.close), volume: toNumber(row.volume) })
  }
  return results.sort((a, b) => ((a.date as string) < (b.date as string) ? -1 : (a.date as string) > (b.date as string) ? 1 : 0))
}

/**
 * The daily history for one or more comma-separated symbols (`gather_historical_prices`). The `symbol` column is only
 * added when more than one symbol is requested.
 */
export async function gatherHistoricalPrices(ctx: NativeCtx, symbols: string, assetClass: string | null, startDate?: string, endDate?: string): Promise<Row[]> {
  const tickers = symbols
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
  const results: Row[] = []
  await Promise.all(
    tickers.map(async (ticker) => {
      let rows: Row[]
      try {
        rows = await getHistoricalPrices(ctx, ticker, assetClass || (await resolveAssetClass(ctx, ticker)), startDate, endDate)
      } catch (err) {
        ctx.log(`No historical prices were returned for ${ticker}. ${err instanceof Error ? err.message : String(err)}`)
        return
      }
      if (tickers.length > 1) for (const row of rows) row.symbol = ticker
      results.push(...rows)
    }),
  )
  if (!results.length) throw new EmptyDataError('No historical prices were returned for any symbol.')
  const symbolOf = (r: Row) => (r.symbol as string | undefined) ?? ''
  return results.sort((a, b) => ((a.date as string) < (b.date as string) ? -1 : (a.date as string) > (b.date as string) ? 1 : symbolOf(a) < symbolOf(b) ? -1 : symbolOf(a) > symbolOf(b) ? 1 : 0))
}

/** A light quote for many symbols in one request (`get_basic_quotes`), in the requested order. */
export async function getBasicQuotes(ctx: NativeCtx, symbols: readonly string[]): Promise<Dict[]> {
  const tickers = symbols.map((s) => s.trim().toUpperCase()).filter(Boolean)
  const assetClasses = await Promise.all(tickers.map((t) => resolveAssetClass(ctx, t)))
  const query = tickers.map((t, i) => `symbol=${t.toLowerCase()}%7C${assetClasses[i]}`).join('&')
  const data = await getNasdaqData(ctx, `quote/basic?${query}`)
  const records: Dict[] = (data ?? {}).records ?? []
  const bySymbol = new Map<string, Dict>()
  for (const r of records) bySymbol.set(String(r.key ?? '').split('|')[0]!.toUpperCase(), r)
  const results = tickers.filter((t) => bySymbol.has(t)).map((t) => bySymbol.get(t)!)
  if (!results.length) throw new EmptyDataError('No quotes were returned for any symbol.')
  return results
}

// --- option contracts ------------------------------------------------------------------------------------------

const DETAIL_FIELDS: Record<string, string> = {
  last_trade_price: 'LastSale',
  change: 'Net',
  high: 'DayHigh',
  low: 'DayLow',
  volume: 'Volume',
  prev_close: 'PrevClose',
  open: 'Open',
  open_interest: 'OpenInterest',
  tick: 'Tick',
  bid: 'Bid',
  ask: 'Ask',
  bid_size: 'BidSize',
  ask_size: 'AskSize',
  contract_high: 'ContractHigh',
  contract_low: 'ContractLow',
  exchange: 'Market',
}
const GREEK_FIELDS: Record<string, string> = { delta: 'Delta', gamma: 'Gamma', rho: 'Rho', theta: 'Theta', vega: 'Vega', implied_volatility: 'Impvol' }
const TEXT_FIELDS = new Set(['tick', 'exchange'])

/** The Nasdaq recordID of one option contract (`build_record_id`), e.g. 'NVDA--260807C00187500'. */
export function buildRecordId(symbol: string, expiration: string, strike: number, optionType: 'call' | 'put'): string {
  const side = optionType === 'call' ? 'C' : 'P'
  const strikePart = String(Math.trunc(pyRound(strike * 1000))).padStart(8, '0')
  return `${symbol.toUpperCase()}--${expiration.slice(2, 4)}${expiration.slice(5, 7)}${expiration.slice(8, 10)}${side}${strikePart}`
}

/** The full per-contract detail and greeks for one strike, both sides (`get_contract_detail`). */
export async function getContractDetail(ctx: NativeCtx, symbol: string, expiration: string, strike: number, assetClass = 'stocks'): Promise<Record<'call' | 'put', Dict | undefined>> {
  const recordId = buildRecordId(symbol, expiration, strike, 'call')
  const payload = await getNasdaqData(ctx, `quote/${symbol.toLowerCase()}/option-chain?assetclass=${assetClass}&recordID=${recordId}`)
  const sides: Record<'call' | 'put', Dict | undefined> = { call: undefined, put: undefined }
  for (const [side, key] of [['call', 'optionChainCallData'], ['put', 'optionChainPutData']] as const) {
    const block: Dict = (payload ?? {})[key] ?? {}
    const detail: Dict = block.optionChainListData ?? {}
    if (!Object.keys(detail).length) continue
    const fields: Dict = {}
    for (const [field, label] of Object.entries(DETAIL_FIELDS)) {
      const raw = (detail[label] ?? {}).value
      fields[field] = TEXT_FIELDS.has(field) ? raw : toNumber(raw)
    }
    const greeks: Dict = block.optionChainGreeksList ?? {}
    for (const [field, label] of Object.entries(GREEK_FIELDS)) fields[field] = toNumber((greeks[label] ?? {}).value)
    sides[side] = fields
  }
  return sides
}
