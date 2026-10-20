// equity/price/quote, equity/profile, equity/search and nasdaq/markets/quotes, provider nasdaq. Ported from
// openbb_nasdaq/models/{equity_quote,equity_info,equity_search,price_quote}.py (OpenBB Platform 5.0.0, Apache-2.0);
// modified: plain rows instead of pandas and pydantic models.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { EmptyDataError, compact, getBasicQuotes, getNasdaqData, getNasdaqDirectory, listParam, readPandasCsv, symbolsOf, toDate, toNumber, toPercent, truthy, type Dict } from './helpers.js'

/** The date as the datetime pydantic makes of a date: midnight, "YYYY-MM-DDT00:00:00". */
const midnight = (day: string | null): string | null => (day === null ? null : `${day}T00:00:00`)

/** The display value out of a label/value block. */
const value = (block: Dict, key: string): any => (block[key] ?? {}).value

/** Split a Nasdaq 'high/low' or 'low - high' display string into [high, low] (`_split_range`). */
function splitRange(v: unknown): [number | null, number | null] {
  if (typeof v !== 'string') return [null, null]
  const separator = v.includes('/') ? '/' : v.includes(' - ') ? '-' : null
  if (separator === null) return [null, null]
  const at = v.indexOf(separator)
  const numbers = [toNumber(v.slice(0, at)), toNumber(v.slice(at + 1))].filter((n): n is number => n !== null)
  return numbers.length === 2 ? [Math.max(...numbers), Math.min(...numbers)] : [null, null]
}

export async function equityQuote(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const symbols = symbolsOf(params)
  const items = await Promise.all(
    symbols.map(async (symbol) => {
      try {
        const [info, summary] = await Promise.all([getNasdaqData(ctx, `quote/${symbol}/info?assetclass=stocks`), getNasdaqData(ctx, `quote/${symbol}/summary?assetclass=stocks`)])
        return { symbol, info, summary: summary ?? {} }
      } catch (err) {
        ctx.log(`No quote was returned for ${symbol}. ${err instanceof Error ? err.message : String(err)}`)
        return undefined
      }
    }),
  )
  const data = items.filter((i) => i !== undefined)
  if (!data.length) return [] // EmptyDataError: No quotes were returned for any symbol.
  return data.map((item) => {
    const info: Dict = item.info ?? {}
    const primary: Dict = info.primaryData ?? {}
    const summary: Dict = (item.summary ?? {}).summaryData ?? {}
    const [high, low] = splitRange(value(summary, 'FiftTwoWeekHighLow'))
    const [dayHigh, dayLow] = splitRange(value(summary, 'TodayHighLow'))
    return compact({
      symbol: item.symbol,
      name: info.companyName,
      exchange: info.exchange,
      asset_type: info.stockType,
      last_price: toNumber(primary.lastSalePrice),
      change: toNumber(primary.netChange),
      change_percent: toPercent(primary.percentageChange),
      volume: toNumber(primary.volume),
      bid: toNumber(primary.bidPrice),
      ask: toNumber(primary.askPrice),
      bid_size: toNumber(primary.bidSize),
      ask_size: toNumber(primary.askSize),
      prev_close: toNumber(value(summary, 'PreviousClose')),
      year_high: high,
      year_low: low,
      high: dayHigh,
      low: dayLow,
      sector: value(summary, 'Sector'),
      industry: value(summary, 'Industry'),
      market_cap: toNumber(value(summary, 'MarketCap')),
      average_volume: toNumber(value(summary, 'AverageVolume')),
      price_target: toNumber(value(summary, 'OneYrTarget')),
      annualized_dividend: toNumber(value(summary, 'AnnualizedDividend')),
      dividend_yield: toPercent(value(summary, 'Yield')),
      ex_dividend_date: toDate(value(summary, 'ExDividendDate')),
      dividend_payment_date: toDate(value(summary, 'DividendPaymentDate')),
      is_nasdaq_100: info.isNasdaq100,
      market_status: info.marketStatus,
      last_timestamp: midnight(toDate(primary.lastTradeTimestamp)),
    })
  })
}

