// Shared by the BLS routes. Ported from openbb_bls/utils/helpers.py, charts_common.py and constants.py (OpenBB
// Platform 5.0.0, Apache-2.0); modified: node-html-parser instead of BeautifulSoup, downloads memoised through
// ctx.cache instead of lru_cache, plain rows instead of pydantic models.
import { NodeType, parse, type HTMLElement, type Node, type TextNode } from 'node-html-parser'
import { readXlsx, type Cell } from '../lib/xlsx.js'
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

/** Like fetchPage, but null on any non-200 answer (the catalog scrapers return an empty list then). */
export function fetchPageOrNull(ctx: NativeCtx, url: string, headers: Record<string, string> = HTML_HEADERS): Promise<string | null> {
  return ctx.cache(`bls:page-or-null:${url}`, HOUR_MS, async () => {
    const res = await ctx.http.response(url, { headers })
    if (res.status !== 200) return null
    return decodeHtml(new Uint8Array(await res.arrayBuffer()))
  })
}

/** A bls.gov file (xlsx, zip, pdf) as bytes. */
export function fetchFile(ctx: NativeCtx, url: string, headers: Record<string, string> = { 'User-Agent': BLS_USER_AGENT, Accept: '*/*' }): Promise<Uint8Array> {
  return ctx.cache(`bls:file:${url}`, HOUR_MS, async () => {
    const res = await ctx.http.response(url, { headers, timeoutMs: 120_000 })
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

/**
 * Numeric character references (`&#x00a0;`) left in text. BLS's spreadsheets pad their numbers with them, and
 * readXlsx (src/lib/xlsx.ts, fast-xml-parser) hands them over undecoded where openpyxl decodes them.
 */
export function decodeCharRefs(s: string): string {
  return s.replace(/&#x([0-9a-fA-F]+);/g, (_m, h: string) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
}

/** Every element below `node` whose tag is in `tags`, in document order (`find_all([...])`). */
export function findAll(node: Node, tags: readonly string[]): HTMLElement[] {
  const want = new Set(tags.map((t) => t.toUpperCase()))
  const out: HTMLElement[] = []
  const walk = (n: Node): void => {
    for (const c of n.childNodes) {
      if (c.nodeType !== NodeType.ELEMENT_NODE) continue
      const el = c as HTMLElement
      if (want.has(el.tagName)) out.push(el)
      walk(el)
    }
  }
  walk(node)
  return out
}

/**
 * Every `<table>` of a page, in order of their start tags (`soup.find_all("table")`). BLS's older pages are so
 * malformed that node-html-parser loses whole tables when it parses the page in one go (it dropped the first of
 * two tables of ppi-fdidsf.htm), so each table is cut out by its tags and parsed on its own.
 */
export function htmlTables(html: string): HTMLElement[] {
  const tag = /<(\/?)table\b[^>]*>/gi
  const tokens = [...html.matchAll(tag)].map((m) => ({ close: m[1] === '/', start: m.index!, end: m.index! + m[0].length }))
  const out: HTMLElement[] = []
  tokens.forEach((open, i) => {
    if (open.close) return
    let depth = 1
    let endAt = html.length
    for (let j = i + 1; j < tokens.length; j++) {
      depth += tokens[j]!.close ? -1 : 1
      if (depth === 0) {
        endAt = tokens[j]!.end
        break
      }
    }
    const table = parse(html.slice(open.start, endAt)).querySelector('table')
    if (table) out.push(table)
  })
  return out
}

/** The text of the page's `<title>`, as `soup.title.string` gives it. */
export function htmlTitle(html: string): string {
  const m = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  return m ? textOf(parse(`<title>${m[1]}</title>`)).trim() : ''
}

/** The anchors that have an href, with it trimmed (`find_all("a", href=True)`). */
export function anchors(node: Node): { el: HTMLElement; href: string }[] {
  return findAll(node, ['a']).flatMap((el) => {
    const href = el.getAttribute('href')
    return href === undefined ? [] : [{ el, href: href.trim() }]
  })
}

/** The nearest ancestor with this tag (`find_parent`). */
export function parentWithTag(node: Node, tag: string): HTMLElement | undefined {
  for (let p = node.parentNode as HTMLElement | null; p; p = p.parentNode as HTMLElement | null) if (p.tagName === tag.toUpperCase()) return p
  return undefined
}

/** `s.strip(chars)`. */
export function stripChars(s: string, chars: string): string {
  let a = 0
  let b = s.length
  while (a < b && chars.includes(s[a]!)) a++
  while (b > a && chars.includes(s[b - 1]!)) b--
  return s.slice(a, b)
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

export type Sheet = { name: string; rows: Cell[][] }

/**
 * A workbook's sheets the way openpyxl's read-only mode gives them: text cells with numeric character references
 * decoded, and every row padded with nulls to the sheet's widest row.
 */
export function loadSheets(bytes: Uint8Array): Sheet[] {
  return readXlsx(bytes).map((s) => {
    const rows = s.rows.map((r) => r.map((c) => (typeof c === 'string' ? decodeCharRefs(c) : c)))
    const width = rows.reduce((w, r) => Math.max(w, r.length), 0)
    return { name: decodeCharRefs(s.name), rows: rows.map((r) => (r.length < width ? [...r, ...Array.from<Cell>({ length: width - r.length }).fill(null)] : r)) }
  })
}
