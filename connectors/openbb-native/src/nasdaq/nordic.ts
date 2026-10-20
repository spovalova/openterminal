// nasdaq/nordic/{screener,historical,historical_trades,movers,knocked_out,bond_yields,index_factors,mortgage_rates,
// trading_hours,holidays,news}, provider nasdaq. Ported from openbb_nasdaq/models/nordic_*.py and
// openbb_nasdaq/utils/{nordic,schedule,translations}.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead
// of pydantic models, and a symbol is resolved by walking the Nordic listings in the directory's order until one claims it
// instead of indexing every listing first (the first listing to claim a symbol wins in both).
import { NativeUnsupported, type NativeCtx, type NativeParams, type Row } from '../types.js'
import { addDays, cleanValue, compact, getNasdaqData, htmlUnescape, jsonHeaders, rowsFromTable, textHeaders, today, toDate, toNumber, toPercent, truthy, type Dict } from './helpers.js'

const NORDIC_NEWS_URL = 'https://api.news.eu.nasdaq.com/news/query.action'
const TRADING_HOURS_URL = 'https://www.nasdaq.com/european-market-activity/trading-hours'

const NORDIC_PATHS: Record<string, string> = {
  shares: 'shares',
  indexes: 'indexes',
  funds: 'funds',
  etf: 'etp',
  etn_etc: 'etp',
  aif: 'etp',
  amf: 'etp',
  options: 'options',
  custom_basket_forwards: 'custom-basket-forwards',
  corporate_bonds: 'corporate-bonds',
  government_bonds: 'government-bonds',
  mortgage_bonds: 'mortgage-bonds',
  sustainable_debt: 'sustainable-debt',
  fi_derivatives: 'fi-derivatives',
  structured_products: 'structured-products',
  warrants: 'warrants-certificates',
  certificates: 'warrants-certificates',
  leverage_certificates: 'warrants-certificates',
  tracker_certificates: 'warrants-certificates',
}

const NORDIC_MARKET_KEYS: Record<string, string> = {
  main_market: 'MAIN_MARKET',
  first_north: 'FIRST_NORTH',
  other_instruments: 'OTHERS',
  sweden: 'STO_MM',
  denmark: 'CPH_MM',
  finland: 'HEL_MM',
  iceland: 'ICE_MM',
}

const SHARE_MARKETS = ['main_market', 'first_north', 'other_instruments']
const COUNTRY_MARKETS = ['sweden', 'denmark', 'finland', 'iceland']
const MORTGAGE_MARKETS = ['denmark', 'sweden', 'iceland']
const FI_DERIVATIVE_MARKETS = ['denmark', 'sweden']

const NORDIC_CATEGORIES: Record<string, string[]> = {
  shares: SHARE_MARKETS,
  corporate_bonds: COUNTRY_MARKETS,
  government_bonds: COUNTRY_MARKETS,
  mortgage_bonds: MORTGAGE_MARKETS,
  sustainable_debt: COUNTRY_MARKETS,
  fi_derivatives: FI_DERIVATIVE_MARKETS,
  structured_products: COUNTRY_MARKETS,
}

const NORDIC_FIXED_CATEGORIES: Record<string, string> = {
  warrants: 'WARRANTS',
  certificates: 'CERTIFICATES',
  leverage_certificates: 'LEVERAGE_CERTIFICATES',
  tracker_certificates: 'TRACKER_CERTIFICATES',
  etf: 'ETF',
  etn_etc: 'ETN/ETC',
  aif: 'AIF',
  amf: 'AMF',
}

/** The index listing is segmented by `market` and serves one group at a time. */
const NORDIC_INDEX_MARKETS = ['NOK_ALL', 'NOK_SH_IN', 'NOK_SC_IN', 'CPH_SH_IN', 'CPH_SC_IN', 'STO_SH_IN', 'STO_SC_IN', 'STO_FI_IN', 'HEL_SH_IN', 'HEL_SC_IN', 'ICE_SH_IN', 'ICE_SC_IN', 'ICE_FI_IN', 'FS_NT_IDXS', 'OSL', 'VINX_SH_IN', 'VINX_SC_IN_IND', 'VINX_SC_IN_SUS', 'CSTM_IDXS']

