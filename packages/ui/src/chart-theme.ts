import { ColorType, CrosshairMode, LineStyle, type ChartOptions, type DeepPartial } from 'lightweight-charts'
import { tokens, seriesPalette } from './tokens.js'
import { hueAlpha } from './hue.js'

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
 * legend lists the kind, so two kinds on one chart stay apart for every reader. Hues are the series palette's pure
 * hues and the accent, skipping slot 1 (azure) for the common kinds, which the first line usually wears. Under
 * deuteranopia gold (insider) and green (buy) collapse, and azure (split) and the accent (macro) do: the letters
 * carry those pairs. Slot 5 (violet) is left out: the marker letter is dark ink, 3.5:1 on it.
 */
export const markerPalette: Record<string, { color: string; letter: string }> = {
  earnings: { color: seriesPalette[1]!, letter: 'E' },
  eps_history: { color: seriesPalette[1]!, letter: 'E' },
  dividend: { color: seriesPalette[2]!, letter: 'D' },
  dividends: { color: seriesPalette[2]!, letter: 'D' },
  news: { color: seriesPalette[5]!, letter: 'N' },
  insider: { color: seriesPalette[3]!, letter: 'I' },
  insiders: { color: seriesPalette[3]!, letter: 'I' },
  macro: { color: tokens.color.accent, letter: 'M' },
  split: { color: seriesPalette[0]!, letter: 'S' },
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
export const bandColor = hueAlpha(tokens.color.accent, 0.08)
/** The 1px edges of an x band ("last week"): the band reads as a faint range with crisp ends (taste round, change 14). */
export const bandEdgeColor = hueAlpha(tokens.color.accent, 0.55)
/** The zero line under signed bars and the MACD histogram. */
export const zeroLineColor = tokens.color.borderStrong

/**
 * Heatmap scales are pure hues at varying alpha (PLAN.md section 6, colour rule), never a mix of a hue with grey: a
 * cell paints its pole's pure hue at alpha |t| × HEAT_ALPHA_MAX over the neutral cell base (surface-3, `heatCell`),
 * so zero reads as the plain grey cell and the strongest value as the hue at 0.75 over it. The cap keeps the cell's
 * light text at 3.7:1 or better on the azure pole and 4.5:1 on the scarlet pole (the old full-strength poles gave
 * 2.9:1 and 2.7:1).
 *
 * Diverging: scarlet (the product's down colour) for negative, azure (series slot 1) for positive, the neutral base at
 * zero. Two hues plus a neutral, per the dataviz rule; red/green fails the CVD gate, scarlet/azure clears it (ΔE 32.2
 * under protanopia, 41.0 for normal vision), and the cell text names the sign.
 */
export const HEAT_ALPHA_MAX = 0.75
export const divergingScale = { negative: tokens.color.down, neutral: tokens.color.surface3, positive: seriesPalette[0]! } as const
/** Sequential scale: one hue (azure) from alpha 0 (the neutral base, `low`) to HEAT_ALPHA_MAX of `high`. */
export const sequentialScale = { low: tokens.color.surface3, high: seriesPalette[0]! } as const

/** Colour for a value on the diverging scale; `t` in [-1, 1]: the pole's hue at alpha |t| × HEAT_ALPHA_MAX, painted over the neutral base. */
export function divergingColor(t: number): string {
  const k = Number.isFinite(t) ? Math.min(1, Math.abs(t)) : 0
  return hueAlpha(t < 0 ? divergingScale.negative : divergingScale.positive, k * HEAT_ALPHA_MAX)
}
/** Colour for a value on the sequential scale; `t` in [0, 1]: azure at alpha t × HEAT_ALPHA_MAX, painted over the neutral base. */
export function sequentialColor(t: number): string {
  const k = Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0
  return hueAlpha(sequentialScale.high, k * HEAT_ALPHA_MAX)
}
/** A heatmap cell's CSS background: a scale colour (a translucent pure hue) over the neutral cell base. */
export function heatCell(color: string): string {
  return `linear-gradient(${color}, ${color}), ${divergingScale.neutral}`
}
/** A scale's legend bar as a CSS background, low to high (diverging: negative pole, zero, positive pole), over the neutral base. */
export function heatLegend(palette: 'diverging' | 'sequential'): string {
  const ramp =
    palette === 'sequential'
      ? `${sequentialColor(0)}, ${sequentialColor(1)}`
      : `${divergingColor(-1)}, ${hueAlpha(divergingScale.negative, 0)} 50%, ${hueAlpha(divergingScale.positive, 0)} 50%, ${divergingColor(1)}`
  return `linear-gradient(90deg, ${ramp}), ${divergingScale.neutral}`
}
