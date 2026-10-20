// index/price/historical, provider cboe. Ported from openbb_cboe/models/index_historical.py (OpenBB Platform 5.0.0,
// Apache-2.0); modified: plain rows instead of a DataFrame and pydantic models.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { chartDate, historicalWindow, inWindow } from './equity-historical.js'
import { compareText, gatherSkippingFailures, getIndexHistory, getIndexRows, symbolsOf, TICKER_EXCEPTIONS, useCacheOf } from './helpers.js'

const PRICE_COLUMNS = ['open', 'high', 'low', 'close']

/** "MM/DD/YYYY" → "YYYY-MM-DD" (`to_datetime(format="%m/%d/%Y")`). */
function usDate(text: string): string {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text.trim())
  if (!m) throw new Error(`time data "${text}" doesn't match format "%m/%d/%Y"`)
  return `${m[3]}-${m[1]!.padStart(2, '0')}-${m[2]!.padStart(2, '0')}`
}

export async function indexHistorical(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const symbols = symbolsOf(params)
  const interval = params.interval === '1m' ? '1m' : '1d'
  const useCache = useCacheOf(params)
  const { start, end } = historicalWindow(params, ctx, symbols.length)

  // Daily history is one CSV per index; intraday is Cboe's chart feed (the European one for European indices).
  let data: { symbol: string; data: Row[] }[]
  if (interval === '1d') {
    const histories = await Promise.all(symbols.map((s) => getIndexHistory(ctx, s, useCache)))
    data = symbols.map((symbol, i) => ({ symbol, data: histories[i]! }))
  } else {
    const rows = await getIndexRows(ctx, useCache)
    const indexes = new Set(rows.map((r) => String(r.index_symbol)))
    const euIndexes = new Set(rows.filter((r) => r.source === 'eu_proprietary_index').map((r) => String(r.index_symbol)))
    const url = (symbol: string): string => {
      const bare = symbol.replaceAll('^', '')
      if (euIndexes.has(bare)) return `https://cdn.cboe.com/api/global/european_indices/intraday_chart_data/${bare}.json`
      const prefix = TICKER_EXCEPTIONS.includes(bare) || indexes.has(bare) ? '_' : ''
      return `https://cdn.cboe.com/api/global/delayed_quotes/charts/intraday/${prefix}${bare}.json`
    }
    data = await gatherSkippingFailures(symbols.map((s) => ctx.http.json<{ symbol: string; data: Row[] }>(url(s))))
  }
  if (data.length === 0) throw new Error('Cboe returned no chart data')

  const frame: Row[] = []
  data.forEach((item, i) => {
    // The symbol comes from the query, by position, as OpenBB takes it.
    const symbol = (symbols[i] ?? '').replaceAll('_', '').replaceAll('^', '')
    for (const d of item.data) {
      if (interval === '1d') {
        const { volume: _volume, ...rest } = d
        frame.push({ ...rest, date: usDate(String(d.date)), symbol })
      } else {
        const { price, datetime } = d as { price: Row; datetime: string }
        frame.push({ ...price, date: datetime, symbol })
      }
    }
  })
  frame.sort((a, b) => compareText(a.date, b.date) || compareText(a.symbol, b.symbol))

  // Zero prices are missing prices.
  for (const r of frame) {
    for (const c of PRICE_COLUMNS) {
      if (r[c] === undefined || r[c] === null || r[c] === '') continue
      const n = Number(r[c])
      r[c] = n === 0 ? undefined : n
    }
  }

  return frame
    .filter((r) => inWindow(String(r.date), start, end))
    .map((r) => {
      const out: Row = {}
      for (const [k, v] of Object.entries(r)) {
        if (v === null || v === undefined || v === '') continue
        if (k === 'symbol' && symbols.length === 1) continue
        out[k] = k === 'date' ? chartDate(String(v)) : v
      }
      return out
    })
}
