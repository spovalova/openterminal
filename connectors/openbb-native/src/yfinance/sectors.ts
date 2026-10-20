// yfinance/sectors/{overview, industries, top_companies, top_funds} and yfinance/industry/{overview, top_performing,
// top_growth}, provider yfinance. Independent implementation of OpenBB's output for these routes (not derived from
// openbb_yfinance, which is AGPL); Yahoo endpoints and the sector-industry key list as used by yfinance (Apache-2.0).
import { NativeHttpError } from '../http.js'
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { compact, isRecord, Q1, raw, yahooJson } from './helpers.js'
import industryKeys from './sector-industries.json' with { type: 'json' }

const list = (v: unknown): Row[] => (Array.isArray(v) ? v.filter(isRecord) : [])
const SECTORS = Object.keys(industryKeys)

/** Yahoo's page for a sector or an industry; undefined when it has none (the key is unknown). */
async function domain(ctx: NativeCtx, kind: 'sectors' | 'industries', key: string): Promise<Row | undefined> {
  try {
    const body = await yahooJson<{ data?: Row }>(ctx, `${Q1}/v1/finance/${kind}/${encodeURIComponent(key)}`, { crumb: true, query: { formatted: 'true', withReturns: 'true', lang: 'en-US', region: 'US' } })
    return body.data
  } catch (err) {
    if (err instanceof NativeHttpError && err.status >= 400 && err.status < 500) return undefined
    throw err
  }
}

/** The sectors a call names: its sector, else all eleven. */
function sectorsOf(params: NativeParams): string[] {
  return typeof params.sector === 'string' && params.sector ? [params.sector] : [...SECTORS]
}

export async function sectorOverview(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const rows: Row[] = []
  for (const sector of sectorsOf(params)) {
    const data = await domain(ctx, 'sectors', sector)
    if (!data) continue
    const o = (data.overview ?? {}) as Row
    rows.push(compact({ sector, name: data.name, symbol: data.symbol, market_cap: raw(o.marketCap), market_weight: raw(o.marketWeight), companies_count: o.companiesCount, industries_count: o.industriesCount, employee_count: raw(o.employeeCount), description: o.description }))
  }
  return rows
}

export async function sectorIndustries(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const rows: Row[] = []
  for (const sector of sectorsOf(params)) {
    const data = await domain(ctx, 'sectors', sector)
    for (const i of list(data?.industries)) if (i.name !== 'All Industries') rows.push(compact({ sector, key: i.key, name: i.name, symbol: i.symbol, market_weight: raw(i.marketWeight) }))
  }
  return rows
}

export async function sectorTopCompanies(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const rows: Row[] = []
  for (const sector of sectorsOf(params)) {
    const data = await domain(ctx, 'sectors', sector)
    for (const c of list(data?.topCompanies)) rows.push(compact({ sector, symbol: c.symbol, name: c.name, rating: c.rating, market_weight: raw(c.marketWeight) }))
  }
  return rows
}

export async function sectorTopFunds(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const fundType = params.fund_type === 'mutualfund' ? 'mutualfund' : 'etf'
  const rows: Row[] = []
  for (const sector of sectorsOf(params)) {
    const data = await domain(ctx, 'sectors', sector)
    for (const f of list(fundType === 'etf' ? data?.topETFs : data?.topMutualFunds)) rows.push(compact({ sector, fund_type: fundType, symbol: f.symbol, name: f.name }))
  }
  return rows
}

/** The industries a call names: its industry, else every one the sector's list gives. */
function industriesOf(params: NativeParams): string[] {
  if (typeof params.industry === 'string' && params.industry) return [params.industry]
  const sector = typeof params.sector === 'string' && params.sector ? params.sector : 'technology'
  return (industryKeys as Record<string, string[]>)[sector] ?? []
}

async function industryRows(params: NativeParams, ctx: NativeCtx, build: (key: string, data: Row) => Row[]): Promise<Row[]> {
  const rows: Row[] = []
  for (const key of industriesOf(params)) {
    const data = await domain(ctx, 'industries', key)
    if (data) rows.push(...build(key, data).map(compact))
  }
  return rows
}

export const industryOverview = (params: NativeParams, ctx: NativeCtx): Promise<Row[]> =>
  industryRows(params, ctx, (industry, data) => {
    const o = (data.overview ?? {}) as Row
    return [{ industry, name: data.name, symbol: data.symbol, sector: data.sectorKey, sector_name: data.sectorName, market_cap: raw(o.marketCap), market_weight: raw(o.marketWeight), companies_count: o.companiesCount, employee_count: raw(o.employeeCount), description: o.description }]
  })

export const industryTopPerforming = (params: NativeParams, ctx: NativeCtx): Promise<Row[]> =>
  industryRows(params, ctx, (industry, data) => list(data.topPerformingCompanies).map((c) => ({ industry, symbol: c.symbol, name: c.name, ytd_return: raw(c.ytdReturn), last_price: raw(c.lastPrice), target_price: raw(c.targetPrice) })))

export const industryTopGrowth = (params: NativeParams, ctx: NativeCtx): Promise<Row[]> =>
  industryRows(params, ctx, (industry, data) => list(data.topGrowthCompanies).map((c) => ({ industry, symbol: c.symbol, name: c.name, ytd_return: raw(c.ytdReturn), growth_estimate: raw(c.growthEstimate) })))
