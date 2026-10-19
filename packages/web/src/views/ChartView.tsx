import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FC } from 'react'
import clsx from 'clsx'
import {
  AreaSeries,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  LineStyle,
  PriceScaleMode,
  createChart,
  createOptionsChart,
  type ChartOptions,
  type DeepPartial,
  type IChartApiBase,
  type ISeriesApi,
  type LineWidth,
  type MouseEventParams,
  type PriceFormat,
  type SeriesType,
} from 'lightweight-charts'
import { DOWN_COLOR, EmptyState, UP_COLOR, chartTheme, levelColor, tokens, zeroLineColor } from '@openterminal/ui'
import type { ViewProps } from './types'
import { withAlpha } from './format'
import { datasetsFor, expandView, recipeOf, viewOf } from './fields'
import { legendLabel } from './series-data'
import { bondLabel } from '../subtitle'
import { NEUTRAL_READING } from './StatView'
import { useWidth } from './use-width'
import { BandPrimitive } from './chart/band-primitive'
import { buildChart, formatValue, horzKey, legendValues, markerKindLabel, type Bar, type Candle, type ChartSpec, type HorzItem, type MarkerSpec, type Point, type SeriesSpec } from './chart/data'

type Chart = IChartApiBase<HorzItem>
type Series = ISeriesApi<SeriesType, HorzItem>

const LINE_STYLE = { solid: LineStyle.Solid, dashed: LineStyle.Dashed, dotted: LineStyle.Dotted } as const

/** The series the legend lists per pane: lines, areas and candles; histograms only when they are the pane's only kind. */
function legendSeries(spec: ChartSpec, pane: number): SeriesSpec[] {
  // An indicator pane has no badges (round 2: three per chart, on the price pane): its inset chips carry the values of
  // the series that would have had one, even when the preset gave the pane a title chip only.
  const own = spec.series.filter((s) => s.pane === pane && (s.legend || (pane > 0 && s.lastValue)))
  const drawn = own.filter((s) => s.kind !== 'histogram')
  return drawn.length > 0 ? drawn : own
}

/** WCAG relative luminance of a #rrggbb colour. */
function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex)
  if (!m) return 0
  const lin = (c: string) => {
    const v = parseInt(c, 16) / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(m[1]!) + 0.7152 * lin(m[2]!) + 0.0722 * lin(m[3]!)
}

/**
 * The text on a badge: dark (the background token) unless light text reads better on that colour. Violet badges took
 * dark text at 3.5:1; light text on them is 4.6:1 (the pure-hue palette, PR #22).
 */
export function badgeTextColor(fill: string): string {
  const l = luminance(fill)
  const dark = (l + 0.05) / (luminance(tokens.color.bg) + 0.05)
  const light = (luminance(tokens.color.fg) + 0.05) / (l + 0.05)
  return light > dark ? tokens.color.fg : tokens.color.bg
}

/** At most three last-value badges per chart (taste round 2, change 3), all on the price pane. */
export const BADGE_MAX = 3
/** A last-value badge is this tall; two closer than this stack, with a leader back to the value. */
const BADGE_HEIGHT = 16
/** A tick label whose centre is this close to a badge's would show half under it: the axis formatter blanks it. */
const TICK_CLEAR = 15

/** Axis labels (change 13): index levels and share counts as "7,659" and "95,394,231", millions and billions compact. */
function compactAxis(v: number): string {
  const abs = Math.abs(v)
  const sign = v < 0 ? '-' : ''
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(abs >= 1e10 ? 1 : 2)}B`
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(abs >= 1e7 ? 1 : 2)}M`
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(v)
}

