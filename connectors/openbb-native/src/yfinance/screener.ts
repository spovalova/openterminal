// equity/screener, provider yfinance. Independent implementation of OpenBB's output for this route (not derived from
// openbb_yfinance, which is AGPL); Yahoo endpoints and the predefined screens as used by yfinance (Apache-2.0).
import { NativeUnsupported, type NativeCtx, type NativeParams, type Row } from '../types.js'
import { isRecord, listParam, Q1, wallParts, yahooJson } from './helpers.js'
import { v7Quote } from './quote.js'
import screenerValues from './screener-values.json' with { type: 'json' }

type Operand = string | number | Query
type Query = { operator: string; operands: Operand[] }
const q = (operator: string, ...operands: Operand[]): Query => ({ operator, operands })
const and = (...operands: Query[]): Query => q('AND', ...operands)

type Screen = { quoteType: 'EQUITY' | 'MUTUALFUND' | 'ETF'; sortField: string; sortType: 'ASC' | 'DESC'; query: Query }
const us = q('EQ', 'region', 'us')

/** Yahoo's predefined screens, as yfinance spells them out. */
const PREDEFINED: Record<string, Screen> = {
  aggressive_small_caps: { quoteType: 'EQUITY', sortField: 'eodvolume', sortType: 'DESC', query: and(q('IS-IN', 'exchange', 'NMS', 'NYQ'), q('LT', 'epsgrowth.lasttwelvemonths', 15)) },
  day_gainers: { quoteType: 'EQUITY', sortField: 'percentchange', sortType: 'DESC', query: and(q('GT', 'percentchange', 3), us, q('GTE', 'intradaymarketcap', 2000000000), q('GTE', 'intradayprice', 5), q('GT', 'dayvolume', 15000)) },
  day_losers: { quoteType: 'EQUITY', sortField: 'percentchange', sortType: 'ASC', query: and(q('LT', 'percentchange', -2.5), us, q('GTE', 'intradaymarketcap', 2000000000), q('GTE', 'intradayprice', 5), q('GT', 'dayvolume', 20000)) },
  growth_technology_stocks: { quoteType: 'EQUITY', sortField: 'eodvolume', sortType: 'DESC', query: and(q('GTE', 'quarterlyrevenuegrowth.quarterly', 25), q('GTE', 'epsgrowth.lasttwelvemonths', 25), q('EQ', 'sector', 'Technology'), q('IS-IN', 'exchange', 'NMS', 'NYQ')) },
  most_actives: { quoteType: 'EQUITY', sortField: 'dayvolume', sortType: 'DESC', query: and(us, q('GTE', 'intradaymarketcap', 2000000000), q('GT', 'dayvolume', 5000000)) },
  most_shorted_stocks: { quoteType: 'EQUITY', sortField: 'short_percentage_of_shares_outstanding.value', sortType: 'DESC', query: and(us, q('GT', 'intradayprice', 1), q('GT', 'avgdailyvol3m', 200000)) },
  small_cap_gainers: { quoteType: 'EQUITY', sortField: 'eodvolume', sortType: 'DESC', query: and(q('LT', 'intradaymarketcap', 2000000000), q('IS-IN', 'exchange', 'NMS', 'NYQ')) },
  undervalued_growth_stocks: { quoteType: 'EQUITY', sortField: 'eodvolume', sortType: 'DESC', query: and(q('BTWN', 'peratio.lasttwelvemonths', 0, 20), q('LT', 'pegratio_5y', 1), q('GTE', 'epsgrowth.lasttwelvemonths', 25), q('IS-IN', 'exchange', 'NMS', 'NYQ')) },
  undervalued_large_caps: { quoteType: 'EQUITY', sortField: 'eodvolume', sortType: 'DESC', query: and(q('BTWN', 'peratio.lasttwelvemonths', 0, 20), q('LT', 'pegratio_5y', 1), q('BTWN', 'intradaymarketcap', 10000000000, 100000000000), q('IS-IN', 'exchange', 'NMS', 'NYQ')) },
  conservative_foreign_funds: {
    quoteType: 'MUTUALFUND',
    sortField: 'fundnetassets',
    sortType: 'DESC',
    query: and(q('IS-IN', 'categoryname', 'Foreign Large Value', 'Foreign Large Blend', 'Foreign Large Growth', 'Foreign Small/Mid Growth', 'Foreign Small/Mid Blend', 'Foreign Small/Mid Value'), q('IS-IN', 'performanceratingoverall', 4, 5), q('LT', 'initialinvestment', 100001), q('LT', 'annualreturnnavy1categoryrank', 50), q('IS-IN', 'riskratingoverall', 1, 2, 3), q('EQ', 'exchange', 'NAS')),
  },
  high_yield_bond: { quoteType: 'MUTUALFUND', sortField: 'fundnetassets', sortType: 'DESC', query: and(q('IS-IN', 'performanceratingoverall', 4, 5), q('LT', 'initialinvestment', 100001), q('LT', 'annualreturnnavy1categoryrank', 50), q('IS-IN', 'riskratingoverall', 1, 2, 3), q('EQ', 'categoryname', 'High Yield Bond'), q('EQ', 'exchange', 'NAS')) },
  portfolio_anchors: { quoteType: 'MUTUALFUND', sortField: 'fundnetassets', sortType: 'DESC', query: and(q('EQ', 'categoryname', 'Large Blend'), q('IS-IN', 'performanceratingoverall', 4, 5), q('LT', 'initialinvestment', 100001), q('LT', 'annualreturnnavy1categoryrank', 50), q('EQ', 'exchange', 'NAS')) },
  solid_large_growth_funds: { quoteType: 'MUTUALFUND', sortField: 'fundnetassets', sortType: 'DESC', query: and(q('EQ', 'categoryname', 'Large Growth'), q('IS-IN', 'performanceratingoverall', 4, 5), q('LT', 'initialinvestment', 100001), q('LT', 'annualreturnnavy1categoryrank', 50), q('EQ', 'exchange', 'NAS')) },
  solid_midcap_growth_funds: { quoteType: 'MUTUALFUND', sortField: 'fundnetassets', sortType: 'DESC', query: and(q('EQ', 'categoryname', 'Mid-Cap Growth'), q('IS-IN', 'performanceratingoverall', 4, 5), q('LT', 'initialinvestment', 100001), q('LT', 'annualreturnnavy1categoryrank', 50), q('EQ', 'exchange', 'NAS')) },
  top_mutual_funds: { quoteType: 'MUTUALFUND', sortField: 'percentchange', sortType: 'DESC', query: and(q('GT', 'intradayprice', 15), q('IS-IN', 'performanceratingoverall', 4, 5), q('GT', 'initialinvestment', 1000), q('EQ', 'exchange', 'NAS')) },
  top_etfs_us: { quoteType: 'ETF', sortField: 'percentchange', sortType: 'DESC', query: and(q('GT', 'intradayprice', 10), q('IS-IN', 'performanceratingoverall', 4, 5), us) },
}