const NORDIC_PROBE_ORDER = ['shares', 'indexes', 'funds', 'etf', 'etn_etc', 'aif', 'amf', 'options', 'custom_basket_forwards', 'corporate_bonds', 'government_bonds', 'mortgage_bonds', 'sustainable_debt', 'fi_derivatives', 'structured_products', 'warrants', 'certificates', 'leverage_certificates', 'tracker_certificates']

const NORDIC_NEWS_MARKET_KEYS: Record<string, string> = {
  all: 'NordicAllMarkets',
  stockholm: 'Stockholm',
  copenhagen: 'Copenhagen',
  helsinki: 'Helsinki',
  iceland: 'Iceland',
  baltic: 'Baltic',
  first_north: 'FirstNorth',
}

const NORDIC_NUMBER_FIELDS: Record<string, string> = {
  last_price: 'lastSalePrice',
  change: 'netChange',
  bid: 'bidPrice',
  ask: 'askPrice',
  high: 'high',
  low: 'low',
  volume: 'volume',
  reported_volume: 'reportedVolume',
  total_volume: 'totalVolume',
  turnover: 'turnover',
  trades_count: 'tradesCount',
  net_asset_value: 'netAssetValue',
  average_price: 'allTradesAvgPrice',
  settlement_price: 'settlementPrice',
  coupon_rate: 'couponRate',
  strike: 'strikePrice',
  contract_size: 'contractSize',
  open_interest: 'openInterest',
  basket_value: 'basketValue',
  theoretical_price: 'theoreticalPrice',
  deferral_threshold: 'deferralThreshold',
}

const NORDIC_TEXT_FIELDS: Record<string, string> = {
  name: 'fullName',
  isin: 'isin',
  currency: 'currency',
  sector: 'sector',
  issuer: 'issuerFullName',
  orderbook_id: 'orderbookId',
  mic_code: 'micCode',
  price_notation: 'priceNotation',
  note_code: 'noteCode',
  note_description: 'noteDescription',
  instrument_type: 'type',
  exchange_symbol: 'exchangeSymbol',
  green_equity_designation: 'greenEquityDesignation',
}

const NORDIC_TRADE_FIELDS: Record<string, string> = {
  price: 'price',
  volume: 'volume',
  buyer: 'buyer',
  seller: 'seller',
  trade_type: 'tradeType',
  market: 'market',
  mmt_flag: 'mmtFlag',
  orderbook: 'orderbook',
  cancelled: 'cancelled',
  agreement_time: 'agreementTime',
}

const NORDIC_PRICE_FIELDS: Record<string, string> = {
  high: 'high',
  low: 'low',
  close: 'close',
  average_price: 'atap',
  volume: 'totalVolume',
  turnover: 'turnover',
  duration: 'duration',
  yield_to_maturity: 'yield',
  yield_calculation_price: 'ycp',
  reference_price: 'priceAPA',
  consolidated_volume: 'volumeAPA',
  consolidated_turnover: 'turnoverAPA',
}

const NORDIC_MOVER_GROUPS: Record<string, string> = { shares: 'SHARES', options_futures: 'OPTIONS_FUTURES', etp: 'ETP', funds: 'FUNDS', indexes: 'INDEXES', warrants_certificates: 'WARRANTS_CERTIFICATES' }

const KNOCKED_OUT_STATES: Record<string, string> = { buyback: 'BUYBACK', trading_halt: 'TRADING_HALT' }
const BASIS: Record<string, string> = { before_tax: 'beforeTax', after_tax: 'afterTax' }

const DIRECTORY_PAGE_SIZE = 1000
const DIRECTORY_ATTEMPTS = 3
const DIRECTORY_BACKOFF_MS = 500

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** The rows of a Nordic screener page: under `instrumentListing`, or at the top level for the custom basket listing. */
const pageRows = (payload: Dict): Dict[] => {
  const listing: Dict = payload.instrumentListing ?? {}
  return (truthy(listing.rows) ? listing.rows : payload.rows) ?? []
}

