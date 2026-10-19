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
  createYieldCurveChart,
  type ChartOptions,
  type DeepPartial,
  type IChartApiBase,
  type ISeriesApi,
  type LineWidth,
  type MouseEventParams,
  type PriceFormat,
  type SeriesType,
} from 'lightweight-charts'
import { DOWN_COLOR, EmptyState, UP_COLOR, chartTheme, levelColor, zeroLineColor } from '@terminal/ui'
import type { ViewProps } from './types'
import { withAlpha } from './format'
import { datasetsFor, expandView, recipeOf, viewOf } from './fields'
import { legendLabel } from './series-data'
import { useWidth } from './use-width'
import { BandPrimitive } from './chart/band-primitive'
import { buildChart, formatValue, horzKey, legendValues, markerKindLabel, type ChartSpec, type HorzItem, type MarkerSpec, type SeriesSpec } from './chart/data'

type Chart = IChartApiBase<HorzItem>
type Series = ISeriesApi<SeriesType, HorzItem>

const LINE_STYLE = { solid: LineStyle.Solid, dashed: LineStyle.Dashed, dotted: LineStyle.Dotted } as const

/** The series the legend lists per pane: lines, areas and candles; histograms only when they are the pane's only kind. */
function legendSeries(spec: ChartSpec, pane: number): SeriesSpec[] {
  const own = spec.series.filter((s) => s.pane === pane && s.legend)
  const drawn = own.filter((s) => s.kind !== 'histogram')
  return drawn.length > 0 ? drawn : own
}

/** Up to six series per pane carry their last value on the axis (stacked when they would collide); past that only the first six. */
const LAST_VALUE_MAX = 6
/** A last-value badge is this tall; two closer than this stack. */
const BADGE_HEIGHT = 16
/** Past this many series the legend moves to a column beside the plot when the widget is wide enough to spare it. */
const SIDE_LEGEND_MIN_SERIES = 5
const SIDE_LEGEND_MIN_WIDTH = 640

/** Axis labels (change 13): index levels and share counts as "7,659" and "95,394,231", millions and billions compact. */
function compactAxis(v: number): string {
  const abs = Math.abs(v)
  const sign = v < 0 ? '-' : ''
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(abs >= 1e10 ? 1 : 2)}B`
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(abs >= 1e7 ? 1 : 2)}M`
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(v)
}

function priceFormatFor(s: SeriesSpec): PriceFormat {
  switch (s.format) {
    case 'percent':
      return { type: 'custom', formatter: (v: number) => `${v.toFixed(2)}%`, minMove: 0.01 }
    case 'compact':
      return { type: 'custom', formatter: compactAxis, minMove: 1 }
    case 'integer':
      return { type: 'price', precision: 0, minMove: 1 }
    case 'ratio':
      return { type: 'price', precision: 1, minMove: 0.1 }
    default:
      return { type: 'price', precision: s.precision, minMove: Math.pow(10, -s.precision) }
  }
}

