// equity/discovery/gainers, tmx/markets/movers, nasdaq/markets/movers, tmx/markets/trades, tmx/markets/short_interest,
// tmx/equity/rankings and tmx/equity/symbol_reference, provider tmx. Ported from openbb_tmx/models/{gainers,
// market_movers,equity_trades,equity_short_interest,rankings,symbol_reference}.py (OpenBB Platform 5.0.0, Apache-2.0);
// modified: plain rows instead of pydantic models.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { MARKET_MOVERS, MOST_RECENT_TRADES, SHORT_INTEREST, STOCK_LIST, TSX30, VENTURE50 } from './gql.js'
import { applyAliases, compact, gql, inOrder, normalizeSymbol, normalizeUrl, numParam, oneOf, optFloat, qmDatatool, requiredSymbols, toFloat, truthy, withoutRouteDefaults } from './helpers.js'

const STOCK_LISTS_DICT: Record<string, string> = {
  dividend: 'TOP_DIVIDEND',
  energy: 'TOP_ENERGY',
  healthcare: 'TOP_HEALTHCARE',
  industrials: 'TOP_INDUSTRIALS',
  price_performer: 'TOP_PRICE_PERFORMER',
  rising_stars: 'RISING_STARS',
  real_estate: 'TOP_REAL_ESTATE',
  tech: 'TOP_TECH',
  utilities: 'TOP_UTILITIES',
  '52w_high': 'TOP_WEEK_52_HIGH',
  volume: 'TOP_VOLUME',
  cdr: 'CIBC_CDR_SL',
}

const GAINERS_ALIASES: Record<string, string> = {
  name: 'longName',
  change: 'priceChange',
  percent_change: 'percentChange',
  thirty_day_price_change: '30 Day Price Change',
  dividend_yield: 'Dividend Yield',
  year_high: '52 Week High',
  avg_volume_10d: '10 Day Avg. Volume',
  ninety_day_price_change: '90 Day Price Change',
}

/** equity/discovery/gainers: one of TMX's stock lists, its ranking metric kept under the list's own title. */
export async function equityGainers(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const category = oneOf(params, 'category', Object.keys(STOCK_LISTS_DICT), 'price_performer')
  const response = await gql<Row>(ctx, 'getStockListSymbolsWithQuote', STOCK_LIST, { stockListId: STOCK_LISTS_DICT[category], locale: 'en' })
  const stockList = response?.stockList as Row | undefined
  if (!stockList) return []
  const items = (stockList.listItems as Row[] | undefined) ?? []
  const metric = stockList.metricTitle as string
  const rows = items.map((item) => {
    const row: Row = {}
    for (const [k, v] of Object.entries(item)) {
      if (k === 'metric') row[metric] = v
      else row[k] = v
    }
    return row
  })
  return rows.map((raw) => {
    // check_metric (a "before" model validator, so it sees the source keys): missing metrics are zero.
    const values: Row = {}
    for (const [k, v] of Object.entries(raw)) {
      let value: unknown = v === null || v === undefined || v === '-' ? 0 : v
      if (k === 'Dividend Yield') value = truthy(value) ? toFloat(value) / 100 : null
      values[k] = value
    }
    const row = applyAliases(values, GAINERS_ALIASES)
    // A missing name was turned into 0 above, which OpenBB's string field then rejects (it fails the whole list, as
    // for the CDR list); the port leaves the name out instead.
    if (typeof row.name !== 'string') delete row.name
    for (const k of ['thirty_day_price_change', 'ninety_day_price_change', 'avg_volume_10d']) if (k in row) row[k] = optFloat(row[k]) ?? null
    row.percent_change = truthy(row.percent_change) ? toFloat(row.percent_change) / 100 : 0
    return compact(row)
  })
}

const MOVER_EXCHANGES = { tsx: 'TSX', tsxv: 'TSXV' } as const
const MOVER_SORT = { gainers: 'desc', losers: 'asc' } as const

/** tmx/markets/movers and nasdaq/markets/movers (OpenBB's MarketMovers model answers both routes). */
export async function marketMovers(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  // The route's own defaults (category most_active_share_volume, limit 10) are the NASDAQ model's; OpenBB drops a
  // value equal to the route default, so TMX's gainers and 25 apply.
  const given = withoutRouteDefaults(params, { category: 'most_active_share_volume', limit: 10 })
  const category = oneOf(given, 'category', ['gainers', 'losers'] as const, 'gainers')
  const exchange = oneOf(given, 'exchange', ['tsx', 'tsxv'] as const, 'tsx')
  const limit = numParam(given, 'limit') ?? 25
  const response = await gql<Row>(ctx, 'getMarketMovers', MARKET_MOVERS, { sortOrder: MOVER_SORT[category], statExchange: MOVER_EXCHANGES[exchange], limit })
  const results = (response?.getMarketMovers as Row[] | undefined) ?? []
  return results.map((d) =>
    compact({
      symbol: d.symbol,
      name: d.name,
      price: optFloat(d.price),
      change: optFloat(d.priceChange),
      change_percent: d.percentChange !== null && d.percentChange !== undefined ? toFloat(d.percentChange) / 100 : undefined,
      open: optFloat(d.open),
      high: optFloat(d.high),
      low: optFloat(d.low),
      volume: optFloat(d.volume),
      trade_volume: optFloat(d.tradeVolume),
      week_52_high: optFloat(d.weeks52high),
      week_52_low: optFloat(d.weeks52low),
      exchange: d.exchangeCode,
    }),
  )
}

