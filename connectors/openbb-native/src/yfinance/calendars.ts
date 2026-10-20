// equity/calendar/earnings, equity/calendar/ipo, equity/calendar/splits, economy/calendar and yfinance/company_calendar,
// provider yfinance. Independent implementation of OpenBB's output for these routes (not derived from openbb_yfinance,
// which is AGPL); Yahoo endpoints as used by yfinance (Apache-2.0).
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { addDays, compact, Q1, raw, symbolsOf, todayNy, utcDate, wallParts, yahooJson } from './helpers.js'
import { quoteSummary } from './quote.js'

type Operand = string | number
export type Query = { operator: string; operands: (Operand | Query)[] }
const q = (operator: string, ...operands: (Operand | Query)[]): Query => ({ operator, operands })

type Doc = { columns: { id: string }[]; rows: unknown[][] }

/** One page of a Yahoo calendar: rows as records keyed by column id. */
export async function visualization(ctx: NativeCtx, entity: string, sortField: string, includeFields: string[], query: Query, size: number, offset = 0): Promise<Row[]> {
  const body = await yahooJson<{ finance?: { result?: { documents?: Doc[] }[] | null; error?: unknown } }>(ctx, `${Q1}/v1/finance/visualization`, {
    method: 'POST',
    crumb: true,
    query: { lang: 'en-US', region: 'US' },
    body: { sortType: 'DESC', entityIdType: entity, sortField, includeFields, size: Math.min(size, 100), offset, query },
  })
  const doc = body.finance?.result?.[0]?.documents?.[0]
  if (!doc) return []
  const ids = doc.columns.map((c) => c.id)
  return doc.rows.map((r) => Object.fromEntries(ids.map((id, i) => [id, r[i]])))
}

/** Yahoo's calendars: the window's start (today) and end (a week on) when the caller gives none. */
function window(params: NativeParams, ctx: NativeCtx): { start: string; end: string } {
  const start = typeof params.start_date === 'string' && params.start_date ? params.start_date : todayNy(ctx)
  const end = typeof params.end_date === 'string' && params.end_date ? params.end_date : addDays(start, 7)
  return { start, end }
}

const between = (field: string, start: string, end: string): Query[] => [q('gte', field, start), q('lte', field, end)]

/** A number, with zero (Yahoo's "none") left out. */
const nonZero = (v: unknown): number | undefined => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  return typeof n === 'number' && n !== 0 && Number.isFinite(n) ? n : undefined
}

/** The date of a Yahoo timestamp ("2026-10-20T20:00:00.000Z") on the New York clock. */
const easternDate = (stamp: unknown): string | undefined => (typeof stamp === 'string' ? wallParts(Date.parse(stamp) / 1000, 'America/New_York').date : undefined)

const MOST_ACTIVE = 'https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved'

/** The tickers of Yahoo's 200 most active stocks, which the earnings calendar is cut down to. */
async function mostActive(ctx: NativeCtx): Promise<string[]> {
  const body = await yahooJson<{ finance?: { result?: { quotes?: Row[] }[] } }>(ctx, MOST_ACTIVE, {
    crumb: true,
    query: { count: 200, formatted: 'false', scrIds: 'MOST_ACTIVES', corsDomain: 'finance.yahoo.com', lang: 'en-US', region: 'US' },
  })
  return (body.finance?.result?.[0]?.quotes ?? []).map((x) => String(x.symbol ?? '')).filter(Boolean)
}

export async function earningsCalendar(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const { start, end } = window(params, ctx)
  const limit = typeof params.limit === 'number' ? params.limit : 100
  const active = await mostActive(ctx)
  const query = q(
    'and',
    q('eq', 'region', 'us'),
    q('or', q('eq', 'eventtype', 'EAD'), q('eq', 'eventtype', 'ERA')),
    ...between('startdatetime', start, end),
    q('or', ...active.map((ticker) => q('eq', 'ticker', ticker))),
  )
  const rows = await visualization(ctx, 'sp_earnings', 'intradaymarketcap', ['ticker', 'companyshortname', 'intradaymarketcap', 'eventname', 'startdatetime', 'startdatetimetype', 'epsestimate', 'epsactual', 'epssurprisepct'], query, limit)
  return rows
    .sort((a, b) => String(b.startdatetime).localeCompare(String(a.startdatetime)))
    .map((r) =>
      compact({
        report_date: easternDate(r.startdatetime),
        symbol: r.ticker,
        name: r.companyshortname,
        eps_previous: nonZero(r.epsactual),
        eps_consensus: nonZero(r.epsestimate),
        market_cap: r.intradaymarketcap,
        timing: r.startdatetimetype,
        eps_surprise_percent: nonZero(r.epssurprisepct),
      }),
    )
}

