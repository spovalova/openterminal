// derivatives/options/chains, tmx/derivatives/options/covered_calls and derivatives/futures/instruments, provider tmx.
// Ported from openbb_tmx/models/{options_chains,covered_call_screener,futures_instruments}.py and utils/{mx,
// quotemedia,helpers}.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of DataFrames and pydantic
// models, HTML tables read with node-html-parser, and the expiry-cycle PDF (pdfplumber in Python) is not read, so
// `expiry_cycle` and `has_long_term_options` are left out.
import { cellNumber, htmlTables, tableRecords } from '../lib/html-tables.js'
import { NativeUnsupported, type NativeCtx, type NativeParams, type Row } from '../types.js'
import { QUOTE_FOR_SYMBOLS } from './gql.js'
import { boolParam, cached, compact, DAY_MS, getText, gql, normalizeSymbol, numParam, qmDatatool, strParam, TmxError, truthy, urlencode, zonedDay } from './helpers.js'
import { equityQuote } from './quote.js'

const NY = 'America/New_York'
const MX = 'https://www.m-x.ca/'
const QUOTES_URL = 'https://www.m-x.ca/en/trading/data/quotes'
const OPTIONS_LIST_URL = 'https://www.m-x.ca/en/trading/data/options-list'
const COVERED_CALL_URL = 'https://www.m-x.ca/en/resources/education/covered-call-screener'

const LISTING_TABS = ['equity_option', 'cdr_option', 'cef_option', 'etf_option', 'currency_option', 'index_option', 'weekly_option']

type Listing = { name: string | null; underlying_symbol: string | null; asset_class?: string; has_weeklies?: boolean }

/** `get_options_listings`: the listed option classes by option symbol; empty when the page cannot be read. */
async function optionsListings(ctx: NativeCtx, useCache: boolean): Promise<Map<string, Listing>> {
  return cached(ctx, useCache, 'tmx:mx-options-listings', DAY_MS, async () => {
    const listings = new Map<string, Listing>()
    const weeklies = new Set<string>()
    try {
      const tables = htmlTables(await getText(ctx, OPTIONS_LIST_URL, MX))
      LISTING_TABS.forEach((tab, i) => {
        const table = tables[i]
        if (!table) return
        for (const row of tableRecords(table)) {
          const symbol = (row['Option Symbol'] ?? '').trim()
          if (!symbol || symbol.toLowerCase() === 'nan') continue
          if (tab === 'weekly_option') {
            weeklies.add(symbol)
            continue
          }
          const underlying = (row['Underlying Symbol'] ?? '').trim()
          listings.set(symbol, { name: (row['Name of Underlying Instrument'] ?? '').trim() || null, underlying_symbol: underlying || null, asset_class: tab })
        }
      })
    } catch {
      return new Map<string, Listing>()
    }
    for (const symbol of weeklies) if (!listings.has(symbol)) listings.set(symbol, { name: null, underlying_symbol: null })
    for (const [symbol, listing] of listings) listing.has_weeklies = weeklies.has(symbol)
    return listings
  })
}

// ---------------------------------------------------------------------------------------------------------------------
// derivatives/options/chains

const TICK_MAP: Record<string, string> = { '1': 'up', '-1': 'down', '0': 'unchanged' }

/** The fields of the chain data model; the rest of a QuoteMedia contract is dropped by the serializer. */
const CHAIN_FIELDS = ['underlying_symbol', 'underlying_price', 'contract_symbol', 'eod_date', 'expiration', 'dte', 'strike', 'option_type', 'contract_size', 'open_interest', 'volume', 'theoretical_price', 'last_trade_price', 'last_trade_size', 'last_trade_time', 'tick', 'bid', 'bid_size', 'bid_time', 'bid_exchange', 'ask', 'ask_size', 'ask_time', 'ask_exchange', 'mark', 'open', 'open_bid', 'open_ask', 'high', 'bid_high', 'ask_high', 'low', 'bid_low', 'ask_low', 'close', 'close_size', 'close_time', 'close_bid', 'close_bid_size', 'close_bid_time', 'close_ask', 'close_ask_size', 'close_ask_time', 'prev_close', 'change', 'change_percent', 'implied_volatility', 'delta', 'gamma', 'theta', 'vega', 'rho']
const CHAIN_TIMES = new Set(['last_trade_time', 'bid_time', 'ask_time', 'close_time', 'close_bid_time', 'close_ask_time'])

