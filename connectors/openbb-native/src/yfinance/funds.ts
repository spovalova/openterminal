// yfinance/funds/{info, allocation, holdings, performance, ratings, risk}, provider yfinance. Independent
// implementation of OpenBB's output for these routes (not derived from openbb_yfinance, which is AGPL); Yahoo endpoints
// as used by yfinance (Apache-2.0).
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { priceHistory } from './chart.js'
import { compact, isRecord, raw, symbolsOf, todayNy } from './helpers.js'
import { quoteSummary } from './quote.js'

const record = (v: unknown): Row => (isRecord(v) ? v : {})
const list = (v: unknown): Row[] => (Array.isArray(v) ? v.filter(isRecord) : [])

/** A fund's quoteSummary modules; throws like OpenBB does for a symbol that is not a fund. */
async function fundModules(ctx: NativeCtx, symbol: string, modules: string[]): Promise<Row | undefined> {
  const result = await quoteSummary(ctx, symbol, modules)
  if (!result) return undefined
  const type = record(result.quoteType).quoteType
  if (type !== undefined && type !== 'ETF' && type !== 'MUTUALFUND') throw new Error(`${symbol} is not a fund (it is ${String(type)}).`)
  return result
}

export async function fundInfo(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const rows: Row[] = []
  for (const symbol of symbolsOf(params)) {
    const r = await fundModules(ctx, symbol, ['quoteType', 'summaryProfile', 'topHoldings', 'fundProfile'])
    if (!r) continue
    const profile = record(r.fundProfile)
    const ops = record(profile.feesExpensesInvestment)
    const cat = record(profile.feesExpensesInvestmentCat)
    const equity = record(record(r.topHoldings).equityHoldings)
    const bond = record(record(r.topHoldings).bondHoldings)
    rows.push(
      compact({
        symbol,
        category: profile.categoryName,
        family: profile.family,
        legal_type: profile.legalType,
        description: record(r.summaryProfile).longBusinessSummary,
        annual_report_expense_ratio: raw(ops.annualReportExpenseRatio),
        annual_report_expense_ratio_category: raw(cat.annualReportExpenseRatio),
        annual_holdings_turnover: raw(ops.annualHoldingsTurnover),
        annual_holdings_turnover_category: raw(cat.annualHoldingsTurnover),
        total_net_assets: raw(ops.totalNetAssets),
        price_to_earnings: raw(equity.priceToEarnings),
        price_to_book: raw(equity.priceToBook),
        price_to_sales: raw(equity.priceToSales),
        price_to_cashflow: raw(equity.priceToCashflow),
        median_market_cap: raw(equity.medianMarketCap),
        three_year_earnings_growth: raw(equity.threeYearEarningsGrowth),
        bond_duration: raw(bond.duration),
        bond_maturity: raw(bond.maturity),
        bond_credit_quality: raw(bond.creditQuality),
      }),
    )
  }
  return rows
}

const ASSET_CLASSES: [string, string][] = [['cashPosition', 'Cash'], ['stockPosition', 'Stock'], ['bondPosition', 'Bond'], ['preferredPosition', 'Preferred'], ['convertiblePosition', 'Convertible'], ['otherPosition', 'Other']]

/** `consumer_cyclical` → `Consumer Cyclical`. */
const titleCase = (key: string): string => key.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')

/** The weights by asset class, by sector and by bond rating. */
export async function fundAllocation(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const breakdown = typeof params.breakdown === 'string' && params.breakdown ? params.breakdown : 'all'
  const rows: Row[] = []
  for (const symbol of symbolsOf(params)) {
    const r = await fundModules(ctx, symbol, ['quoteType', 'summaryProfile', 'topHoldings', 'fundProfile'])
    if (!r) continue
    const top = record(r.topHoldings)
    if (breakdown === 'all' || breakdown === 'asset_class') {
      for (const [key, category] of ASSET_CLASSES) if (raw(top[key]) !== undefined && raw(top[key]) !== null) rows.push({ symbol, breakdown: 'asset_class', category, weight: raw(top[key]) })
    }
    if (breakdown === 'all' || breakdown === 'sector') {
      for (const w of list(top.sectorWeightings)) for (const [key, weight] of Object.entries(w)) rows.push({ symbol, breakdown: 'sector', category: titleCase(key), weight: raw(weight) })
    }
    if (breakdown === 'all' || breakdown === 'bond_rating') {
      for (const w of list(top.bondRatings)) for (const [key, weight] of Object.entries(w)) rows.push({ symbol, breakdown: 'bond_rating', category: key.toUpperCase(), weight: raw(weight) })
    }
  }
  return rows
}