/** tmx/markets/trades: the most recent trades with the brokers on each side, newest first. */
export async function marketTrades(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const limit = numParam(params, 'limit') ?? 50
  const results = await inOrder(requiredSymbols(params), async (raw) => {
    const symbol = normalizeSymbol(raw.toUpperCase())
    const response = await gql<Row>(ctx, 'getCompanyMostRecentTrades', MOST_RECENT_TRADES, { symbol, limit }, symbol)
    return ((response?.getCompanyMostRecentTrades as Row[] | undefined) ?? []).map((trade) => ({ symbol, ...trade }))
  })
  if (results.length === 0) return []
  const when = (d: Row): string => String(d.datetime ?? '')
  // sorted(..., reverse=True) keeps equal elements in their original order.
  const sorted = results.map((d, i) => ({ d, i })).sort((a, b) => (when(a.d) < when(b.d) ? 1 : when(a.d) > when(b.d) ? -1 : a.i - b.i)).map((x) => x.d)
  return sorted.map((d) =>
    compact({
      date: d.datetime,
      symbol: d.symbol,
      price: optFloat(d.price),
      volume: optFloat(d.volume),
      exchange: d.exchangeCode,
      buyer_id: d.buyerId,
      buyer_name: d.buyerName,
      seller_id: d.sellerId,
      seller_name: d.sellerName,
    }),
  )
}

/** tmx/markets/short_interest. */
export async function shortInterest(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const results = await inOrder(requiredSymbols(params), async (raw) => {
    const symbol = normalizeSymbol(raw.toUpperCase())
    const response = await gql<Row>(ctx, 'GetCompanyShortInterest', SHORT_INTEREST, { symbol }, symbol)
    const record = response?.getCompanyShortInterest as Row | undefined
    return record ? [{ requested_symbol: symbol, ...record }] : []
  })
  return results.map((d) =>
    compact({
      symbol: d.requested_symbol,
      settlement_date: d.BUSINESS_DATE,
      short_interest: optFloat(d.SHORT_INTEREST),
      short_interest_percent: d.SHORTINTERESTPCT !== null && d.SHORTINTERESTPCT !== undefined ? toFloat(d.SHORTINTERESTPCT) / 100 : undefined,
      days_to_cover_10d: optFloat(d.DAYSTOCOVER10DAY),
      days_to_cover_30d: optFloat(d.DAYSTOCOVER30DAY),
      days_to_cover_90d: optFloat(d.DAYSTOCOVER90DAY),
    }),
  )
}

const RANKINGS = { tsx30: ['GetTsx30Companies', 'getTsx30Companies', TSX30], venture50: ['getVenture50Companies', 'getVenture50Companies', VENTURE50] } as const

const RANKING_ALIASES: Record<string, string> = {
  symbol: 'ticker',
  share_price_appreciation: 'sharePriceAppreciation',
  market_cap_change: 'marketCapChange',
  website: 'url',
  logo_url: 'logoUrl',
}

/** tmx/equity/rankings: the TSX 30 and the TSX Venture 50. */
export async function rankings(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const ranking = oneOf(params, 'ranking', ['tsx30', 'venture50'] as const, 'tsx30')
  const [operation, key, document] = RANKINGS[ranking]
  const response = await gql<Row>(ctx, operation, document, {})
  const data = (response?.[key] as Row[] | undefined) ?? []
  const text = (value: unknown): unknown => {
    const resolved = value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Row).en : value
    return typeof resolved === 'string' ? resolved.trim() || null : resolved
  }
  const pct = (value: unknown): number | null => {
    if (value === null || value === undefined) return null
    const cleaned = String(value).replaceAll('%', '').replaceAll(',', '').trim()
    return cleaned ? toFloat(cleaned) / 100 : null
  }
  return data.map((row) => {
    const record: Row = {}
    for (const [k, v] of Object.entries(row)) record[k] = text(v)
    record.description = record.desc ?? null
    delete record.desc
    const sharePrice = record.sharePrice
    delete record.sharePrice
    let appreciation = sharePrice
    if (!truthy(appreciation)) {
      appreciation = record.sharePriceAppreciation
      delete record.sharePriceAppreciation
    }
    record.sharePriceAppreciation = pct(appreciation)
    record.marketCapChange = pct(record.marketCapChange)
    const out = applyAliases(record, RANKING_ALIASES)
    if ('website' in out) out.website = normalizeUrl(out.website) ?? null
    return compact(out)
  })
}

/** tmx/equity/symbol_reference: whether the feed resolves each symbol, and to what. */
export async function symbolReference(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const symbols = requiredSymbols(params).map((s) => s.trim()).filter(Boolean)
  const results = await qmDatatool(ctx, 'getValidSymbols.json', 'InteractiveChart', { symbols: symbols.join(',') })
  const entries = results.validatesymbol
  const list = (Array.isArray(entries) ? entries : entries ? [entries] : []) as Row[]
  return list.map((d) =>
    compact({
      symbol: d.symbolstring,
      is_valid: d.valid,
      resolved_symbol: d.symbol,
      exchange: truthy(d.exchange) ? d.exchange : undefined,
      exchange_short_name: d.exShName,
      exchange_name: d.exLgName,
    }),
  )
}