export async function ipoCalendar(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const { start, end } = window(params, ctx)
  const query = q('or', ...['startdatetime', 'filingdate', 'amendeddate'].map((field) => q('gtelt', field, start, end)))
  const rows = await visualization(ctx, 'ipo_info', 'startdatetime', ['ticker', 'companyshortname', 'exchange_short_name', 'filingdate', 'startdatetime', 'amendeddate', 'pricefrom', 'priceto', 'offerprice', 'currencyname', 'shares', 'dealtype'], query, 12)
  return rows.map((r) =>
    compact({
      ipo_date: typeof r.startdatetime === 'string' ? r.startdatetime.slice(0, 10) : undefined,
      name: r.companyshortname,
      exchange: r.exchange_short_name,
      filing_date: typeof r.filingdate === 'string' ? r.filingdate.slice(0, 10) : undefined,
      price_from: nonZero(r.pricefrom),
      price_to: nonZero(r.priceto),
      price: nonZero(r.offerprice),
      currency: r.currencyname,
      shares: nonZero(r.shares),
      action: r.dealtype,
    }),
  )
}

export async function splitsCalendar(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const { start, end } = window(params, ctx)
  const query = q('and', ...between('startdatetime', start, end))
  const rows = await visualization(ctx, 'splits', 'startdatetime', ['ticker', 'companyshortname', 'startdatetime', 'optionable', 'old_share_worth', 'share_worth'], query, 12)
  return rows.map((r) =>
    compact({
      date: typeof r.startdatetime === 'string' ? r.startdatetime.slice(0, 10) : undefined,
      numerator: r.share_worth,
      denominator: r.old_share_worth,
      name: r.companyshortname,
      optionable: r.optionable,
    }),
  )
}

export async function economyCalendar(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const { start, end } = window(params, ctx)
  const query = q('and', ...between('startdatetime', start, end))
  const rows = await visualization(ctx, 'economic_event', 'startdatetime', ['econ_release', 'country_code', 'startdatetime', 'period', 'after_release_actual', 'consensus_estimate', 'prior_release_actual', 'originally_reported_actual'], query, 12)
  return rows.map((r) =>
    compact({
      date: typeof r.startdatetime === 'string' ? r.startdatetime.replace(/\.000Z$/, 'Z') : undefined,
      country: r.country_code,
      source: 'Yahoo Finance',
      consensus: nonZero(r.consensus_estimate),
      previous: nonZero(r.prior_release_actual),
      revised: nonZero(r.originally_reported_actual),
      actual: nonZero(r.after_release_actual),
      reference_period: r.period,
    }),
  )
}

/** The next earnings date, ex-dividend and dividend dates, and analyst ranges Yahoo shows on a company's calendar. */
export async function companyCalendar(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const rows: Row[] = []
  for (const symbol of symbolsOf(params)) {
    const events = (await quoteSummary(ctx, symbol, ['calendarEvents']))?.calendarEvents as Row | undefined
    if (!events) continue
    const earnings = (events.earnings ?? {}) as Row
    const dates = (earnings.earningsDate ?? []) as number[]
    rows.push(
      compact({
        symbol,
        earnings_date: typeof dates[0] === 'number' ? utcDate(dates[0]) : undefined,
        ex_dividend_date: typeof raw(events.exDividendDate) === 'number' ? utcDate(raw(events.exDividendDate) as number) : undefined,
        dividend_date: typeof raw(events.dividendDate) === 'number' ? utcDate(raw(events.dividendDate) as number) : undefined,
        earnings_high: raw(earnings.earningsHigh),
        earnings_low: raw(earnings.earningsLow),
        earnings_average: raw(earnings.earningsAverage),
        revenue_high: raw(earnings.revenueHigh),
        revenue_low: raw(earnings.revenueLow),
        revenue_average: raw(earnings.revenueAverage),
      }),
    )
  }
  return rows
}
