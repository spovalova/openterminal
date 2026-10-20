// equity/price/quote and equity/profile, provider tmx. Ported from openbb_tmx/models/equity_quote.py and
// equity_profile.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models, and the
// quote and profile rows are built by the same alias table that pydantic applies.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { QUOTE_BY_SYMBOL, QUOTE_FOR_SYMBOLS } from './gql.js'
import { applyAliases, compact, gql, listParam, normalizeSymbol, normalizeUrl, optFloat, pyRound, toFloat, truthy, TmxError } from './helpers.js'

const QUOTE_ALIASES: Record<string, string> = {
  last_price: 'price',
  open: 'openPrice',
  high: 'dayHigh',
  low: 'dayLow',
  change: 'priceChange',
  change_percent: 'percentChange',
  prev_close: 'prevClose',
  stock_exchange: 'exchangeCode',
  industry_category: 'industry',
  industry_group: 'qmdescription',
  exchange: 'exchangeCode',
  security_type: 'datatype',
  year_high: 'weeks52high',
  year_low: 'weeks52low',
  ma_21: 'day21MovingAvg',
  ma_50: 'day50MovingAvg',
  ma_200: 'day200MovingAvg',
  volume_avg_10d: 'averageVolume10D',
  volume_avg_30d: 'averageVolume30D',
  volume_avg_50d: 'averageVolume50D',
  market_cap: 'marketCap',
  market_cap_all_classes: 'MarketCapAllClasses',
  div_amount: 'dividendAmount',
  div_currency: 'dividendCurrency',
  div_yield: 'dividendYield',
  div_freq: 'dividendFrequency',
  div_ex_date: 'exDividendDate',
  div_pay_date: 'dividendPayDate',
  div_growth_3y: 'dividend3Years',
  div_growth_5y: 'dividend5Years',
  pe: 'peRatio',
  debt_to_equity: 'totalDebtToEquity',
  price_to_book: 'priceToBook',
  price_to_cf: 'priceToCashFlow',
  return_on_equity: 'returnOnEquity',
  return_on_assets: 'returnOnAssets',
  shares_outstanding: 'shareOutStanding',
  shares_escrow: 'sharesESCROW',
  shares_total: 'totalSharesOutStanding',
}

/** Fields whose validators turn percents into fractions: `round(float(v) / 100, 6) if v else None`. */
const QUOTE_PERCENTS = ['return_on_equity', 'return_on_assets', 'div_yield', 'div_growth_3y', 'div_growth_5y', 'change_percent']
const QUOTE_DATES = ['div_ex_date', 'div_pay_date']
const QUOTE_FLOATS = ['last_price', 'open', 'high', 'low', 'close', 'vwap', 'prev_close', 'change', 'year_high', 'year_low', 'ma_21', 'ma_50', 'ma_200', 'div_amount']
const QUOTE_INTS = ['volume', 'volume_avg_10d', 'volume_avg_30d', 'volume_avg_50d', 'market_cap', 'market_cap_all_classes', 'shares_outstanding', 'shares_escrow', 'shares_total']

/** The date validator: `YYYY-MM-DD` or `YYYY-MM-DD HH:MM:SS.ffffff`, anything else is an error. */
function dateOnly(v: unknown): string | undefined {
  if (!truthy(v)) return undefined
  const s = String(v)
  const m = /^(\d{4}-\d{2}-\d{2})(?: \d{2}:\d{2}:\d{2}\.\d+)?$/.exec(s)
  if (!m) throw new TmxError(`time data '${s}' does not match format '%Y-%m-%d'`)
  return m[1]
}

/** Quotes for symbols the single-symbol feed does not serve (`_quote_batch`). */
async function quoteBatch(ctx: NativeCtx, symbols: string[]): Promise<Row[]> {
  const response = await gql<Row>(ctx, 'getQuoteForSymbols', QUOTE_FOR_SYMBOLS, { symbols }, symbols.join(','))
  const rows = ((response?.getQuoteForSymbols as Row[] | undefined) ?? []).filter((row) => row.price !== null && row.price !== undefined)
  return rows
}

