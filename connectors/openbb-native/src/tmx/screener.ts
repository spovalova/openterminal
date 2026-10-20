// equity/screener, provider tmx. Ported from openbb_tmx/models/equity_screener.py and utils/{mx,quotemedia,choices}.py
// (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of DataFrames and pydantic models, and the
// Montreal Exchange pages are read with the same regular expressions on the raw HTML.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { SCREENER_CHOICES } from './choices-data.js'
import { directoryRows, sortRows } from './directory.js'
import { QUOTE_FOR_SYMBOLS } from './gql.js'
import { applyAliases, boolParam, cached, compact, getText, gql, mapLimit, numParam, optFloat, QM_APP_URL, QM_WEBMASTER_ID, qmToken, strParam, TmxError, truthy, withoutRouteDefaults } from './helpers.js'

const MX = 'https://www.m-x.ca/'
const QUOTES_URL = 'https://www.m-x.ca/en/trading/data/quotes'
const SUMMARY_URL = 'https://www.m-x.ca/en/trading/data/intra-session-summary'
const SCREENER_TOOL = '5bce4b128f9078f167181cd08afb1d38aa34941e20629b8df36f902dfcf13fa0'
const SCREENER_SECTIONS = ['companyBasics', 'performance', 'keyRatios', 'dividends', 'profitability', 'trading', 'balanceSheet']
const SCREENER_BATCH = 100
const QUOTE_BATCH = 60

const DIRECTORY_SORT_FIELDS: Record<string, string> = { market_cap: 'marketCap', symbol: 'symbol', name: 'name', exchange: 'exchange' }

const RANGED_FIELDS: Record<string, string> = {
  market_cap: 'marketCapitalization',
  price: 'stockPrice',
  price_change: 'priceChange',
  dividend_yield: 'divYield',
  dividend_rate: 'divRate',
  dividend_growth_3y: 'divGrowthAvg3y',
  dividend_growth_5y: 'divGrowthAvg5y',
  pe_ratio: 'peRatio',
  ps_ratio: 'psRatio',
  pb_ratio: 'pbRatio',
  pcf_ratio: 'pcfRatio',
  book_value_per_share: 'bvps',
  current_ratio: 'currentRatio',
  quick_ratio: 'quickRatio',
  debt_to_equity: 'debtToEquityRatio',
  debt_to_capital: 'debtCapitalRatio',
  eps: 'latestFiscalEps',
  gross_margin: 'grossMargin',
  ebitda_margin: 'ebitdaMargin',
  ebit_margin: 'ebitMargin',
  return_on_assets: 'roa',
  return_on_equity: 'roe',
  return_on_capital: 'roc',
  revenue_per_share: 'revPs',
  revenue_ltm: 'revenueLtm',
  total_revenue: 'totalRevenue',
  free_cash_flow: 'freeCashFlow',
  employees: 'employees',
  book_value: 'bookValue',
  total_equity: 'totalEquity',
  total_assets: 'totalAssets',
  current_liabilities: 'currentLiabilities',
  current_assets: 'currentAssets',
  beta: 'beta',
  alpha: 'alpha',
  r_squared: 'r2',
  standard_deviation: 'stddev',
  volume: 'intradayVolume',
  volume_previous_day: 'yesterdaysVolume',
  volume_avg_10d: 'averageVolume10d',
  volume_avg_30d: 'averageVolume30d',
  volume_avg_50d: 'averageVolume50d',
  volume_avg_90d: 'averageVolume90d',
  trade_value_avg_90d: 'averageTradeValue90',
  insider_holdings: 'insiderHoldingPct',
  institutional_holdings: 'instHoldingPct',
  performance_7d: 'pricePerfomance7d',
  performance_30d: 'pricePerfomance30d',
  performance_90d: 'pricePerfomance90d',
  performance_ytd: 'pricePerfomanceYtd',
  change_52w: 'change52w',
  high_52w: 'high52weekPrice',
  low_52w: 'low52weekPrice',
  revenue_growth_3y: 'revenueGrowth3yr',
  revenue_growth_5y: 'revenueGrowth5yr',
  income_growth_3y: 'incomeGrowth3yr',
  income_growth_5y: 'incomeGrowth5yr',
}

const QUOTE_FIELDS: Record<string, string> = { price: 'price', volume: 'volume', openPrice: 'open', dayHigh: 'high', dayLow: 'low', prevClose: 'prev_close', weeks52high: 'high_52w', weeks52low: 'low_52w', currency: 'currency' }

