// equity/fundamental/{filings,dividends,historical_splits}, equity/estimates/consensus, equity/ownership/insider_trading,
// tmx/equity/ownership/insider_transactions, equity/calendar/earnings and news/company, provider tmx. Ported from
// openbb_tmx/models/{company_filings,historical_dividends,historical_splits,price_target_consensus,insider_trading,
// insider_transactions,calendar_earnings,company_news}.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows
// instead of pydantic models.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { COMPANY_ANALYSTS, COMPANY_FILINGS, COMPANY_INSIDERS, DIVIDENDS_FOR_SYMBOL, EARNINGS_FOR_DATE, INSIDER_TRANSACTIONS, NEWS_AND_EVENTS, SPLITS_FOR_SYMBOL } from './gql.js'
import { addDays, applyAliases, compact, dateChunks, gql, inOrder, isoDay, listParam, mapLimit, normalizeSymbol, numParam, oneOf, optFloat, percent, pyRound, requiredSymbols, strParam, TmxError, toSnakeCase, toFloat, toZonedIso, truthy, weekday } from './helpers.js'

const NY = 'America/New_York'
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** `sorted(..., reverse=True)` on a string key: equal elements keep their original order. */
function sortedDesc<T>(items: T[], key: (item: T) => string): T[] {
  return items
    .map((item, i) => ({ item, i, k: key(item) }))
    .sort((a, b) => cmp(b.k, a.k) || a.i - b.i)
    .map((x) => x.item)
}

/** `dateutil.parser.parse(str(v)).date()` for the ISO dates the feeds send. */
function parseDay(v: unknown): string | undefined {
  if (!truthy(v)) return undefined
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v))
  if (!m) throw new TmxError(`Unknown string format: ${String(v)}`)
  return m[1]
}

// ---------------------------------------------------------------------------------------------------------------------

const FILINGS_ALIASES: Record<string, string> = { filing_date: 'filingDate', report_type: 'name', report_url: 'urlToPdf' }

/** equity/fundamental/filings: the filings of a company, one request per week of the window, newest first. */
export async function companyFilings(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const raw = strParam(params, 'symbol')
  if (!raw) throw new TmxError('Symbol is required for TMX.')
  const today = isoDay(ctx.now())
  const start = strParam(params, 'start_date') ?? addDays(today, -16 * 7)
  const end = strParam(params, 'end_date') ?? today
  const symbol = normalizeSymbol(raw.toUpperCase().replaceAll('-', '.').replaceAll('.TO', '').replaceAll('.TSX', ''))
  const pages = await mapLimit(dateChunks(start, end, 7), 6, async ([from, to]) => {
    const data = await gql<Row>(ctx, 'getCompanyFilings', COMPANY_FILINGS, { symbol, fromDate: from, toDate: to, limit: 1000 }, symbol)
    return (data?.filings as Row[] | undefined) ?? []
  })
  return sortedDesc(pages.flat(), (x) => String(x.filingDate)).map((d) => {
    const row = applyAliases(d, FILINGS_ALIASES)
    row.filing_date = parseDay(row.filing_date) ?? null
    return compact(row)
  })
}

const DIVIDEND_ALIASES: Record<string, string> = { ex_dividend_date: 'exDate', record_date: 'recordDate', payment_date: 'payableDate', declaration_date: 'declarationDate' }

/** equity/fundamental/dividends: the whole history, whatever the dates asked for (TMX has no date filter). */
export async function historicalDividends(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const symbol = normalizeSymbol(String(params.symbol).toUpperCase())
  const response = await gql<Row>(ctx, 'getDividendsForSymbol', DIVIDENDS_FOR_SYMBOL, { symbol, page: 1, batch: 500 }, symbol)
  const history = (response?.dividendHistory as Row | undefined) ?? {}
  const dividends = ((history.dividends as Row[] | undefined) ?? []).slice().sort((a, b) => cmp(String(a.exDate), String(b.exDate)))
  return dividends.map((d) => {
    const row = applyAliases(d, DIVIDEND_ALIASES)
    for (const k of ['ex_dividend_date', 'record_date', 'payment_date', 'declaration_date']) if (k in row) row[k] = parseDay(row[k]) ?? null
    if ('amount' in row) row.amount = optFloat(row.amount) ?? null
    return compact(row)
  })
}