export async function equityProfile(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const symbols = symbolsOf(params)
  const items = await Promise.all(
    symbols.map(async (symbol) => {
      try {
        const [profile, info] = await Promise.all([getNasdaqData(ctx, `company/${symbol}/company-profile`), getNasdaqData(ctx, `quote/${symbol}/info?assetclass=stocks`)])
        return { symbol, profile: (profile ?? {}) as Dict, info: (info ?? {}) as Dict }
      } catch (err) {
        ctx.log(`No profile was returned for ${symbol}. ${err instanceof Error ? err.message : String(err)}`)
        return undefined
      }
    }),
  )
  const data = items.filter((i) => i !== undefined)
  if (!data.length) return [] // EmptyDataError
  return data.map(({ symbol, profile, info }) => {
    const name = value(profile, 'CompanyName')
    return compact({
      symbol,
      name: truthy(name) ? name : info.companyName,
      long_description: value(profile, 'CompanyDescription'),
      industry: value(profile, 'Industry'),
      sector: value(profile, 'Sector'),
      region: value(profile, 'Region'),
      address: value(profile, 'Address'),
      phone_number: value(profile, 'Phone'),
      exchange: info.exchange,
      stock_type: info.stockType,
      is_nasdaq_100: info.isNasdaq100,
    })
  })
}

/** Batch quotes for any mix of stocks, funds, indexes and crypto pairs. */
export async function marketsQuotes(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const symbols = listParam(params, 'symbol')
  if (!symbols.length) throw new Error('symbol is required')
  let data: Dict[]
  try {
    data = await getBasicQuotes(ctx, symbols)
  } catch (err) {
    if (err instanceof EmptyDataError) return []
    throw err
  }
  return data.map((row) => {
    const ticker: unknown[] = row.ticker ?? []
    const url = row.url
    return compact({
      symbol: String(row.key ?? '').split('|')[0]!.toUpperCase(),
      name: ticker.length > 1 ? ticker[1] : null,
      asset_class: row.assetclass,
      last_price: toNumber(row.lastSale),
      change: toNumber(row.change),
      change_percent: toPercent(row.pctChange),
      volume: toNumber(row.volume),
      url: url ? `https://www.nasdaq.com${url}` : null,
    })
  })
}

const SEARCH_ALIASES: Record<string, string> = {
  Symbol: 'symbol',
  'Security Name': 'name',
  'Nasdaq Traded': 'nasdaq_traded',
  'listing Exchange': 'exchange',
  'Market Category': 'market_category',
  ETF: 'etf',
  'Round Lot Size': 'round_lot_size',
  'Test Issue': 'test_issue',
  'Financial Status': 'financial_status',
  'CQS Symbol': 'cqs_symbol',
  'NASDAQ Symbol': 'nasdaq_symbol',
  NextShares: 'next_shares',
}

export async function equitySearch(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const text = await getNasdaqDirectory(ctx)
  // read_csv(...).iloc[:-1] drops the file-creation line
  let { rows } = readPandasCsv(text, '|')
  rows = rows.slice(0, -1)
  const isEtf = params.is_etf === true
  rows = rows.filter((r) => r.ETF === (isEtf ? 'Y' : 'N'))
  rows = rows.filter((r) => !/test/i.test(String(r['Security Name'] ?? '')))
  const q = params.query === undefined ? '' : String(params.query)
  if (q) {
    const re = new RegExp(q, 'i')
    const has = (v: unknown) => typeof v === 'string' && re.test(v)
    rows = rows.filter((r) => has(r.Symbol) || has(r['Security Name']) || has(r['CQS Symbol']) || has(r['NASDAQ Symbol']))
  }
  // The directory's own lower-case "listing Exchange" alias never matches its "Listing Exchange" column, which stays as is.
  return rows.map((r) => {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(r)) {
      if (k === 'Market Category' && v === ' ') continue
      out[SEARCH_ALIASES[k] ?? k] = v
    }
    return compact(out)
  })
}