/** Yahoo's screener accepts `is-in` as an OR of equalities. */
function expand(query: Query): Query {
  const operands = query.operands.map((o) => (isRecord(o) ? expand(o as Query) : o))
  if (query.operator === 'IS-IN') {
    const [field, ...values] = operands
    return q('OR', ...values.map((v) => q('EQ', field as string, v)))
  }
  return { operator: query.operator, operands }
}

const PAGE = 250

type Page = { quotes?: Row[]; total?: number }

/** Yahoo's predefined screens answer to their upper-case name and give fuller records than a posted query does. */
async function predefined(ctx: NativeCtx, name: string, limit: number): Promise<Row[]> {
  const body = await yahooJson<{ finance?: { result?: Page[] | null } }>(ctx, `${Q1}/v1/finance/screener/predefined/saved`, {
    crumb: true,
    query: { corsDomain: 'finance.yahoo.com', formatted: 'false', lang: 'en-US', region: 'US', scrIds: name.toUpperCase(), count: limit === 0 ? PAGE : Math.min(limit, PAGE) },
  })
  return (body.finance?.result?.[0]?.quotes ?? []).filter(isRecord)
}

async function screen(ctx: NativeCtx, s: Screen, limit: number): Promise<Row[]> {
  const rows: Row[] = []
  for (let offset = 0; limit === 0 || rows.length < limit; offset += PAGE) {
    const size = limit === 0 ? PAGE : Math.min(PAGE, limit - rows.length)
    const body = await yahooJson<{ finance?: { result?: Page[] | null } }>(ctx, `${Q1}/v1/finance/screener`, {
      method: 'POST',
      crumb: true,
      query: { corsDomain: 'finance.yahoo.com', formatted: 'false', lang: 'en-US', region: 'US' },
      body: { offset, size, sortField: s.sortField, sortType: s.sortType, quoteType: s.quoteType, query: expand(s.query), userId: '', userIdType: 'guid' },
    })
    const result = body.finance?.result?.[0]
    const quotes = (result?.quotes ?? []).filter(isRecord)
    rows.push(...quotes)
    if (quotes.length < size || offset + quotes.length >= (result?.total ?? Infinity)) break
  }
  return rows
}