/** `get_option_chain`: the whole chain, every expiry, with greeks. */
async function optionChain(ctx: NativeCtx, symbol: string): Promise<Row> {
  const base = { symbol, greeks: true, callput: 'group', groupDate: true, inclExpired: false, adjOptions: true, money: 'All', optionSize: 'all' }
  const results = await qmDatatool(ctx, 'getOptionQuotes.json', 'options', base)
  const dates = (((results.expiryDates as Row | undefined)?.expiryDate as Row[] | undefined) ?? []).map((e) => e.date).filter(Boolean) as string[]
  if (dates.length <= ((results.expiryGroup as unknown[] | undefined) ?? []).length) return results
  return qmDatatool(ctx, 'getOptionQuotes.json', 'options', { ...base, expiryDates: dates.join(',') })
}

/** Python's `str(datetime)` for an aware timestamp: a space instead of the T, and +00:00 for UTC. */
function pyDatetimeStr(iso: string): string {
  return iso.replace('T', ' ').replace(/Z$/, '+00:00')
}

/** `_flatten_chain`: one record per contract, sorted by expiration, strike and type. */
function flattenChain(results: Row, symbol: string, today: string): Row[] {
  const rows: Row[] = []
  for (const group of (results.expiryGroup as Row[] | undefined) ?? []) {
    for (const pair of (group.callputgroup as Row[] | undefined) ?? []) {
      for (const quote of (pair.quote as Row[] | undefined) ?? []) {
        const contract = (quote.contract as Row | undefined) ?? {}
        const price = (quote.pricedata as Row | undefined) ?? {}
        const greeks = (quote.greeks as Row | undefined) ?? {}
        const key = ((quote.key as Row | undefined)?.symbol as string[] | undefined) ?? []
        const expiration = contract.expirydate as string | undefined
        if (!expiration) continue
        rows.push({
          underlying_symbol: `${symbol}:CA`,
          contract_symbol: key.length > 0 ? key[0] : quote.symbolstring,
          expiration,
          strike: contract.strike,
          option_type: String(contract.callput ?? '').toLowerCase(),
          open_interest: contract.openinterest,
          volume: price.contractvolume,
          last_trade_price: price.last,
          last_trade_time: price.lasttradedatetime,
          prev_close: price.prevclose,
          change: price.change,
          change_percent: price.changepercent,
          open: price.open,
          high: price.high,
          low: price.low,
          bid: price.bid,
          bid_size: price.bidsize,
          ask: price.ask,
          ask_size: price.asksize,
          tick: TICK_MAP[String(price.tick)],
          implied_volatility: greeks.impvol,
          delta: greeks.delta,
          gamma: greeks.gamma,
          theta: greeks.theta,
          vega: greeks.vega,
          rho: greeks.rho,
        })
      }
    }
  }
  rows.sort((a, b) => cmpStr(String(a.expiration), String(b.expiration)) || Number(a.strike) - Number(b.strike) || cmpStr(String(a.option_type), String(b.option_type)))
  const todayMs = Date.parse(`${today}T00:00:00Z`)
  for (const r of rows) r.dte = Math.round((Date.parse(`${String(r.expiration)}T00:00:00Z`) - todayMs) / DAY_MS)
  return rows
}

const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** The model serializer: one record per contract; datetimes print as `str(datetime)` when the first one is a datetime. */
function serializeChain(rows: Row[]): Row[] {
  const fields = CHAIN_FIELDS.filter((f) => rows.some((r) => r[f] !== undefined))
  return rows.map((r) => {
    const out: Row = {}
    for (const f of fields) {
      let v = r[f] ?? null
      if (CHAIN_TIMES.has(f) && typeof v === 'string' && rows[0]?.[f] !== null && rows[0]?.[f] !== undefined) v = pyDatetimeStr(v)
      out[f] = v
    }
    return compact(out)
  })
}