const groupedAxis = (digits: number) => {
  const f = new Intl.NumberFormat('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
  return (v: number) => f.format(v)
}

/** A signed percent ("+25.84%", "-28.14%"): the axis and the badges of a rebased chart. */
export function signedPercent(v: number, digits = 2): string {
  return `${v > 0 ? '+' : v < 0 ? '-' : ''}${Math.abs(v).toFixed(digits)}%`
}

/**
 * The axis format of a series, always a custom formatter (round 2): prices grouped ("1,250.00", never "1250.00"), a
 * rebased axis as signed percents from the first value, and every tick a badge would half cover blanked (`blocked`).
 */
function priceFormatFor(s: SeriesSpec, rebased: boolean, blocked: (v: number) => boolean): PriceFormat {
  let base: (v: number) => string
  let minMove: number
  if (rebased) {
    base = (v) => signedPercent(v, Math.abs(v) >= 10 ? 0 : 1)
    minMove = 0.01
  } else {
    switch (s.format) {
      case 'percent':
        base = (v) => `${v.toFixed(2)}%`
        minMove = 0.01
        break
      case 'compact':
        base = compactAxis
        minMove = 1
        break
      case 'integer':
        base = groupedAxis(0)
        minMove = 1
        break
      case 'ratio':
        base = groupedAxis(1)
        minMove = 0.1
        break
      default:
        base = groupedAxis(s.precision)
        minMove = Math.pow(10, -s.precision)
    }
  }
  return { type: 'custom', minMove, formatter: (v: number) => (blocked(v) ? '' : base(v)) }
}

/** Where the last values of a chart live (round 2, change 3). */
export type BadgePlan = {
  /** Series that carry a badge on the price pane's axis: three at most. */
  series: Set<string>
  /** Level badges (a strike, RSI 70) the price pane may add after them. */
  levels: number
  /** `badges`: on the axis; `values`: past three series the legend chips carry them; `totals`: a strike axis, whose last strike means nothing, puts totals and the at-the-money reading in the legend. */
  legend: 'badges' | 'values' | 'totals'
}

/**
 * At most three badges per chart: the price pane's series when there are three or fewer (levels fill what is left),
 * none past three (the legend carries the values, so no solid column of colour hides the y ticks), none on a strike
 * axis, and none on an indicator pane, whose inset legend reads its value.
 */
export function badgePlan(spec: Pick<ChartSpec, 'x' | 'series'>): BadgePlan {
  if (spec.x === 'number') return { series: new Set(), levels: 0, legend: 'totals' }
  const bars = barOnlyPanes(spec.series)
  const candidates = spec.series.filter((s) => s.pane === 0 && s.lastValue && s.last != null && (s.kind !== 'histogram' || bars.has(0)))
  if (candidates.length > BADGE_MAX) return { series: new Set(), levels: 0, legend: 'values' }
  return { series: new Set(candidates.map((s) => s.id)), levels: BADGE_MAX - candidates.length, legend: 'badges' }
}

/** Percent change from a base: what a rebased axis plots. */
export function pctFrom(v: number, first: number): number {
  return ((v - first) / first) * 100
}

/** A rebased series' plotted values: percent change from its first value (the axis reads "+25%", the badge "+25.84%"). */
export function rebaseData(data: SeriesSpec['data'], first: number): SeriesSpec['data'] {
  const pct = (v: number) => pctFrom(v, first)
  return (data as (Point | Candle | Bar)[]).map((d) => {
    if ('close' in d) return { ...d, open: pct(d.open), high: pct(d.high), low: pct(d.low), close: pct(d.close) }
    if ('value' in d && typeof d.value === 'number') return { ...d, value: pct(d.value) }
    return d
  }) as SeriesSpec['data']
}

/** A by-strike line read at the money: the value at the strike nearest the underlying. */
export function atTheMoney(s: Pick<SeriesSpec, 'byTime'>, underlying: number | undefined): { strike: number; value: number } | undefined {
  if (underlying === undefined || s.byTime.size === 0) return undefined
  let best: number | undefined
  for (const k of s.byTime.keys()) if (best === undefined || Math.abs(k - underlying) < Math.abs(best - underlying)) best = k
  return best === undefined ? undefined : { strike: best, value: s.byTime.get(best)! }
}

type Badge = {
  id: string
  color: string
  text: string
  /** Where the badge is drawn (stacked away from a neighbour) and where its value is: a leader joins them when they differ. */
  top: number
  y: number
  side: 'right' | 'left'
  /** A level's label ("Strike", "52w high"), drawn beside its badge. */
  title?: string
}
/** An event pin: the bar's x, the bar's high (or low) y, and the marker kinds on that bar. */
type Pin = { id: string; x: number; y: number; below: boolean; paneTop: number; items: { letter: string; color: string; kind: string }[] }
/** Pin circle diameter and the stem between the bar and the circle. */
const PIN = 14
const STEM = 6

/** Axis labels on a strike axis: a paired bar's offset x rounds back to its strike. */
function xStepLabel(step: number | undefined): (v: number) => string {
  const digits = step && !Number.isInteger(step) ? 2 : 0
  return (v: number) => {
    const x = step ? Math.round(v / step) * step : v
    return x.toFixed(Number.isInteger(x) ? 0 : digits)
  }
}

/** The first value of a series (the base of an indexed-to-100 axis). */
function firstValue(s: SeriesSpec): number | null {
  const d = (s.data as { value?: number; close?: number }[])[0]
  const v = d?.value ?? d?.close
  return v != null && Number.isFinite(v) && v !== 0 ? v : null
}

/** One event pin: a stem from the bar, then a circle per kind with its letter inside, stacked away from the bar. */
const MarkerPin: FC<{ pin: Pin }> = ({ pin }) => {
  const n = pin.items.length
  const span = STEM + n * PIN + (n - 1) * 2
  // Above the bar unless that would leave the pane; then the pin sits on the bar's top edge.
  const top = pin.below ? pin.y + 2 : Math.max(pin.paneTop + 2, pin.y - 2 - span)
  return (
    <div data-marker="" data-kinds={pin.items.map((i) => i.kind).join(',')} className="pointer-events-none absolute z-10 flex flex-col items-center" style={{ left: Math.round(pin.x - PIN / 2), top: Math.round(top), width: PIN, flexDirection: pin.below ? 'column-reverse' : 'column' }}>
      {pin.items.map((i, k) => (
        <span key={i.kind} className="num inline-flex shrink-0 items-center justify-center rounded-full text-[9px] leading-none font-semibold text-bg" style={{ width: PIN, height: PIN, background: i.color, marginBottom: k === n - 1 ? 0 : 2 }}>
          {i.letter}
        </span>
      ))}
      <span aria-hidden="true" className="w-px shrink-0" style={{ height: STEM, background: pin.items[0]!.color, opacity: 0.7 }} />
    </div>
  )
}
type AxisBox = { right: { left: number; width: number }; left: { left: number; width: number } }

/**
 * Panes whose badge-carrying series are all bars (OI and volume by strike, signed bars): their histograms carry the
 * last value. Elsewhere a histogram is secondary (volume under candles, the MACD histogram beside its lines) and does not.
 */
export function barOnlyPanes(series: readonly Pick<SeriesSpec, 'pane' | 'kind' | 'lastValue'>[]): Set<number> {
  const out = new Set<number>()
  for (const s of series) if (s.lastValue && s.kind === 'histogram') out.add(s.pane)
  for (const s of series) if (s.kind !== 'histogram') out.delete(s.pane)
  return out
}

/** Stack badges that would overlap (change 4): sorted by y, each at least BADGE_HEIGHT under the one above, the group kept inside the pane. */
export function stackBadges<T extends { top: number }>(badges: T[], paneTop: number, paneHeight: number): T[] {
  const sorted = [...badges].sort((a, b) => a.top - b.top)
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.top < sorted[i - 1]!.top + BADGE_HEIGHT) sorted[i] = { ...sorted[i]!, top: sorted[i - 1]!.top + BADGE_HEIGHT }
  }
  const bottom = paneTop + paneHeight - BADGE_HEIGHT / 2
  const last = sorted[sorted.length - 1]
  if (last && last.top > bottom) {
    const shift = last.top - bottom
    for (let i = 0; i < sorted.length; i++) sorted[i] = { ...sorted[i]!, top: sorted[i]!.top - shift }
  }
  const minTop = paneTop + BADGE_HEIGHT / 2
  for (let i = 0; i < sorted.length; i++) if (sorted[i]!.top < minTop) sorted[i] = { ...sorted[i]!, top: minTop }
  return sorted
}