// Yahoo's quote fields that the screener rows name differently.
const RENAMED: [string, string][] = [
  ['shortName', 'name'], ['regularMarketPrice', 'price'], ['regularMarketChange', 'change'], ['regularMarketChangePercent', 'percent_change'], ['regularMarketVolume', 'volume'],
  ['regularMarketOpen', 'open'], ['regularMarketDayHigh', 'high'], ['regularMarketDayLow', 'low'], ['regularMarketPreviousClose', 'previous_close'],
  ['fiftyDayAverage', 'ma50'], ['twoHundredDayAverage', 'ma200'], ['fiftyTwoWeekHigh', 'year_high'], ['fiftyTwoWeekLow', 'year_low'], ['marketCap', 'market_cap'],
  ['sharesOutstanding', 'shares_outstanding'], ['bookValue', 'book_value'], ['priceToBook', 'price_to_book'], ['epsTrailingTwelveMonths', 'eps_ttm'], ['epsForward', 'eps_forward'],
  ['forwardPE', 'pe_forward'], ['trailingAnnualDividendYield', 'dividend_yield'], ['exchange', 'exchange'], ['exchangeTimezoneName', 'exchange_timezone'], ['currency', 'currency'],
]
const DROPPED = new Set(['dividendYield'])

/** "2026-09-08T16:00:00-04:00": a Yahoo timestamp on a time zone's clock, with its offset. */
function isoWithOffset(seconds: number, timeZone: string): string {
  const w = wallParts(seconds, timeZone)
  const offset = Math.round((Date.parse(`${w.date}T${w.time}Z`) / 1000 - seconds) / 60)
  const sign = offset < 0 ? '-' : '+'
  return `${w.date}T${w.time}${sign}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0')}:${String(Math.abs(offset) % 60).padStart(2, '0')}`
}

function row(quote: Row): Row {
  const out: Row = { symbol: quote.symbol }
  const used = new Set(['symbol'])
  for (const [from, to] of RENAMED) {
    used.add(from)
    const v = quote[from]
    if (v === undefined || v === null) continue
    out[to] = to === 'percent_change' && typeof v === 'number' ? v / 100 : v
  }
  // The dividend yield is the trailing one, zero for a stock that pays nothing.
  out.dividend_yield ??= 0
  if (typeof quote.earningsTimestamp === 'number') out.earnings_date = isoWithOffset(quote.earningsTimestamp, typeof quote.exchangeTimezoneName === 'string' ? quote.exchangeTimezoneName : 'America/New_York')
  for (const [k, v] of Object.entries(quote)) if (!used.has(k) && !DROPPED.has(k) && v !== undefined && v !== null) out[k] = v
  return out
}

const snake = (name: string): string => name.toLowerCase().replace(/&/g, ' ').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')

/** An industry named in snake case (`aerospace_defense`) as Yahoo's `peer_group` field, or its `industry` field for names the groups lack. */
function industryOperand(name: string): Query {
  const key = snake(name)
  const peer = screenerValues.peer_group.find((i) => snake(i) === key)
  if (peer) return q('EQ', 'peer_group', peer)
  const industry = screenerValues.industry.find((i) => snake(i) === key)
  if (industry) return q('EQ', 'industry', industry)
  throw new NativeUnsupported(`industry ${name} is not one Yahoo's screener lists`)
}

/** Floors a plain screen applies unless `universe` lifts them. */
const FLOORS = { price: 5, volume: 10_000 }

