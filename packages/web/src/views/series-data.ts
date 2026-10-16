import type { Frame, Interval, View } from '@terminal/core'
import { columnIndex, isIntraday, preview } from '@terminal/core'
import type { BusinessDay, CandlestickData, HistogramData, LineData, Time, UTCTimestamp } from 'lightweight-charts'

/** Which lightweight-charts shape a series widget renders. */
export type SeriesMode = 'line' | 'candle' | 'normalize'

export function seriesMode(view: View): SeriesMode {
  if (view.type !== 'series') return 'line'
  if (view.candle) return 'candle'
  if (view.normalize) return 'normalize'
  return 'line'
}

export type Bar = { time: Time; open: number; high: number; low: number; close: number; volume: number | null }
export type SymbolSeries = { symbol: string; bars: Bar[] }

/**
 * Epoch ms → lightweight-charts time.
 * Intraday bars keep the timestamp (seconds). Daily and weekly bars become business days (UTC date)
 * so every symbol's bar for one session lands on the same x position regardless of the exchange's
 * open time, and weekends leave no gaps.
 */
export function toChartTime(ms: number, intraday: boolean): Time {
  if (intraday) return Math.floor(ms / 1000) as UTCTimestamp
  const d = new Date(ms)
  const bd: BusinessDay = { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }
  return bd
}

function timeKey(t: Time): number {
  if (typeof t === 'number') return t
  if (typeof t === 'string') return Date.parse(t)
  return Date.UTC(t.year, t.month - 1, t.day)
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * Group an ohlcv frame into per-symbol bar arrays in the order symbols first appear.
 * Rows with a null or non-finite close are dropped; duplicate times keep the last row;
 * bars are sorted ascending by time as lightweight-charts requires.
 */
export function groupBars(frame: Frame, intraday: boolean): SymbolSeries[] {
  const iSym = columnIndex(frame, 'symbol')
  const iTime = columnIndex(frame, 'time')
  const iOpen = columnIndex(frame, 'open')
  const iHigh = columnIndex(frame, 'high')
  const iLow = columnIndex(frame, 'low')
  const iClose = columnIndex(frame, 'close')
  const iVol = columnIndex(frame, 'volume')
  if (iTime < 0 || iClose < 0) return []

  const groups = new Map<string, Map<number, Bar>>()
  for (const row of frame.rows) {
    const symbol = iSym >= 0 ? String(row[iSym] ?? '') : '*'
    const ms = num(row[iTime])
    const close = num(row[iClose])
    if (ms == null || close == null) continue
    const time = toChartTime(ms, intraday)
    const open = num(row[iOpen]) ?? close
    const high = num(row[iHigh]) ?? Math.max(open, close)
    const low = num(row[iLow]) ?? Math.min(open, close)
    const volume = iVol >= 0 ? num(row[iVol]) : null
    let g = groups.get(symbol)
    if (!g) groups.set(symbol, (g = new Map()))
    g.set(timeKey(time), { time, open, high, low, close, volume })
  }

  const out: SymbolSeries[] = []
  for (const [symbol, byTime] of groups) {
    const bars = [...byTime.entries()].sort((a, b) => a[0] - b[0]).map(([, bar]) => bar)
    if (bars.length > 0) out.push({ symbol, bars })
  }
  return out
}

export function toLineData(bars: Bar[]): LineData[] {
  return bars.map((b) => ({ time: b.time, value: b.close }))
}

export function toCandleData(bars: Bar[]): CandlestickData[] {
  return bars.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close }))
}

export function toVolumeData(bars: Bar[], upColor: string, downColor: string): HistogramData[] {
  return bars
    .filter((b) => b.volume != null)
    .map((b) => ({ time: b.time, value: b.volume as number, color: b.close >= b.open ? upColor : downColor }))
}

/** One legend row per symbol: the numbers are exactly `preview(frame).stats[symbol].close`. */
export type LegendRow = { symbol: string; last: number | null; changePct: number | null; color: string | undefined }

export function legendRows(frame: Frame, symbols: string[], colorFor: (i: number) => string | undefined): LegendRow[] {
  const stats = preview(frame).stats
  return symbols.map((symbol, i) => {
    const close = stats[symbol]?.close
    return { symbol, last: close?.last ?? null, changePct: close?.changePct ?? null, color: colorFor(i) }
  })
}

export function intervalIsIntraday(interval: Interval | undefined): boolean {
  return interval ? isIntraday(interval) : false
}
