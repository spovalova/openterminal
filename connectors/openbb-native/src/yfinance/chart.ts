// Yahoo's chart endpoint (prices, dividends, splits) and the OpenBB price rows built from it. Independent
// implementation of OpenBB's output for the price routes (not derived from openbb_yfinance, which is AGPL); Yahoo
// endpoints as used by yfinance (Apache-2.0).
import { NativeHttpError } from '../http.js'
import type { NativeCtx, Row } from '../types.js'
import { addDays, dayStart, isRecord, Q2, wallParts, yahooJson } from './helpers.js'

/** OpenBB's interval names → Yahoo's. */
const INTERVALS: Record<string, string> = { '1m': '1m', '2m': '2m', '5m': '5m', '15m': '15m', '30m': '30m', '60m': '60m', '90m': '90m', '1h': '1h', '1d': '1d', '5d': '5d', '1W': '1wk', '1M': '1mo', '1Q': '3mo' }

export const yahooInterval = (interval: string): string => INTERVALS[interval] ?? interval
export const isIntraday = (interval: string): boolean => /^\d+(m|h)$/.test(interval)

export type Bar = {
  /** Unix seconds. */
  time: number
  /** "YYYY-MM-DD" on the exchange's wall clock. */
  date: string
  /** "HH:MM:SS" on the exchange's wall clock. */
  clock: string
  open: number | null
  high: number | null
  low: number | null
  close: number | null
  volume: number | null
  adjclose: number | null
}
export type ChartEvent = { time: number; amount?: number; numerator?: number; denominator?: number }
export type Chart = { symbol: string; meta: Row; timezone: string; bars: Bar[]; dividends: ChartEvent[]; splits: ChartEvent[] }

type Series = (number | null)[] | undefined
const at = (s: Series, i: number): number | null => (s && typeof s[i] === 'number' ? s[i]! : null)

export type ChartQuery = { interval: string; period1: number; period2: number; prepost?: boolean }

/** One symbol's chart; undefined when Yahoo has no data for it. */
export async function fetchChart(ctx: NativeCtx, symbol: string, q: ChartQuery): Promise<Chart | undefined> {
  let body: { chart?: { result?: Row[] | null; error?: { code?: string; description?: string } | null } }
  try {
    body = await yahooJson(ctx, `${Q2}/v8/finance/chart/${encodeURIComponent(symbol)}`, {
      query: { period1: q.period1, period2: q.period2, interval: yahooInterval(q.interval), includePrePost: q.prepost ?? false, events: 'div,splits,capitalGains', lang: 'en-US', region: 'US' },
    })
  } catch (err) {
    if (err instanceof NativeHttpError && err.status === 404) return undefined
    throw err
  }
  const result = body.chart?.result?.[0]
  if (!result) return undefined
  const meta = (result.meta ?? {}) as Row
  const timezone = typeof meta.exchangeTimezoneName === 'string' ? meta.exchangeTimezoneName : 'UTC'
  const stamps = (result.timestamp ?? []) as number[]
  const indicators = (result.indicators ?? {}) as Row
  const quote = ((indicators.quote as Row[] | undefined)?.[0] ?? {}) as Record<string, Series>
  const adj = ((indicators.adjclose as Row[] | undefined)?.[0]?.adjclose ?? undefined) as Series
  const bars: Bar[] = stamps.map((time, i) => {
    const w = wallParts(time, timezone)
    return { time, date: w.date, clock: w.time, open: at(quote.open, i), high: at(quote.high, i), low: at(quote.low, i), close: at(quote.close, i), volume: at(quote.volume, i), adjclose: at(adj, i) }
  })
  const events = (result.events ?? {}) as Row
  const list = (name: string): Row[] => (isRecord(events[name]) ? Object.values(events[name] as Row).filter(isRecord) : [])
  const dividends = list('dividends').map((e): ChartEvent => ({ time: Number(e.date), amount: Number(e.amount) }))
  const splits = list('splits').map((e): ChartEvent => ({ time: Number(e.date), numerator: Number(e.numerator), denominator: Number(e.denominator) }))
  return { symbol, meta, timezone, bars, dividends, splits }
}