/**
 * The chart renderer: a preset's panes and layers on lightweight-charts 5 (PLAN.md section 17). Panes stack with
 * relative heights (`addPane`, stretch factors); a layer's `scale` picks the axis (`priceScaleId`); markers are
 * series markers with a letter per kind; levels are price lines; bands a primitive; volume and signed bars are
 * histograms; a numeric x goes through the yield-curve chart (maturities in months) or the options chart.
 * The price pane's legend sits above the plot (one or two rows, or a column beside it past four series in a wide
 * widget) so no line passes behind a chip; the indicator panes keep their title chip inset. Last values are HTML
 * badges on the axis in the series colour, stacked when they would collide, covering the tick under them
 * (taste round, change 4). Candles and the indexed-to-100 scale (v1 `candle` and `normalize`) render as before.
 */
export const ChartView: FC<ViewProps> = ({ widget, frames }) => {
  const view = viewOf(widget)
  const labels = 'labels' in view ? view.labels : undefined
  const spec = useMemo(() => {
    const datasets = datasetsFor(widget, frames)
    const panes = expandView(widget, frames)
    // A FINRA bond symbol reads as the bond ("CRWV 9.25% 2030", round 2 change 8); an index by its name ("S&P 500").
    return buildChart(panes, frames, datasets, { labels, groupLabel: (g: string) => bondLabel(g, widget.title) ?? legendLabel(g) })
  }, [widget, frames, labels])
  const percentUnits = useMemo(() => {
    // Series whose field carries a percent unit show their change in basis points (rates, yields).
    const datasets = datasetsFor(widget, frames)
    const out = new Set<string>()
    for (const s of spec.series) {
      const [, , data, y] = s.id.split(':')
      const unit = data && y ? datasets[data]?.fields[y]?.unit : undefined
      if (unit === 'percent' || unit === 'fraction' || s.format === 'percent') out.add(s.id)
    }
    return out
  }, [spec, widget, frames])
  const empty = spec.series.length === 0
  const structure = `${spec.x}|${spec.xStep ?? 0}|${spec.intraday}|${spec.panes.map((p) => `${p.height}:${p.side.right?.indexed}:${p.side.left?.indexed}`).join(',')}`

  const hostRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<Chart | null>(null)
  const seriesRef = useRef<{ api: Series; spec: SeriesSpec }[]>([])
  const specRef = useRef(spec)
  specRef.current = spec
  /** Price bands per scale (`pane:side`) where a badge sits: the axis formatter prints no tick there. */
  const blockedRef = useRef(new Map<string, [number, number][]>())
  const blockedSig = useRef('')
  const blockedFor = useCallback((key: string) => (v: number) => (blockedRef.current.get(key) ?? []).some(([lo, hi]) => v >= lo && v <= hi), [])
  const percentRef = useRef(percentUnits)
  percentRef.current = percentUnits
  const [tops, setTops] = useState<number[]>([])
  const [hover, setHover] = useState<{ key: number; x: number; y: number } | null>(null)
  const [badges, setBadges] = useState<Badge[]>([])
  const [pins, setPins] = useState<Pin[]>([])
  const [axes, setAxes] = useState<AxisBox>({ right: { left: 0, width: 0 }, left: { left: 0, width: 0 } })
  const [rootRef] = useWidth()
  const theme = chartTheme as DeepPartial<ChartOptions>

  const measurePanes = (chart: Chart, count: number) => {
    const next: number[] = []
    let top = 0
    for (let i = 0; i < count; i++) {
      next.push(top)
      try {
        top += chart.paneSize(i).height + 1
      } catch {
        top += 0
      }
    }
    setTops((prev) => (prev.length === next.length && prev.every((v, i) => v === next[i]) ? prev : next))
  }

  /** Where every last-value badge sits: the series' last value through its own price scale, stacked per pane and side. */
  const layoutBadges = useCallback(() => {
    const chart = chartRef.current
    if (!chart) return
    const current = specRef.current
    const paneTop: number[] = []
    const paneHeight: number[] = []
    let top = 0
    for (let i = 0; i < current.panes.length; i++) {
      paneTop.push(top)
      let h: number
      try {
        h = chart.paneSize(i).height
      } catch {
        h = 0
      }
      paneHeight.push(h)
      top += h + 1
    }
    // The pane legends sit at the same tops. Measured here, after the chart has painted: read synchronously after a
    // resize the panes still have their old heights, and the RSI legend landed on the MACD pane at 1920.
    setTops((prev) => (prev.length === paneTop.length && prev.every((v, i) => v === paneTop[i]) ? prev : paneTop))
    const plotWidth = chart.timeScale().width()
    const widthOf = (side: 'right' | 'left') => {
      try {
        return chart.priceScale(side).width()
      } catch {
        return 0
      }
    }
    const leftWidth = widthOf('left')
    setAxes({ right: { left: leftWidth + plotWidth, width: widthOf('right') }, left: { left: 0, width: leftWidth } })
    const groups = new Map<string, Badge[]>()
    const plan = badgePlan(current)
    for (const { api, spec: s } of seriesRef.current) {
      if (!plan.series.has(s.id) || s.last == null) continue
      const rebased = !!current.panes[s.pane]?.side[s.side]?.indexed
      const first = rebased ? firstValue(s) : null
      if (rebased && first == null) continue
      // On a rebased axis the series is plotted as its change from the first value: the badge reads that change, the
      // same number as the legend's change and in the axis' own units (round 2: never 71.86 beside a 61.39 legend).
      const plotted = rebased ? pctFrom(s.last, first!) : s.last
      let y: number | null
      try {
        y = api.priceToCoordinate(plotted)
      } catch {
        y = null
      }
      if (y == null || !Number.isFinite(y)) continue
      const text = rebased ? signedPercent(plotted) : percentRef.current.has(s.id) ? `${s.last.toFixed(2)}%` : formatValue(s.last, s.format, s.precision)
      let color = s.color
      if (s.kind === 'candle') {
        const bars = s.data as { open: number; close: number }[]
        const last = bars[bars.length - 1]
        color = last && last.close < last.open ? DOWN_COLOR : UP_COLOR
      }
      const key = `${s.pane}:${s.side}`
      const list = groups.get(key) ?? []
      const at = (paneTop[s.pane] ?? 0) + y
      list.push({ id: s.id, color, text, top: at, y: at, side: s.side })
      groups.set(key, list)
    }
    // Levels (strikes, a target) carry their price on the price pane's axis too, stacked with the last values, while
    // the chart's three badges allow; an indicator pane's 30/70 lines read on its own axis (round 2: RSI 70 / 40.09 /
    // 30 filled a 50px pane's whole axis).
    let levelsLeft = plan.levels
    for (const { api, spec: s } of seriesRef.current) {
      if (s.pane !== 0) continue
      s.priceLines.forEach((l, k) => {
        if (levelsLeft <= 0) return
        const rebased = !!current.panes[s.pane]?.side[s.side]?.indexed
        const first = rebased ? firstValue(s) : null
        if (rebased && first == null) return
        const plotted = rebased ? pctFrom(l.price, first!) : l.price
        let y: number | null
        try {
          y = api.priceToCoordinate(plotted)
        } catch {
          y = null
        }
        const h = paneHeight[s.pane] ?? 0
        if (y == null || !Number.isFinite(y) || y < 0 || (h > 0 && y > h)) return
        levelsLeft--
        const text = rebased ? signedPercent(plotted) : percentRef.current.has(s.id) ? `${l.price.toFixed(2)}%` : formatValue(l.price, s.format, s.precision)
        const key = `${s.pane}:${s.side}`
        const list = groups.get(key) ?? []
        const at = (paneTop[s.pane] ?? 0) + y
        list.push({ id: `${s.id}|level|${k}`, color: l.color ?? levelColor, text, top: at, y: at, side: s.side, ...(l.label ? { title: l.label } : {}) })
        groups.set(key, list)
      })
    }
    // Event pins (change 12): a 14px circle with the letter inside, above the bar's high (below its low for a
    // below-bar marker) on a short stem; kinds on one bar stack; the first bar's pin is inset from the plot's edge.
    const nextPins: Pin[] = []
    for (const { spec: s, api } of seriesRef.current) {
      if (s.markers.length === 0) continue
      const extent = new Map<number, { hi: number; lo: number }>()
      for (const d of s.data as { time: HorzItem; high?: number; low?: number; value?: number }[]) {
        const hi = d.high ?? d.value
        const lo = d.low ?? d.value
        if (hi != null && lo != null) extent.set(horzKey(d.time), { hi, lo })
      }
      const byBar = new Map<string, MarkerSpec[]>()
      for (const m of s.markers) {
        const k = `${horzKey(m.time)}|${m.position === 'belowBar' ? 'b' : 'a'}`
        const list = byBar.get(k) ?? []
        if (!list.some((x) => x.kind === m.kind)) list.push(m)
        byBar.set(k, list)
      }
      for (const [k, list] of byBar) {
        const m = list[0]!
        const e = extent.get(horzKey(m.time))
        if (!e) continue
        let x: number | null
        let y: number | null
        const rebased = !!current.panes[s.pane]?.side[s.side]?.indexed
        const first = rebased ? firstValue(s) : null
        const at = m.position === 'belowBar' ? e.lo : e.hi
        try {
          x = chart.timeScale().timeToCoordinate(m.time as never)
          y = api.priceToCoordinate(rebased && first ? pctFrom(at, first) : at)
        } catch {
          x = null
          y = null
        }
        if (x == null || y == null || !Number.isFinite(x) || !Number.isFinite(y)) continue
        const top = paneTop[s.pane] ?? 0
        nextPins.push({ id: `${s.id}|${k}`, x: Math.max(leftWidth + PIN / 2 + 2, leftWidth + x), y: top + y, below: m.position === 'belowBar', paneTop: top, items: list.map((i) => ({ letter: i.letter, color: i.color, kind: i.kind })) })
      }
    }
    setPins((prev) => (prev.length === nextPins.length && prev.every((p, i) => p.id === nextPins[i]!.id && p.x === nextPins[i]!.x && p.y === nextPins[i]!.y) ? prev : nextPins))
    const out: Badge[] = []
    for (const [key, list] of groups) {
      const pane = Number(key.split(':')[0])
      out.push(...stackBadges(list, paneTop[pane] ?? 0, paneHeight[pane] ?? 0))
    }
    // A tick a badge covers is removed, not half hidden (round 2: 7,650 under 7,659.44): the price band around each
    // badge goes to the axis formatter, which prints nothing there, and the scales repaint once when the bands move.
    const blocked = new Map<string, [number, number][]>()
    for (const b of out) {
      const key = `${b.id.split('|')[0]!.split(':')[0]}:${b.side}`
      const owner = seriesRef.current.find((x) => `${x.spec.pane}:${x.spec.side}` === key)
      if (!owner) continue
      const top = paneTop[owner.spec.pane] ?? 0
      let a: number | null
      let c: number | null
      try {
        a = owner.api.coordinateToPrice(b.top - top - TICK_CLEAR)
        c = owner.api.coordinateToPrice(b.top - top + TICK_CLEAR)
      } catch {
        a = null
        c = null
      }
      if (a == null || c == null) continue
      const list = blocked.get(key) ?? []
      list.push([Math.min(a, c), Math.max(a, c)])
      blocked.set(key, list)
    }
    const signature = JSON.stringify([...blocked.entries()].map(([k, v]) => [k, v.map(([lo, hi]) => [+lo.toPrecision(6), +hi.toPrecision(6)])]))
    if (signature !== blockedSig.current) {
      blockedSig.current = signature
      blockedRef.current = blocked
      const repainted = new Set<string>()
      for (const { api, spec: s } of seriesRef.current) {
        const key = `${s.pane}:${s.side}`
        if (repainted.has(key)) continue
        repainted.add(key)
        try {
          api.applyOptions({ priceFormat: priceFormatFor(s, !!current.panes[s.pane]?.side[s.side]?.indexed, blockedFor(key)) })
        } catch {
          /* a disposed series */
        }
      }
    }
    setBadges((prev) => (prev.length === out.length && prev.every((b, i) => b.id === out[i]!.id && b.top === out[i]!.top && b.y === out[i]!.y && b.text === out[i]!.text && b.color === out[i]!.color && b.title === out[i]!.title) ? prev : out))
  }, [])
  const scheduleBadges = useCallback(() => {
    if (typeof requestAnimationFrame === 'undefined') {
      layoutBadges()
      return
    }
    // The chart paints on its own animation frame: measure after it has.
    requestAnimationFrame(() => requestAnimationFrame(layoutBadges))
  }, [layoutBadges])

  // Create the chart once per structure (x kind, intraday, pane list); dispose on unmount.
  useEffect(() => {
    const el = hostRef.current
    if (!el || empty) return
    const base = {
      ...theme,
      layout: { ...theme.layout, attributionLogo: false },
      autoSize: false,
      width: el.clientWidth || 300,
      height: el.clientHeight || 200,
      timeScale: { ...theme.timeScale, timeVisible: spec.intraday, secondsVisible: false },
    }
    let chart: Chart
    if (spec.x === 'time') chart = createChart(el, base) as unknown as Chart
    else {
      // A tenor or strike axis is categorical (change 14): one evenly spaced slot per maturity or strike, so the
      // 1M-6M end is not a cliff at x = 0; labels "3M", "10Y" (or the strike), with room for the last one.
      const label = spec.x === 'months' ? (m: number) => spec.xLabels.get(m) ?? (m < 12 ? `${m}M` : `${(m / 12).toFixed(m % 12 ? 1 : 0)}Y`) : xStepLabel(spec.xStep)
      chart = createOptionsChart(el, {
        ...(base as DeepPartial<ChartOptions>),
        localization: { ...(base as { localization?: object }).localization, timeFormatter: label },
        timeScale: { ...base.timeScale, tickMarkFormatter: label, rightOffset: 0.6 },
      } as never) as unknown as Chart
      // The price-based horizontal scale ignores tickMarkFormatter and prints `toFixed`; its behaviour object is the
      // only place to put "3M" and "10Y" on the axis and under the crosshair.
      const behaviour = (chart as unknown as { horzBehaviour?: () => { formatTickmark?: unknown; formatHorzItem?: unknown } }).horzBehaviour?.()
      if (behaviour) {
        behaviour.formatTickmark = (item: { time: number }) => label(item.time)
        behaviour.formatHorzItem = (item: number) => label(item)
      }
    }
    chartRef.current = chart

    // The axis font is a web font (font-display: swap): repaint once it has loaded so the ticks do not keep the fallback face.
    let fontsCancelled = false
    if (typeof document !== 'undefined' && document.fonts?.ready) {
      void document.fonts.ready.then(() => {
        if (!fontsCancelled && chartRef.current === chart) chart.applyOptions({ layout: { fontFamily: theme.layout?.fontFamily } })
      })
    }
    const onMove = (param: MouseEventParams<HorzItem>) => {
      if (param.time === undefined || !param.point) {
        setHover(null)
        return
      }
      setHover({ key: horzKey(param.time), x: param.point.x, y: param.point.y })
    }
    chart.subscribeCrosshairMove(onMove)
    const onRange = () => scheduleBadges()
    const ts = chart.timeScale() as { subscribeVisibleLogicalRangeChange?: (h: () => void) => void; unsubscribeVisibleLogicalRangeChange?: (h: () => void) => void }
    ts.subscribeVisibleLogicalRangeChange?.(onRange)

    let observer: ResizeObserver | undefined
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver((entries) => {
        const rect = entries[0]?.contentRect
        if (rect && rect.width > 0 && rect.height > 0) {
          chart.applyOptions({ width: rect.width, height: rect.height })
          // Widgets always show the whole range: refit after a resize (the grid cell or the expand dialog changing size).
          chart.timeScale().fitContent()
          measurePanes(chart, chart.panes().length)
          scheduleBadges()
        }
      })
      observer.observe(el)
    }
    return () => {
      fontsCancelled = true
      observer?.disconnect()
      chart.unsubscribeCrosshairMove(onMove)
      ts.unsubscribeVisibleLogicalRangeChange?.(onRange)
      seriesRef.current = []
      chartRef.current = null
      chart.remove()
    }
    // theme is a module constant; spec.x, spec.intraday and spec.xLabels only change with the structure
  }, [structure, empty])

  // (Re)load series whenever the spec changes; fit the visible range to it.
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    for (const s of seriesRef.current) chart.removeSeries(s.api)
    seriesRef.current = []
    while (chart.panes().length < spec.panes.length) chart.addPane(true)

    for (const s of spec.series) {
      // A rebased (indexed) scale plots each series as its percent change from its first value on a normal axis
      // (round 2), so the axis, the badge and the legend's change are one number in one unit.
      const rebased = !!spec.panes[s.pane]?.side[s.side]?.indexed
      const first = rebased ? firstValue(s) : null
      const toPlot = (v: number) => (rebased && first ? pctFrom(v, first) : v)
      const common = {
        priceScaleId: s.side,
        priceFormat: priceFormatFor(s, rebased, blockedFor(`${s.pane}:${s.side}`)),
        priceLineVisible: false,
        // The badges are drawn by the view (stacked, covering the tick under them), not by the library.
        lastValueVisible: false,
        ...(s.range ? { autoscaleInfoProvider: () => ({ priceRange: { minValue: s.range![0], maxValue: s.range![1] } }) } : {}),
      }
      let series: Series
      switch (s.kind) {
        case 'candle':
          series = chart.addSeries(CandlestickSeries, { ...common, upColor: UP_COLOR, downColor: DOWN_COLOR, borderVisible: false, wickUpColor: UP_COLOR, wickDownColor: DOWN_COLOR }, s.pane)
          break
        case 'area':
          series = chart.addSeries(AreaSeries, { ...common, lineColor: s.color, topColor: withAlpha(s.color, 0.3), bottomColor: withAlpha(s.color, 0.02), lineWidth: s.width as LineWidth }, s.pane)
          break
        case 'histogram':
          series = chart.addSeries(HistogramSeries, { ...common, color: withAlpha(s.color, 0.6), base: 0 }, s.pane)
          break
        default:
          // Dots at each tenor or strike on a categorical axis (change 14).
          series = chart.addSeries(LineSeries, { ...common, color: s.color, lineWidth: s.width as LineWidth, crosshairMarkerRadius: 4, ...(spec.x !== 'time' ? { pointMarkersVisible: true, pointMarkersRadius: 3 } : {}) }, s.pane)
      }
      series.setData((rebased && first ? rebaseData(s.data, first) : s.data) as never)
      if (s.kind === 'histogram' && (s.data as { value: number }[]).some((d) => d.value < 0)) {
        series.createPriceLine({ price: 0, color: zeroLineColor, lineWidth: 1, lineStyle: LineStyle.Solid, axisLabelVisible: false, title: '' })
      }
      for (const l of s.priceLines) {
        // The label on the axis is the view's badge (stacked with the last values), not the library's.
        series.createPriceLine({ price: toPlot(l.price), color: l.color ?? levelColor, lineWidth: 1, lineStyle: LINE_STYLE[l.style], axisLabelVisible: false, title: '' })
      }
      // Event markers are drawn by the view (pins anchored to the bar, change 12), laid out with the badges.
      if (s.bands.length > 0) series.attachPrimitive(new BandPrimitive(s.bands))
      seriesRef.current.push({ api: series, spec: s })
    }
    // Pane heights and scales.
    const panes = chart.panes()
    for (const p of spec.panes) {
      panes[p.index]?.setStretchFactor(p.height)
      for (const side of ['right', 'left'] as const) {
        const used = spec.series.some((s) => s.pane === p.index && s.side === side)
        const scale = p.side[side]
        try {
          chart.priceScale(side, p.index).applyOptions({
            visible: used && (scale?.visible ?? true),
            // Rebased series arrive as percent changes (above): the scale itself stays normal.
            mode: PriceScaleMode.Normal,
            // Room above the highest bar for an event pin and its stem (change 12).
            scaleMargins: { top: spec.series.some((x) => x.pane === p.index && x.markers.length > 0) ? 0.18 : 0.12, bottom: 0.08 },
          })
        } catch {
          /* a pane without that scale */
        }
      }
    }
    for (let i = chart.panes().length - 1; i >= spec.panes.length; i--) chart.removePane(i)
    chart.timeScale().fitContent()
    measurePanes(chart, spec.panes.length)
    scheduleBadges()
  }, [spec, scheduleBadges])

  // Pane tops moved (a resize, a new pane): the badges follow.
  useEffect(() => {
    scheduleBadges()
  }, [tops, scheduleBadges])

  if (empty) {
    const recipe = recipeOf(widget)
    if (recipe === 'macro') return <EmptyState title="No observations" hint="The query returned no values for this range." />
    if (recipe === 'ohlcv' || recipe === 'index') return <EmptyState title="No bars" hint="The query returned no price bars for this range." />
    return <EmptyState title="Nothing to chart" hint="The frame has no series the preset can draw." />
  }

  const plan = badgePlan(spec)
  const hoverMarkers: MarkerSpec[] = hover ? spec.series.flatMap((s) => s.markers.filter((m) => horzKey(m.time) === hover.key)) : []
  const preset = view.preset
  const mainRows = legendSeries(spec, 0)
  const mainPane = spec.panes[0]
  const mainRebased = !!(mainPane?.side.right?.indexed || mainPane?.side.left?.indexed)
  const levelsOnMain = spec.series.filter((s) => s.pane === 0).reduce((n, s) => n + s.priceLines.length, 0)
  const insetRows = spec.panes.slice(1).reduce((n, p) => n + legendSeries(spec, p.index).length, 0)
  // What `data-last-value` reports (the checklist's "last-value label"): every last value on screen, on a badge or in a chip.
  const lastValueTotal =
    (plan.legend === 'badges' ? plan.series.size + Math.min(plan.levels, levelsOnMain) : plan.legend === 'values' ? mainRows.length : mainRows.filter((r) => r.kind === 'histogram' || atTheMoney(r, spec.underlying)).length) + insetRows
  const mainLegend =
    mainRows.length > 0 || mainPane?.title ? (
      <Legend placement="top" title={mainPane?.title} rows={mainRows} hover={hover?.key ?? null} percentUnits={percentUnits} markerKinds={spec.markerKinds} categorical={spec.x !== 'time'} mode={plan.legend} rebased={mainRebased} underlying={spec.underlying} />
    ) : null

  return (
    <div ref={rootRef} data-view="chart" data-preset={preset} data-x={spec.x} data-panes={spec.panes.length} data-last-value={lastValueTotal} data-badges={plan.legend} data-legend-placement="top" style={rootStyle}>
      {mainLegend}
      <div style={plotStyle}>
        <div ref={hostRef} style={hostStyle} />
        {spec.panes.slice(1).map((p) => {
          const rows = legendSeries(spec, p.index)
          if (rows.length === 0 && !p.title) return null
          return <Legend key={p.index} placement="inset" top={tops[p.index] ?? 0} title={p.title} rows={rows} hover={hover?.key ?? null} percentUnits={percentUnits} markerKinds={[]} categorical={spec.x !== 'time'} mode="values" rebased={false} />
        })}
        {badges.map((b) => {
          const box = axes[b.side]
          if (box.width <= 0) return null
          const top = Math.round(b.top - BADGE_HEIGHT / 2)
          // Stacked off its value (two close lines): a leader from the line's end at the plot edge to the badge.
          const moved = Math.abs(b.top - b.y) > 1
          const edge = b.side === 'right' ? box.left : box.left + box.width
          return (
            <div key={b.id} className="contents">
              {moved && (
                <svg data-leader="" aria-hidden="true" className="pointer-events-none absolute z-10 overflow-visible" style={{ left: 0, top: 0, width: 1, height: 1 }}>
                  <polyline
                    points={b.side === 'right' ? `${edge - 10},${b.y} ${edge - 4},${b.y} ${edge + 1},${b.top}` : `${edge + 10},${b.y} ${edge + 4},${b.y} ${edge - 1},${b.top}`}
                    fill="none"
                    stroke={b.color}
                    strokeWidth={1}
                  />
                </svg>
              )}
              <div
                data-badge=""
                className="num pointer-events-none absolute z-10 flex items-center justify-center overflow-hidden text-[11px] leading-none font-medium"
                style={{ left: box.left + 1, width: box.width - 1, top, height: BADGE_HEIGHT, background: b.color, color: badgeTextColor(b.color) }}
              >
                {b.text}
              </div>
              {b.title && (
                <div
                  data-badge-title=""
                  className="pointer-events-none absolute z-10 flex items-center rounded-sm bg-surface/80 px-1 text-[10px] leading-none whitespace-nowrap text-fg-2"
                  style={{ left: b.side === 'right' ? box.left - 2 : box.left + box.width + 2, transform: b.side === 'right' ? 'translateX(-100%)' : undefined, top, height: BADGE_HEIGHT }}
                >
                  {b.title}
                </div>
              )}
            </div>
          )
        })}
        {pins.map((p) => (
          <MarkerPin key={p.id} pin={p} />
        ))}
        {hoverMarkers.length > 0 && hover && <MarkerTooltip markers={hoverMarkers} x={hover.x} y={hover.y} />}
      </div>
    </div>
  )
}

