/**
 * Design tokens as a JS object. Mirrors the `@theme` block in styles.css;
 * keep both in sync. Used by the chart theme and by anything that cannot
 * read CSS variables (canvas, lightweight-charts).
 *
 * Colour rule (PLAN.md section 6, 2026-10-19; see ./hue.ts): every chromatic token is a pure hue, one sRGB channel at
 * 255 and one at 0, with no white or black mixed in; the neutrals are true greys (R = G = B). Lighter or darker
 * variants are the same hue at a lower alpha over the background (`hueAlpha`), never a new mixed colour.
 */
export const tokens = {
  color: {
    bg: '#0c0c0c',
    surface: '#151515',
    surface2: '#1d1d1d',
    surface3: '#262626',
    border: '#282828',
    borderStrong: '#373737',
    fg: '#e7e7e7',
    fg2: '#a4a4a4',
    fg3: '#7f7f7f',
    accent: '#d400ff',
    accentFg: '#0c0c0c',
    up: '#00ff00',
    down: '#ff2a00',
  },
  /** 8px grid unit. */
  unit: 8,
  fontSize: { xs: 11, sm: 12, base: 13, lg: 15, xl: 18, '2xl': 24 },
  lineHeight: { xs: 16, sm: 16, base: 20, lg: 22, xl: 24, '2xl': 30 },
  font: {
    sans: '"Geist Variable", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
    /** A locally installed Berkeley Mono wins; the bundled Ioskeley Mono (OFL) is the fallback everyone gets. */
    mono: '"Berkeley Mono", "Ioskeley Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace',
  },
  radius: { sm: 3, md: 5, lg: 8 },
} as const

export type Tokens = typeof tokens

/**
 * Categorical palette for multi-symbol series: azure, orange, aquamarine, gold, violet, rose, cyan, all pure hues (hue
 * angles 205°, 30°, 165°, 50°, 275°, 325°, 190°). Fixed order; assign by index of the symbol in the query, never cycle.
 * Pure hues differ a lot in lightness (pure blue nearly vanishes on the dark surface, pure yellow glares), so the angles
 * were searched for legibility within the rule: every slot is at least 3:1 on tokens.color.surface (violet lowest,
 * 3.2:1), and the dataviz validator (dark) passes chroma, contrast and CVD on all pairs, not only neighbours (worst
 * CVD ΔE 9.3 azure/violet under deuteranopia, worst normal-vision ΔE 16.9 aquamarine/cyan). The dark lightness band
 * (OKLCH L 0.48 to 0.67) fails for orange, aquamarine, gold and cyan by construction, since only black would darken
 * them; legends, axis badges and tables carry the identity beside the colour.
 */
export const seriesPalette: string[] = ['#0095ff', '#ff8000', '#00ffbf', '#ffd500', '#9500ff', '#ff0095', '#00d5ff']

export const UP_COLOR = tokens.color.up
export const DOWN_COLOR = tokens.color.down

/** Color for the i-th series; symbols past the palette length fold to the last slot. */
export function seriesColor(index: number): string {
  return seriesPalette[Math.min(Math.max(index, 0), seriesPalette.length - 1)] ?? seriesPalette[0]!
}
