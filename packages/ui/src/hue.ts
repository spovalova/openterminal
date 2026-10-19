/**
 * Pure hues (PLAN.md section 6, "Colour", product rule of 2026-10-19). Every chromatic colour in Open Terminal is a
 * pure hue: "hue or spectral colors which has no white or black added, so pure pigment". In sRGB that is one channel
 * at 255, one at 0 and the third anywhere from 0 to 255 (HSL saturation 100%, lightness 50%). Neutrals (R = G = B:
 * backgrounds, surfaces, borders, text) carry no hue and stay neutral. A lighter or darker variant of a hue is the same
 * pure hue at a lower alpha over the background, never a mix toward white, black or grey.
 *
 * `parseColor` reads every notation the source uses (hex, rgb/rgba, hsl/hsla, hwb, oklch, oklab) into sRGB, so the
 * rule is checked on the colour a browser would paint; test/pure-hue.test.ts scans packages/ui and packages/web with it.
 */

/** An sRGB colour: channels 0..255 (unrounded), alpha 0..1. */
export type Rgba = { r: number; g: number; b: number; a: number }

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x))

/** A CSS number or percentage; `pct` is what 100% means (255 for an rgb channel, 1 for alpha). */
function num(token: string, pct: number): number {
  const t = token.trim()
  if (t === 'none') return 0
  return t.endsWith('%') ? (parseFloat(t) / 100) * pct : parseFloat(t)
}

/** A CSS hue in degrees (deg, turn, rad, grad or a bare number). */
function angle(token: string): number {
  const t = token.trim()
  const v = parseFloat(t)
  if (t.endsWith('turn')) return v * 360
  if (t.endsWith('grad')) return v * 0.9
  if (t.endsWith('rad')) return (v * 180) / Math.PI
  return v
}

/** The arguments of a colour function, comma or space separated, with an optional `/ alpha`. */
function args(body: string): { parts: string[]; alpha: string | undefined } {
  const [main, alpha] = body.split('/')
  const parts = main!.includes(',') ? main!.split(',').map((s) => s.trim()) : main!.trim().split(/\s+/)
  if (alpha === undefined && parts.length === 4) return { parts: parts.slice(0, 3), alpha: parts[3] }
  return { parts, alpha: alpha?.trim() }
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))
  return [f(0) * 255, f(8) * 255, f(4) * 255]
}

const toGamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055)

function oklabToRgb(L: number, a: number, b: number): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
  const bl = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
  return [toGamma(r) * 255, toGamma(g) * 255, toGamma(bl) * 255]
}

/** Parse a CSS colour into sRGB; null for anything else (a `var()`, a keyword other than `transparent`). */
export function parseColor(css: string): Rgba | null {
  const s = css.trim().toLowerCase()
  if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 }
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s)
  if (hex) {
    let h = hex[1]!
    if (h.length <= 4) h = h.split('').map((c) => c + c).join('')
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16)
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 }
  }
  const fn = /^(rgba?|hsla?|hwb|oklch|oklab)\((.*)\)$/.exec(s)
  if (!fn) return null
  const { parts, alpha } = args(fn[2]!)
  if (parts.length !== 3) return null
  const a = alpha === undefined ? 1 : num(alpha, 1)
  let rgb: [number, number, number]
  switch (fn[1]) {
    case 'rgb':
    case 'rgba':
      rgb = [num(parts[0]!, 255), num(parts[1]!, 255), num(parts[2]!, 255)]
      break
    case 'hsl':
    case 'hsla':
      rgb = hslToRgb(((angle(parts[0]!) % 360) + 360) % 360, num(parts[1]!, 100) / 100, num(parts[2]!, 100) / 100)
      break
    case 'hwb': {
      const w = num(parts[1]!, 100) / 100
      const k = num(parts[2]!, 100) / 100
      const pure = hslToRgb(((angle(parts[0]!) % 360) + 360) % 360, 1, 0.5)
      const scale = w + k >= 1 ? 0 : 1 - w - k
      const grey = w + k >= 1 ? w / (w + k) : w
      rgb = pure.map((c) => (c / 255) * scale * 255 + grey * 255) as [number, number, number]
      break
    }
    case 'oklch': {
      const L = num(parts[0]!, 1)
      const C = num(parts[1]!, 0.4)
      const h = (angle(parts[2]!) * Math.PI) / 180
      rgb = oklabToRgb(L, C * Math.cos(h), C * Math.sin(h))
      break
    }
    default:
      rgb = oklabToRgb(num(parts[0]!, 1), num(parts[1]!, 0.4), num(parts[2]!, 0.4))
  }
  if (rgb.some((c) => !Number.isFinite(c)) || !Number.isFinite(a)) return null
  const [r, g, b] = rgb.map((c) => clamp(c, 0, 255)) as [number, number, number]
  return { r, g, b, a: clamp(a, 0, 1) }
}

const rounded = (c: Rgba) => [Math.round(c.r), Math.round(c.g), Math.round(c.b)] as const

/** No hue: R = G = B (black, white and every grey). */
export function isNeutral(c: Rgba): boolean {
  const [r, g, b] = rounded(c)
  return r === g && g === b
}

/** Full saturation, nothing mixed in: one channel at 255 and one at 0. */
export function isPureHue(c: Rgba): boolean {
  const [r, g, b] = rounded(c)
  return Math.max(r, g, b) === 255 && Math.min(r, g, b) === 0
}

/** The colour rule: a neutral or a pure hue, at any alpha. */
export function isAllowedColor(c: Rgba): boolean {
  return isNeutral(c) || isPureHue(c)
}

/** HSL hue angle of an sRGB colour, 0..360 (0 for a neutral). */
export function hueAngle(c: Rgba): number {
  const r = c.r / 255
  const g = c.g / 255
  const b = c.b / 255
  const max = Math.max(r, g, b)
  const d = max - Math.min(r, g, b)
  if (d === 0) return 0
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return (h * 60 + 360) % 360
}

const hex2 = (v: number) => Math.round(v).toString(16).padStart(2, '0')

/** The pure hue at HSL hue angle `deg`, as #rrggbb. */
export function pureAt(deg: number): string {
  const [r, g, b] = hslToRgb(((deg % 360) + 360) % 360, 1, 0.5)
  return `#${hex2(r)}${hex2(g)}${hex2(b)}`
}

/** A colour at alpha `a` as rgba(); a token stays the same pure hue (or neutral), only lighter or darker over the background. */
export function hueAlpha(color: string, a: number): string {
  const c = parseColor(color)
  if (!c) return color
  const [r, g, b] = rounded(c)
  return `rgba(${r}, ${g}, ${b}, ${+clamp(a * c.a, 0, 1).toFixed(3)})`
}

/**
 * Snap a colour from outside the design system (a layer's `color` written by the agent or a recipe) onto the rule:
 * a neutral is kept, any other colour becomes the pure hue at its hue angle with its alpha. Unparseable input gives
 * undefined, so the caller falls back to the palette.
 */
export function toPureHue(color: string | undefined): string | undefined {
  if (!color) return undefined
  const c = parseColor(color)
  if (!c) return undefined
  if (isNeutral(c)) return color
  const pure = pureAt(hueAngle(c))
  return c.a >= 1 ? pure : hueAlpha(pure, c.a)
}
