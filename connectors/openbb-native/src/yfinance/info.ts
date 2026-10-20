// equity/price/quote, equity/profile, etf/info, equity/ownership/share_statistics, equity/fundamental/metrics and
// equity/fundamental/management, provider yfinance. Independent implementation of OpenBB's output for these routes
// (not derived from openbb_yfinance, which is AGPL); Yahoo endpoints as used by yfinance (Apache-2.0).
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { compact, raw, symbolsOf, utcDate } from './helpers.js'
import { quoteSummary, tickerInfo, trailingPegRatio } from './quote.js'

type Pick = [out: string, key: string]

/** Yahoo's field names → OpenBB's, for the keys a record holds. */
function pick(info: Row, fields: readonly Pick[]): Row {
  const row: Row = {}
  for (const [out, key] of fields) if (info[key] !== undefined && info[key] !== null) row[out] = info[key]
  return row
}

/** One row per symbol Yahoo knows, in the order asked. */
async function perSymbol(ctx: NativeCtx, symbols: string[], build: (symbol: string) => Promise<Row | undefined>): Promise<Row[]> {
  const rows: Row[] = []
  for (const symbol of symbols) {
    const row = await build(symbol)
    if (row && Object.keys(row).length > 1) rows.push(compact(row))
  }
  return rows
}

const QUOTE: readonly Pick[] = [
  ['symbol', 'symbol'], ['asset_type', 'quoteType'], ['name', 'longName'], ['exchange', 'exchange'],
  ['bid', 'bid'], ['bid_size', 'bidSize'], ['ask', 'ask'], ['ask_size', 'askSize'], ['last_price', 'currentPrice'],
  ['open', 'open'], ['high', 'dayHigh'], ['low', 'dayLow'], ['volume', 'volume'], ['prev_close', 'previousClose'],
  ['year_high', 'fiftyTwoWeekHigh'], ['year_low', 'fiftyTwoWeekLow'], ['ma_50d', 'fiftyDayAverage'], ['ma_200d', 'twoHundredDayAverage'],
  ['volume_average', 'averageVolume'], ['volume_average_10d', 'averageVolume10days'], ['currency', 'currency'],
]

export async function equityQuote(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  return perSymbol(ctx, symbolsOf(params), async (symbol) => {
    const info = await tickerInfo(ctx, symbol)
    return info && pick(info, QUOTE)
  })
}

const PROFILE: readonly Pick[] = [
  ['symbol', 'symbol'], ['name', 'longName'], ['stock_exchange', 'exchange'], ['long_description', 'longBusinessSummary'],
  ['company_url', 'website'], ['business_phone_no', 'phone'], ['hq_address1', 'address1'], ['hq_address_city', 'city'],
  ['hq_address_postal_code', 'zip'], ['hq_state', 'state'], ['hq_country', 'country'], ['employees', 'fullTimeEmployees'],
  ['sector', 'sector'], ['industry_category', 'industry'], ['issue_type', 'quoteType'], ['currency', 'currency'],
  ['market_cap', 'marketCap'], ['shares_outstanding', 'sharesOutstanding'], ['shares_float', 'floatShares'],
  ['shares_implied_outstanding', 'impliedSharesOutstanding'], ['shares_short', 'sharesShort'], ['dividend_yield', 'dividendYield'], ['beta', 'beta'],
]

export async function equityProfile(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  return perSymbol(ctx, symbolsOf(params), async (symbol) => {
    const info = await tickerInfo(ctx, symbol)
    return info && pick(info, PROFILE)
  })
}

const ETF_INFO: readonly Pick[] = [
  ['symbol', 'symbol'], ['name', 'longName'], ['description', 'longBusinessSummary'], ['fund_type', 'legalType'], ['fund_family', 'fundFamily'],
  ['category', 'category'], ['exchange', 'exchange'], ['currency', 'currency'], ['nav_price', 'navPrice'], ['total_assets', 'totalAssets'],
  ['trailing_pe', 'trailingPE'], ['dividend_yield', 'yield'], ['dividend_rate_ttm', 'trailingAnnualDividendRate'],
  ['dividend_yield_ttm', 'trailingAnnualDividendYield'], ['year_high', 'fiftyTwoWeekHigh'], ['year_low', 'fiftyTwoWeekLow'],
  ['ma_50d', 'fiftyDayAverage'], ['ma_200d', 'twoHundredDayAverage'], ['return_ytd', 'ytdReturn'], ['return_3y_avg', 'threeYearAverageReturn'],
  ['return_5y_avg', 'fiveYearAverageReturn'], ['beta_3y_avg', 'beta3Year'], ['volume_avg', 'averageVolume'], ['volume_avg_10d', 'averageVolume10days'],
  ['bid', 'bid'], ['bid_size', 'bidSize'], ['ask', 'ask'], ['ask_size', 'askSize'], ['open', 'open'], ['high', 'dayHigh'], ['low', 'dayLow'],
  ['volume', 'volume'], ['prev_close', 'previousClose'],
]