export async function equityQuote(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const symbols = listParam(params).map((s) => s.toUpperCase())
  const results: Row[] = []
  const unquoted: string[] = []

  await Promise.all(
    symbols.map(async (raw) => {
      const symbol = normalizeSymbol(raw)
      let response: Row | null | undefined
      try {
        response = await gql<Row>(ctx, 'getQuoteBySymbol', QUOTE_BY_SYMBOL, { symbol, locale: 'en' }, symbol)
      } catch (err) {
        if (!(err instanceof TmxError)) throw err
        response = undefined
      }
      const quote = response?.getQuoteBySymbol as Row | undefined
      if (quote) results.push(quote)
      else unquoted.push(symbol)
    }),
  )
  if (unquoted.length > 0) results.push(...(await quoteBatch(ctx, unquoted)))

  const dropped = new Set(['shortDescription', 'longDescription', 'website', 'phoneNumber', 'fullAddress', 'email', 'issueType', 'exchangeName', 'employees', 'exShortName'])
  const order = new Map(symbols.map((s, i) => [s, i]))
  const rows = results
    .map((d) => {
      const kept: Row = {}
      for (const [k, v] of Object.entries(d)) {
        if (dropped.has(k)) continue
        // `v in (nan, 0, "")`: zero, false and the empty string mean missing.
        kept[k] = v === 0 || v === false || v === '' ? null : v
      }
      return kept
    })
    .sort((a, b) => (order.get(String(a.symbol)) ?? symbols.length) - (order.get(String(b.symbol)) ?? symbols.length))

  return rows.map((d) => {
    const row = applyAliases(d, QUOTE_ALIASES)
    for (const k of QUOTE_PERCENTS) if (k in row) row[k] = truthy(row[k]) ? pyRound(toFloat(row[k]) / 100, 6) : null
    for (const k of QUOTE_DATES) if (k in row) row[k] = dateOnly(row[k]) ?? null
    for (const k of [...QUOTE_FLOATS, ...QUOTE_INTS]) if (k in row) row[k] = optFloat(row[k]) ?? null
    return compact(row)
  })
}

const PROFILE_ALIASES: Record<string, string> = {
  short_description: 'shortDescription',
  long_description: 'longDescription',
  company_url: 'website',
  business_phone_no: 'phoneNumber',
  business_address: 'fullAddress',
  stock_exchange: 'exchangeCode',
  industry_category: 'industry',
  industry_group: 'qmdescription',
  issue_type: 'issueType',
  // The declared field accepts its camelCase name too (every Data field has a camel validation alias).
  dividend_frequency: 'dividendFrequency',
  share_outstanding: 'shareOutStanding',
  shares_escrow: 'sharesESCROW',
  total_shares_outstanding: 'totalSharesOutStanding',
}

const PROFILE_KEEP = new Set(['shortDescription', 'longDescription', 'website', 'phoneNumber', 'fullAddress', 'sector', 'qmdescription', 'industry', 'exchangeCode', 'shareOutStanding', 'sharesESCROW', 'totalSharesOutStanding', 'email', 'issueType', 'name', 'symbol', 'dividendFrequency', 'employees'])

export async function equityProfile(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const symbols = listParam(params).map((s) => s.toUpperCase())
  const results: Row[] = []
  await Promise.all(
    symbols.map(async (raw) => {
      const symbol = normalizeSymbol(raw)
      const response = await gql<Row>(ctx, 'getQuoteBySymbol', QUOTE_BY_SYMBOL, { symbol, locale: 'en' }, symbol)
      const quote = response?.getQuoteBySymbol as Row | undefined
      if (quote) results.push(quote)
    }),
  )
  const order = new Map(symbols.map((s, i) => [s, i]))
  return results
    .map((d) => Object.fromEntries(Object.entries(d).filter(([k]) => PROFILE_KEEP.has(k))))
    .sort((a, b) => (order.get(String(a.symbol)) ?? symbols.length) - (order.get(String(b.symbol)) ?? symbols.length))
    .map((d) => {
      // validate_empty_strings: the empty string is missing.
      const blank = Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v === '' ? null : v]))
      const row = applyAliases(blank, PROFILE_ALIASES)
      if ('company_url' in row) row.company_url = normalizeUrl(row.company_url) ?? null
      for (const k of ['employees', 'shares_escrow']) if (k in row) row[k] = optFloat(row[k]) ?? null
      return compact(row)
    })
}
