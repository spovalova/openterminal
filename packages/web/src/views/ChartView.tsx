import { useEffect, useMemo, useRef, useState, type CSSProperties, type FC } from 'react'
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
  createSeriesMarkers,
  createYieldCurveChart,
  type ChartOptions,
  type DeepPartial,
  type IChartApiBase,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type LineWidth,
  type MouseEventParams,
  type PriceFormat,
  type SeriesType,
} from 'lightweight-charts'
import { isWidgetV2 } from '@terminal/core'
import { DOWN_COLOR, EmptyState, UP_COLOR, chartTheme, levelColor, zeroLineColor } from '@terminal/ui'
import type { ViewProps } from './types'
import { direction, withAlpha } from './format'
import { datasetsFor, expandView, kindOf, viewOf } from './fields'
import { legendLabel } from './series-data'
import { BandPrimitive } from './chart/band-primitive'
import { buildChart, horzKey, legendValues, type ChartSpec, type HorzItem, type MarkerSpec, type SeriesSpec } from './chart/data'

type Chart = IChartApiBase<HorzItem>
type Series = ISeriesApi<SeriesType, HorzItem>

const LINE_STYLE = { solid: LineStyle.Solid, dashed: LineStyle.Dashed, dotted: LineStyle.Dotted } as const

/** The series the legend lists per pane: lines, areas and candles; histograms only when they are the pane's only kind. */
function legendSeries(spec: ChartSpec, pane: number): SeriesSpec[] {
  const own = spec.series.filter((s) => s.pane === pane && s.legend)
  const drawn = own.filter((s) => s.kind !== 'histogram')
  return drawn.length > 0 ? drawn : own
}

/** Up to four series per pane carry their last value on the axis; past that only the first, so the badges stay legible. */
const LAST_VALUE_MAX = 4

function priceFormatFor(s: SeriesSpec): PriceFormat {
  switch (s.format) {
    case 'percent':
      return { type: 'custom', formatter: (v: number) => `${v.toFixed(2)}%`, minMove: 0.01 }
    case 'compact':
      return { type: 'volume', precision: 2, minMove: 1 }
    case 'integer':
      return { type: 'price', precision: 0, minMove: 1 }
    case 'ratio':
      return { type: 'price', precision: 1, minMove: 0.1 }
    default:
      return { type: 'price', precision: s.precision, minMove: Math.pow(10, -s.precision) }
  }
}

/**
 * The chart renderer: a preset's panes and layers on lightweight-charts 5 (PLAN.md section 17). Panes stack with
 * relative heights (`addPane`, stretch factors); a layer's `scale` picks the axis (`priceScaleId`); markers are
 * series markers with a letter per kind; levels are price lines; bands a primitive; volume and signed bars are
 * histograms; a numeric x goes through the yield-curve chart (maturities in months) or the options chart.
 * The legend sits as chips in each pane's top-left and follows the crosshair; last values sit on the axis in
 * the series colour. Candles and the indexed-to-100 scale (v1 `candle` and `normalize`) render as before.
 */
export const ChartView: FC<ViewProps> = ({ widget, frames }) => {
  const view = viewOf(widget)
  const kind = kindOf(widget)
  const labels = 'labels' in view ? view.labels : undefined
  const spec = useMemo(() => {
    const datasets = datasetsFor(widget, frames)
    const panes = expandView(widget, frames)
    const groupLabel = kind ? (g: string) => legendLabel(g, kind) : undefined
    return buildChart(panes, frames, datasets, { labels, groupLabel })
  }, [widget, frames, labels, kind])
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
  const seriesRef = useRef<Series[]>([])
  const pluginsRef = useRef<ISeriesMarkersPluginApi<HorzItem>[]>([])
  const [tops, setTops] = useState<number[]>([])
  const [hover, setHover] = useState<{ key: number; x: number; y: number } | null>(null)
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

  // Create the chart once per structure (x kind, intraday, pane list); dispose on unmount.
  useEffect(() => {
    const el = hostRef.current
    if (!el || empty) return
    const base = {
      ...theme,
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

    let observer: ResizeObserver | undefined
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver((entries) => {
        const rect = entries[0]?.contentRect
        if (rect && rect.width > 0 && rect.height > 0) {
          chart.applyOptions({ width: rect.width, height: rect.height })
          // Widgets always show the whole range: refit after a resize (the grid cell or the expand dialog changing size).
          chart.timeScale().fitContent()
          measurePanes(chart, chart.panes().length)
        }
      })
      observer.observe(el)
    }
    return () => {
      fontsCancelled = true
      observer?.disconnect()
      chart.unsubscribeCrosshairMove(onMove)
      seriesRef.current = []
      pluginsRef.current = []
      chartRef.current = null
      chart.remove()
    }
    // theme is a module constant; spec.x, spec.intraday and spec.xLabels only change with the structure
  }, [structure, empty])

  // (Re)load series whenever the spec changes; fit the visible range to it.
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    for (const p of pluginsRef.current) p.detach()
    pluginsRef.current = []
    for (const s of seriesRef.current) chart.removeSeries(s)
    seriesRef.current = []
    while (chart.panes().length < spec.panes.length) chart.addPane(true)

    const lastValueCount = new Map<number, number>()
    for (const s of spec.series) {
      const n = lastValueCount.get(s.pane) ?? 0
      const lastValueVisible = s.lastValue && n < LAST_VALUE_MAX && s.kind !== 'histogram'
      if (lastValueVisible) lastValueCount.set(s.pane, n + 1)
      const common = {
        priceScaleId: s.side,
        priceFormat: priceFormatFor(s),
        priceLineVisible: false,
        lastValueVisible,
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
      if (s.markers.length > 0) {
        const plugin = createSeriesMarkers(series, s.markers.map((m) => ({ time: m.time, position: m.position, shape: 'circle' as const, color: m.color, text: m.letter, size: 1 })))
        pluginsRef.current.push(plugin)
      }
      if (s.bands.length > 0) series.attachPrimitive(new BandPrimitive(s.bands))
      seriesRef.current.push(series)
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
            scaleMargins: { top: 0.14, bottom: 0.08 },
          })
        } catch {
          /* a pane without that scale */
        }
      }
    }
    for (let i = chart.panes().length - 1; i >= spec.panes.length; i--) chart.removePane(i)
    chart.timeScale().fitContent()
    measurePanes(chart, spec.panes.length)
  }, [spec])

  if (empty) {
    if (kind === 'macro') return <EmptyState title="No observations" hint="The query returned no values for this range." />
    if (kind === 'ohlcv') return <EmptyState title="No bars" hint="The query returned no price bars for this range." />
    return <EmptyState title="Nothing to chart" hint="The frame has no series the preset can draw." />
  }

  const lastValueTotal = Math.min(LAST_VALUE_MAX * spec.panes.length, spec.series.filter((s) => s.lastValue && s.kind !== 'histogram').length)
  const hoverMarkers: MarkerSpec[] = hover ? spec.series.flatMap((s) => s.markers.filter((m) => horzKey(m.time) === hover.key)) : []
  const preset = view.preset

  return (
    <div data-view="chart" data-preset={preset} data-x={spec.x} data-panes={spec.panes.length} data-last-value={lastValueTotal} data-kind={kind} data-mode={isWidgetV2(widget) ? undefined : legacyMode(widget)} style={rootStyle}>
      <div style={plotStyle}>
        <div ref={hostRef} style={hostStyle} />
        {spec.panes.map((p) => {
          const rows = legendSeries(spec, p.index)
          if (rows.length === 0 && !p.title) return null
          return (
            <Legend
              key={p.index}
              top={tops[p.index] ?? 0}
              title={p.title}
              rows={rows}
              hover={hover?.key ?? null}
              percentUnits={percentUnits}
              markerKinds={p.index === 0 ? spec.markerKinds : []}
            />
          )
        })}
        {hoverMarkers.length > 0 && hover && <MarkerTooltip markers={hoverMarkers} x={hover.x} y={hover.y} />}
      </div>
    </div>
  )
}