/** equity/fundamental/historical_splits. */
export async function historicalSplits(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const symbol = normalizeSymbol(String(params.symbol).toUpperCase())
  let response: Row | null | undefined
  try {
    response = await gql<Row>(ctx, 'getSplitsForSymbol', SPLITS_FOR_SYMBOL, { symbol }, symbol)
  } catch (err) {
    if (!(err instanceof TmxError) || !err.message.includes('Cannot read properties of undefined')) throw err
    response = {}
  }
  const results = (response?.getSplitsForSymbol as Row[] | undefined) ?? []
  return sortedDesc(results, (d) => String(d.splitDate ?? '')).map((d) => compact({ date: parseDay(d.splitDate), ratio: optFloat(d.ratio) }))
}

const CONSENSUS_ALIASES: Record<string, string> = { target_consensus: 'price_target', target_high: 'price_target_high', target_low: 'price_target_low', target_upside: 'price_target_upside' }

/** equity/estimates/consensus: analyst ratings and price targets. */
export async function priceTargetConsensus(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const symbols = listParam(params).map((s) => s.toUpperCase())
  if (symbols.length === 0) throw new TmxError('Symbol is a required field for TMX.')
  const results = await inOrder(symbols, async (raw) => {
    const symbol = normalizeSymbol(raw)
    const response = await gql<Row>(ctx, 'getCompanyAnalysts', COMPANY_ANALYSTS, { symbol, datatype: 'equity' }, symbol)
    const data = response?.getCompanyAnalysts as Row | undefined
    if (!data) return []
    const consensus = data.consensusAnalysts as Row
    const target = data.priceTarget as Row
    return [
      {
        symbol,
        total_analysts: data.totalAnalysts,
        consensus_action: consensus.consensus,
        buy_ratings: consensus.buy,
        sell_ratings: consensus.sell,
        hold_ratings: consensus.hold,
        price_target: target.priceTarget,
        price_target_high: target.highPriceTarget,
        price_target_low: target.lowPriceTarget,
        price_target_upside: target.priceTargetUpside,
      },
    ]
  })
  return results.map((d) => {
    const row = applyAliases(d, CONSENSUS_ALIASES)
    row.target_upside = percent(row.target_upside) ?? null
    for (const k of ['target_consensus', 'target_high', 'target_low']) row[k] = truthy(row[k]) ? pyRound(toFloat(row[k]), 2) : null
    return compact(row)
  })
}

/** equity/ownership/insider_trading: the insiders of a company by period, or the period totals with `summary`. */
export async function insiderTrading(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const symbol = normalizeSymbol(String(params.symbol).toUpperCase())
  const summary = params.summary === true || params.summary === 'true'
  const response = await gql<Row>(ctx, 'getCompanyInsidersActivities', COMPANY_INSIDERS, { symbol }, symbol)
  const data = response?.getCompanyInsidersActivities as Row | undefined
  if (!data || Object.keys(data).length === 0) return []

  const insiders: Row[] = []
  for (const activity of (data.insiderActivities as Row[] | undefined) ?? []) {
    for (const type of ['buy', 'sell']) {
      for (const t of (activity[type] as Row[] | undefined) ?? []) {
        insiders.push({
          period: activity.periodkey,
          acquisition_or_disposition: type,
          owner_name: t.name,
          number_of_trades: t.trades,
          securities_transacted: t.shares,
          securities_owned: t.sharesHeld,
          trade_value: t.tradeValue,
        })
      }
    }
  }
  const totals: Row[] = ((data.activitySummary as Row[] | undefined) ?? []).map((a) => ({
    period: a.periodkey,
    securities_bought: a.buyShares,
    securities_sold: a.soldShares,
    net_activity: a.netActivity,
    securities_transacted: a.totalShares,
  }))
  const chosen = !summary && insiders.length > 0 ? insiders : summary && totals.length > 0 ? totals : []
  return chosen.map((d) => {
    const row: Row = { ...d }
    // period_to_snake_case
    row.period = truthy(row.period) ? toSnakeCase(String(row.period)) : null
    return compact(row)
  })
}

const INSIDER_DURATIONS: Record<string, number> = { '3m': 3, '6m': 6, '12m': 12, '24m': 24, '36m': 36, '60m': 60, '120m': 120 }

const INSIDER_TX_ALIASES: Record<string, string> = {
  owner_name: 'filer',
  transaction_date: 'date',
  filing_date: 'filingdate',
  transaction_type: 'type',
  transaction_type_code: 'transactionTypeCode',
  securities_transacted: 'amount',
  securities_owned: 'amountowned',
  ownership_type: 'amounttype',
  price: 'pricefrom',
  currency: 'pricefromcurrency',
  market_value: 'marketvalue',
  security_type: 'securitydesignation',
  underlying_security_type: 'underlyingsecuritydesignation',
  underlying_shares: 'equivalentunderlying',
  insider_since: 'insiderstartdate',
  filing_id: 'transactionid',
  issuer_number: 'issuernumber',
  insider_number: 'insiderNumber',
}