const NATIVE_RANGES: Record<string, string> = Object.fromEntries(['market_cap', 'price', 'price_change', 'volume', 'open_interest', 'high_52w', 'low_52w'].map((f) => [f, f]))

const DEFAULT_SORTS: Record<string, string> = { Index: 'volume', Future: 'open_interest' }

const SCREENER_ALIASES: Record<string, string> = {
  primary_symbol: 'primarySymbol',
  filing_current: 'filingCurrent',
  market_cap: 'marketCapitalization',
  intraday_market_cap: 'intradayMarketCapitalization',
  price: 'stockPrice',
  intraday_price: 'intradayStockPrice',
  price_change: 'priceChange',
  high_52w: 'high52weekPrice',
  low_52w: 'low52weekPrice',
  above_52w_high: 'above52wHigh',
  below_52w_low: 'below52wLow',
  change_52w: 'change52w',
  performance_7d: 'pricePerfomance7d',
  performance_30d: 'pricePerfomance30d',
  performance_90d: 'pricePerfomance90d',
  performance_ytd: 'pricePerfomanceYtd',
  volume: 'intradayVolume',
  volume_previous_day: 'yesterdaysVolume',
  volume_avg_10d: 'averageVolume10d',
  volume_avg_30d: 'averageVolume30d',
  volume_avg_50d: 'averageVolume50d',
  volume_avg_90d: 'averageVolume90d',
  trade_value_avg_90d: 'averageTradeValue90',
  r_squared: 'r2',
  standard_deviation: 'stddev',
  insider_holdings: 'insiderHoldingPct',
  institutional_holdings: 'instHoldingPct',
  pe_ratio: 'peRatio',
  ps_ratio: 'psRatio',
  pb_ratio: 'pbRatio',
  pcf_ratio: 'pcfRatio',
  book_value_per_share: 'bvps',
  eps: 'latestFiscalEps',
  current_ratio: 'currentRatio',
  quick_ratio: 'quickRatio',
  debt_to_equity: 'debtToEquityRatio',
  debt_to_capital: 'debtCapitalRatio',
  gross_margin: 'grossMargin',
  ebitda_margin: 'ebitdaMargin',
  ebit_margin: 'ebitMargin',
  return_on_assets: 'roa',
  return_on_equity: 'roe',
  return_on_capital: 'roc',
  dividend_yield: 'divYield',
  dividend_rate: 'divRate',
  dividend_growth_3y: 'divGrowthAvg3y',
  dividend_growth_5y: 'divGrowthAvg5y',
  revenue_ltm: 'revenueLtm',
  total_revenue: 'totalRevenue',
  revenue_per_share: 'revPs',
  revenue_growth_3y: 'revenueGrowth3yr',
  revenue_growth_5y: 'revenueGrowth5yr',
  income_growth_3y: 'incomeGrowth3yr',
  income_growth_5y: 'incomeGrowth5yr',
  free_cash_flow: 'freeCashFlow',
  book_value: 'bookValue',
  total_assets: 'totalAssets',
  total_equity: 'totalEquity',
  current_assets: 'currentAssets',
  current_liabilities: 'currentLiabilities',
}

const SCREENER_BOOLS = ['primary_symbol', 'filing_current', 'optionable', 'above_52w_high', 'below_52w_low']
const SCREENER_NUMBERS = ['sector', 'market_cap', 'intraday_market_cap', 'price', 'settlement_price', 'intraday_price', 'open', 'high', 'low', 'prev_close', 'price_change', 'net_change', 'high_52w', 'low_52w', 'change_52w', 'performance_7d', 'performance_30d', 'performance_90d', 'performance_ytd', 'volume', 'open_interest', 'transactions', 'volume_previous_day', 'volume_avg_10d', 'volume_avg_30d', 'volume_avg_50d', 'volume_avg_90d', 'trade_value_avg_90d', 'beta', 'alpha', 'r_squared', 'standard_deviation', 'insider_holdings', 'institutional_holdings', 'pe_ratio', 'ps_ratio', 'pb_ratio', 'pcf_ratio', 'book_value_per_share', 'eps', 'current_ratio', 'quick_ratio', 'debt_to_equity', 'debt_to_capital', 'gross_margin', 'ebitda_margin', 'ebit_margin', 'return_on_assets', 'return_on_equity', 'return_on_capital', 'dividend_yield', 'dividend_rate', 'dividend_growth_3y', 'dividend_growth_5y', 'revenue_ltm', 'total_revenue', 'revenue_per_share', 'revenue_growth_3y', 'revenue_growth_5y', 'income_growth_3y', 'income_growth_5y', 'free_cash_flow', 'book_value', 'total_assets', 'total_equity', 'current_assets', 'current_liabilities', 'employees']