function customScreen(params: NativeParams): Screen {
  const assetType = typeof params.asset_type === 'string' ? params.asset_type : 'equity'
  if (assetType !== 'equity') throw new NativeUnsupported(`the native screener covers equities; ${assetType} screens are answered by the OpenBB API`)
  const universe = params.universe === true
  const all = (v: unknown): string[] => listParam(v).filter((x) => x.toLowerCase() !== 'all')
  const countries = all(params.country).map((c) => {
    if (!/^[A-Za-z]{2}$/.test(c)) throw new NativeUnsupported(`country ${c}: only two-letter codes`)
    return c.toLowerCase()
  })
  const operands: Query[] = []
  const exchanges = all(params.exchange)
  // Left open, a screen looks at the United States; an exchange on its own is enough to place it elsewhere.
  if (countries.length) operands.push(q('IS-IN', 'region', ...countries))
  else if (!exchanges.length) operands.push(us)
  if (exchanges.length) operands.push(q('IS-IN', 'exchange', ...exchanges.map((e) => e.toUpperCase())))
  const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)
  const between = (field: string, min: number | undefined, max: number | undefined): void => {
    if (min !== undefined) operands.push(q('GTE', field, min))
    if (max !== undefined) operands.push(q('LTE', field, max))
  }
  if (assetType === 'equity') {
    const sectors = all(params.sector).map((x) => x.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' '))
    if (sectors.length) operands.push(q('IS-IN', 'sector', ...sectors))
    if (typeof params.industry === 'string' && params.industry) operands.push(industryOperand(params.industry))
    // A universe screen lifts the market cap, price and volume floors (the market cap floor arrives as a default).
    between('intradayprice', universe ? undefined : (num(params.price_min) ?? FLOORS.price), num(params.price_max))
    between('dayvolume', universe ? undefined : (num(params.volume_min) ?? FLOORS.volume), num(params.volume_max))
    between('intradaymarketcap', universe ? undefined : (num(params.mktcap_min) ?? 500_000_000), num(params.mktcap_max))
    between('beta', num(params.beta_min), num(params.beta_max))
    return { quoteType: 'EQUITY', sortField: 'percentchange', sortType: 'DESC', query: and(...operands) }
  }
  if (typeof params.fund_issuer === 'string' && params.fund_issuer) operands.push(q('EQ', 'fundfamilyname', params.fund_issuer))
  if (typeof params.fund_style === 'string' && params.fund_style) operands.push(q('EQ', 'categoryname', params.fund_style))
  between('intradayprice', num(params.price_min), num(params.price_max))
  if (operands.length === 0) operands.push(us)
  return { quoteType: assetType === 'etf' ? 'ETF' : 'MUTUALFUND', sortField: 'fundnetassets', sortType: 'DESC', query: and(...operands) }
}

/** The columns a posted query's rows keep besides the renamed ones; a predefined screen's records keep everything. */
const CUSTOM_EXTRA = ['quoteType', 'longName', 'trailingPE', 'ytdReturn', 'trailingThreeMonthReturns', 'annualReturnNavY3', 'annualReturnNavY5', 'netExpenseRatio', 'yieldTTM', 'netAssets', 'openInterest']

export async function equityScreener(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  if (typeof params.config === 'string' && params.config) throw new NativeUnsupported('screener builder configurations are answered by the OpenBB API')
  const limit = typeof params.limit === 'number' ? params.limit : 200
  if (typeof params.preset === 'string' && params.preset) {
    if (!PREDEFINED[params.preset]) throw new NativeUnsupported(`screener preset ${params.preset} is a file of OpenBB's, not a Yahoo screen`)
    return (await predefined(ctx, params.preset, limit)).map(row)
  }
  const found = await screen(ctx, customScreen(params), limit)
  // A posted query's records lack some fields (trailing P/E, fund returns); the quote has them.
  const symbols = found.map((f) => String(f.symbol))
  const quotes = new Map<string, Row>()
  for (let i = 0; i < symbols.length; i += 50) for (const [k, v] of await v7Quote(ctx, symbols.slice(i, i + 50))) quotes.set(k, v)
  return found.map((f) => {
    const merged = { ...quotes.get(String(f.symbol)), ...f }
    const full = row(merged)
    const kept: Row = {}
    for (const [k, v] of Object.entries(full)) if (RENAMED.some(([, to]) => to === k) || k === 'symbol' || k === 'earnings_date' || CUSTOM_EXTRA.includes(k)) kept[k] = v
    return kept
  })
}
