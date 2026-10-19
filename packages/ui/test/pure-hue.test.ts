/// <reference types="node" />
/**
 * The colour rule (PLAN.md section 6, product rule of 2026-10-19): every chromatic colour in Open Terminal is a pure
 * hue, "hue or spectral colors which has no white or black added, so pure pigment". In sRGB one channel is 255, one
 * is 0 and the third is anything (HSL saturation 100%, lightness 50%); alpha is free, so a lighter or darker variant
 * is the same hue over the background. Neutrals (R = G = B) carry no hue and are allowed.
 *
 * This test reads every source file of packages/ui and packages/web (src, test, index.html) and fails on a colour
 * literal that breaks the rule: hex (#rgb, #rgba, #rrggbb, #rrggbbaa, and %23-encoded in data URLs), rgb()/rgba(),
 * hsl()/hsla(), hwb(), oklch() and oklab() (converted to sRGB first), a CSS named colour, a color-mix() with anything
 * but `transparent`, and a darkening or desaturating filter. Colours built at runtime are checked through the
 * exported tokens and scale functions below.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { hueAlpha, hueAngle, isAllowedColor, isNeutral, isPureHue, parseColor, pureAt, toPureHue } from '../src/hue.js'
import { tokens, seriesPalette } from '../src/tokens.js'
import { bandColor, bandEdgeColor, divergingColor, heatLegend, markerPalette, sequentialColor } from '../src/chart-theme.js'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '../../..')
const SELF = fileURLToPath(import.meta.url)

/** Every source file the rule covers. */
function sources(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (name === 'node_modules' || name === 'dist' || name === 'fonts') continue
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.(ts|tsx|css|html)$/.test(name) && p !== SELF) out.push(p)
    }
  }
  for (const pkg of ['ui', 'web']) {
    for (const dir of ['src', 'test']) walk(join(repo, 'packages', pkg, dir))
    out.push(join(repo, 'packages', pkg, 'index.html'))
  }
  return out
}

/** CSS named colours that are themselves pure hues or neutrals; every other named colour is a tint or a shade. */
const NAMED_OK = new Set(['red', 'lime', 'blue', 'yellow', 'aqua', 'cyan', 'fuchsia', 'magenta', 'orange', 'gold', 'chartreuse', 'springgreen', 'deepskyblue', 'orangered', 'darkorange', 'black', 'white', 'gray', 'grey', 'silver', 'dimgray', 'dimgrey', 'darkgray', 'darkgrey', 'lightgray', 'lightgrey', 'gainsboro', 'whitesmoke'])
const NAMED = 'aliceblue antiquewhite aquamarine azure beige bisque blanchedalmond blueviolet brown burlywood cadetblue chocolate coral cornflowerblue cornsilk crimson darkblue darkcyan darkgoldenrod darkgreen darkkhaki darkmagenta darkolivegreen darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink dodgerblue firebrick floralwhite forestgreen ghostwhite goldenrod green greenyellow honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgreen lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow limegreen linen maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna skyblue slateblue slategray slategrey snow steelblue tan teal thistle tomato turquoise violet wheat yellowgreen'.split(' ')

type Finding = { file: string; line: number; literal: string; why: string }

/** The body of a call starting at `open` (the index of its `(`), balanced; null when unbalanced on the line. */
function balanced(text: string, open: number): string | null {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++
    else if (text[i] === ')' && --depth === 0) return text.slice(open + 1, i)
    else if (text[i] === '\n') return null
  }
  return null
}

/** Split at top-level commas. */
function topLevel(body: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '(') depth++
    else if (body[i] === ')') depth--
    else if (body[i] === ',' && depth === 0) {
      out.push(body.slice(start, i).trim())
      start = i + 1
    }
  }
  out.push(body.slice(start).trim())
  return out
}

function describeColour(literal: string): string {
  const c = parseColor(literal)
  if (!c) return 'unparseable'
  const [r, g, b] = [c.r, c.g, c.b].map(Math.round)
  return `rgb(${r}, ${g}, ${b}) at ${hueAngle(c).toFixed(0)}°: not a pure hue (one channel 255, one 0) nor a neutral (R = G = B); nearest pure hue ${pureAt(hueAngle(c))}, or a true grey if it was meant as a neutral`
}

