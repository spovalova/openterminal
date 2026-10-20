// equity/price/historical and etf/historical, provider cboe. Ported from openbb_cboe/models/equity_historical.py
// (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of a DataFrame and pydantic models.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { addDays, compareText, gatherSkippingFailures, getIndexDirectory, nyToday, symbolsOf, TICKER_EXCEPTIONS, useCacheOf } from './helpers.js'

const VOLUME_COLUMNS = ['volume', 'puts_volume', 'calls_volume', 'total_options_volume']
const PRICE_COLUMNS = ['open', 'high', 'low', 'close']

/** The query window as `transform_query` fills it: 720 days for several symbols, else everything up to today. */
export function historicalWindow(params: NativeParams, ctx: NativeCtx, symbolCount: number): { start: string; end: string } {
  const today = nyToday(ctx)
  const given = params.start_date ? String(params.start_date) : undefined
  const start = given ?? (symbolCount > 1 ? addDays(today, -720) : '1950-01-01')
  return { start, end: params.end_date ? String(params.end_date) : today }
}

/** `start <= date <= end + 1 day`, as `to_datetime` compares them: a date alone is midnight. */
export function inWindow(date: string, start: string, end: string): boolean {
  const full = (d: string) => (d.length > 10 ? d : `${d}T00:00:00`)
  return full(date) >= full(start) && full(date) <= full(addDays(end, 1))
}

/** pydantic's `date` | `datetime` for a chart timestamp: "2026-10-16" stays a date, "2026-10-20T09:31:00" a naive datetime. */
export const chartDate = (d: string): string => (d.includes(':') ? d.replace(' ', 'T') : d.slice(0, 10))

type ChartBody = { symbol: string; data: Row[] }

export async function equityHistorical(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const symbols = symbolsOf(params)
  const interval = params.interval === '1m' ? '1m' : '1d'
  const { start, end } = historicalWindow(params, ctx, symbols.length)
  const indexes = await getIndexDirectory(ctx, useCacheOf(params))

  const url = (symbol: string): string => {
    const bare = symbol.replaceAll('^', '')
    // NDX and RUT publish only the latest session as a chart; Cboe's own code picks the feed by symbol count.
    const kind = TICKER_EXCEPTIONS.includes(bare) ? (symbols.length === 1 ? 'intraday' : 'historical') : interval === '1m' ? 'intraday' : 'historical'
    const prefix = TICKER_EXCEPTIONS.includes(bare) || indexes.has(bare) ? '_' : ''
    return `https://cdn.cboe.com/api/global/delayed_quotes/charts/${kind}/${prefix}${bare}.json`
  }
  const data = await gatherSkippingFailures(symbols.map((s) => ctx.http.json<ChartBody>(url(s))))
  if (data.length === 0) throw new Error('Cboe returned no chart data')

  // One frame of every symbol's rows, then sorted by date and symbol.
  const frame: Row[] = []
  for (const item of data) {
    const symbol = item.symbol.replaceAll('_', '').replaceAll('^', '')
    for (const d of item.data) {
      if (interval === '1d') {
        // NDX and RUT alone get the intraday feed, whose rows have no "date": Cboe's own code fails on them here too.
        if (d.date === undefined) throw new Error("'date'")
        frame.push({ ...d, symbol })
      } else {
        const { price, volume, datetime } = d as { price: Row; volume: Row; datetime: string }
        frame.push({ ...price, ...volume, date: datetime, symbol })
      }
    }
  }
  frame.sort((a, b) => compareText(a.date, b.date) || compareText(a.symbol, b.symbol))

  const columns = [...new Set(frame.flatMap((r) => Object.keys(r)))]
  const dropped = new Set<string>()
  for (const c of columns) {
    if (VOLUME_COLUMNS.includes(c)) {
      let sum = 0
      for (const r of frame) {
        if (r[c] === undefined || r[c] === null) throw new Error(`${c} has missing values: cannot convert float NaN to integer`)
        r[c] = Math.trunc(Number(r[c]))
        sum += r[c] as number
      }
      if (sum === 0 && c !== 'volume') dropped.add(c)
    }
    if (PRICE_COLUMNS.includes(c)) for (const r of frame) if (r[c] !== undefined && r[c] !== null && !Number.isNaN(Number(r[c]))) r[c] = Number(r[c])
  }

  return frame
    .filter((r) => typeof r.open === 'number' && r.open > 0)
    .filter((r) => inWindow(String(r.date), start, end))
    .map((r) => {
      const out: Row = {}
      for (const [k, v] of Object.entries(r)) {
        if (dropped.has(k) || v === null || v === undefined) continue
        if (k === 'symbol' && symbols.length === 1) continue
        // The intraday feed's `stock_volume` is OpenBB's `volume` (`__alias_dict__`).
        out[k === 'stock_volume' ? 'volume' : k] = k === 'date' ? chartDate(String(v)) : v
      }
      return out
    })
}