/** tmx/equity/ownership/insider_transactions: individual SEDI filings, newest first. */
export async function insiderTransactions(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const symbol = requiredSymbols(params)[0]!.toUpperCase()
  const period = oneOf(params, 'period', Object.keys(INSIDER_DURATIONS), '12m')
  const response = await gql<Row>(ctx, 'getInsiderTransactions', INSIDER_TRANSACTIONS, { symbol, monthDuration: INSIDER_DURATIONS[period] }, symbol)
  const filings = response?.getInsiderTransactions
  const data = Array.isArray(filings) ? (filings as Row[]) : []
  if (data.length === 0) return []
  const published = new Set([...Object.values(INSIDER_TX_ALIASES), 'relationship'])
  return sortedDesc(data, (row) => String(row.date)).map((row) => {
    const kept = Object.fromEntries(Object.entries(row).filter(([k]) => published.has(k)))
    const out = applyAliases(kept, INSIDER_TX_ALIASES)
    for (const k of ['transaction_date', 'filing_date', 'insider_since']) if (k in out) out[k] = parseDay(out[k]) ?? null
    for (const k of ['transaction_type_code', 'securities_transacted', 'securities_owned', 'price', 'market_value', 'underlying_shares', 'filing_id']) if (k in out) out[k] = optFloat(out[k]) ?? null
    return compact(out)
  })
}

const EARNINGS_ALIASES: Record<string, string> = {
  eps_actual: 'actualEps',
  reporting_time: 'announceTime',
  eps_consensus: 'estimatedEps',
  eps_surprise: 'epsSurpriseDollar',
  surprise_percent: 'epsSurprisePercent',
  name: 'companyName',
}

/** equity/calendar/earnings: the earnings reported on each business day of the window. */
export async function calendarEarnings(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const today = isoDay(ctx.now())
  const start = strParam(params, 'start_date') ?? today
  const end = strParam(params, 'end_date') ?? addDays(today, 5)
  const days: string[] = []
  for (let d = start; d <= end; d = addDays(d, 1)) if (weekday(d) < 5) days.push(d)

  const pages = await mapLimit(days, 6, async (date) => {
    let response: Row | null | undefined
    try {
      response = await gql<Row>(ctx, 'getEnhancedEarningsForDate', EARNINGS_FOR_DATE, { date })
    } catch (err) {
      if (err instanceof TmxError && err.message.includes('Cannot read properties of undefined')) return []
      throw err
    }
    return ((response?.getEnhancedEarningsForDate as Row[] | undefined) ?? []).map((d) => ({ report_date: date, ...d }))
  })
  const results = pages.flat().sort((a, b) => cmp(String(a.report_date), String(b.report_date)))
  return results.map((d) => {
    const row = applyAliases(Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v === 'N/A' ? null : v])), EARNINGS_ALIASES)
    row.surprise_percent = percent(row.surprise_percent) ?? null
    for (const k of ['eps_consensus', 'eps_actual', 'eps_surprise']) if (k in row) row[k] = optFloat(row[k]) ?? null
    return compact(row)
  })
}

const NEWS_ALIASES: Record<string, string> = { date: 'datetime', title: 'headline' }

/** news/company: headlines for each symbol, newest first. */
export async function companyNews(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const symbols = listParam(params).map((s) => s.toUpperCase())
  if (symbols.length === 0) throw new TmxError('Symbol is a required field for TMX.')
  const page = numParam(params, 'page') || 1
  const limit = numParam(params, 'limit') || 100
  const results = await inOrder(symbols, async (raw) => {
    const symbol = normalizeSymbol(raw)
    const data = (await gql<Row>(ctx, 'getNewsAndEvents', NEWS_AND_EVENTS, { symbol, page, limit, locale: 'en' }, symbol)) ?? {}
    return ((data.news as Row[] | undefined) ?? []).map((item) => {
      const { newsid, summary: _summary, ...rest } = item
      return { ...rest, url: `https://money.tmx.com/quote/${symbol.toUpperCase()}/news/${String(newsid)}`, symbols: symbol }
    })
  })
  return sortedDesc(results, (d) => String(d.datetime)).map((d) => {
    const row = applyAliases(d, NEWS_ALIASES)
    // date_validate: the New York wall time of an ISO timestamp.
    row.date = toZonedIso(Date.parse(String(row.date)), NY)
    return compact(row)
  })
}