// ---------------------------------------------------------------------------------------------------------------------
// choices

function slugify(name: string): string {
  return name.replace(/[^0-9a-zA-Z]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase().replace(/_+/g, '_')
}

function choiceIndex(names: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const name of names) {
    const slug = slugify(name)
    let candidate = slug
    let n = 2
    while (out.has(candidate) && out.get(candidate) !== name) candidate = `${slug}_${n++}`
    out.set(candidate, name)
  }
  return out
}

const SCREENER_FIELDS: Record<string, string> = { sector: 'sectors', industry_group: 'industry_groups', industry: 'industries' }
const SCREENER_INDEX = Object.fromEntries(Object.entries(SCREENER_FIELDS).map(([field, group]) => [field, choiceIndex(Object.keys(SCREENER_CHOICES[group] ?? {}))]))

/** `screener_code`: the sector code a slug selects. */
function screenerCode(field: string, slug: string | undefined): string | undefined {
  if (!slug) return undefined
  const name = SCREENER_INDEX[field]?.get(slug)
  const code = name === undefined ? undefined : SCREENER_CHOICES[SCREENER_FIELDS[field]!]?.[name]
  return code === undefined ? undefined : String(code)
}

// ---------------------------------------------------------------------------------------------------------------------
// The query

type Query = {
  exchange?: string
  symbol_type?: string
  country?: string
  sector?: string
  industry_group?: string
  industry?: string
  optionable?: boolean
  primary_symbol?: boolean
  filing_current?: boolean
  above_52w_high?: boolean
  below_52w_low?: boolean
  sort_by: string
  sort_order: 'ASC' | 'DESC'
  fundamentals: boolean
  limit: number
  use_cache: boolean
  params: NativeParams
}

const EXCHANGES = ['TSX', 'TSXV', 'CSE', 'ALPHA', 'NEO-L', 'NEO-D', 'NEO-N', 'CMF', 'MOE'] as const
const SYMBOL_TYPES = ['Equity', 'ETF', 'Mutual Fund', 'Money Market Fund', 'Index', 'Future'] as const

function oneOfOpt<T extends string>(params: NativeParams, key: string, allowed: readonly T[]): T | undefined {
  const v = strParam(params, key)
  if (v === undefined) return undefined
  if (!(allowed as readonly string[]).includes(v)) throw new TmxError(`Input should be ${allowed.map((a) => `'${a}'`).join(', ')} (${key}: ${v})`)
  return v as T
}

const optBool = (params: NativeParams, key: string): boolean | undefined => {
  const v = params[key]
  if (v === undefined || v === null || v === '') return undefined
  return v === true || String(v).toLowerCase() === 'true'
}

/** `transform_query` and the query model's validation. */
function readQuery(rawParams: NativeParams): Query {
  // The route's defaults (exchange, sector and country "all", sort market_cap descending) are shared with other
  // providers; OpenBB drops a value equal to the route default, so TMX's own defaults apply.
  const params = withoutRouteDefaults(rawParams, { exchange: 'all', sector: 'all', country: 'all', sort_by: 'market_cap', sort_order: 'DESC', fundamentals: true, use_cache: true })
  const symbolType = oneOfOpt(params, 'symbol_type', SYMBOL_TYPES)
  const country = params.country === undefined ? 'CA' : oneOfOpt(params, 'country', ['CA', 'US', 'GB'] as const)
  const fundamentals = symbolType !== undefined && symbolType !== 'Equity' ? false : boolParam(params, 'fundamentals', true)
  let sortBy = strParam(params, 'sort_by')
  if (sortBy === undefined || sortBy === 'market_cap') sortBy = DEFAULT_SORTS[symbolType ?? ''] ?? 'market_cap'
  const query: Query = {
    sort_by: sortBy,
    sort_order: oneOf2(params, 'sort_order'),
    fundamentals,
    limit: numParam(params, 'limit') ?? 100,
    use_cache: boolParam(params, 'use_cache', true),
    params,
  }
  const set = <K extends keyof Query>(key: K, value: Query[K] | undefined): void => {
    if (value !== undefined) query[key] = value
  }
  set('exchange', oneOfOpt(params, 'exchange', EXCHANGES))
  set('symbol_type', symbolType)
  set('country', country)
  set('sector', strParam(params, 'sector'))
  set('industry_group', strParam(params, 'industry_group'))
  set('industry', strParam(params, 'industry'))
  for (const key of ['optionable', 'primary_symbol', 'filing_current', 'above_52w_high', 'below_52w_low'] as const) set(key, optBool(params, key))
  return query
}

