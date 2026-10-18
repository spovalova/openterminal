import type { Frame, Interval, Kind, View } from '@terminal/core'
import { columnIndex, isIntraday, preview } from '@terminal/core'
import type { BusinessDay, CandlestickData, HistogramData, LineData, Time, UTCTimestamp } from 'lightweight-charts'
// Short labels for the macro series, shared with the widget sub-header; a symbol is its own label.
import { MACRO_LABELS } from '../subtitle'

/** Which lightweight-charts shape a series widget renders. */
export type SeriesMode = 'line' | 'candle' | 'normalize'

export function seriesMode(view: View): SeriesMode {
  if (view.type !== 'series') return 'line'
  if (view.candle) return 'candle'
  if (view.normalize) return 'normalize'
  return 'line'
}

export type Bar = { time: Time; open: number; high: number; low: number; close: number; volume: number | null }
/** One line: the group key (a `symbol`, or a `series` name for macro frames) and its bars. */
export type SymbolSeries = { group: string; bars: Bar[] }

/**
 * Which columns a frame draws from: ohlcv frames group by `symbol` and plot `close`; macro frames
 * group by `series` and plot `value`. Null when the frame has no time or value column.
 */
export function seriesColumns(frame: Pick<Frame, 'columns'>): { group: 'symbol' | 'series' | null; value: 'close' | 'value' } | null {
  if (columnIndex(frame, 'time') < 0) return null
  const value = columnIndex(frame, 'close') >= 0 ? 'close' : columnIndex(frame, 'value') >= 0 ? 'value' : null
  if (!value) return null
  const group = columnIndex(frame, 'symbol') >= 0 ? 'symbol' : columnIndex(frame, 'series') >= 0 ? 'series' : null
  return { group, value }
}

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
 * Group a frame into per-group bar arrays in the order groups first appear: by `symbol` with `close`
 * for ohlcv, by `series` with `value` for macro (open, high and low collapse onto the value).
 * Rows with a null or non-finite value are dropped; duplicate times keep the last row;
 * bars are sorted ascending by time as lightweight-charts requires.
 */
export function groupBars(frame: Frame, intraday: boolean): SymbolSeries[] {
  const cols = seriesColumns(frame)
  if (!cols) return []
  const iSym = cols.group ? columnIndex(frame, cols.group) : -1
  const iTime = columnIndex(frame, 'time')
  const iOpen = columnIndex(frame, 'open')
  const iHigh = columnIndex(frame, 'high')
  const iLow = columnIndex(frame, 'low')
  const iClose = columnIndex(frame, cols.value)
  const iVol = columnIndex(frame, 'volume')

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
  for (const [group, byTime] of groups) {
    const bars = [...byTime.entries()].sort((a, b) => a[0] - b[0]).map(([, bar]) => bar)
    if (bars.length > 0) out.push({ group, bars })
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

/**
 * One legend row per group. Every number is exactly what `preview(frame).stats[group][value]` reports:
 * `first` and `last` over the range and `changePct` between them (`close` for ohlcv, `value` for macro).
 */
export type LegendRow = { group: string; first: number | null; last: number | null; changePct: number | null; color: string | undefined }

export function legendRows(frame: Frame, groups: string[], colorFor: (i: number) => string | undefined): LegendRow[] {
  const stats = preview(frame).stats
  const value = seriesColumns(frame)?.value ?? 'close'
  return groups.map((group, i) => {
    const st = stats[group]?.[value]
    return { group, first: st?.first ?? null, last: st?.last ?? null, changePct: st?.changePct ?? null, color: colorFor(i) }
  })
}

/** The legend label for one line: the widget's `view.labels` override, else the macro short name, else the group itself. */
export function legendLabel(group: string, kind: Kind, labels?: Record<string, string>): string {
  const override = labels?.[group]?.trim()
  if (override) return override
  return kind === 'macro' ? (MACRO_LABELS[group] ?? group) : group
}

/** The lines a series widget draws, from its query params: the ohlcv symbols or the macro series. */
export function legendGroups(kind: Kind, params: Record<string, unknown>): string[] {
  const list = kind === 'ohlcv' ? params.symbols : kind === 'macro' ? params.series : undefined
  return Array.isArray(list) ? list.map(String) : []
}

export function intervalIsIntraday(interval: Interval | undefined): boolean {
  return interval ? isIntraday(interval) : false
}