export async function etfInfo(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  return perSymbol(ctx, symbolsOf(params), async (symbol) => {
    const info = await tickerInfo(ctx, symbol)
    if (!info) return undefined
    if (info.quoteType !== 'ETF') throw new Error(`${symbol} is not an ETF.`)
    const row = pick(info, ETF_INFO)
    if (typeof info.fundInceptionDate === 'number') row.inception_date = utcDate(info.fundInceptionDate)
    return row
  })
}

const METRICS: readonly Pick[] = [
  ['symbol', 'symbol'], ['currency', 'currency'], ['market_cap', 'marketCap'], ['pe_ratio', 'trailingPE'], ['forward_pe', 'forwardPE'],
  ['peg_ratio', 'pegRatio'], ['peg_ratio_ttm', 'trailingPegRatio'], ['enterprise_to_ebitda', 'enterpriseToEbitda'],
  ['earnings_growth', 'earningsGrowth'], ['earnings_growth_quarterly', 'earningsQuarterlyGrowth'], ['revenue_per_share', 'revenuePerShare'],
  ['revenue_growth', 'revenueGrowth'], ['enterprise_to_revenue', 'enterpriseToRevenue'], ['quick_ratio', 'quickRatio'], ['current_ratio', 'currentRatio'],
  ['debt_to_equity', 'debtToEquity'], ['gross_margin', 'grossMargins'], ['operating_margin', 'operatingMargins'], ['ebitda_margin', 'ebitdaMargins'],
  ['profit_margin', 'profitMargins'], ['return_on_assets', 'returnOnAssets'], ['return_on_equity', 'returnOnEquity'], ['dividend_yield', 'dividendYield'],
  ['payout_ratio', 'payoutRatio'], ['book_value', 'bookValue'], ['price_to_book', 'priceToBook'], ['enterprise_value', 'enterpriseValue'],
  ['overall_risk', 'overallRisk'], ['audit_risk', 'auditRisk'], ['board_risk', 'boardRisk'], ['compensation_risk', 'compensationRisk'],
  ['shareholder_rights_risk', 'shareHolderRightsRisk'], ['beta', 'beta'], ['price_return_1y', '52WeekChange'],
]

export async function equityMetrics(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  return perSymbol(ctx, symbolsOf(params), async (symbol) => {
    const info = await tickerInfo(ctx, symbol)
    if (!info) return undefined
    const peg = await trailingPegRatio(ctx, symbol)
    if (peg !== undefined) info.trailingPegRatio = peg
    const row = pick(info, METRICS)
    // Yahoo's five-year average yield is a percent; the others are fractions.
    if (typeof info.fiveYearAvgDividendYield === 'number') row.dividend_yield_5y_avg = info.fiveYearAvgDividendYield / 100
    return row
  })
}

const SHARES: readonly Pick[] = [
  ['symbol', 'symbol'], ['float_shares', 'floatShares'], ['outstanding_shares', 'sharesOutstanding'], ['implied_shares_outstanding', 'impliedSharesOutstanding'],
  ['short_interest', 'sharesShort'], ['short_percent_of_float', 'shortPercentOfFloat'], ['days_to_cover', 'shortRatio'],
  ['short_interest_prev_month', 'sharesShortPriorMonth'], ['insider_ownership', 'heldPercentInsiders'], ['institution_ownership', 'heldPercentInstitutions'],
]

export async function shareStatistics(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  return perSymbol(ctx, symbolsOf(params), async (symbol) => {
    const [info, holders] = await Promise.all([tickerInfo(ctx, symbol), quoteSummary(ctx, symbol, ['majorHoldersBreakdown'])])
    if (!info) return undefined
    const row = pick(info, SHARES)
    if (typeof info.dateShortInterest === 'number') row.date = utcDate(info.dateShortInterest)
    if (typeof info.sharesShortPreviousMonthDate === 'number') row.short_interest_prev_date = utcDate(info.sharesShortPreviousMonthDate)
    const breakdown = (holders?.majorHoldersBreakdown ?? {}) as Row
    if (typeof breakdown.institutionsFloatPercentHeld === 'number') row.institution_float_ownership = breakdown.institutionsFloatPercentHeld
    if (typeof breakdown.institutionsCount === 'number') row.institutions_count = breakdown.institutionsCount
    return row
  })
}

export async function management(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const symbol = symbolsOf(params)[0]
  if (!symbol) return []
  const profile = await quoteSummary(ctx, symbol, ['assetProfile'])
  const officers = ((profile?.assetProfile as Row | undefined)?.companyOfficers ?? []) as Row[]
  if (officers.length === 0) throw new Error(`No executive data found for ${symbol}`)
  return officers.map((o) =>
    compact({ title: o.title, name: o.name, pay: raw(o.totalPay), year_born: raw(o.yearBorn), exercised_value: raw(o.exercisedValue), unexercised_value: raw(o.unexercisedValue), fiscal_year: raw(o.fiscalYear), age: raw(o.age) }),
  )
}