function oneOf2(params: NativeParams, key: string): 'ASC' | 'DESC' {
  const v = strParam(params, key) ?? 'DESC'
  if (v !== 'ASC' && v !== 'DESC') throw new TmxError(`Input should be 'ASC' or 'DESC' (${key}: ${v})`)
  return v
}

const bound = (query: Query, name: string): number | undefined => numParam(query.params, name)

/** `_sector_prefix`. */
function sectorPrefix(query: Query): string | undefined {
  for (const field of ['industry', 'industry_group', 'sector'] as const) {
    const code = screenerCode(field, query[field])
    if (code) return code
  }
  return undefined
}

/** `_apply_fixed`: the true-or-false filters and the sector code. */
function applyFixed(rows: Row[], query: Query): Row[] {
  const flags: [keyof Query, string][] = [
    ['optionable', 'optionable'],
    ['primary_symbol', 'primarySymbol'],
    ['filing_current', 'filingCurrent'],
    ['above_52w_high', 'above52wHigh'],
    ['below_52w_low', 'below52wLow'],
  ]
  let out = rows
  for (const [field, source] of flags) {
    const wanted = query[field] as boolean | undefined
    if (wanted !== undefined) out = out.filter((r) => truthy(r[source]) === wanted)
  }
  const prefix = sectorPrefix(query)
  if (prefix) out = out.filter((r) => String(r.sector ?? '').startsWith(prefix))
  return out
}

/** `_apply_ranges`: every minimum and maximum the query carries. */
function applyRanges(rows: Row[], query: Query, sources: Record<string, string> = RANGED_FIELDS): Row[] {
  let out = rows
  for (const [field, source] of Object.entries(sources)) {
    const low = bound(query, `${field}_min`)
    const high = bound(query, `${field}_max`)
    if (low !== undefined) out = out.filter((r) => r[source] !== null && r[source] !== undefined && (r[source] as number) >= low)
    if (high !== undefined) out = out.filter((r) => r[source] !== null && r[source] !== undefined && (r[source] as number) <= high)
  }
  return out
}

/** `_ordered`: by the field the query sorts on, absent values last. */
function ordered(rows: Row[], query: Query, sources: Record<string, string>): Row[] {
  const key = sources[query.sort_by] ?? query.sort_by
  const ranked = rows.filter((r) => r[key] !== null && r[key] !== undefined)
  const desc = query.sort_order !== 'ASC'
  const sorted = ranked.map((r, i) => ({ r, i })).sort((a, b) => ((a.r[key] as number) < (b.r[key] as number) ? -1 : (a.r[key] as number) > (b.r[key] as number) ? 1 : 0) * (desc ? -1 : 1) || a.i - b.i).map((x) => x.r)
  return [...sorted, ...rows.filter((r) => r[key] === null || r[key] === undefined)]
}

// ---------------------------------------------------------------------------------------------------------------------
// The sources

/** `get_screener_equities`: the screener's fundamentals for a list of symbols, 100 per request. */
async function screenerEquities(ctx: NativeCtx, symbols: string[], country: string): Promise<Row[]> {
  const token = await qmToken(ctx, SCREENER_TOOL)
  const batches: string[][] = []
  for (let i = 0; i < symbols.length; i += SCREENER_BATCH) batches.push(symbols.slice(i, i + SCREENER_BATCH))
  const pages = await mapLimit(batches, 4, async (batch) => {
    const url = `${QM_APP_URL}/v2/screener/equities?country=${country}&module=datatool&webmaster_id=${QM_WEBMASTER_ID}&token=${token}&symbols=${batch.join(',')}`
    const response = await ctx.http.json<Row>(url, { headers: { Accept: '*/*', 'Accept-Language': 'en', Origin: 'https://money.tmx.com', Referer: 'https://money.tmx.com/' } })
    const equities = ((response?.results as Row | undefined)?.equities as Row[] | undefined) ?? []
    const out: Row[] = []
    for (const entry of equities) {
      const flat: Row = {}
      for (const section of SCREENER_SECTIONS) Object.assign(flat, (entry[section] as Row | undefined) ?? {})
      if (truthy(flat.symbol)) out.push(flat)
    }
    return out
  })
  return pages.flat()
}