// --- the instrument directory ----------------------------------------------------------------------------------

type Instrument = { orderbook_id: string; asset_class: string; listing: string; name?: string; isin?: string }

/** Every `(listing, path, filter)` a listing is fetched by. */
function directoryRequests(listing: string): [string, string][] {
  const path = NORDIC_PATHS[listing]!
  const fixed = NORDIC_FIXED_CATEGORIES[listing]
  const markets = NORDIC_CATEGORIES[listing]
  if (listing === 'indexes') return NORDIC_INDEX_MARKETS.map((group) => [path, `&market=${group}`])
  if (markets) return markets.map((market) => [path, `&category=${NORDIC_MARKET_KEYS[market]}`])
  return [[path, fixed ? `&category=${fixed}` : '']]
}

/** One page of a listing and its page count; a page that comes back empty when the listing claims more is retried. */
async function directoryPage(ctx: NativeCtx, path: string, query: string, page: number): Promise<[Dict[], number]> {
  const url = `nordic/screener/${path}?tableonly=true&lang=en&size=${DIRECTORY_PAGE_SIZE}&page=${page}${query}`
  for (let attempt = 0; attempt < DIRECTORY_ATTEMPTS; attempt++) {
    let data: Dict
    try {
      data = (await getNasdaqData(ctx, url)) ?? {}
    } catch (err) {
      if (attempt === DIRECTORY_ATTEMPTS - 1) throw err
      await ctx.sleep(DIRECTORY_BACKOFF_MS * (attempt + 1))
      continue
    }
    const rows = pageRows(data)
    const pages = Math.trunc(Number((data.pagination ?? {}).totalPages || 1))
    if (rows.length || page === 1 || attempt === DIRECTORY_ATTEMPTS - 1) return [rows, pages]
    await ctx.sleep(DIRECTORY_BACKOFF_MS * (attempt + 1))
  }
  return [[], 1]
}

/** Resolve a Nasdaq Nordic symbol to its orderbook id and asset class (`resolve_nordic_instrument`). */
async function resolveNordicInstrument(ctx: NativeCtx, symbol: string): Promise<Instrument> {
  const wanted = symbol.trim().toUpperCase()
  return ctx.cache(`nasdaq:nordic:${wanted}`, 24 * 3600 * 1000, async () => {
    for (const listing of NORDIC_PROBE_ORDER) {
      for (const [path, query] of directoryRequests(listing)) {
        let rows: Dict[]
        let pages: number
        try {
          ;[rows, pages] = await directoryPage(ctx, path, query, 1)
        } catch {
          continue
        }
        const rest: Dict[][] = []
        for (let page = 2; page <= pages; page++) {
          try {
            rest.push((await directoryPage(ctx, path, query, page))[0])
          } catch {
            // a refused page is left out of the directory
          }
        }
        for (const row of [rows, ...rest].flat()) {
          if (row.symbol && row.symbol === wanted) {
            const found: Instrument = { orderbook_id: row.orderbookId, asset_class: row.assetClass, listing }
            if (row.fullName) found.name = row.fullName
            if (row.isin) found.isin = row.isin
            return found
          }
        }
      }
    }
    throw new Error(`'${symbol}' was not found in the Nasdaq Nordic instrument directory.`)
  })
}

// --- screener --------------------------------------------------------------------------------------------------

const PAGE_SIZE = 500

