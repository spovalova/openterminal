// equity/fundamental/filings, equity/historical_market_cap and equity/fundamental/historical_eps, provider yfinance.
// Independent implementation of OpenBB's output for these routes (not derived from openbb_yfinance, which is AGPL);
// Yahoo endpoints as used by yfinance (Apache-2.0).
import { parse } from 'node-html-parser'
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { priceHistory } from './chart.js'
import { addDays, compact, todayNy, symbolsOf, yahooResponse } from './helpers.js'
import { quoteSummary, tickerInfo } from './quote.js'

/** SEC filings Yahoo lists for each symbol, newest first across symbols. */
export async function filings(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const rows: Row[] = []
  for (const symbol of symbolsOf(params)) {
    const result = await quoteSummary(ctx, symbol, ['secFilings'])
    const list = ((result?.secFilings as Row | undefined)?.filings ?? []) as Row[]
    for (const f of list) rows.push(compact({ filing_date: f.date, report_type: f.type, report_url: f.edgarUrl, symbol, title: f.title }))
  }
  return rows.sort((a, b) => String(b.filing_date).localeCompare(String(a.filing_date)))
}

/**
 * Market cap on each trading day of a window: the day's close times the shares Yahoo reports today (implied shares
 * outstanding, else shares outstanding). A year back from the end when no start is given.
 */
export async function historicalMarketCap(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const symbol = symbolsOf(params)[0]
  if (!symbol) return []
  const end = typeof params.end_date === 'string' && params.end_date ? params.end_date : todayNy(ctx)
  const start = typeof params.start_date === 'string' && params.start_date ? params.start_date : addDays(end, -365)
  const info = await tickerInfo(ctx, symbol)
  const shares = info && (typeof info.impliedSharesOutstanding === 'number' ? info.impliedSharesOutstanding : info.sharesOutstanding)
  if (typeof shares !== 'number') return []
  const bars = await priceHistory(ctx, symbol, { interval: '1d', start, end })
  return bars.map((b) => ({ date: b.date, symbol, market_cap: (b.close as number) * shares }))
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** "November 2, 2026 at 3 PM EST" → "2026-11-02". */
export function earningsDate(text: string): string | undefined {
  const m = /^([A-Za-z]+) (\d{1,2}), (\d{4})/.exec(text.trim())
  const month = m ? MONTHS.indexOf(m[1]!) : -1
  if (!m || month < 0) return undefined
  return `${m[3]}-${String(month + 1).padStart(2, '0')}-${m[2]!.padStart(2, '0')}`
}

const number = (text: string | undefined): number | undefined => {
  const t = (text ?? '').trim().replace(/,/g, '')
  if (t === '' || t === '-') return undefined
  const n = Number(t)
  return Number.isFinite(n) ? n : undefined
}

/** One page of Yahoo's earnings calendar for a symbol: date, EPS estimate, reported EPS, surprise. */
export async function earningsPage(ctx: NativeCtx, symbol: string, offset: number, size: number): Promise<Row[]> {
  const res = await yahooResponse(ctx, 'https://finance.yahoo.com/calendar/earnings', { query: { symbol, offset, size } })
  const html = await res.text()
  if (!res.ok) return []
  const rows: Row[] = []
  for (const tr of parse(html).querySelectorAll('table tbody tr')) {
    const cells = tr.querySelectorAll('td').map((td) => td.text.trim())
    // Symbol, Company, Earnings Date, EPS Estimate, Reported EPS, Surprise (%)
    if (cells.length < 6) continue
    const date = earningsDate(cells[2] ?? '')
    if (!date) continue
    rows.push(compact({ symbol, date, eps_estimated: number(cells[3]), eps_actual: number(cells[4]), surprise_percent: number(cells[5]) }))
  }
  return rows
}

/** Every earnings date Yahoo lists, upcoming first, with estimate, actual and surprise. */
export async function historicalEps(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const limit = typeof params.limit === 'number' ? params.limit : undefined
  const out: Row[] = []
  for (const symbol of symbolsOf(params)) {
    const rows: Row[] = []
    const size = limit !== undefined && limit <= 25 ? 25 : limit !== undefined && limit <= 50 ? 50 : 100
    for (let offset = 0; limit === undefined || rows.length < limit; offset += size) {
      const page = await earningsPage(ctx, symbol, offset, size)
      rows.push(...page)
      if (page.length < size) break
    }
    out.push(...(limit === undefined ? rows : rows.slice(0, limit)))
  }
  return out
}