/** The ten largest holdings Yahoo lists for each fund. */
export async function fundHoldings(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const rows: Row[] = []
  for (const symbol of symbolsOf(params)) {
    const r = await fundModules(ctx, symbol, ['quoteType', 'summaryProfile', 'topHoldings', 'fundProfile'])
    if (!r) continue
    for (const h of list(record(r.topHoldings).holdings)) rows.push(compact({ symbol: h.symbol, name: h.holdingName, weight: raw(h.holdingPercent), fund: symbol }))
  }
  return rows
}

// Morningstar's style box grid, in the order of the numbers in Yahoo's style box image names.
const EQUITY_SIZE = ['Large', 'Mid', 'Small']
const EQUITY_STYLE = ['Value', 'Blend', 'Growth']
const BOND_QUALITY = ['High', 'Medium', 'Low']
const BOND_SENSITIVITY = ['Limited', 'Moderate', 'Extensive']

export async function fundRatings(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const rows: Row[] = []
  for (const symbol of symbolsOf(params)) {
    const r = await fundModules(ctx, symbol, ['quoteType', 'fundProfile', 'defaultKeyStatistics'])
    if (!r) continue
    const profile = record(r.fundProfile)
    const stats = record(r.defaultKeyStatistics)
    const row: Row = {
      symbol,
      morningstar_overall_rating: raw(stats.morningStarOverallRating),
      morningstar_risk_rating: raw(stats.morningStarRiskRating),
      category: profile.categoryName,
      family: profile.family,
      legal_type: profile.legalType,
    }
    const url = typeof profile.styleBoxUrl === 'string' ? profile.styleBoxUrl : undefined
    const box = url && /(eq|bd)(\d)\.gif$/.exec(url)
    if (url && box) {
      const n = Number(box[2])
      const col = (n - 1) % 3
      const line = Math.floor((n - 1) / 3)
      row.style_box = n
      row.style_box_url = url
      if (box[1] === 'eq') {
        row.style_box_type = 'equity'
        row.style_box_size = EQUITY_SIZE[line]
        row.style_box_investment_style = EQUITY_STYLE[col]
        row.style_box_label = `${EQUITY_SIZE[line]} ${EQUITY_STYLE[col]}`
      } else {
        row.style_box_type = 'fixed_income'
        row.style_box_credit_quality = BOND_QUALITY[line]
        row.style_box_interest_rate_sensitivity = BOND_SENSITIVITY[col]
        row.style_box_label = `${BOND_QUALITY[line]} Credit Quality / ${BOND_SENSITIVITY[col]} Sensitivity`
      }
    }
    rows.push(compact(row))
  }
  return rows
}

type Close = { date: string; close: number }

/** A calendar date a number of months before another (the day clamped to the month's length). */
function monthsBefore(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  const index = y * 12 + (m - 1) - months
  const year = Math.floor(index / 12)
  const month = (index % 12) + 1
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return `${year}-${String(month).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`
}

const daysBetween = (a: string, b: string): number => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000)

/** Daily dividend-adjusted closes from the first bar Yahoo has, oldest first. */
async function adjustedCloses(ctx: NativeCtx, symbol: string): Promise<Close[]> {
  const bars = await priceHistory(ctx, symbol, { interval: '1d', start: '1900-01-01', end: todayNy(ctx), adjustDividends: true })
  return bars.filter((b) => typeof b.close === 'number').map((b) => ({ date: String(b.date), close: b.close as number }))
}

