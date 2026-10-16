import { useEffect, useRef, useState, type FC } from 'react'
import { CandlestickSeries, LineSeries, PriceScaleMode, createChart, type UTCTimestamp } from 'lightweight-charts'
import { candleSeriesDefaults, chartTheme, lineSeriesDefaults } from '../chart-theme.js'
import { seriesPalette } from '../tokens.js'
import { formatPercent } from '../format.js'
import { dailyTimes, walk } from './fixtures.js'
import clsx from 'clsx'

type Leg = { symbol: string; color: string; last: number; changePct: number }

/** Multi-symbol line chart, indexed to 100, with a legend row in text tokens. */
export const LineChartDemo: FC<{ symbols: string[]; normalize?: boolean }> = ({ symbols, normalize = true }) => {
  const el = useRef<HTMLDivElement>(null)
  const [legend, setLegend] = useState<Leg[]>([])

  useEffect(() => {
    const node = el.current
    if (!node) return
    const chart = createChart(node, { ...chartTheme, autoSize: true })
    const times = dailyTimes(64)
    const legs: Leg[] = []
    symbols.forEach((symbol, i) => {
      const color = seriesPalette[i] ?? seriesPalette[seriesPalette.length - 1]!
      const closes = walk(i * 7919 + 17, times.length, 60 + i * 35, 0.045)
      const series = chart.addSeries(LineSeries, { ...lineSeriesDefaults, color, title: symbol })
      series.setData(times.map((t, k) => ({ time: t as UTCTimestamp, value: closes[k]! })))
      const first = closes[0]!
      const last = closes[closes.length - 1]!
      legs.push({ symbol, color, last, changePct: ((last - first) / first) * 100 })
    })
    if (normalize) chart.priceScale('right').applyOptions({ mode: PriceScaleMode.IndexedTo100 })
    chart.timeScale().fitContent()
    setLegend(legs)
    return () => chart.remove()
  }, [symbols, normalize])

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 px-3 pt-1.5 text-xs tabular-nums">
        {legend.map((l) => (
          <span key={l.symbol} className="inline-flex items-center gap-1.5">
            <span aria-hidden className="inline-block size-2 rounded-full" style={{ background: l.color }} />
            <span className="font-medium text-fg">{l.symbol}</span>
            <span className="text-fg-2">{l.last.toFixed(2)}</span>
            <span className={clsx(l.changePct >= 0 ? 'text-up' : 'text-down')}>{formatPercent(l.changePct)}</span>
          </span>
        ))}
      </div>
      <div ref={el} className="min-h-0 flex-1" />
    </div>
  )
}

/** Single-symbol candlestick with UP/DOWN colors. */
export const CandleChartDemo: FC<{ symbol: string }> = ({ symbol }) => {
  const el = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const node = el.current
    if (!node) return
    const chart = createChart(node, { ...chartTheme, autoSize: true })
    const times = dailyTimes(40)
    const closes = walk(99, times.length + 1, 170, 0.04)
    const series = chart.addSeries(CandlestickSeries, { ...candleSeriesDefaults, title: symbol })
    series.setData(
      times.map((t, k) => {
        const open = closes[k]!
        const close = closes[k + 1]!
        const hi = Math.max(open, close) * 1.012
        const lo = Math.min(open, close) * 0.988
        return { time: t as UTCTimestamp, open, high: Number(hi.toFixed(2)), low: Number(lo.toFixed(2)), close }
      }),
    )
    chart.timeScale().fitContent()
    return () => chart.remove()
  }, [symbol])
  return <div ref={el} className="h-full" />
}
