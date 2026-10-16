/**
 * Design tokens as a JS object. Mirrors the `@theme` block in styles.css;
 * keep both in sync. Used by the chart theme and by anything that cannot
 * read CSS variables (canvas, lightweight-charts).
 */
export const tokens = {
  color: {
    bg: '#0b0c0e',
    surface: '#141518',
    surface2: '#1b1d21',
    surface3: '#23262b',
    border: '#26282d',
    borderStrong: '#34373d',
    fg: '#e6e7ea',
    fg2: '#a0a4ab',
    fg3: '#7a7f88',
    accent: '#9085e9',
    accentFg: '#0b0c0e',
    up: '#2fbf6b',
    down: '#f0575a',
  },
  /** 8px grid unit. */
  unit: 8,
  fontSize: { xs: 11, sm: 12, base: 13, lg: 15, xl: 18, '2xl': 24 },
  lineHeight: { xs: 16, sm: 16, base: 20, lg: 22, xl: 24, '2xl': 30 },
  font: {
    sans: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
    mono: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
  },
  radius: { sm: 3, md: 5, lg: 8 },
} as const

export type Tokens = typeof tokens

/**
 * Categorical palette for multi-symbol series. Fixed order; assign by index of
 * the symbol in the query, never cycle. Validated on tokens.color.surface
 * (worst adjacent CVD ΔE 8.4, normal-vision 19.3, contrast ≥ 3:1).
 */
export const seriesPalette: string[] = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300']

export const UP_COLOR = tokens.color.up
export const DOWN_COLOR = tokens.color.down

/** Color for the i-th series; symbols past the palette length fold to the last slot. */
export function seriesColor(index: number): string {
  return seriesPalette[Math.min(Math.max(index, 0), seriesPalette.length - 1)] ?? seriesPalette[0]!
}
