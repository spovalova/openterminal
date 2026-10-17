import { useEffect, useMemo, useRef, type CSSProperties, type FC } from 'react'
import {
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  PriceScaleMode,
  createChart,
  type ChartOptions,
  type DeepPartial,
  type IChartApi,
  type ISeriesApi,
  type LineSeriesPartialOptions,
  type SeriesType,
} from 'lightweight-charts'
import { DOWN_COLOR, EmptyState, UP_COLOR, chartTheme, seriesPalette } from '@terminal/ui'
import type { ViewProps } from './types'
import { direction, formatPercent, formatPrice, withAlpha } from './format'
import { groupBars, intervalIsIntraday, legendRows, seriesMode, toCandleData, toLineData, toVolumeData, type LegendRow } from './series-data'

/** Colour for the i-th symbol: fixed palette order, never cycled past the palette size. */
function colorFor(i: number): string | undefined {
  return seriesPalette.length ? seriesPalette[i % seriesPalette.length] : undefined
}

function themeBackground(theme: DeepPartial<ChartOptions>): string | undefined {
  const bg = theme.layout?.background
  if (bg && typeof bg === 'object' && 'color' in bg && typeof bg.color === 'string') return bg.color
  return undefined
}

/**
 * `series` view: an ohlcv frame on lightweight-charts.
 * - default: one line per symbol (palette order)
 * - candle: one candlestick series plus a volume histogram on its own scale at the bottom
 * - normalize: lines on an indexed-to-100 price scale, so every symbol rebases at the first visible bar
 * The legend lists each symbol's last close and change over the range, exactly as `preview()` reports them.
 */
export const SeriesView: FC<ViewProps> = ({ widget, frame }) => {
  const mode = seriesMode(widget.view)
  const intraday = widget.query.kind === 'ohlcv' ? intervalIsIntraday(widget.query.params.interval) : false
  const series = useMemo(() => {
    const all = groupBars(frame, intraday)
    return mode === 'candle' ? all.slice(0, 1) : all
  }, [frame, intraday, mode])
  const legend = useMemo(
    () =>
      legendRows(
        frame,
        series.map((s) => s.symbol),
        mode === 'candle' ? () => UP_COLOR : colorFor,
      ),
    [frame, series, mode],
  )
  const empty = series.length === 0

  const hostRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<SeriesType>[]>([])
  const theme = chartTheme as DeepPartial<ChartOptions>

  // Create the chart once per (mode, interval kind); dispose on unmount.
  useEffect(() => {
    const el = hostRef.current
    if (!el || empty) return
    const chart = createChart(el, {
      ...theme,
      autoSize: false,
      width: el.clientWidth || 300,
      height: el.clientHeight || 200,
      timeScale: { ...theme.timeScale, timeVisible: intraday, secondsVisible: false },
      rightPriceScale: {
        ...theme.rightPriceScale,
        mode: mode === 'normalize' ? PriceScaleMode.IndexedTo100 : PriceScaleMode.Normal,
        scaleMargins: mode === 'candle' ? { top: 0.08, bottom: 0.28 } : (theme.rightPriceScale?.scaleMargins ?? { top: 0.12, bottom: 0.08 }),
      },
    })
    chartRef.current = chart

    let observer: ResizeObserver | undefined
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver((entries) => {
        const rect = entries[0]?.contentRect
        if (rect && rect.width > 0 && rect.height > 0) {
          chart.applyOptions({ width: rect.width, height: rect.height })
          // Widgets always show the whole range: refit after a resize (the grid cell or the expand dialog changing size).
          chart.timeScale().fitContent()
        }
      })
      observer.observe(el)
    }
    return () => {
      observer?.disconnect()
      seriesRef.current = []
      chartRef.current = null
      chart.remove()
    }
    // theme is a module constant
  }, [mode, intraday, empty])

  // (Re)load series whenever the data changes; fit the visible range to it.
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    for (const s of seriesRef.current) chart.removeSeries(s)
    seriesRef.current = []

    if (mode === 'candle') {
      const first = series[0]
      if (!first) return
      const candles = chart.addSeries(CandlestickSeries, {
        upColor: UP_COLOR,
        downColor: DOWN_COLOR,
        borderVisible: false,
        wickUpColor: UP_COLOR,
        wickDownColor: DOWN_COLOR,
        priceLineVisible: false,
        lastValueVisible: true,
      })
      candles.setData(toCandleData(first.bars))
      const volume = chart.addSeries(HistogramSeries, {
        priceScaleId: 'volume',
        priceFormat: { type: 'volume' },
        priceLineVisible: false,
        lastValueVisible: false,
      })
      volume.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } })
      volume.setData(toVolumeData(first.bars, withAlpha(UP_COLOR, 0.4), withAlpha(DOWN_COLOR, 0.4)))
      seriesRef.current = [candles, volume]
    } else {
      seriesRef.current = series.map((s, i) => {
        const opts: LineSeriesPartialOptions = {
          lineWidth: 2,
          priceLineVisible: false,
          lastValueVisible: series.length === 1,
          crosshairMarkerRadius: 4,
        }
        const color = colorFor(i)
        if (color) opts.color = color
        const line = chart.addSeries(LineSeries, opts)
        line.setData(toLineData(s.bars))
        return line
      })
    }
    chart.timeScale().fitContent()
  }, [series, mode])

  if (empty) {
    return <EmptyState title="No bars" hint="The query returned no price bars for this range." />
  }

  return (
    <div data-view="series" data-mode={mode} style={rootStyle}>
      <div ref={hostRef} style={hostStyle} />
      <Legend rows={legend} background={themeBackground(theme)} />
    </div>
  )
}

const rootStyle: CSSProperties = { position: 'relative', width: '100%', height: '100%', minHeight: 160 }
const hostStyle: CSSProperties = { position: 'absolute', inset: 0 }

const Legend: FC<{ rows: LegendRow[]; background: string | undefined }> = ({ rows, background }) => (
  <div
    data-legend=""
    role="list"
    aria-label="Series legend"
    style={{
      position: 'absolute',
      top: 8,
      left: 8,
      zIndex: 2,
      display: 'flex',
      flexWrap: 'wrap',
      gap: '2px 12px',
      padding: '4px 8px',
      borderRadius: 4,
      fontSize: 11,
      lineHeight: '16px',
      fontVariantNumeric: 'tabular-nums',
      background: background ? withAlpha(background, 0.72) : 'rgba(0, 0, 0, 0.5)',
      pointerEvents: 'none',
      maxWidth: 'calc(100% - 72px)',
    }}
  >
    {rows.map((row) => {
      const dir = direction(row.changePct)
      return (
        <div key={row.symbol} role="listitem" data-symbol={row.symbol} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span aria-hidden="true" style={{ display: 'inline-block', width: 10, height: 2, borderRadius: 1, background: row.color ?? 'currentColor' }} />
          <span style={{ fontWeight: 600 }}>{row.symbol}</span>
          <span data-field="last">{formatPrice(row.last)}</span>
          <span data-field="change" style={{ color: dir === 'up' ? UP_COLOR : dir === 'down' ? DOWN_COLOR : undefined, opacity: dir === 'flat' ? 0.7 : 1 }}>
            {formatPercent(row.changePct)}
          </span>
        </div>
      )
    })}
  </div>
)