/** derivatives/options/chains: the live chain from QuoteMedia. */
export async function optionsChains(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  if (strParam(params, 'date') !== undefined) throw new NativeUnsupported('end-of-day option chains (date) are not ported')
  const symbol = normalizeSymbol(String(params.symbol).toUpperCase())
  const results = await optionChain(ctx, symbol)
  const today = zonedDay(ctx.now().getTime(), NY)
  const rows = flattenChain(results, symbol, today)
  if (rows.length === 0) throw new TmxError(`No option chain was returned for ${symbol}.`)
  const quotes = await equityQuote({ symbol: String(params.symbol).toUpperCase() }, ctx)
  const underlying = quotes[0]?.last_price
  if (underlying !== undefined && underlying !== null) for (const r of rows) r.underlying_price = underlying
  return serializeChain(rows)
}

// ---------------------------------------------------------------------------------------------------------------------
// tmx/derivatives/options/covered_calls

/** A float the way Python formats it into the form body: `5.0`, `7.5`. */
const pyFloat = (n: number): string => (Number.isInteger(n) ? `${n}.0` : String(n))

/** `_quoted`: a zero or empty level is no quote. */
const quoted = (v: unknown): unknown => (v === 0 || v === '' || v === null || v === undefined ? null : v)

/** `_percent`: a published percent as a decimal. */
function percentCell(v: unknown): number | null {
  const n = typeof v === 'number' ? v : cellNumber(String(v ?? ''))
  return n === undefined || Number.isNaN(n) ? null : n / 100
}

/** A cell the way read_html types it: a number when it reads as one, else the text. */
const typed = (text: string | undefined): string | number | undefined => (text === undefined ? undefined : (cellNumber(text) ?? text))

/** tmx/derivatives/options/covered_calls: listed calls that clear a premium and capital-gain screen. */
export async function coveredCalls(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const useCache = boolParam(params, 'use_cache', true)
  const payload = urlencode({ symbol: (strParam(params, 'symbol') ?? '').toUpperCase(), month: strParam(params, 'expiration') ?? '', premium: pyFloat(numParam(params, 'premium_return_min') ?? 5), gain: pyFloat(numParam(params, 'capital_gain_min') ?? 5) })
  const html = await ctx.http.text(COVERED_CALL_URL, {
    method: 'POST',
    body: payload,
    headers: { Accept: 'text/html,application/xhtml+xml,*/*', 'Content-Type': 'application/x-www-form-urlencoded', Referer: COVERED_CALL_URL, 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36' },
  })
  if (!html) return []
  const table = htmlTables(html).find((t) => t.headers.includes('Symbol'))
  if (!table) return []

  const results: Row[] = []
  for (const r of tableRecords(table)) {
    const parts = String(r['Serie / Strike Price'] ?? '').split(/\s+/).filter(Boolean)
    if (parts.length < 3) continue
    const strike = Number(parts[2])
    results.push({
      symbol: r.Symbol,
      expiration: parts[0],
      strike: Number.isNaN(strike) ? null : strike,
      underlying_price: quoted(typed(r['Last Price'])),
      total_return: percentCell(typed(r['Potential Total Return (%)'])),
      premium_return: percentCell(typed(r['Premium Return (%)'])),
      capital_gain: percentCell(typed(r['Potential Capital Gain (%)'])),
      bid: quoted(typed(r['Bid Price'])),
      bid_size: quoted(typed(r['Bid Size'])),
      ask: quoted(typed(r['Ask Price'])),
      ask_size: quoted(typed(r['Ask Size'])),
      volume: typed(r.Volume),
      open_interest: typed(r['Open Int.']),
    })
  }
  if (results.some((r) => r.underlying_price === null)) await fillUnderlying(ctx, results, useCache)
  return results.map((d) => compact({ ...d, expiration: d.expiration ? String(d.expiration).slice(0, 10) : undefined }))
}

/** `_fill_underlying`: the underlying price from the quote feed for rows the screener left without one. */
async function fillUnderlying(ctx: NativeCtx, rows: Row[], useCache: boolean): Promise<void> {
  const roots = [...new Set(rows.map((r) => r.symbol as string).filter(Boolean))].sort()
  if (roots.length === 0) return
  const listings = await optionsListings(ctx, useCache)
  const listed = new Map(roots.map((root) => [root, listings.get(root)?.underlying_symbol || root]))
  const symbols = [...new Set(listed.values())].sort()
  let response: Row | null | undefined
  try {
    response = await gql<Row>(ctx, 'getQuoteForSymbols', QUOTE_FOR_SYMBOLS, { symbols }, symbols.join(','))
  } catch {
    return
  }
  const prices = new Map<string, unknown>()
  for (const row of (response?.getQuoteForSymbols as Row[] | undefined) ?? []) if (row.symbol) prices.set(String(row.symbol), row.price)
  for (const row of rows) if (row.underlying_price === null || row.underlying_price === undefined) row.underlying_price = prices.get(listed.get(String(row.symbol)) ?? '') ?? null
}

// ---------------------------------------------------------------------------------------------------------------------
// derivatives/futures/instruments

const INSTRUMENT_CLASSES: Record<string, [string, string, string | null]> = {
  symbolOEQ: ['equity_option', 'Equity Options', 'option'],
  symbolCDR: ['cdr_option', 'CDR Options', 'option'],
  symbolCEF: ['cef_option', 'Closed-End Fund Options', 'option'],
  symbolETF: ['etf_option', 'ETF Options', 'option'],
  symbolSSF: ['share_future', 'Share Futures', 'future'],
  symbolESF: ['etf_future', 'ETF Futures', 'future'],
  symbolOCU: ['currency_option', 'Currency Options', 'option'],
  symbolID: ['index_derivative', 'Index Derivatives', null],
  symbolIRD: ['interest_rate_derivative', 'Interest Rate Derivatives', null],
  symbolBTC: ['basis_trade_on_close', 'Basis Trade on Close', 'future'],
}

const OPTION_PRODUCTS = new Set(['SXO', 'SXJ', 'SXV', 'OCR', 'OGZ', 'OGF', 'OGB'])

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

const QUOTE_SYMBOLS: Record<string, string> = { COA: '/COA', CRA: '/CRA', CGZ: '/CGZ', CGF: '/CGF', CGB: '/CGB', LGB: '/LGB', SXF: '/SXF' }

/** `_parse_selectors`: every instrument selector of the quotes page. */
function parseSelectors(html: string): Row[] {
  const results: Row[] = []
  for (const match of html.matchAll(/<select name="symbol" id="(\w+)"[^>]*>(.*?)<\/select>/gs)) {
    const selector = match[1]!
    const body = match[2]!
    const cls = INSTRUMENT_CLASSES[selector]
    if (!cls) continue
    const [assetClass, label, defaultType] = cls
    for (const option of body.matchAll(/<option value="([^"]*)"[^>]*>(.*?)<\/option>/gs)) {
      const value = option[1]!
      if (!value) continue
      const root = value.replace(/\*+$/, '')
      results.push({
        symbol: root,
        name: INTEREST_RATE_PRODUCTS[root] || INDEX_PRODUCTS[root] || null,
        instrument_type: defaultType ?? (OPTION_PRODUCTS.has(root) ? 'option' : 'future'),
        asset_class: assetClass,
        asset_class_name: label,
        quote_symbol: QUOTE_SYMBOLS[root] ?? null,
        option_symbol: value,
        underlying_symbol: null,
        expiry_cycle: null,
        has_long_term_options: null,
        has_weekly_options: null,
      })
    }
  }
  return results
}

