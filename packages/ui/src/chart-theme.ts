import { ColorType, CrosshairMode, LineStyle, type ChartOptions, type DeepPartial } from 'lightweight-charts'
import { tokens } from './tokens.js'

/**
 * lightweight-charts v5 options for the dark theme. Spread into createChart:
 *
 *   const chart = createChart(el, { ...chartTheme, autoSize: true })
 *   chart.addSeries(LineSeries, { color: seriesPalette[0], lineWidth: 2 })
 *
 * Grid and axes are recessive (hairlines), the crosshair is a dotted fg-3 line,
 * and text uses the secondary ink.
 */
export const chartTheme: DeepPartial<ChartOptions> = {
  layout: {
    background: { type: ColorType.Solid, color: tokens.color.surface },
    textColor: tokens.color.fg2,
    fontSize: tokens.fontSize.xs,
    fontFamily: tokens.font.sans,
    panes: { separatorColor: tokens.color.border, separatorHoverColor: tokens.color.borderStrong },
  },
  grid: {
    vertLines: { color: tokens.color.border, style: LineStyle.Solid, visible: true },
    horzLines: { color: tokens.color.border, style: LineStyle.Solid, visible: true },
  },
  crosshair: {
    mode: CrosshairMode.Normal,
    vertLine: {
      color: tokens.color.fg3,
      width: 1,
      style: LineStyle.Dotted,
      labelVisible: true,
      labelBackgroundColor: tokens.color.surface3,
    },
    horzLine: {
      color: tokens.color.fg3,
      width: 1,
      style: LineStyle.Dotted,
      labelVisible: true,
      labelBackgroundColor: tokens.color.surface3,
    },
  },
  rightPriceScale: {
    borderVisible: true,
    borderColor: tokens.color.border,
    textColor: tokens.color.fg2,
    scaleMargins: { top: 0.1, bottom: 0.1 },
    entireTextOnly: true,
  },
  leftPriceScale: {
    borderVisible: true,
    borderColor: tokens.color.border,
    textColor: tokens.color.fg2,
  },
  timeScale: {
    borderVisible: true,
    borderColor: tokens.color.border,
    timeVisible: true,
    secondsVisible: false,
    rightOffset: 2,
    fixLeftEdge: true,
  },
  localization: { locale: 'en-US' },
}

/** Series-level defaults that pair with chartTheme (a line per symbol). */
export const lineSeriesDefaults = {
  lineWidth: 2 as const,
  priceLineVisible: false,
  lastValueVisible: true,
  crosshairMarkerVisible: true,
  crosshairMarkerRadius: 3,
}

/** Series-level defaults for a single-symbol candlestick. */
export const candleSeriesDefaults = {
  upColor: tokens.color.up,
  downColor: tokens.color.down,
  borderVisible: false,
  wickUpColor: tokens.color.up,
  wickDownColor: tokens.color.down,
  priceLineVisible: false,
  lastValueVisible: true,
}
