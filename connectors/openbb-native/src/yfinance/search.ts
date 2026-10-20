// yfinance/search, yfinance/news and news/company, provider yfinance. Independent implementation of OpenBB's output for
// these routes (not derived from openbb_yfinance, which is AGPL); Yahoo endpoints as used by yfinance (Apache-2.0).
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { compact, isRecord, listParam, Q1, wallParts, yahooJson } from './helpers.js'

/** Yahoo's exchange codes that OpenBB shows under a market's name. */
const EXCHANGE_NAMES: Record<string, string> = {
  ASE: 'NYSE AMEX',
  BTS: 'CBOE BZX',
  NCM: 'NASDAQ',
  NGM: 'NASDAQ',
  NMS: 'NASDAQ',
  NYQ: 'NYSE',
  PCX: 'NYSE ARCA',
  PNK: 'OTC Markets',
}

/** Symbols and names matching a query, in Yahoo's lookup order. */
export async function search(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const query = typeof params.query === 'string' ? params.query.trim() : ''
  if (!query) return []
  const type = params.asset_type === 'crypto' ? 'cryptocurrency' : typeof params.asset_type === 'string' && params.asset_type ? params.asset_type : 'all'
  const limit = typeof params.limit === 'number' ? params.limit : 30
  const body = await yahooJson<{ finance?: { result?: { documents?: Row[] }[] } }>(ctx, `${Q1}/v1/finance/lookup`, {
    query: { query, type, start: 0, count: limit + 1, formatted: 'false', fetchPricingData: 'true', lang: 'en-US', region: 'US' },
  })
  const docs = body.finance?.result?.[0]?.documents ?? []
  return docs.filter((d) => typeof d.symbol === 'string').slice(0, limit).map((d) => compact({ symbol: d.symbol, name: d.shortName, description: d.shortName, exchange: typeof d.exchange === 'string' ? (EXCHANGE_NAMES[d.exchange] ?? d.exchange) : '', asset_type: d.quoteType }))
}

type NewsItem = { title?: string; publisher?: string; link?: string; providerPublishTime?: number; relatedTickers?: string[] }

/** Yahoo's search news for a query or a ticker. */
async function searchNews(ctx: NativeCtx, q: string, count: number): Promise<NewsItem[]> {
  const body = await yahooJson<{ news?: NewsItem[] }>(ctx, `${Q1}/v1/finance/search`, {
    query: { q, quotesCount: 0, newsCount: count, enableFuzzyQuery: 'false', quotesQueryId: 'tss_match_phrase_query', newsQueryId: 'news_cie_vespa', listsCount: 0, enableCb: 'false', enableNavLinks: 'false', enableResearchReports: 'false', enableCulturalAssets: 'false', recommendedCount: 0 },
  })
  return (body.news ?? []).filter(isRecord) as NewsItem[]
}

/** "2026-10-20T18:33:00Z" for a Yahoo timestamp in seconds. */
const isoUtc = (seconds: number): string => `${wallParts(seconds, 'UTC').date}T${wallParts(seconds, 'UTC').time}Z`

/**
 * News for a search query (title, author, url) or for tickers. Yahoo's per-ticker news feed no longer answers
 * (OpenBB gets nothing from it), so tickers are searched by name: those rows also carry the date and the related tickers.
 */
export async function news(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const limit = typeof params.limit === 'number' ? params.limit : 20
  const query = typeof params.query === 'string' ? params.query.trim() : ''
  if (query) return (await searchNews(ctx, query, limit)).map((n) => compact({ title: n.title, author: n.publisher, url: n.link }))
  const symbols = listParam(params.symbol).map((s) => s.toUpperCase())
  return companyNews({ ...params, symbol: symbols, limit }, ctx)
}

/** Company news within a date window, newest first, a story once however many tickers it names. */
export async function companyNews(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const symbols = listParam(params.symbol).map((s) => s.toUpperCase())
  const limit = typeof params.limit === 'number' ? params.limit : undefined
  const start = typeof params.start_date === 'string' && params.start_date ? params.start_date : undefined
  const end = typeof params.end_date === 'string' && params.end_date ? params.end_date : undefined
  const seen = new Set<string>()
  const rows: Row[] = []
  for (const symbol of symbols) {
    for (const n of await searchNews(ctx, symbol, Math.max(limit ?? 20, 20))) {
      if (!n.link || seen.has(n.link) || typeof n.providerPublishTime !== 'number') continue
      const day = wallParts(n.providerPublishTime, 'UTC').date
      if ((start && day < start) || (end && day > end)) continue
      seen.add(n.link)
      rows.push(compact({ date: isoUtc(n.providerPublishTime), title: n.title, author: n.publisher, url: n.link, symbols: n.relatedTickers?.join(',') }))
    }
  }
  rows.sort((a, b) => String(b.date).localeCompare(String(a.date)))
  return limit === undefined ? rows : rows.slice(0, limit)
}
