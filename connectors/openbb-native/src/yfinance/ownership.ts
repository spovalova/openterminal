// equity/ownership/insider_trading and yfinance/ownership/{insider_purchases, insider_roster, institutional, major,
// mutual_fund}, provider yfinance. Independent implementation of OpenBB's output for these routes (not derived from
// openbb_yfinance, which is AGPL); Yahoo endpoints as used by yfinance (Apache-2.0).
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { compact, isRecord, raw, symbolsOf, utcDate } from './helpers.js'
import { quoteSummary } from './quote.js'

const list = (v: unknown): Row[] => (Array.isArray(v) ? v.filter(isRecord) : [])
const date = (v: unknown): string | undefined => (typeof raw(v) === 'number' ? utcDate(raw(v) as number) : undefined)

async function forSymbols(params: NativeParams, ctx: NativeCtx, modules: string[], build: (symbol: string, result: Row) => Row[]): Promise<Row[]> {
  const rows: Row[] = []
  for (const symbol of symbolsOf(params)) {
    const result = await quoteSummary(ctx, symbol, modules)
    if (result) rows.push(...build(symbol, result).map(compact))
  }
  return rows
}

/** Insider transactions, newest first; the limit is per symbol. */
export async function insiderTrading(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const limit = typeof params.limit === 'number' ? params.limit : undefined
  return forSymbols(params, ctx, ['insiderTransactions'], (symbol, result) =>
    list((result.insiderTransactions as Row | undefined)?.transactions)
      .map((t) => ({
        symbol,
        transaction_date: date(t.startDate),
        owner_name: t.filerName,
        owner_title: t.filerRelation,
        ownership_type: t.ownership,
        transaction_type: t.moneyText,
        securities_transacted: raw(t.shares),
        filing_url: t.filerUrl,
        transaction_value: raw(t.value),
        description: t.transactionText,
      }))
      .slice(0, limit),
  )
}

/** The six-month summary of insider buying and selling, as the table Yahoo shows. */
export const insiderPurchases = (params: NativeParams, ctx: NativeCtx): Promise<Row[]> =>
  forSymbols(params, ctx, ['netSharePurchaseActivity'], (symbol, result) => {
    const n = (result.netSharePurchaseActivity ?? {}) as Row
    return [
      { symbol, category: 'Purchases', shares: raw(n.buyInfoShares), transactions: raw(n.buyInfoCount) },
      { symbol, category: 'Sales', shares: raw(n.sellInfoShares), transactions: raw(n.sellInfoCount) },
      { symbol, category: 'Net Shares Purchased (Sold)', shares: raw(n.netInfoShares), transactions: raw(n.netInfoCount) },
      { symbol, category: 'Total Insider Shares Held', shares: raw(n.totalInsiderShares) },
      { symbol, category: '% Net Shares Purchased (Sold)', shares: raw(n.netPercentInsiderShares) },
      { symbol, category: '% Buy Shares', shares: raw(n.buyPercentInsiderShares) },
      { symbol, category: '% Sell Shares', shares: raw(n.sellPercentInsiderShares) },
    ].filter((r) => r.shares !== undefined && r.shares !== null)
  })

/** Insiders Yahoo lists for a company, with their latest transaction and direct holding. */
export const insiderRoster = (params: NativeParams, ctx: NativeCtx): Promise<Row[]> =>
  forSymbols(params, ctx, ['insiderHolders'], (symbol, result) =>
    list((result.insiderHolders as Row | undefined)?.holders).map((h) => ({
      symbol,
      name: h.name,
      position: h.relation,
      url: h.url,
      most_recent_transaction: h.transactionDescription,
      latest_transaction_date: date(h.latestTransDate),
      shares_owned_directly: raw(h.positionDirect),
      position_direct_date: date(h.positionDirectDate),
    })),
  )

const holders = (module: 'institutionOwnership' | 'fundOwnership') => (params: NativeParams, ctx: NativeCtx): Promise<Row[]> =>
  forSymbols(params, ctx, [module], (symbol, result) =>
    list((result[module] as Row | undefined)?.ownershipList).map((o) => ({
      symbol,
      date_reported: date(o.reportDate),
      holder: o.organization,
      percent_held: raw(o.pctHeld),
      shares: raw(o.position),
      value: raw(o.value),
      percent_change: raw(o.pctChange),
    })),
  )

export const institutionalHolders = holders('institutionOwnership')
export const mutualFundHolders = holders('fundOwnership')

/** Insider and institutional ownership shares of the company. */
export const majorHolders = (params: NativeParams, ctx: NativeCtx): Promise<Row[]> =>
  forSymbols(params, ctx, ['majorHoldersBreakdown'], (symbol, result) => {
    const b = (result.majorHoldersBreakdown ?? {}) as Row
    return [{ symbol, insiders_percent_held: raw(b.insidersPercentHeld), institutions_percent_held: raw(b.institutionsPercentHeld), institutions_float_percent_held: raw(b.institutionsFloatPercentHeld), institutions_count: raw(b.institutionsCount) }]
  })
