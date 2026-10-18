// Records the v1.2 fixtures (quoteSummary modules, options chains, dividend events) for the Vitest suite.
// Trimmed to the fields the connector reads so the files stay small. Live network; run once.
// From connectors/yahoo: pnpm exec tsx scripts/record-catalog.ts
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createYahooClient } from '../src/client.js'

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures')
mkdirSync(dir, { recursive: true })
const yf = createYahooClient()
const now = new Date()
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function save(name: string, data: unknown) {
  const file = join(dir, `${name}.json`)
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n')
  console.log(`wrote ${file}`)
}

const pick = <T extends object>(o: T | undefined, keys: string[]): Partial<T> | undefined =>
  o === undefined ? undefined : (Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, (o as Record<string, unknown>)[k]])) as Partial<T>)

const EQUITY_MODULES = ['assetProfile', 'price', 'summaryDetail', 'defaultKeyStatistics', 'financialData', 'earningsTrend', 'earningsHistory', 'insiderTransactions', 'institutionOwnership'] as const
const ETF_MODULES = ['assetProfile', 'price', 'summaryDetail', 'defaultKeyStatistics', 'topHoldings'] as const

function trimSummary(r: Record<string, any>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (r.assetProfile) out.assetProfile = pick(r.assetProfile, ['maxAge', 'sector', 'industry', 'fullTimeEmployees', 'longBusinessSummary'])
  if (r.price) out.price = pick(r.price, ['maxAge', 'symbol', 'quoteType', 'longName', 'shortName', 'exchange', 'exchangeName', 'marketCap', 'regularMarketPrice'])
  if (r.summaryDetail)
    out.summaryDetail = pick(r.summaryDetail, ['maxAge', 'marketCap', 'trailingPE', 'forwardPE', 'priceToSalesTrailing12Months', 'dividendYield', 'dividendRate', 'trailingAnnualDividendYield', 'beta', 'averageVolume', 'yield'])
  if (r.defaultKeyStatistics)
    out.defaultKeyStatistics = pick(r.defaultKeyStatistics, [
      'maxAge', 'forwardPE', 'pegRatio', 'enterpriseToEbitda', 'priceToBook', 'profitMargins', 'beta', 'beta3Year',
      'sharesShort', 'sharesShortPriorMonth', 'sharesShortPreviousMonthDate', 'dateShortInterest', 'shortRatio', 'shortPercentOfFloat', 'yield',
    ])
  if (r.financialData)
    out.financialData = pick(r.financialData, [
      'maxAge', 'currentPrice', 'targetHighPrice', 'targetLowPrice', 'targetMeanPrice', 'recommendationKey', 'recommendationMean', 'numberOfAnalystOpinions',
      'debtToEquity', 'returnOnEquity', 'earningsGrowth', 'revenueGrowth', 'grossMargins', 'operatingMargins', 'profitMargins',
    ])
  if (r.earningsTrend)
    out.earningsTrend = {
      maxAge: r.earningsTrend.maxAge,
      trend: r.earningsTrend.trend.map((t: any) => ({ period: t.period, endDate: t.endDate, growth: t.growth, earningsEstimate: t.earningsEstimate })),
    }
  if (r.earningsHistory) out.earningsHistory = r.earningsHistory
  if (r.insiderTransactions)
    out.insiderTransactions = {
      maxAge: r.insiderTransactions.maxAge,
      count: r.insiderTransactions.transactions.length,
      transactions: r.insiderTransactions.transactions.slice(0, 8).map((t: any) => pick(t, ['shares', 'value', 'filerUrl', 'transactionText', 'filerName', 'filerRelation', 'startDate', 'ownership'])),
    }
  if (r.institutionOwnership) out.institutionOwnership = { maxAge: r.institutionOwnership.maxAge, ownershipList: r.institutionOwnership.ownershipList }
  if (r.topHoldings) out.topHoldings = { maxAge: r.topHoldings.maxAge, stockPosition: r.topHoldings.stockPosition, holdings: r.topHoldings.holdings }
  return out
}

const summaries: Record<string, unknown> = {}
for (const [symbol, modules] of [['MU', EQUITY_MODULES], ['NVDA', EQUITY_MODULES], ['SMH', ETF_MODULES]] as const) {
  summaries[symbol] = trimSummary(await yf.quoteSummary(symbol, { modules: [...modules] }))
  await sleep(1500)
}
save('summaryModules', { recordedAt: now.toISOString(), bySymbol: summaries })

// Options: the default (nearest) expiration and two later ones, each trimmed to 14 strikes a side of the price.
const CONTRACT_KEYS = ['contractSymbol', 'strike', 'lastPrice', 'volume', 'openInterest', 'bid', 'ask', 'expiration', 'impliedVolatility', 'inTheMoney']
function trimChain(chain: any, price: number) {
  const strikes = [...new Set<number>([...chain.calls, ...chain.puts].map((c: any) => c.strike))].sort((a, b) => a - b)
  const below = strikes.filter((s) => s < price).slice(-14)
  const above = strikes.filter((s) => s >= price).slice(0, 14)
  const keep = new Set([...below, ...above])
  const trim = (list: any[]) => list.filter((c) => keep.has(c.strike)).map((c) => pick(c, CONTRACT_KEYS))
  return { expirationDate: chain.expirationDate, counts: { calls: chain.calls.length, puts: chain.puts.length }, calls: trim(chain.calls), puts: trim(chain.puts) }
}
const first = await yf.options('MU', {})
const price = first.quote.regularMarketPrice as number
const dates = first.expirationDates
const sevenOut = dates.find((d) => d.getTime() - now.getTime() >= 7 * 86_400_000) ?? dates[1]!
const far = dates[Math.min(10, dates.length - 1)]!
const byDate: Record<string, unknown> = { default: trimChain(first.options[0], price) }
for (const d of [sevenOut, far]) {
  await sleep(1500)
  const r = await yf.options('MU', { date: d })
  byDate[d.toISOString()] = trimChain(r.options[0], price)
}
save('options', {
  recordedAt: now.toISOString(),
  bySymbol: { MU: { underlyingSymbol: first.underlyingSymbol, expirationDates: dates, quote: pick(first.quote, ['symbol', 'regularMarketPrice', 'postMarketPrice', 'marketState', 'regularMarketTime']), byDate } },
})

// Dividends: chart events only (bars dropped), last 15 per symbol.
const dividends: Record<string, unknown> = {}
for (const symbol of ['MU', 'NVDA']) {
  await sleep(1500)
  const r = await yf.chart(symbol, { period1: new Date(now.getTime() - 30 * 365.25 * 86_400_000), interval: '1mo', events: 'div', includePrePost: false })
  const all = r.events?.dividends ?? []
  dividends[symbol] = { meta: pick(r.meta, ['symbol', 'currency']), count: all.length, events: { dividends: all.slice(-15) }, quotes: [] }
}
save('dividends', { recordedAt: now.toISOString(), bySymbol: dividends })