const rootStyle: CSSProperties = { display: 'flex', flexDirection: 'column', width: '100%', height: '100%', minHeight: 160 }
const plotStyle: CSSProperties = { position: 'relative', flex: '1 1 0', minHeight: 0, minWidth: 0 }
const hostStyle: CSSProperties = { position: 'absolute', inset: 0 }

type LegendProps = {
  placement: 'top' | 'inset'
  top?: number
  title: string | undefined
  rows: SeriesSpec[]
  hover: number | null
  percentUnits: Set<string>
  markerKinds: ChartSpec['markerKinds']
  /** A categorical or numeric x (a curve, strikes): the chips carry no change figure, a snapshot has no move. */
  categorical: boolean
  /** Where the chart's last values live (`badgePlan`): beside badges, in the chips past three series, or totals on a strike axis. */
  mode: BadgePlan['legend']
  /** The pane is rebased: the axis reads percent change, so past three series the chip's change is its value. */
  rebased: boolean
  /** A strike axis' underlying: a by-strike line reads its value at the money. */
  underlying?: number | undefined
}

/** The text colour of a signed move: up, down, or muted at zero. */
function changeTone(v: number | null): string {
  return v == null || v === 0 ? 'text-fg-2' : v > 0 ? 'text-up' : 'text-down'
}