/** Trailing returns (1m to 10y, year to date) and each calendar year's return, from adjusted daily closes. */
export async function fundPerformance(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const rows: Row[] = []
  for (const symbol of symbolsOf(params)) {
    const closes = await adjustedCloses(ctx, symbol)
    const last = closes.at(-1)
    if (!last) continue
    const asOf = (date: string): Close | undefined => {
      for (let i = closes.length - 1; i >= 0; i--) if (closes[i]!.date <= date) return closes[i]
      return undefined
    }
    for (const [period, months] of [['1m', 1], ['3m', 3], ['6m', 6], ['1y', 12], ['3y', 36], ['5y', 60], ['10y', 120]] as const) {
      const base = asOf(monthsBefore(last.date, months))
      // A window that reaches back before the first bar is not offered.
      if (!base || closes[0]!.date > monthsBefore(last.date, months)) continue
      const cumulative = last.close / base.close - 1
      const days = daysBetween(base.date, last.date)
      rows.push({ symbol, measure: 'trailing_return', period, cumulative_return: cumulative, ...(days > 365 ? { annualized_return: (1 + cumulative) ** (365.25 / days) - 1 } : {}) })
    }
    const lastYear = Number(last.date.slice(0, 4))
    const yearEnd = (year: number): Close | undefined => asOf(`${year}-12-31`)
    const ytdBase = yearEnd(lastYear - 1)
    if (ytdBase && ytdBase.date.startsWith(String(lastYear - 1))) rows.push({ symbol, measure: 'trailing_return', period: 'ytd', cumulative_return: last.close / ytdBase.close - 1 })
    const firstYear = Number(closes[0]!.date.slice(0, 4))
    for (let year = firstYear + 1; year <= lastYear; year++) {
      const end = year === lastYear ? last : yearEnd(year)
      const start = yearEnd(year - 1)
      if (end && start && start.date.startsWith(String(year - 1))) rows.push({ symbol, measure: 'annual_return', period: String(year), cumulative_return: end.close / start.close - 1 })
    }
  }
  return rows.map(compact)
}

const sampleStdev = (xs: number[]): number => {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length
  return Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1))
}

/** Volatility, beta, annualised return, Sharpe ratio and worst drawdown of a fund against a benchmark, on closing prices. */
export async function fundRisk(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const end = typeof params.end_date === 'string' && params.end_date ? params.end_date : todayNy(ctx)
  const start = typeof params.start_date === 'string' && params.start_date ? params.start_date : monthsBefore(end, 36)
  const benchmark = typeof params.benchmark === 'string' && params.benchmark ? params.benchmark : '^GSPC'
  const riskFree = typeof params.risk_free_rate === 'number' ? params.risk_free_rate : 0
  const closesOf = async (symbol: string): Promise<Map<string, number>> => new Map((await priceHistory(ctx, symbol, { interval: '1d', start, end })).filter((b) => typeof b.close === 'number').map((b) => [String(b.date), b.close as number]))
  const bench = await closesOf(benchmark)
  const rows: Row[] = []
  for (const symbol of symbolsOf(params)) {
    const fund = await closesOf(symbol)
    const dates = [...fund.keys()].filter((d) => bench.has(d)).sort()
    if (dates.length < 3) continue
    const f = dates.map((d) => fund.get(d)!)
    const b = dates.map((d) => bench.get(d)!)
    const rf = f.slice(1).map((x, i) => x / f[i]! - 1)
    const rb = b.slice(1).map((x, i) => x / b[i]! - 1)
    const n = rf.length
    const meanF = rf.reduce((a, c) => a + c, 0) / n
    const meanB = rb.reduce((a, c) => a + c, 0) / n
    const cov = rf.reduce((a, x, i) => a + (x - meanF) * (rb[i]! - meanB), 0) / (n - 1)
    const variance = rb.reduce((a, y) => a + (y - meanB) ** 2, 0) / (n - 1)
    const volatility = sampleStdev(rf) * Math.sqrt(252)
    const annualized = (f.at(-1)! / f[0]!) ** (252 / n) - 1
    let peak = f[0]!
    let drawdown = 0
    for (const x of f) {
      peak = Math.max(peak, x)
      drawdown = Math.min(drawdown, x / peak - 1)
    }
    rows.push({ symbol, start_date: start, end_date: end, volatility, beta: cov / variance, annualized_return: annualized, sharpe_ratio: (annualized - riskFree) / volatility, max_drawdown: drawdown, benchmark })
  }
  return rows
}