export async function nordicScreener(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const assetClass = String(params.asset_class ?? 'shares')
  const path = NORDIC_PATHS[assetClass]
  if (path === undefined) throw new NativeUnsupported(`nasdaq has no Nordic ${assetClass} listing`)
  const markets = NORDIC_CATEGORIES[assetClass]
  let category: string | undefined = NORDIC_FIXED_CATEGORIES[assetClass]
  if (markets) {
    const market = (params.market === undefined ? undefined : String(params.market)) || markets[0]!
    if (!markets.includes(market)) throw new Error(`'${market}' is not a market for '${assetClass}'. Choose one of: ${markets.join(', ')}.`)
    category = NORDIC_MARKET_KEYS[market]
  }
  const suffix = category ? `&category=${category}` : ''
  const base = `nordic/screener/${path}?tableonly=false&lang=en&size=${PAGE_SIZE}`
  const first: Dict = (await getNasdaqData(ctx, `${base}&page=1${suffix}`)) ?? {}
  const rows = [...pageRows(first)]
  const totalPages = Math.trunc(Number((first.pagination ?? {}).totalPages || 1))
  if (totalPages > 1) {
    const pages = await Promise.all(Array.from({ length: totalPages - 1 }, (_, i) => i + 2).map(async (page) => pageRows((await getNasdaqData(ctx, `${base}&page=${page}${suffix}`)) ?? {})))
    for (const p of pages) rows.push(...p)
  }
  if (!rows.length) return [] // EmptyDataError
  return rows.map((row) => {
    const record: Dict = {
      symbol: row.symbol,
      asset_class: row.assetClass,
      change_percent: toPercent(row.percentageChange),
      total_expense_ratio: toPercent(row.totalExpenseRatio),
      expiration: toDate(row.expirationDate),
      last_traded: toDate(row.lastTraded),
    }
    for (const [field, key] of Object.entries(NORDIC_TEXT_FIELDS)) record[field] = cleanValue(row[key])
    for (const [field, key] of Object.entries(NORDIC_NUMBER_FIELDS)) record[field] = toNumber(row[key])
    record.coupon_rate = toPercent(row.couponRate)
    return compact(record)
  })
}

// --- historical ------------------------------------------------------------------------------------------------

export async function nordicHistorical(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const symbolParam = String(params.symbol ?? '')
  if (!symbolParam) throw new Error('symbol is required')
  const end = (params.end_date as string | undefined) ?? today(ctx)
  const start = (params.start_date as string | undefined) ?? addDays(end, -365)
  const instrument = await resolveNordicInstrument(ctx, symbolParam)
  const data = await getNasdaqData(ctx, `nordic/instruments/${instrument.orderbook_id}/price-history?assetClass=${instrument.asset_class}&lang=en&fromDate=${start}&toDate=${end}`)
  const rows = rowsFromTable((data ?? {}).priceHistory)
  if (!rows.length) return [] // EmptyDataError
  const symbol = symbolParam.toUpperCase()
  const results: Row[] = []
  for (const row of rows) {
    const stamped = toDate(row.date)
    if (stamped === null) continue
    const record: Dict = { date: stamped, symbol }
    for (const [field, key] of Object.entries(NORDIC_PRICE_FIELDS)) record[field] = toNumber(row[key])
    record.yield_to_maturity = toPercent(row.yield)
    results.push(compact(record))
  }
  return results.sort((a, b) => cmp(a.date as string, b.date as string))
}

// --- historical trades -----------------------------------------------------------------------------------------