/** Every rule-breaking colour literal in `text`. */
export function scan(text: string, file = '<text>'): Finding[] {
  const found: Finding[] = []
  const lineOf = (i: number) => text.slice(0, i).split('\n').length
  const check = (literal: string, at: number) => {
    const c = parseColor(literal)
    if (!c) found.push({ file, line: lineOf(at), literal, why: 'not a colour the rule can read; use a token' })
    else if (!isAllowedColor(c)) found.push({ file, line: lineOf(at), literal, why: describeColour(literal) })
  }
  for (const m of text.matchAll(/(?<![\w&%#/-])#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g)) check(`#${m[1]}`, m.index)
  for (const m of text.matchAll(/%23([0-9a-fA-F]{6}|[0-9a-fA-F]{3})(?![0-9a-fA-F])/g)) check(`#${m[1]}`, m.index)
  for (const m of text.matchAll(/\b(rgba?|hsla?|hwb|oklch|oklab|lab|lch)\(/g)) {
    const body = balanced(text, m.index + m[0].length - 1)
    // `rgba(${r}, …)` and other built strings are runtime values, checked through the exported functions below.
    if (body === null || body.trim() === '' || /[$a-df-z_]/i.test(body.replace(/\b(deg|grad|rad|turn|none)\b/g, '').replace(/e[-+]?\d/gi, ''))) continue
    if (m[1] === 'lab' || m[1] === 'lch') {
      found.push({ file, line: lineOf(m.index), literal: `${m[1]}(${body})`, why: 'CIE lab()/lch() is not read by the check; write the colour in sRGB' })
      continue
    }
    check(`${m[1]}(${body})`, m.index)
  }
  for (const m of text.matchAll(/color-mix\(/g)) {
    const body = balanced(text, m.index + m[0].length - 1)
    if (body === null) continue
    const parts = topLevel(body)
    const operands = parts.slice(1).map((p) => p.replace(/\s+\d+(\.\d+)?%$/, '').trim())
    if (!operands.includes('transparent')) found.push({ file, line: lineOf(m.index), literal: `color-mix(${body})`, why: 'mixes two colours; only a mix with transparent (an alpha) keeps a pure hue pure' })
  }
  for (const m of text.matchAll(/\b(brightness|saturate)-(\d+)\b/g)) {
    if (Number(m[2]) < 100) found.push({ file, line: lineOf(m.index), literal: m[0], why: `${m[1]} below 100 mixes in black or grey; use opacity` })
  }
  for (const m of text.matchAll(/(?<![\w-])(grayscale|sepia)(-\d+)?(?![\w-])/g)) found.push({ file, line: lineOf(m.index), literal: m[0], why: 'desaturates; use opacity' })
  for (const m of text.matchAll(/(['"`]|:\s*)([a-z]+)(?=['"`;])/g)) {
    const name = m[2]!
    if (NAMED.includes(name) && !NAMED_OK.has(name)) found.push({ file, line: lineOf(m.index), literal: name, why: 'a named colour that is a tint or a shade, not a pure hue' })
  }
  return found
}

describe('parseColor reads every notation into sRGB', () => {
  it('hex, rgb, hsl, hwb, oklch, oklab', () => {
    expect(parseColor('#d400ff')).toEqual({ r: 212, g: 0, b: 255, a: 1 })
    expect(parseColor('#f0f')).toEqual({ r: 255, g: 0, b: 255, a: 1 })
    expect(parseColor('#0095ff80')!.a).toBeCloseTo(0.502, 3)
    expect(parseColor('rgb(0 0 0 / 0.6)')).toEqual({ r: 0, g: 0, b: 0, a: 0.6 })
    expect(parseColor('rgba(255, 42, 0, 0.75)')).toEqual({ r: 255, g: 42, b: 0, a: 0.75 })
    expect(parseColor('rgb(100% 0% 50%)')).toEqual({ r: 255, g: 0, b: 127.5, a: 1 })
    const hsl = parseColor('hsl(290 100% 50%)')!
    expect([hsl.r, hsl.g, hsl.b].map(Math.round)).toEqual([212, 0, 255])
    expect(isPureHue(parseColor('hsla(30, 100%, 50%, 0.4)')!)).toBe(true)
    expect(isPureHue(parseColor('hsl(30 100% 60%)')!)).toBe(false) // white mixed in
    expect(isPureHue(parseColor('hsl(30 80% 50%)')!)).toBe(false) // grey mixed in
    expect(isPureHue(parseColor('hwb(205 0% 0%)')!)).toBe(true)
    expect(isPureHue(parseColor('hwb(205 10% 0%)')!)).toBe(false)
    // oklch(0.628 0.2577 29.23) is sRGB red, #ff0000; a lighter L adds white
    const red = parseColor('oklch(0.62796 0.25768 29.2339)')!
    expect([red.r, red.g, red.b].map(Math.round)).toEqual([255, 0, 0])
    expect(isAllowedColor(parseColor('oklch(0.75 0.15 29)')!)).toBe(false)
    expect(isNeutral(parseColor('oklab(0.5 0 0)')!)).toBe(true)
    expect(parseColor('transparent')).toEqual({ r: 0, g: 0, b: 0, a: 0 })
    expect(parseColor('var(--color-accent)')).toBeNull()
  })

  it('snaps an outside colour onto the rule, keeping neutrals and alpha', () => {
    expect(toPureHue('#3987e5')).toBe('#0074ff') // the old series blue, at its own hue angle (213°)
    expect(toPureHue('rgba(240, 87, 90, 0.5)')).toBe('rgba(255, 0, 5, 0.5)')
    expect(toPureHue('#7f7f7f')).toBe('#7f7f7f')
    expect(toPureHue('close')).toBeUndefined()
    expect(hueAlpha('#00ff00', 0.45)).toBe('rgba(0, 255, 0, 0.45)')
  })

  it('the scan catches every notation and lets alpha, neutrals and dynamic strings through', () => {
    const bad = scan(
      [
        "const a = '#9085e9'",
        'background: rgb(57, 135, 229);',
        'color: hsl(210 70% 60%);',
        "fill='%239085e9'",
        'x: oklch(0.7 0.1 250);',
        'y: color-mix(in oklab, var(--color-accent) 50%, white);',
        "className: 'active:brightness-95'",
        "stroke: 'teal'",
      ].join('\n'),
    )
    expect(bad.map((f) => f.line).sort()).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    const ok = scan(
      [
        "const a = '#d400ff'",
        'shadow: 0 0 0 1px rgb(0 0 0 / 0.6);',
        'color: hsla(165, 100%, 50%, 0.3);',
        'bg: color-mix(in oklab, var(--color-up) 28%, transparent);',
        'rgba(${r}, ${g}, ${b}, ${alpha})',
        "className: 'hover:brightness-110 bg-accent/15'",
        "href: '#unverified', id: '#root'",
        "fill: 'red', ink: 'gray'",
      ].join('\n'),
    )
    expect(ok).toEqual([])
  })
})

describe('the colour rule (PLAN.md section 6)', () => {
  it('no source file in packages/ui or packages/web has a colour that is neither a pure hue nor a neutral', () => {
    const files = sources()
    expect(files.length).toBeGreaterThan(50)
    const findings = files.flatMap((f) => scan(readFileSync(f, 'utf8'), relative(repo, f)))
    expect(findings.map((f) => `${f.file}:${f.line} ${f.literal}: ${f.why}`)).toEqual([])
  })

  it('every token and every runtime scale colour is a pure hue or a neutral', () => {
    const runtime = [
      ...Object.values(tokens.color),
      ...seriesPalette,
      ...Object.values(markerPalette).map((m) => m.color),
      bandColor,
      bandEdgeColor,
      ...[-1, -0.6, -0.2, 0, 0.3, 0.7, 1].map(divergingColor),
      ...[0, 0.25, 0.5, 1].map(sequentialColor),
      ...[...heatLegend('diverging').matchAll(/rgba\([^)]*\)|#[0-9a-f]{6}/g), ...heatLegend('sequential').matchAll(/rgba\([^)]*\)|#[0-9a-f]{6}/g)].map((m) => m[0]),
    ]
    for (const c of runtime) expect(isAllowedColor(parseColor(c)!), c).toBe(true)
    // the chromatic tokens are pure hues proper, not neutrals
    for (const c of [tokens.color.accent, tokens.color.up, tokens.color.down, ...seriesPalette]) expect(isPureHue(parseColor(c)!), c).toBe(true)
  })

  it('styles.css and tokens.ts agree on every colour token', () => {
    const css = readFileSync(join(repo, 'packages/ui/src/styles.css'), 'utf8')
    const value = (name: string) => new RegExp(`--color-${name}:\\s*(#[0-9a-f]{6});`).exec(css)?.[1]
    const kebab = (k: string) => k.replace(/([A-Z0-9])/g, (c) => `-${c.toLowerCase()}`)
    for (const [k, v] of Object.entries(tokens.color)) expect(value(kebab(k)), k).toBe(v)
    seriesPalette.forEach((v, i) => expect(value(`series-${i + 1}`)).toBe(v))
  })
})