export type HistoryOptions = {
  interval: string
  /** "YYYY-MM-DD", inclusive. */
  start: string
  end: string
  prepost?: boolean
  /** Add `dividend` (and `split_ratio`) columns when the window has such events. */
  actions?: boolean
  /** Scale open, high, low and close by adjusted close over close. */
  adjustDividends?: boolean
  /** Dates of daily and coarser bars as "YYYY-MM-DDT00:00:00" rather than "YYYY-MM-DD". */
  datetimes?: boolean
}

/**
 * Bars between two exchange-local dates as OpenBB rows. The window is requested a day wider on both sides and cut
 * by the exchange's own calendar date, so no time zone loses its first or last session.
 */
export async function priceHistory(ctx: NativeCtx, symbol: string, o: HistoryOptions): Promise<Row[]> {
  const intraday = isIntraday(o.interval)
  // Weekly, monthly and quarterly bars come whole: a bar is in the window when it starts in it, however far past
  // the end date it runs. Yahoo's 5d bars follow the start they were asked for, so that start is sent as it is.
  const whole = ['1W', '1M', '1Q'].includes(o.interval)
  const period2 = whole ? Math.floor(ctx.now().getTime() / 1000) + 86_400 : dayStart(addDays(o.end, 2))
  const request = (period1: number): Promise<Chart | undefined> => fetchChart(ctx, symbol, { interval: o.interval, period1, period2, ...(o.prepost ? { prepost: true } : {}) })
  let chart: Chart | undefined
  try {
    chart = await request(dayStart(o.interval === '5d' ? o.start : addDays(o.start, -1)))
  } catch (err) {
    // Intraday data reaches back only so far, and the extra day may cross the limit: ask for the start itself.
    if (!(err instanceof NativeHttpError) || err.status !== 422) throw err
    chart = await request(dayStart(o.start))
  }
  if (!chart) return []
  return barRows(chart, o, intraday)
}

/** The OpenBB rows for a chart's bars in the window: dates, adjustment, and dividend and split columns. */
export function barRows(chart: Chart, o: HistoryOptions, intraday: boolean): Row[] {
  // Intraday windows run from midnight of the start date to midnight after the end date, both included, on the
  // exchange's clock; daily and coarser bars are in the window when their own date is.
  const from = `${o.start}T00:00:00`
  const to = `${addDays(o.end, 1)}T00:00:00`
  const bars = chart.bars.filter((b) => {
    if (b.close === null) return false
    if (!intraday) return b.date >= o.start && b.date <= o.end
    const at = `${b.date}T${b.clock}`
    return at >= from && at <= to
  })
  const key = (b: Bar): string => (intraday ? `${b.date}T${b.clock}` : o.datetimes ? `${b.date}T00:00:00` : b.date)

  // An event belongs to the bar that contains it: the first bar of its day for intraday data, the week or month
  // that starts on or before it for coarser ones.
  const barFor = (time: number): Bar | undefined => {
    const w = wallParts(time, chart.timezone)
    if (intraday) return bars.find((b) => b.date === w.date)
    let found: Bar | undefined
    for (const b of chart.bars) {
      if (b.date <= w.date) found = b
      else break
    }
    return found && bars.includes(found) ? found : undefined
  }
  const dividends = new Map<Bar, number>()
  const splits = new Map<Bar, number>()
  if (o.actions) {
    for (const e of chart.dividends) {
      const b = barFor(e.time)
      if (b) dividends.set(b, (dividends.get(b) ?? 0) + (e.amount ?? 0))
    }
    for (const e of chart.splits) {
      const b = barFor(e.time)
      if (b && e.numerator && e.denominator) splits.set(b, e.numerator / e.denominator)
    }
  }

  return bars.map((b): Row => {
    const ratio = o.adjustDividends && b.adjclose !== null && b.close ? b.adjclose / b.close : 1
    const scale = (v: number | null): number | undefined => (v === null ? undefined : ratio !== 1 ? v * ratio : v)
    const row: Row = { date: key(b), open: scale(b.open), high: scale(b.high), low: scale(b.low), close: o.adjustDividends && b.adjclose !== null ? b.adjclose : (b.close ?? undefined), volume: b.volume ?? undefined }
    if (splits.size > 0) row.split_ratio = splits.get(b) ?? 0
    if (dividends.size > 0) row.dividend = dividends.get(b) ?? 0
    return row
  })
}