/** `_quoted`: the delayed quote joined onto every instrument of the universe. */
async function quoted(ctx: NativeCtx, rows: Row[]): Promise<Row[]> {
  const symbols = rows.filter((r) => truthy(r.symbol)).map((r) => String(r.symbol))
  const batches: string[][] = []
  for (let i = 0; i < symbols.length; i += QUOTE_BATCH) batches.push(symbols.slice(i, i + QUOTE_BATCH))
  const pages = await mapLimit(batches, 8, async (symbolsBatch) => ((await gql<Row>(ctx, 'getQuoteForSymbols', QUOTE_FOR_SYMBOLS, { symbols: symbolsBatch }))?.getQuoteForSymbols as Row[] | undefined) ?? [])
  const quotes = new Map<string, Row>()
  for (const q of pages.flat()) if (truthy(q.symbol)) quotes.set(String(q.symbol), q)
  return rows.map((row) => {
    const quote = quotes.get(String(row.symbol)) ?? {}
    const change = quote.percentChange as number | null | undefined
    const entry: Row = {
      symbol: row.symbol,
      name: quote.longname || row.name,
      exchange: quote.exchange || row.exchangeShortName,
      country: row.countryCode,
      symbol_type: row.symbolType,
      price_change: change !== null && change !== undefined ? change / 100 : null,
      net_change: quote.priceChange ?? null,
    }
    for (const [source, field] of Object.entries(QUOTE_FIELDS)) entry[field] = quote[source] ?? null
    return entry
  })
}

// --- The Montreal Exchange futures --------------------------------------------------------------------------------

const SUMMARY_COLUMNS: Record<string, string> = {
  Open: 'open',
  High: 'high',
  Low: 'low',
  Last: 'price',
  Change: 'net_change',
  Volume: 'volume',
  'Open Interest': 'open_interest',
  Transactions: 'transactions',
  'Accrued Financing': 'accrued_financing',
  'CORRA Rate': 'corra_rate',
}
const SUMMARY_PRICES = ['open', 'high', 'low', 'price', 'accrued_financing']

const MONTH_CODES: Record<string, string> = { January: 'F', February: 'G', March: 'H', April: 'J', May: 'K', June: 'M', July: 'N', August: 'Q', September: 'U', October: 'V', November: 'X', December: 'Z' }

const INTEREST_RATE_PRODUCTS: Record<string, string> = {
  COA: 'One-Month CORRA Futures',
  CRA: 'Three-Month CORRA Futures',
  BCS: 'FTSE Canada Bank Credit Index Futures',
  CGZ: 'Two-Year Government of Canada Bond Futures',
  CGF: 'Five-Year Government of Canada Bond Futures',
  CGB: 'Ten-Year Government of Canada Bond Futures',
  LGB: 'Thirty-Year Government of Canada Bond Futures',
  OCR: 'Options on Three-Month CORRA Futures',
  OGZ: 'Options on Two-Year Government of Canada Bond Futures',
  OGF: 'Options on Five-Year Government of Canada Bond Futures',
  OGB: 'Options on Ten-Year Government of Canada Bond Futures',
}