/** `get_instrument_universe`: every instrument listed on the Montreal Exchange. */
async function instrumentUniverse(ctx: NativeCtx, useCache: boolean): Promise<Row[]> {
  return cached(ctx, useCache, 'tmx:mx-instruments', DAY_MS, async () => {
    const html = await getText(ctx, `${QUOTES_URL}?symbol=AC`, MX)
    const results = parseSelectors(html || '')
    if (results.length === 0) throw new TmxError('The Montreal Exchange instrument list came back empty.')
    const listings = await optionsListings(ctx, useCache)
    for (const instrument of results) {
      const listing = listings.get(instrument.symbol as string)
      instrument.underlying_symbol = listing?.underlying_symbol ?? null
      instrument.has_weekly_options = listing?.has_weeklies ?? null
      if (!instrument.name) instrument.name = listing?.name ?? null
    }
    return results
  })
}

/** derivatives/futures/instruments: the Montreal Exchange universe, futures only unless told otherwise. */
export async function futuresInstruments(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const assetClass = strParam(params, 'asset_class')
  const instrumentType = strParam(params, 'instrument_type') ?? 'future'
  let rows = await instrumentUniverse(ctx, boolParam(params, 'use_cache', true))
  if (assetClass) rows = rows.filter((r) => r.asset_class === assetClass)
  if (truthy(instrumentType)) rows = rows.filter((r) => r.instrument_type === instrumentType)
  return rows.map((r) => compact(r))
}