function legacyMode(widget: ViewProps['widget']): string | undefined {
  if (isWidgetV2(widget) || widget.view.type !== 'series') return undefined
  return widget.view.candle ? 'candle' : widget.view.normalize ? 'normalize' : 'line'
}

const rootStyle: CSSProperties = { display: 'flex', flexDirection: 'column', width: '100%', height: '100%', minHeight: 160 }
const plotStyle: CSSProperties = { position: 'relative', flex: '1 1 0', minHeight: 0 }
const hostStyle: CSSProperties = { position: 'absolute', inset: 0 }

/**
 * Legend chips in a pane's top-left (the Instinct reference): one per line with its colour, label (the widget's
 * `labels` override, else the symbol; the symbol stays as the row's title), last value and change over the
 * range, exactly the preview's numbers; under the crosshair the chips show the hovered bar instead. Marker
 * kinds get a chip with their letter. Pointer events pass through to the chart.
 */
const Legend: FC<{ top: number; title: string | undefined; rows: SeriesSpec[]; hover: number | null; percentUnits: Set<string>; markerKinds: ChartSpec['markerKinds'] }> = ({ top, title, rows, hover, percentUnits, markerKinds }) => (
  <div
    data-legend=""
    role="list"
    aria-label={title ? `${title} legend` : 'Series legend'}
    className="pointer-events-none absolute left-2 z-10 flex max-w-[calc(100%-64px)] flex-wrap items-center gap-x-1 gap-y-0.5 text-xs leading-4"
    style={{ top: top + 6 }}
  >
    {title && (
      <span data-pane-title="" className="rounded-sm bg-surface/80 px-1.5 py-px font-medium text-fg-2">
        {title}
      </span>
    )}
    {rows.map((row) => {
      const hovered = hover != null ? row.byTime.get(hover) : undefined
      const text = legendValues(row, percentUnits.has(row.id), hovered ?? null)
      const dir = direction(text.changeValue)
      return (
        <div
          key={row.id}
          role="listitem"
          data-symbol={row.group}
          title={row.label === row.group ? undefined : row.group}
          className="flex items-center gap-1.5 rounded-sm bg-surface/80 px-1.5 py-px whitespace-nowrap"
        >
          <span aria-hidden="true" className="inline-block h-0.5 w-2.5 rounded-xs" style={{ background: row.color }} />
          <span className="num font-semibold text-fg">{row.label}</span>
          <span data-field="last" className="num text-fg-2">
            {text.last}
          </span>
          <span data-field="change" className="num" style={{ color: dir === 'up' ? UP_COLOR : dir === 'down' ? DOWN_COLOR : undefined, opacity: dir === 'flat' ? 0.7 : 1 }}>
            {text.change}
          </span>
        </div>
      )
    })}
    {markerKinds.map((m) => (
      <div key={m.kind} role="listitem" data-marker-kind={m.kind} className="flex items-center gap-1 rounded-sm bg-surface/80 px-1.5 py-px whitespace-nowrap text-fg-2">
        <span aria-hidden="true" className="num inline-flex h-3.5 w-3.5 items-center justify-center rounded-full text-[9px] font-semibold text-bg" style={{ background: m.color }}>
          {m.letter}
        </span>
        <span>{m.kind}</span>
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
