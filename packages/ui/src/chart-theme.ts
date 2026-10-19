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
    // Axis ticks and value labels are numbers, so the mono stack; the canvas is repainted once the font has loaded (SeriesView).
    fontFamily: tokens.font.mono,
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

// ---- v2 marks (PLAN.md section 17): colours for the layer model's marks, checked with the dataviz validator on tokens.color.surface ----

/**
 * Event-marker colours by kind. Identity is never colour alone: every marker carries its kind's letter and the
 * legend lists the kind, so two kinds on one chart stay apart for every reader. Hues come from the series
 * palette and the accent, skipping slot 1 (blue), which the first line usually wears.
 */
export const markerPalette: Record<string, { color: string; letter: string }> = {
  earnings: { color: '#d95926', letter: 'E' },
  eps_history: { color: '#d95926', letter: 'E' },
  dividend: { color: '#199e70', letter: 'D' },
  dividends: { color: '#199e70', letter: 'D' },
  news: { color: '#d55181', letter: 'N' },
  insider: { color: '#c98500', letter: 'I' },
  insiders: { color: '#c98500', letter: 'I' },
  macro: { color: tokens.color.accent, letter: 'M' },
  split: { color: '#3987e5', letter: 'S' },
  calendar: { color: tokens.color.accent, letter: 'M' },
  buy: { color: tokens.color.up, letter: 'B' },
  sell: { color: tokens.color.down, letter: 'S' },
  custom: { color: tokens.color.fg2, letter: '•' },
}
/** The marker look for a kind value: a known kind, else `custom` with the kind's initial as the letter. */
export function markerStyle(kind: string | null | undefined): { color: string; letter: string } {
  const key = (kind ?? '').toLowerCase()
  const known = markerPalette[key]
  if (known) return known
  const custom = markerPalette.custom!
  const letter = key ? key.trim().charAt(0).toUpperCase() : custom.letter
  return { color: custom.color, letter }
}

/** Horizontal levels (strikes, targets, RSI 30/70) and shaded bands (an earnings window, a negative spread). */
export const levelColor = tokens.color.fg3
export const bandColor = 'rgba(144, 133, 233, 0.14)'
/** The zero line under signed bars and the MACD histogram. */
export const zeroLineColor = tokens.color.borderStrong

/**
 * Diverging scale for the heatmap: red (the product's down colour) for negative, blue for positive, the raised
 * surface as the neutral midpoint. Two hues plus a neutral gray, per the dataviz rule; red/green was tried and
 * fails the CVD gate (ΔE 4.1 under deuteranopia), so positive is blue (ΔE 20.8), and the cell text names the sign.
 */
export const divergingScale = { negative: tokens.color.down, neutral: tokens.color.surface3, positive: '#3987e5' } as const
/** Sequential scale: one hue (blue), from the raised surface to the full hue. */
export const sequentialScale = { low: tokens.color.surface3, high: '#3987e5' } as const

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
/** Linear mix of two hex colours in sRGB; `t` in [0, 1]. */
export function mixHex(a: string, b: string, t: number): string {
  const k = Math.min(1, Math.max(0, t))
  const [r1, g1, b1] = hexToRgb(a)
  const [r2, g2, b2] = hexToRgb(b)
  const c = (x: number, y: number) => Math.round(x + (y - x) * k)
  return `rgb(${c(r1, r2)}, ${c(g1, g2)}, ${c(b1, b2)})`
}
/** Colour for a value on the diverging scale; `t` in [-1, 1] (negative → red pole, positive → blue pole). */
export function divergingColor(t: number): string {
  if (!Number.isFinite(t) || t === 0) return divergingScale.neutral
  return t < 0 ? mixHex(divergingScale.neutral, divergingScale.negative, Math.min(1, -t)) : mixHex(divergingScale.neutral, divergingScale.positive, Math.min(1, t))
}
/** Colour for a value on the sequential scale; `t` in [0, 1]. */
export function sequentialColor(t: number): string {
  return mixHex(sequentialScale.low, sequentialScale.high, Number.isFinite(t) ? t : 0)
}