type Badge = { id: string; color: string; text: string; top: number; side: 'right' | 'left' }
/** An event pin: the bar's x, the bar's high (or low) y, and the marker kinds on that bar. */
type Pin = { id: string; x: number; y: number; below: boolean; paneTop: number; items: { letter: string; color: string; kind: string }[] }
/** Pin circle diameter and the stem between the bar and the circle. */
const PIN = 14
const STEM = 6

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
    return buildChart(panes, frames, datasets, { labels, groupLabel: (g: string) => legendLabel(g) })
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
  const structure = `${spec.x}|${spec.intraday}|${spec.panes.map((p) => `${p.height}:${p.side.right?.indexed}:${p.side.left?.indexed}`).join(',')}`

  const hostRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<Chart | null>(null)
  const seriesRef = useRef<{ api: Series; spec: SeriesSpec }[]>([])
  const specRef = useRef(spec)
  specRef.current = spec
  const percentRef = useRef(percentUnits)
  percentRef.current = percentUnits
  const [tops, setTops] = useState<number[]>([])
  const [hover, setHover] = useState<{ key: number; x: number; y: number } | null>(null)
  const [badges, setBadges] = useState<Badge[]>([])
  const [pins, setPins] = useState<Pin[]>([])
  const [axes, setAxes] = useState<AxisBox>({ right: { left: 0, width: 0 }, left: { left: 0, width: 0 } })
  const [rootRef, rootWidth] = useWidth()
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
    const count = new Map<number, number>()
    for (const { api, spec: s } of seriesRef.current) {
      if (!s.lastValue || s.kind === 'histogram' || s.last == null) continue
      const n = count.get(s.pane) ?? 0
      if (n >= LAST_VALUE_MAX) continue
      count.set(s.pane, n + 1)
      let y: number | null
      try {
        y = api.priceToCoordinate(s.last)
      } catch {
        y = null
      }
      if (y == null || !Number.isFinite(y)) continue
      const indexed = current.panes[s.pane]?.side[s.side]?.indexed
      const first = indexed ? firstValue(s) : null
      // On a rebased axis the badge reads the axis (the index level), not the raw price the legend shows.
      const text = indexed && first ? (s.last / first * 100).toFixed(2) : percentRef.current.has(s.id) ? `${s.last.toFixed(2)}%` : formatValue(s.last, s.format, s.precision)
      let color = s.color
      if (s.kind === 'candle') {
        const bars = s.data as { open: number; close: number }[]
        const last = bars[bars.length - 1]
        color = last && last.close < last.open ? DOWN_COLOR : UP_COLOR
      }
      const key = `${s.pane}:${s.side}`
      const list = groups.get(key) ?? []
      list.push({ id: s.id, color, text, top: (paneTop[s.pane] ?? 0) + y, side: s.side })
      groups.set(key, list)
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
        try {
          x = chart.timeScale().timeToCoordinate(m.time as never)
          y = api.priceToCoordinate(m.position === 'belowBar' ? e.lo : e.hi)
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
    setBadges((prev) => (prev.length === out.length && prev.every((b, i) => b.id === out[i]!.id && b.top === out[i]!.top && b.text === out[i]!.text && b.color === out[i]!.color) ? prev : out))
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
    else if (spec.x === 'months') {
      const months = [...spec.xLabels.keys()]
      const max = months.length ? Math.max(...months) : 120
      chart = createYieldCurveChart(el, {
        ...(base as DeepPartial<ChartOptions>),
        yieldCurve: { baseResolution: 1, minimumTimeRange: Math.max(12, max), startTimeRange: 0, formatTime: (m: number) => spec.xLabels.get(m) ?? (m < 12 ? `${m}M` : `${(m / 12).toFixed(m % 12 ? 1 : 0)}Y`) },
      } as never) as unknown as Chart
    } else chart = createOptionsChart(el, base as never) as unknown as Chart
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
      const common = {
        priceScaleId: s.side,
        priceFormat: priceFormatFor(s),
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
          series = chart.addSeries(LineSeries, { ...common, color: s.color, lineWidth: s.width as LineWidth, crosshairMarkerRadius: 4 }, s.pane)
      }
      series.setData(s.data as never)
      if (s.kind === 'histogram' && (s.data as { value: number }[]).some((d) => d.value < 0)) {
        series.createPriceLine({ price: 0, color: zeroLineColor, lineWidth: 1, lineStyle: LineStyle.Solid, axisLabelVisible: false, title: '' })
      }
      for (const l of s.priceLines) {
        series.createPriceLine({ price: l.price, color: l.color ?? levelColor, lineWidth: 1, lineStyle: LINE_STYLE[l.style], axisLabelVisible: true, title: l.label ?? '' })
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
            mode: scale?.indexed ? PriceScaleMode.IndexedTo100 : PriceScaleMode.Normal,
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

  const lastValueTotal = Math.min(LAST_VALUE_MAX * spec.panes.length, spec.series.filter((s) => s.lastValue && s.kind !== 'histogram').length)
  const hoverMarkers: MarkerSpec[] = hover ? spec.series.flatMap((s) => s.markers.filter((m) => horzKey(m.time) === hover.key)) : []
  const preset = view.preset
  const mainRows = legendSeries(spec, 0)
  const mainPane = spec.panes[0]
  const side = mainRows.length >= SIDE_LEGEND_MIN_SERIES && (rootWidth ?? 0) >= SIDE_LEGEND_MIN_WIDTH
  const mainLegend =
    mainRows.length > 0 || mainPane?.title ? (
      <Legend placement={side ? 'side' : 'top'} title={mainPane?.title} rows={mainRows} hover={hover?.key ?? null} percentUnits={percentUnits} markerKinds={spec.markerKinds} categorical={spec.x !== 'time'} />
    ) : null

  return (
    <div
      ref={rootRef}
      data-view="chart"
      data-preset={preset}
      data-x={spec.x}
      data-panes={spec.panes.length}
      data-last-value={lastValueTotal}
      data-legend-placement={side ? 'side' : 'top'}
      style={side ? rootRowStyle : rootStyle}
    >
      {!side && mainLegend}
      <div style={plotStyle}>
        <div ref={hostRef} style={hostStyle} />
        {spec.panes.slice(1).map((p) => {
          const rows = legendSeries(spec, p.index)
          if (rows.length === 0 && !p.title) return null
          return <Legend key={p.index} placement="inset" top={tops[p.index] ?? 0} title={p.title} rows={rows} hover={hover?.key ?? null} percentUnits={percentUnits} markerKinds={[]} categorical={spec.x !== 'time'} />
        })}
        {badges.map((b) => {
          const box = axes[b.side]
          if (box.width <= 0) return null
          return (
            <div
              key={b.id}
              data-badge=""
              className="num pointer-events-none absolute z-10 flex items-center justify-center overflow-hidden text-[11px] leading-none font-medium text-bg"
              style={{ left: box.left + 1, width: box.width - 1, top: Math.round(b.top - BADGE_HEIGHT / 2), height: BADGE_HEIGHT, background: b.color }}
            >
              {b.text}
            </div>
          )
        })}
        {pins.map((p) => (
          <MarkerPin key={p.id} pin={p} />
        ))}
        {hoverMarkers.length > 0 && hover && <MarkerTooltip markers={hoverMarkers} x={hover.x} y={hover.y} />}
      </div>
      {side && mainLegend}
    </div>
  )
}

const rootStyle: CSSProperties = { display: 'flex', flexDirection: 'column', width: '100%', height: '100%', minHeight: 160 }
const rootRowStyle: CSSProperties = { display: 'flex', flexDirection: 'row', width: '100%', height: '100%', minHeight: 160 }
const plotStyle: CSSProperties = { position: 'relative', flex: '1 1 0', minHeight: 0, minWidth: 0 }
const hostStyle: CSSProperties = { position: 'absolute', inset: 0 }

type LegendProps = {
  placement: 'top' | 'side' | 'inset'
  top?: number
  title: string | undefined
  rows: SeriesSpec[]
  hover: number | null
  percentUnits: Set<string>
  markerKinds: ChartSpec['markerKinds']
  /** A categorical or numeric x (a curve, strikes): the chips carry no change figure, a snapshot has no move. */
  categorical: boolean
}

/**
 * Legend chips: one per line with its colour, label (the widget's `labels` override, else the symbol; the symbol
 * stays as the row's title), last value and change over the range, exactly the preview's numbers; under the
 * crosshair the chips show the hovered bar instead. The change is set in a tint of the series colour, not red or
 * green (change 7). Above the plot (one or two rows) or in a column beside it for the price pane; inset in the
 * top-left for indicator panes. Marker kinds get a chip with their letter and display name.
 */
const Legend: FC<LegendProps> = ({ placement, top, title, rows, hover, percentUnits, markerKinds, categorical }) => (
  <div
    data-legend=""
    data-placement={placement}
    role="list"
    aria-label={title ? `${title} legend` : 'Series legend'}
    className={clsx(
      'text-xs leading-4',
      placement === 'inset' && 'pointer-events-none absolute left-2 z-10 flex max-w-[calc(100%-64px)] flex-wrap items-center gap-x-1 gap-y-0.5',
      placement === 'top' && 'flex max-h-[38px] shrink-0 flex-wrap items-center gap-x-3 gap-y-0.5 overflow-hidden px-3 pt-1.5 pb-1',
      placement === 'side' && 'flex w-[168px] shrink-0 flex-col gap-0.5 overflow-y-auto border-l border-border py-2 pr-2 pl-2',
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
      return (
        <div key={row.id} role="listitem" data-symbol={row.group} title={row.label === row.group ? undefined : row.group} className={clsx('flex min-w-0 items-center gap-1.5 whitespace-nowrap', placement === 'inset' && 'rounded-sm bg-surface/80 px-1.5 py-px')}>
          <span aria-hidden="true" className="inline-block h-0.5 w-2.5 shrink-0 rounded-xs" style={{ background: row.color }} />
          <span className="num truncate font-semibold text-fg">{row.label}</span>
          <span data-field="last" className="num text-fg-2">
            {text.last}
          </span>
          {!categorical && (
            <span data-field="change" className="num" style={{ color: row.color, opacity: 0.85 }}>
              {text.change}
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