const INDEX_PRODUCTS: Record<string, string> = {
  SXF: 'S&P/TSX 60 Index Standard Futures',
  SXM: 'S&P/TSX 60 Index Mini Futures',
  AXF: 'Adjusted Interest Rate S&P/TSX 60 Total Return Index Futures',
  SEG: 'S&P/TSX 60 ESG Index Futures',
  SCG: 'S&P/TSX Composite ESG Index Futures',
  SDV: 'S&P/TSX 60 Dividend Index Futures',
  SCF: 'S&P/TSX Composite Index Mini Futures',
  SXO: 'S&P/TSX 60 Index Standard Options',
  SXJ: 'Sector Index Options',
  SXV: 'Sector Index Options',
  SXA: 'S&P/TSX Global Gold Index Futures',
  SXB: 'S&P/TSX Capped Financials Index Futures',
  SXD: 'S&P/TSX Composite Energy GICS Sector Total Return Index Futures',
  SXG: 'S&P/TSX Composite Financials GICS Level Sector Total Return Index Futures',
  SXH: 'S&P/TSX Capped Information Technology Index Futures',
  SXK: 'S&P/TSX Composite Index Banks (Industry Group) Futures',
  SXR: 'S&P/TSX Composite Real Estate GICS Sector Total Return Index Futures',
  SXT: 'S&P/TSX Composite Telecom Services GICS Level Sector Total Return Index Futures',
  SXU: 'S&P/TSX Capped Utilities Index Futures',
  SXW: 'S&P/TSX Composite Insurance GICS Industry Group Total Return Index Futures',
  SXY: 'S&P/TSX Capped Energy Index Futures',
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

/** `_plain`: the readable text of a markup fragment. */
function plain(html: string): string {
  const text = html.replace(/<[^>]+>/g, '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e.startsWith('#x')) return String.fromCodePoint(parseInt(e.slice(2), 16))
    if (e.startsWith('#')) return String.fromCodePoint(Number(e.slice(1)))
    return ENTITIES[e.toLowerCase()] ?? m
  })
  return text.replace(/\s+/g, ' ').trim()
}

function summaryValue(value: string | undefined, field: string): number | null {
  if (value === undefined) return null
  const number = Number(value)
  if (value.trim() === '' || Number.isNaN(number)) return null
  return number === 0 && SUMMARY_PRICES.includes(field) ? null : number
}

function summaryProduct(title: string, roots: string[]): { section: string; names: Record<string, string> } {
  const product = title.replace(/\s*\([A-Z0-9]{2,4}(?:,\s*[A-Z0-9]{2,4})*\)\s*$/, '')
  if (roots.length === 1) return { section: product, names: { [roots[0]!]: product } }
  return { section: product, names: Object.fromEntries(roots.map((root) => [root, INDEX_PRODUCTS[root] || INTEREST_RATE_PRODUCTS[root] || product])) }
}

function summaryRows(headers: string[], body: string, product: { section: string; names: Record<string, string> }): Row[] {
  const contract = /symbol=([A-Z0-9]+)\*?#([A-Z]+)([FGHJKMNQUVXZ])(\d{2})"/
  const results: Row[] = []
  for (const rowMatch of body.matchAll(/<tr[^>]*>(.*?)<\/tr>/gs)) {
    const cells = [...rowMatch[1]!.matchAll(/<td([^>]*)>(.*?)<\/td>/gs)].map((m) => [m[1]!, m[2]!] as const)
    if (cells.length !== headers.length) continue
    const order = /data-order="([^"]*)"/.exec(cells[0]![0])
    const listed = contract.exec(cells[0]![1])
    let entry: Row
    let root: string
    if (headers[0] === 'Month') {
      if (!listed) continue
      root = listed[1]!
      const month = listed[3]!
      const year = listed[4]!
      entry = { symbol: `/${root}${month}${year.slice(-1)}`, contract: `${root}${month}${year}`, root, expiration: order ? order[1] : null }
    } else {
      root = plain(cells[0]![1])
      if (!root) continue
      entry = { symbol: `/${root}`, contract: null, root }
    }
    entry.name = product.names[root] || product.section
    entry.exchange = 'MOE'
    headers.slice(1).forEach((header, i) => {
      const field = SUMMARY_COLUMNS[header]
      if (!field) return
      const found = /data-order="([^"]*)"/.exec(cells[i + 1]![0])
      entry[field] = summaryValue(found ? found[1] : undefined, field)
    })
    if ('net_change' in entry && (entry.price === null || entry.price === undefined)) entry.net_change = null
    results.push(entry)
  }
  return results
}

