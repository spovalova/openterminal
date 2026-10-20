// Shared by the BLS routes. Ported from openbb_bls/utils/helpers.py, charts_common.py and constants.py (OpenBB
// Platform 5.0.0, Apache-2.0); modified: node-html-parser instead of BeautifulSoup, downloads memoised through
// ctx.cache instead of lru_cache, plain rows instead of pydantic models.
import { NodeType, parse, type HTMLElement, type Node, type TextNode } from 'node-html-parser'
import type { NativeCtx, Row } from '../types.js'

/** bls.gov answers 403 to unidentified clients; OpenBB sends this (its BLS_USER_AGENT environment variable can override it). */
export const BLS_USER_AGENT = 'openbb-platform-bls/2.0 (hello@openbb.co)'
export const HTML_HEADERS = { 'User-Agent': BLS_USER_AGENT, Accept: 'text/html,*/*' }
const HOUR_MS = 3600 * 1000

/** UTF-8, falling back to latin-1 (`_decode`). */
export function decodeHtml(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return new TextDecoder('latin1').decode(bytes)
  }
}

/** A bls.gov page as text; OpenBB raises "BLS returned HTTP n fetching url." on anything but 200. */
export function fetchPage(ctx: NativeCtx, url: string, headers: Record<string, string> = HTML_HEADERS): Promise<string> {
  return ctx.cache(`bls:page:${url}`, HOUR_MS, async () => {
    const res = await ctx.http.response(url, { headers })
    if (res.status !== 200) throw new Error(`BLS returned HTTP ${res.status} fetching ${url}.`)
    return decodeHtml(new Uint8Array(await res.arrayBuffer()))
  })
}

/** A bls.gov file (xlsx, zip, pdf) as bytes. */
export function fetchFile(ctx: NativeCtx, url: string, headers: Record<string, string> = { 'User-Agent': BLS_USER_AGENT, Accept: '*/*' }): Promise<Uint8Array> {
  return ctx.cache(`bls:file:${url}`, HOUR_MS, async () => {
    const res = await ctx.http.response(url, { headers })
    if (res.status !== 200) throw new Error(`BLS returned HTTP ${res.status} fetching ${url}.`)
    return new Uint8Array(await res.arrayBuffer())
  })
}

export function parseHtml(html: string): HTMLElement {
  return parse(html)
}

/** BeautifulSoup's `get_text(" ", strip=True)`: the text nodes, each trimmed, empty ones dropped, joined by a space. */
export function textOf(node: Node): string {
  const parts: string[] = []
  const walk = (n: Node): void => {
    for (const c of n.childNodes) {
      if (c.nodeType === NodeType.TEXT_NODE) {
        const t = (c as TextNode).text.trim()
        if (t) parts.push(t)
      } else if (c.nodeType === NodeType.ELEMENT_NODE) walk(c)
    }
  }
  if (node.nodeType === NodeType.TEXT_NODE) {
    const t = (node as TextNode).text.trim()
    return t
  }
  walk(node)
  return parts.join(' ')
}

/** `" ".join(s.split())`. */
export function squish(s: string): string {
  return s.split(/\s+/).filter(Boolean).join(' ')
}

const NO_NUMBER = new Set(['', '(NA)', 'NA', 'N/A', '-', '--'])
const FLOAT_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/

/** A numeric cell (thousands commas, trailing %) as a number; blanks and markers are null (`_to_num`). */
export function toNum(text: unknown): number | null {
  if (text === null || text === undefined) return null
  const cleaned = String(text).replace(/ /g, ' ').trim().replace(/%+$/, '').replace(/,/g, '').trim()
  if (NO_NUMBER.has(cleaned) || !FLOAT_RE.test(cleaned)) return null
  return Number(cleaned)
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
}

export const isoDate = (year: number, month: number, day: number): string => `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`

/** "Mon YYYY" in a stub cell → first of that month (`parse_month`). */
export function parseMonth(text: string): string | null {
  const m = /([A-Za-z]{3,9})\.?\s+(\d{4})/.exec(text ?? '')
  if (!m) return null
  const month = MONTHS[m[1]!.trim().toLowerCase().replace(/\.+$/, '')]
  return month === undefined ? null : isoDate(Number(m[2]), month, 1)
}

/** "Qn YYYY" → first day of the quarter (`parse_quarter`). */
export function parseQuarter(text: string): string | null {
  const m = /Q([1-4])\s+(\d{4})/.exec(text ?? '')
  return m ? isoDate(Number(m[2]), (Number(m[1]) - 1) * 3 + 1, 1) : null
}

/** "YYYY" → January 1 (`parse_year`). */
export function parseYear(text: string): string | null {
  const m = /(?<![A-Za-z0-9_])(\d{4})(?![A-Za-z0-9_])/.exec(text ?? '')
  return m ? isoDate(Number(m[1]), 1, 1) : null
}

/** Rows inside the inclusive window; a row without the key is dropped when a bound is set (`apply_date_window`). */
export function applyDateWindow<T extends Row>(rows: T[], start?: string, end?: string, key = 'date'): T[] {
  let out = rows
  if (start) out = out.filter((r) => typeof r[key] === 'string' && (r[key] as string) >= start)
  if (end) out = out.filter((r) => typeof r[key] === 'string' && (r[key] as string) <= end)
  return out
}

export const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)