/** A by-strike bar series' total (OI or volume across the strikes shown). */
function totalOf(row: SeriesSpec): number {
  return (row.data as { value?: number }[]).reduce((n, d) => n + (typeof d.value === 'number' && Number.isFinite(d.value) ? d.value : 0), 0)
}

/**
 * Legend chips: one per line with its colour, label (the widget's `labels` override, else the symbol; the symbol
 * stays as the row's title), last value and change over the range, exactly the preview's numbers; under the
 * crosshair the chips show the hovered bar instead. The change is set in a tint of the series colour, not red or
 * green (change 7). Above the plot for the price pane (round 2: never a 170px column beside it); inset in the
 * top-left for indicator panes. Past three series the badges go and the chips carry the last value (on a rebased
 * chart the change, which is what the axis reads); on a strike axis a bar series shows its total and a line its value
 * at the money, never the last strike's. Marker kinds get a chip with their letter and display name.
 */
const Legend: FC<LegendProps> = ({ placement, top, title, rows, hover, percentUnits, markerKinds, categorical, mode, rebased, underlying }) => {
  const many = placement === 'top' && rows.length > 4
  // One price series on the price pane: its move has a side. A comparison, a rate or an indicator: neutral.
  const only = placement === 'top' && rows.length === 1 ? rows[0]! : undefined
  const field = only?.id.split(':')[3] ?? ''
  const signed = !!only && !percentUnits.has(only.id) && (only.kind === 'candle' || (/^(close|adj_close|price|last|last_price|value|nav)$/i.test(field) && !NEUTRAL_READING.test(field)))
  return (
  <div
    data-legend=""
    data-placement={placement}
    role="list"
    aria-label={title ? `${title} legend` : 'Series legend'}
    className={clsx(
      'text-xs leading-4',
      placement === 'inset' && 'pointer-events-none absolute left-2 z-10 flex max-w-[calc(100%-64px)] flex-wrap items-center gap-x-1 gap-y-0.5',
      placement === 'top' && 'flex shrink-0 flex-wrap items-center gap-y-0.5 overflow-hidden px-3 pt-1.5 pb-1',
      // Two rows for a few series; more may take three rather than hide a series (the seventh Mag 7 line had no chip).
      placement === 'top' && (many ? 'max-h-[56px] gap-x-2.5' : 'max-h-[38px] gap-x-3'),
    )}
    style={placement === 'inset' ? { top: (top ?? 0) + 6 } : undefined}
  >
    {title && (
      <span data-pane-title="" className={clsx('rounded-sm px-1.5 py-px font-medium text-fg-2', placement === 'inset' && 'bg-surface/80')}>
        {title}
      </span>
    )}
    {rows.map((row) => {
      const hovered = hover != null ? row.byTime.get(hover) : undefined
      const text = legendValues(row, percentUnits.has(row.id), hovered ?? null)
      let last: string | null = text.last
      let change: string | null = categorical ? null : text.change
      if (mode === 'values' && rebased) last = null // the change is the value the axis reads
      if (mode === 'totals') {
        change = null
        if (hovered != null) last = text.last
        else if (row.kind === 'histogram') last = `${formatValue(totalOf(row), 'integer')} total`
        else {
          const atm = atTheMoney(row, underlying)
          last = atm ? `${formatValue(atm.value, row.format, row.precision)} at the money` : null
        }
      }
      return (
        <div key={row.id} role="listitem" data-symbol={row.group} title={row.label === row.group ? undefined : row.group} className={clsx('flex min-w-0 items-center gap-1.5 whitespace-nowrap', placement === 'inset' && 'rounded-sm bg-surface/80 px-1.5 py-px')}>
          {row.kind === 'candle' ? (
            // Candles have two colours: a two-tone glyph, never the up-candle green alone (round 2, change 4).
            <span aria-hidden="true" data-glyph="candle" className="inline-flex h-2.5 w-2.5 shrink-0 items-stretch gap-px">
              <span className="w-1 rounded-xs" style={{ background: UP_COLOR }} />
              <span className="w-1 rounded-xs" style={{ background: DOWN_COLOR }} />
            </span>
          ) : (
            <span aria-hidden="true" className="inline-block h-0.5 w-2.5 shrink-0 rounded-xs" style={{ background: row.color }} />
          )}
          <span className="num truncate font-semibold text-fg">{row.label}</span>
          {last !== null && (
            <span data-field="last" className="num text-fg-2">
              {last}
            </span>
          )}
          {change !== null && (
            // Text never wears the series colour (round 2, change 4: a red "-28.14%" in up-candle green): one price series
            // colours its move by sign, a comparison or a rate keeps it neutral (the colour beside it is the identity).
            <span data-field="change" className={clsx('num', signed ? changeTone(text.changeValue) : 'text-fg-2')}>
              {change}
            </span>
          )}
        </div>
      )
    })}
    {markerKinds.map((m) => (
      <div key={m.kind} role="listitem" data-marker-kind={m.kind} className={clsx('flex items-center gap-1 whitespace-nowrap text-fg-2', placement === 'inset' && 'rounded-sm bg-surface/80 px-1.5 py-px')}>
        <span aria-hidden="true" className="num inline-flex h-3.5 w-3.5 items-center justify-center rounded-full text-[9px] font-semibold text-bg" style={{ background: m.color }}>
          {m.letter}
        </span>
        <span>{markerKindLabel(m.kind)}</span>
      </div>
    ))}
  </div>
  )
}

/** The events under the crosshair: label and detail per marker, beside the pointer. */
const MarkerTooltip: FC<{ markers: MarkerSpec[]; x: number; y: number }> = ({ markers, x, y }) => (
  <div
    data-marker-tooltip=""
    className={clsx('pointer-events-none absolute z-20 max-w-[280px] rounded-md border border-border bg-surface-2 px-2 py-1.5 text-xs leading-4 shadow-dialog')}
    style={{ left: x + 12, top: Math.max(4, y - 12) }}
  >
    {markers.slice(0, 4).map((m, i) => (
      <div key={i} className="flex items-start gap-1.5">
        <span aria-hidden="true" className="num mt-px inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold text-bg" style={{ background: m.color }}>
          {m.letter}
        </span>
        <span className="min-w-0">
          <span className="line-clamp-2 text-fg">{m.label}</span>
          {m.detail && <span className="num text-fg-2">{m.detail}</span>}
        </span>
      </div>
    ))}
    {markers.length > 4 && <div className="text-fg-3">+{markers.length - 4} more</div>}
  </div>
)
