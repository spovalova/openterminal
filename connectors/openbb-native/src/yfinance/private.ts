// yfinance/private_companies, provider yfinance. Independent implementation of OpenBB's output for this route (not
// derived from openbb_yfinance, which is AGPL); Yahoo endpoints as used by yfinance (Apache-2.0).
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { compact, isRecord, Q1, raw, utcDate, yahooJson } from './helpers.js'
import { quoteSummary } from './quote.js'

/** How Yahoo sorts each list: by implied valuation, 52-week move, funding date or total funding, highest first. */
const SORT: Record<string, string> = {
  highest_valuation: 'latest_implied_valuation',
  '52_week_gainers': 'fiftytwowkpercentchange',
  recently_funded: 'latest_funding_date',
  most_funded: 'funding_to_date',
}

/** Yahoo's screener over private companies. */
export async function screenPrivate(ctx: NativeCtx, sortField: string, size: number): Promise<Row[]> {
  const body = await yahooJson<{ finance?: { result?: { quotes?: Row[] }[] | null } }>(ctx, `${Q1}/v1/finance/screener`, {
    method: 'POST',
    crumb: true,
    query: { corsDomain: 'finance.yahoo.com', formatted: 'false', lang: 'en-US', region: 'US' },
    body: { offset: 0, size, sortField, sortType: 'DESC', quoteType: 'PRIVATE_COMPANY', query: { operator: 'AND', operands: [{ operator: 'EQ', operands: ['region', 'us'] }] }, userId: '', userIdType: 'guid' },
  })
  return (body.finance?.result?.[0]?.quotes ?? []).filter(isRecord)
}

export async function privateCompanies(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const category = typeof params.category === 'string' && params.category ? params.category : 'highest_valuation'
  const limit = typeof params.limit === 'number' ? params.limit : 100
  const quotes = await screenPrivate(ctx, SORT[category] ?? SORT.highest_valuation!, Math.min(limit, 250))
  const rows: Row[] = []
  for (const q of quotes.slice(0, limit)) {
    const symbol = String(q.symbol)
    const summary = await quoteSummary(ctx, symbol, ['assetProfile', 'defaultKeyStatistics'])
    const profile = (summary?.assetProfile ?? {}) as Row
    const stats = (summary?.defaultKeyStatistics ?? {}) as Row
    const team = (Array.isArray(profile.executiveTeam) ? profile.executiveTeam : []).filter(isRecord)
    const funded = raw(stats.latestFundingDate)
    rows.push(
      compact({
        symbol,
        name: q.longName ?? q.shortName,
        valuation: raw(stats.latestImpliedValuation),
        funding_to_date: raw(stats.fundingToDate),
        latest_amount_raised: raw(stats.latestAmountRaised),
        latest_funding_date: typeof funded === 'number' ? utcDate(funded) : undefined,
        latest_share_class: stats.latestShareClass,
        lead_investor: stats.leadInvestor,
        total_funding_rounds: raw(stats.totalFundingRounds),
        change_52_week: raw(stats['52WeekChange']),
        price: q.regularMarketPrice,
        employees: raw(profile.fullTimeEmployees),
        date_founded: profile.dateFounded,
        sector: profile.sector,
        industry: profile.industry,
        city: profile.city,
        state: profile.state,
        country: profile.country,
        website: profile.website,
        lead_executives: team.length ? team.map((t) => `${String(t.name)} (${String(t.title)})`).join(', ') : undefined,
        summary: profile.longBusinessSummary,
      }),
    )
  }
  return rows
}