/** A trade timestamp such as '2026-07-23 10:12:54' as a naive ISO datetime. */
function parseTime(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value.trim())
  if (!m) return null
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!))
  if (d.getUTCFullYear() !== +m[1]! || d.getUTCMonth() !== +m[2]! - 1 || d.getUTCDate() !== +m[3]! || d.getUTCHours() !== +m[4]! || d.getUTCMinutes() !== +m[5]!) return null
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`
}

export async function nordicHistoricalTrades(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const symbolParam = String(params.symbol ?? '')
  if (!symbolParam) throw new Error('symbol is required')
  const end = (params.end_date as string | undefined) ?? today(ctx)
  const start = (params.start_date as string | undefined) ?? addDays(end, -3 * 30)
  const instrument = await resolveNordicInstrument(ctx, symbolParam)
  const data = await getNasdaqData(ctx, `nordic/instruments/${instrument.orderbook_id}/trade-history?assetClass=${instrument.asset_class}&type=TABLE_VIEW&lang=en&fromDate=${start}&toDate=${end}`)
  const rows = rowsFromTable((data ?? {}).trades)
  if (!rows.length) return [] // EmptyDataError
  const results: Row[] = []
  for (const row of rows) {
    const stamped = parseTime(row.time)
    if (stamped === null) continue
    const record: Dict = { date: stamped, symbol: truthy(row.name) ? row.name : symbolParam.toUpperCase() }
    for (const [field, key] of Object.entries(NORDIC_TRADE_FIELDS)) record[field] = field === 'price' || field === 'volume' ? toNumber(row[key]) : cleanValue(row[key])
    results.push(compact(record))
  }
  return results.sort((a, b) => cmp(a.date as string, b.date as string))
}

// --- movers, knocked out ---------------------------------------------------------------------------------------

export async function nordicMovers(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const group = String(params.asset_group ?? 'shares')
  const key = NORDIC_MOVER_GROUPS[group]
  if (key === undefined) throw new NativeUnsupported(`nasdaq has no Nordic movers group ${group}`)
  const limit = typeof params.limit === 'number' ? params.limit : 15
  const data = await getNasdaqData(ctx, `nordic/market-movers?assetGroup=${key}&returnMovers=TOP_TRADED&size=${limit}&lang=en`)
  const block: Dict = ((data ?? {}).marketMovers ?? {}).TOP_TRADED ?? {}
  const rows: Dict[] = block.rows ?? []
  if (!rows.length) return [] // EmptyDataError
  return rows.map((row) =>
    compact({
      symbol: row.symbol,
      name: row.fullName,
      isin: row.isin,
      asset_class: row.assetClass,
      currency: cleanValue(row.ccy),
      last_price: toNumber(row.lastSalePrice),
      change: toNumber(row.netChange),
      change_percent: toPercent(row.percentageChange),
      bid: toNumber(row.bidPrice),
      ask: toNumber(row.askPrice),
      volume: toNumber(row.volume),
      volume_change_percent: toPercent(row.volumePercentageChange),
      turnover: toNumber(row.turnover),
      turnover_eur: toNumber(row.turnoverEUR),
      trades_count: toNumber(row.numTrades),
      contract_size: toNumber(row.contractSize),
      expiration: toDate(row.expiryDate),
      orderbook_id: row.orderbookId,
    }),
  )
}

export async function nordicKnockedOut(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const state = String(params.state ?? 'buyback')
  const key = KNOCKED_OUT_STATES[state]
  if (key === undefined) throw new NativeUnsupported(`nasdaq has no knocked-out state ${state}`)
  const data = await getNasdaqData(ctx, `nordic/screener/knocked-out?tableonly=true&lang=en&size=1000&page=1&category=${key}`)
  const rows: Dict[] = ((data ?? {}).instrumentListing ?? {}).rows ?? []
  if (!rows.length) return [] // EmptyDataError
  return rows.map((row) =>
    compact({
      isin: cleanValue(row.isin),
      name: cleanValue(row.fullName),
      status: cleanValue(row.noteDescription),
      asset_class: cleanValue(row.assetClass),
      exchange_symbol: cleanValue(row.exchangeSymbol),
      orderbook_id: cleanValue(row.orderbookId),
    }),
  )
}

// --- the Danish fixed-income tables ----------------------------------------------------------------------------

/** The Danish fixed-income reference tables are published untranslated, so their labels are mapped here. */
const DANISH_LABELS: Record<string, string> = {
  'Rente før skat - restløbetid (år)': 'Yield before tax - residual maturity (years)',
  'Rente efter skat - restløbetid (år)': 'Yield after tax - residual maturity (years)',
  'Alm & Særl. realkredit': 'Ordinary & special mortgage credit',
  Enhedsprioritet: 'Unit priority mortgage',
  'Stat, fiskeri & Færøerne': 'Government, fisheries & Faroe Islands',
  'Særlige institutter': 'Special institutions',
  'Antal papirer': 'Number of securities',
  'Effektiv rente': 'Effective yield',
  'Vægt i %': 'Weight in %',
  'Kreditor indeksfaktorer: Restgæld/obligationer': 'Creditor index factors: Outstanding debt/bonds',
  'Debitor indeksfaktorer: Ejebolig, hovedstol': 'Debtor index factors: Owner-occupied housing, principal',
  'Indekskorrektionsfaktorer: Restgæld/obligationer': 'Index correction factors: Outstanding debt/bonds',
  'Støttet byggeri, hovedstol': 'Subsidised construction, principal',
  'Rederiindeks 1 1/2 pct': 'Shipping index 1.5 pct',
  'Rederiindeks 3 pct.': 'Shipping index 3 pct',
  'Referenceindeks:': 'Reference index',
}

/** `translate`: a Nasdaq Nordic label in English, or the label as published when it needs no translation. */
function translate(label: unknown): string | null {
  if (label === null || label === undefined) return null
  const text = String(label).trim().replace(/:+$/, '')
  return DANISH_LABELS[text] ?? DANISH_LABELS[String(label).trim()] ?? text
}

export async function nordicBondYields(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const basis = String(params.basis ?? 'before_tax')
  const key = BASIS[basis]
  if (key === undefined) throw new NativeUnsupported(`nasdaq has no ${basis} bond yields`)
  const data: Dict = (await getNasdaqData(ctx, 'nordic/average-yield?lang=en')) ?? {}
  const block: Dict = data[key] ?? {}
  const headers: Dict = block.headers ?? {}
  const reported = toDate(data.date)
  const results: Row[] = []
  for (const section of (block.sections ?? []) as Dict[]) {
    const segment = translate(section.name)
    for (const row of (section.rows ?? []) as Dict[]) {
      for (const [column, label] of Object.entries(headers)) {
        if (column === 'attribute') continue
        results.push(compact({ date: reported, segment, attribute: translate(row.attribute), maturity: label, value: toNumber(row[column]) }))
      }
    }
  }
  return results // EmptyDataError when there are none
}

export async function nordicIndexFactors(_params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const data: Dict = (await getNasdaqData(ctx, 'nordic/index-factors?lang=en')) ?? {}
  const results: Row[] = []
  for (const block of Object.values(data.indexFactors ?? {}) as unknown[]) {
    if (typeof block !== 'object' || block === null || Array.isArray(block)) continue
    for (const row of ((block as Dict).rows ?? []) as Dict[]) {
      for (const [column, value] of Object.entries(row)) {
        const effective = toDate(column)
        if (column === 'attribute' || effective === null) continue
        const number = toNumber(value)
        if (number === null) continue
        results.push(compact({ date: effective, attribute: translate(row.attribute), value: number }))
      }
    }
  }
  return results.sort((a, b) => cmp(a.date as string, b.date as string) || cmp(String(a.attribute), String(b.attribute)))
}

export async function nordicMortgageRates(_params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const data: Dict = (await getNasdaqData(ctx, 'nordic/mortgage-rates?lang=en')) ?? {}
  const block: Dict = data.mortgageRates ?? {}
  const headers: Dict = block.headers ?? {}
  const results: Row[] = []
  for (const row of (block.rows ?? []) as Dict[]) {
    for (const [column, label] of Object.entries(headers)) {
      if (column === 'fullName' || column === 'url') continue
      const rate = toPercent(row[column])
      if (rate === null) continue
      results.push(compact({ lender: row.fullName, term: label, rate, url: row.url }))
    }
  }
  return results
}

// --- trading hours and holidays --------------------------------------------------------------------------------

const TABLE = /<table.*?<\/table>/gs
const ROW = /<tr.*?<\/tr>/gs
const CELL = /<t[dh].*?<\/t[dh]>/gs
const HEADING = /<h[23][^>]*>(.*?)<\/h[23]>/gs
const HOLIDAY_YEAR = /Exchange Holiday Schedule\s+(\d{4})/
const CLOSED_DATE = /([A-Z][a-z]{2})\s+(\d{1,2}),\s*(\d{4})/g

/** Strip markup and collapse whitespace to a single readable line (`clean`). */
function clean(markup: string): string {
  return htmlUnescape(markup.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
}

async function fetchTradingHours(ctx: NativeCtx): Promise<string> {
  return ctx.http.text(TRADING_HOURS_URL, { headers: textHeaders() })
}

/** Split the page into its tables, each with the heading above it. */
function tables(markup: string): [string, string[][]][] {
  const out: [string, string[][]][] = []
  for (const match of markup.matchAll(TABLE)) {
    const headings = [...markup.slice(0, match.index).matchAll(HEADING)].map((h) => clean(h[1]!))
    const rows = [...match[0].matchAll(ROW)].map((row) => [...row[0].matchAll(CELL)].map((cell) => clean(cell[0])))
    out.push([headings.length ? headings[headings.length - 1]! : '', rows])
  }
  return out
}

export async function nordicTradingHours(_params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const markup = await fetchTradingHours(ctx)
  const results: Row[] = []
  for (const [heading, rows] of tables(markup)) {
    if (HOLIDAY_YEAR.test(heading) || rows.length < 2) continue
    const header = rows[0]!
    const section = clean(header[0] ?? '') || heading
    if (!section) continue
    for (const row of rows.slice(1)) {
      const segment = row[0] ?? ''
      if (!segment) continue
      const n = Math.min(header.length - 1, row.length - 1)
      for (let i = 1; i <= n; i++) {
        const hours = row[i]!.replaceAll(' ', ' ').trim()
        if (!hours || hours === '-' || hours === '--' || hours === '---') continue
        results.push({ section, segment, market: header[i]!.replaceAll(' ', ' ').trim(), hours })
      }
    }
  }
  return results
}

export async function nordicHolidays(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const markup = await fetchTradingHours(ctx)
  const year = typeof params.year === 'number' ? params.year : undefined
  const rows: Row[] = []
  for (const [heading, trs] of tables(markup)) {
    if (!HOLIDAY_YEAR.test(heading) || trs.length < 2) continue
    const header = trs[0]!
    for (const row of trs.slice(1)) {
      const market = row[0] ?? ''
      if (!market) continue
      const n = Math.min(header.length - 1, row.length - 1)
      for (let i = 1; i <= n; i++) {
        for (const m of row[i]!.replaceAll(' ', ' ').matchAll(CLOSED_DATE)) {
          const closed = toDate(`${m[1]} ${m[2]}, ${m[3]}`)
          if (closed === null) continue
          rows.push({ market, instrument_group: header[i]!, date: closed })
        }
      }
    }
  }
  const wanted = rows.filter((r) => year === undefined || Number((r.date as string).slice(0, 4)) === year)
  return wanted.sort((a, b) => cmp(a.date as string, b.date as string) || cmp(a.market as string, b.market as string) || cmp(a.instrument_group as string, b.instrument_group as string))
}

// --- news ------------------------------------------------------------------------------------------------------

export async function nordicNews(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const market = String(params.market ?? 'all')
  const key = NORDIC_NEWS_MARKET_KEYS[market]
  if (key === undefined) throw new NativeUnsupported(`nasdaq has no Nordic news market ${market}`)
  const limit = typeof params.limit === 'number' ? params.limit : 50
  const url = `${NORDIC_NEWS_URL}?countResults=true&globalGroup=exchangeNotice&displayLanguage=en&timeZone=CET&dateMask=yyyy-MM-dd+HH%3Amm%3Ass&limit=${limit}&start=0&dir=DESC&globalName=${key}`
  const response = await ctx.http.json<Dict>(url, { headers: jsonHeaders() })
  const items = ((response ?? {}).results ?? {}).item
  const data: Dict[] = Array.isArray(items) ? items : truthy(items) ? [items] : []
  if (!data.length) return [] // EmptyDataError
  const results: Row[] = []
  for (const row of data) {
    const released = parseTime(truthy(row.releaseTime) ? row.releaseTime : row.published)
    if (released === null) continue
    const attachments: Dict[] = row.attachment ?? []
    results.push(
      compact({
        date: released,
        title: row.headline,
        company: row.company,
        market: row.market,
        category: row.cnsCategory,
        language: row.language,
        url: row.messageUrl,
        attachment_url: attachments.length ? attachments[0]!.attachmentUrl : null,
        disclosure_id: row.disclosureId,
      }),
    )
  }
  return results.sort((a, b) => cmp(b.date as string, a.date as string))
}