/** `_parse_summary`: every product the intra-session summary reports. */
function parseSummary(html: string): Row[] {
  const section = /<li id="[^"]+"[^>]*>\s*<a href="#[^"]*">\s*(.*?)(?:<span class="session">.*?<\/span>)?\s*<\/a>(.*?)<\/li>/gs
  const results: Row[] = []
  const start = html.indexOf('Intra-Session Summary')
  for (const m of html.slice(start).matchAll(section)) {
    const title = m[1]!
    const content = m[2]!
    const head = /<thead>(.*?)<\/thead>/s.exec(content)
    if (!head || [...head[1]!.matchAll(/<tr[^>]*>/g)].length !== 1) continue
    const headers = [...head[1]!.matchAll(/<th[^>]*>(.*?)<\/th>/gs)].map((h) => plain(h[1]!))
    if (headers.length === 0 || !['Month', 'Symbol'].includes(headers[0]!)) continue
    const heading = plain(title)
    const named = /\(([A-Z0-9, ]+)\)\s*$/.exec(heading)
    const product = summaryProduct(heading, named ? named[1]!.split(',').map((r) => r.trim()) : [])
    for (const body of content.matchAll(/<tbody[^>]*>(.*?)<\/tbody>/gs)) results.push(...summaryRows(headers, body[1]!, product))
  }
  return results
}

/** `get_futures_summary`: every future listed on the Montreal Exchange with its session. */
async function futuresSummary(ctx: NativeCtx, useCache: boolean): Promise<Row[]> {
  return cached(ctx, useCache, 'tmx:mx-futures-summary', 5 * 60 * 1000, async () => {
    const results = parseSummary((await getText(ctx, SUMMARY_URL, MX)) || '')
    if (results.length === 0) throw new TmxError('The Montreal Exchange session summary came back empty.')
    return results
  })
}

function settlementValue(value: string): number | null {
  const n = Number(value.replaceAll(',', ''))
  if (value.trim() === '' || Number.isNaN(n)) return null
  return n || null
}

function contractSymbol(root: string, month: string): string | null {
  const parts = month.split(/\s+/).filter(Boolean)
  if (parts.length !== 2 || !(parts[0]! in MONTH_CODES)) return null
  return `/${root}${MONTH_CODES[parts[0]!]}${parts[1]!.slice(-1)}`
}

/** `_parse_quotes`: the settlement price of every month one product lists. */
function parseQuotes(html: string, root: string): Record<string, number> {
  const results: Record<string, number> = {}
  for (const t of html.matchAll(/<table[^>]*>(.*?)<\/table>/gs)) {
    const table = t[1]!
    const head = /<thead>(.*?)<\/thead>/s.exec(table)
    if (!head) continue
    const headers = [...head[1]!.matchAll(/<th[^>]*>(.*?)<\/th>/gs)].map((h) => plain(h[1]!))
    const column = headers.indexOf('Settl. price')
    if (column < 0) continue
    for (const r of table.matchAll(/<tr[^>]*>(.*?)<\/tr>/gs)) {
      const cells = [...r[1]!.matchAll(/<td[^>]*>(.*?)<\/td>/gs)].map((c) => plain(c[1]!))
      if (cells.length !== headers.length) continue
      const price = settlementValue(cells[column]!)
      if (price === null) continue
      const symbol = contractSymbol(root, cells[0]!)
      if (symbol && !(symbol in results)) results[symbol] = price
      if (!(`/${root}` in results)) results[`/${root}`] = price
    }
  }
  return results
}

/** `get_settlement_prices`: the settlement of every contract the named products list. */
async function settlementPrices(ctx: NativeCtx, roots: string[], useCache: boolean): Promise<Record<string, number>> {
  const pages = await mapLimit([...new Set(roots)].sort(), 10, async (root) => {
    try {
      return await cached(ctx, useCache, `tmx:mx-settlements:${root}`, 3600 * 1000, async () => parseQuotes(await getText(ctx, `${QUOTES_URL}?symbol=${root}`, MX), root))
    } catch {
      return {} as Record<string, number>
    }
  })
  return Object.assign({}, ...pages)
}

async function listedFutures(ctx: NativeCtx, query: Query): Promise<Row[]> {
  if ((query.exchange !== undefined && query.exchange !== 'MOE') || (query.country !== undefined && query.country !== 'CA')) return []
  return (await futuresSummary(ctx, query.use_cache)).map((row) => ({
    symbol: row.symbol,
    name: row.name,
    exchange: row.exchange,
    country: 'CA',
    symbol_type: 'Future',
    root: row.root,
    expiration: row.expiration,
    price: row.price,
    open: row.open,
    high: row.high,
    low: row.low,
    net_change: row.net_change,
    volume: row.volume,
    open_interest: row.open_interest,
    transactions: row.transactions,
  }))
}

async function settled(ctx: NativeCtx, rows: Row[], useCache: boolean): Promise<Row[]> {
  const roots = [...new Set(rows.filter((r) => truthy(r.root)).map((r) => String(r.root)))]
  if (roots.length === 0) return rows
  const prices = await settlementPrices(ctx, roots, useCache)
  for (const row of rows) row.settlement_price = prices[String(row.symbol)] ?? null
  return rows
}

// ---------------------------------------------------------------------------------------------------------------------

/** equity/screener. */
export async function equityScreener(rawParams: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const query = readQuery(rawParams)
  const data = await screen(ctx, query)
  return data.map((d) => {
    const excluded = new Set(['symbol', 'name', 'exchange', 'exchangeShortName', 'country', 'countryCode', 'symbolType', 'marketCap', 'marketCapitalization', 'optionable', 'root'])
    const kept: Row = {}
    for (const [k, v] of Object.entries(d)) if (!excluded.has(k)) kept[k] = v
    const merged: Row = {
      ...kept,
      symbol: d.symbol,
      name: d.name,
      exchange: d.exchange || d.exchangeShortName,
      country: d.country || d.countryCode,
      symbol_type: d.symbol_type || d.symbolType,
      market_cap: d.marketCapitalization || d.marketCap,
      optionable: d.optionable,
    }
    const row = applyAliases(merged, SCREENER_ALIASES)
    for (const k of SCREENER_NUMBERS) if (k in row) row[k] = optFloat(row[k]) ?? null
    for (const k of SCREENER_BOOLS) if (k in row && row[k] !== null && row[k] !== undefined) row[k] = row[k] === true || row[k] === 1 || row[k] === 'true'
    return compact(row)
  })
}

async function screen(ctx: NativeCtx, query: Query): Promise<Row[]> {
  if (query.symbol_type === 'Future') {
    const rows = applyRanges(await listedFutures(ctx, query), query, NATIVE_RANGES)
    if (rows.length === 0) return []
    return settled(ctx, ordered(rows, query, NATIVE_RANGES).slice(0, query.limit), query.use_cache)
  }

  let frame = await directoryRows(ctx, query.country, query.symbol_type ? [query.symbol_type] : undefined, query.exchange ? [query.exchange] : undefined, query.use_cache)
  const capMin = bound(query, 'market_cap_min')
  const capMax = bound(query, 'market_cap_max')
  if (capMin !== undefined) frame = frame.filter((r) => typeof r.marketCap === 'number' && r.marketCap >= capMin)
  if (capMax !== undefined) frame = frame.filter((r) => typeof r.marketCap === 'number' && r.marketCap <= capMax)
  if (query.optionable !== undefined) frame = frame.filter((r) => r.optionable === query.optionable)
  if (frame.length === 0) return []

  frame = sortRows(frame, DIRECTORY_SORT_FIELDS[query.sort_by] ?? 'marketCap', query.sort_order === 'ASC')

  if (query.symbol_type === 'Index') {
    const rows = applyRanges(await quoted(ctx, frame), query, NATIVE_RANGES)
    if (rows.length === 0) return []
    return ordered(rows, query, NATIVE_RANGES).slice(0, query.limit)
  }
  if (!query.fundamentals) return frame.slice(0, query.limit)

  const universe = frame.map((r) => String(r.symbol)).filter((s) => !s.includes(':')).slice(0, Math.max(query.limit * 6, 300))
  let rows = await screenerEquities(ctx, universe, (query.country ?? 'CA').toUpperCase())
  rows = applyFixed(rows, query)
  rows = applyRanges(rows, query)
  if (rows.length === 0) return []
  if (query.sort_by) {
    const key = RANGED_FIELDS[query.sort_by] ?? query.sort_by
    const desc = query.sort_order !== 'ASC'
    // key=(value is None, value) with reverse for DESC: missing values come first when descending.
    const cmp = (a: Row, b: Row): number => {
      const am = a[key] === null || a[key] === undefined
      const bm = b[key] === null || b[key] === undefined
      if (am !== bm) return am ? 1 : -1
      if (am && bm) return 0
      return (a[key] as number) < (b[key] as number) ? -1 : (a[key] as number) > (b[key] as number) ? 1 : 0
    }
    rows = rows.map((r, i) => ({ r, i })).sort((x, y) => (desc ? -cmp(x.r, y.r) : cmp(x.r, y.r)) || x.i - y.i).map((x) => x.r)
  }
  return rows.slice(0, query.limit)
}

