// Filing item sections, provider sec. Ported from openbb_sec/utils/filing_sections.py (OpenBB Platform 5.0.0,
// Apache-2.0); modified: bs4 is ../markdown/soup.ts, and an element's source offset (bs4's sourceline and sourcepos)
// is found by scanning the markup for start tags in document order.
import { parse, type Tag } from '../markdown/soup.js'
import { PY_WS, pyStrip } from './pandas-lite.js'

export type ItemSection = { name: string; item_num: string; part: string; text: string }

const ITEM_HEADER = /^(?:#{1,4}\s*)?\*{0,2}\s*(?:Part\s+(?:I{1,3}|[1-4])[.\s,\-–—]*)?(?:ITEM|Item)\s*(1[0-6]?|[2-9])([A-Ia-i])?[.\s\-–—:)]*\s*(.*)$/i
const PART_HEADER = /^(?:#{1,4}\s*)?\*{0,2}\s*Part\s+(I{1,3}|IV|[1-4])\b/i
const ANY_ITEM_TEXT = /^(?:Part\s+(?:I{1,3}|IV|[1-4])[.\s,\-–—]*)?(?:ITEM|Item)\s*(1[0-6]?|[2-9])([A-Ia-i])?\b/i

const DIGIT = /\p{Nd}/u
const hasDigit = (s: string): boolean => DIGIT.test(s)

/** Python's `str.splitlines()` */
export function splitLines(s: string): string[] {
  // eslint-disable-next-line no-control-regex
  const parts = s.split(new RegExp('\\r\\n|[\\n\\r\\v\\f\\x1c-\\x1e\\x85\\u2028\\u2029]'))
  if (parts.length > 0 && parts.at(-1) === '') parts.pop()
  return parts
}

/** Remove page footers (e.g. 'Apple Inc. | 2025 Form 10-K | 3') and page numbers. */
export function stripMarkdownFooters(textIn: string): string {
  if (!textIn) return ''
  const text = textIn.replace(/^[ \t]*[A-Za-z][^|\n]{0,60}?\|\s*(?:\d{2,4}\s+)?(?:form\s+)?10-[kq]\s*\|\s*\d{1,4}[ \t]*/gim, '')
  const kept: string[] = []
  for (const line of text.split('\n')) {
    const stripped = pyStrip(line)
    if (stripped && stripped.length < 100) {
      if (/^\p{Nd}{1,4}$/u.test(stripped)) continue
      if (/\bform\s+10-[kq]\b/i.test(stripped) && hasDigit(stripped)) continue
    }
    kept.push(line)
  }
  return pyStrip(kept.join('\n').replace(/\n{3,}/g, '\n\n'))
}

const NEEDS_REFLOW = /^ {4}\S|\S {3,}\S/m
const COLUMN_GAP = /(?<=\S) {3,}(?=\S)/g
const VALUE_TOKEN = /\(\s*\$?\s*[\d,]+(?:\.\d+)?\s*\)|\$\s*[\d,]+(?:\.\d+)?|[\d,]+(?:\.\d+)?|--+|\*/g

type Token = [number, number, string]

function valueTokens(line: string): Token[] {
  return [...line.matchAll(VALUE_TOKEN)].map((m): Token => [m.index!, m.index! + m[0].length, pyStrip(m[0])])
}

function nearest(position: number, columns: number[]): number {
  let best = 0
  for (let k = 1; k < columns.length; k++) if (Math.abs(position - columns[k]!) < Math.abs(position - columns[best]!)) best = k
  return best
}

/** Convert a fixed-width ASCII table block into a markdown table. */
function fixedWidthTableToMarkdown(lines: string[]): string | null {
  const body = lines.filter((l) => pyStrip(l) !== '').map((l) => l.replace(new RegExp(`[${PY_WS}]+$`), ''))
  if (body.length < 2) return null

  const edges = new Map<number, number>()
  for (const line of body) {
    const tokens = valueTokens(line)
    if (tokens.length >= 3) for (const [, end] of tokens) edges.set(end, (edges.get(end) ?? 0) + 1)
  }
  if (edges.size === 0) return null

  const clusters: [number, number][] = []
  for (const end of [...edges.keys()].sort((a, b) => a - b)) {
    const last = clusters.at(-1)
    if (last && end - last[0] <= 4) clusters[clusters.length - 1] = [end, last[1] + edges.get(end)!]
    else clusters.push([end, edges.get(end)!])
  }
  const cols = clusters.filter(([, count]) => count >= 3).map(([end]) => end)
  if (cols.length < 2) return null

  const starts: number[] = []
  for (const line of body) for (const [start, end] of valueTokens(line)) if (cols.some((c) => Math.abs(end - c) <= 4)) starts.push(start)
  if (starts.length === 0) throw new Error('min() arg is an empty sequence')
  const boundary = Math.min(...starts)

  const numericTail = (line: string): boolean => {
    const tail = line.slice(boundary)
    return pyStrip(tail) !== '' && !/[A-Za-z]{2,}/.test(tail)
  }

  const first = body.findIndex((line) => numericTail(line))
  if (first < 0) return null

  let labelHeader = ''
  const headers: string[] = cols.map(() => '')
  for (const line of body.slice(0, first)) {
    for (const token of line.matchAll(/\S+(?: \S+)*?(?=\s{2,}|$)/g)) {
      const text = pyStrip(token[0])
      const end = token.index! + token[0].length
      if (end <= boundary) labelHeader = pyStrip(`${labelHeader} ${text}`)
      else {
        const index = nearest(end, cols)
        headers[index] = pyStrip(`${headers[index]} ${text}`)
      }
    }
  }

  const rowValues = (line: string): string[] => {
    const out: string[] = cols.map(() => '')
    for (const [start, end, text] of valueTokens(line)) {
      if (start < boundary) continue
      const index = nearest(end, cols)
      out[index] = pyStrip(`${out[index]} ${text}`)
    }
    return out
  }

  const rows: string[][] = []
  let pending = ''
  for (const line of body.slice(first)) {
    if (numericTail(line)) {
      const label = pyStrip(`${pending} ${pyStrip(line.slice(0, boundary))}`)
      pending = ''
      rows.push([label, ...rowValues(line)])
    } else {
      pending = pyStrip(`${pending} ${pyStrip(line)}`)
    }
  }

  const clean = (value: string): string => pyStrip(value.replace(/\.{2,}/g, '').replace(new RegExp(`[${PY_WS}]+`, 'g'), ' ')).replaceAll('|', '\\|')
  const out = [`| ${[labelHeader, ...headers].map(clean).join(' | ')} |`, `|${Array.from({ length: cols.length + 1 }, () => '---').join('|')}|`]
  for (const row of rows) out.push(`| ${row.map(clean).join(' | ')} |`)
  return out.join('\n')
}

const columnGaps = (line: string): number => [...line.matchAll(COLUMN_GAP)].length

/** A short, standalone line that reads as a section heading. */
function isHeading(line: string): boolean {
  return line.length >= 3 && line.length <= 60 && /^\p{Lu}/u.test(line) && !'.,;:'.includes(line.at(-1)!) && !line.includes('  ')
}

/** Reflow fixed-width plain-text filing prose into clean markdown. */
export function reflowPlainText(text: string, force = false): string {
  if (!text || (!force && !NEEDS_REFLOW.test(text))) return text

  const out: string[] = []
  const paragraph: string[] = []
  const table: string[] = []
  const mdTable: string[] = []
  let inTable = false
  const wsRun = new RegExp(`[${PY_WS}]+`, 'g')

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return
    if (paragraph.length === 1 && isHeading(pyStrip(paragraph[0]!))) {
      out.push(`**${pyStrip(paragraph[0]!)}**`)
    } else {
      const joined = pyStrip(paragraph.map((l) => pyStrip(l)).join(' ').replace(wsRun, ' '))
      const last = out.at(-1)
      if (last !== undefined && !['*', '|', '#'].includes(last.slice(0, 1)) && !['.', ';', ':', '!', '?', ')', '"', "'"].includes(last.slice(-1)) && /^\p{Ll}/u.test(joined)) out[out.length - 1] = `${last} ${joined}`
      else out.push(joined)
    }
    paragraph.length = 0
  }

  const flushTable = (): void => {
    const block = table.filter((l) => pyStrip(l) !== '')
    if (block.length > 0) {
      const markdown = fixedWidthTableToMarkdown(table)
      out.push(markdown || pyStrip(block.join(' ').replace(wsRun, ' ')))
    }
    table.length = 0
    inTable = false
  }

  const flushMdTable = (): void => {
    if (mdTable.length > 0) {
      out.push(mdTable.join('\n'))
      mdTable.length = 0
    }
  }

  for (const raw of text.split('\n')) {
    const stripped = pyStrip(raw)
    if (/^(?:<PAGE>|\p{Nd}{1,4})$/u.test(stripped)) continue
    if (stripped.startsWith('|')) {
      flushParagraph()
      flushTable()
      mdTable.push(stripped)
      continue
    }
    flushMdTable()
    if (inTable) {
      if (stripped && columnGaps(raw) === 0 && stripped.length > 50) {
        flushTable()
        paragraph.push(raw)
      } else table.push(raw)
      continue
    }
    if (!stripped) {
      flushParagraph()
      continue
    }
    if (columnGaps(raw) >= 2 && hasDigit(raw)) {
      const header: string[] = []
      while (paragraph.length > 0 && columnGaps(paragraph.at(-1)!) >= 1) header.unshift(paragraph.pop()!)
      flushParagraph()
      table.push(...header)
      table.push(raw)
      inTable = true
      continue
    }
    paragraph.push(raw)
  }
  flushParagraph()
  flushTable()
  flushMdTable()

  if (out.length === 1 && out[0]!.startsWith('**') && out[0]!.endsWith('**')) out[0] = out[0]!.slice(2, -2)
  return out.join('\n\n')
}

/** Start offsets of the `div`, `p` and `td` start tags of a document in order (what bs4 reports as sourceline/sourcepos). */
function blockStartOffsets(html: string): number[] {
  const out: number[] = []
  // Comments, scripts and styles hold text, not tags.
  const skip = /<!--[\s\S]*?-->|<script\b[\s\S]*?<\/script\s*>|<style\b[\s\S]*?<\/style\s*>|<(div|p|td)(?=[\s/>])/gi
  for (const m of html.matchAll(skip)) if (m[1] !== undefined) out.push(m.index!)
  return out
}

/** `get_text(" ", strip=True)` of a tag, or null once it is longer than `limit` characters. */
function shortText(tag: Tag, limit: number): string | null {
  const parts: string[] = []
  let length = 0
  for (const piece of tag.allStrings(true)) {
    length += piece.length + (parts.length > 0 ? 1 : 0)
    if (length > limit) return null
    parts.push(piece)
  }
  return parts.join(' ')
}

/** The raw HTML of an item section, located by its short item header. */
export function extractSectionHtml(html: string, itemNum: string): string {
  const soup = parse(html, 'html.parser')
  const elements = soup.findAll(['div', 'p', 'td'])
  const offsets = blockStartOffsets(html)
  if (offsets.length !== elements.length) throw new Error(`extract_section_html: found ${elements.length} blocks but ${offsets.length} start tags`)

  const candidates: [number, string, boolean][] = []
  const seen = new Set<string>()
  elements.forEach((element, index) => {
    const pos = offsets[index]!
    const joined = shortText(element, 80)
    if (joined === null) return
    const text = joined.replaceAll('\xa0', ' ')
    const match = ANY_ITEM_TEXT.exec(text)
    if (!match) return
    const remainder = text.slice(match[0].length).replace(/^[ .:)\-—–\t]+|[ .:)\-—–\t]+$/g, '')
    if (remainder && !/^[A-Z&(]/.test(remainder)) return
    const num = `${match[1]}${(match[2] ?? '').toUpperCase()}`
    const key = `${num}\0${Math.floor(pos / 64)}`
    if (seen.has(key)) return
    seen.add(key)
    candidates.push([pos, num, Boolean(remainder)])
  })

  candidates.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) || Number(a[2]) - Number(b[2]))
  const target = itemNum.toUpperCase()
  const titled = candidates.filter(([, num, hasTitle]) => num === target && hasTitle).map(([pos]) => pos)
  const untitled = candidates.filter(([, num]) => num === target).map(([pos]) => pos)
  let start: number
  if (titled.length > 0) start = titled[0]!
  else if (untitled.length > 0) start = untitled.at(-1)!
  else return ''
  const end = candidates.find(([pos, num]) => pos > start && num !== target)?.[0] ?? html.length
  return html.slice(start, end)
}

/** Whether a block element's text is predominantly bold. */
function isBoldParagraph(element: Tag): boolean {
  const text = element.getText(' ', true)
  if (!text) return false
  let bold = 0
  for (const tag of element.findAll(['b', 'strong'])) bold += tag.getText('', true).length
  for (const span of element.findAll('span')) {
    const style = (span.getStr('style', '') || '').replaceAll(' ', '').toLowerCase()
    if (/font-weight:(?:bold|bolder|[6-9]00)/.test(style)) bold += span.getText('', true).length
  }
  return bold >= 0.6 * text.replace(new RegExp(`[${PY_WS}]`, 'g'), '').length
}

/** Split a section's HTML into blocks at bold sub-headings. */
export function splitBoldSections(sectionHtml: string, headingKey: string): Row[] {
  const soup = parse(sectionHtml, 'html.parser')
  const itemHeader = /^(?:part\s+\w+[\s.,:-]*)?item\s+\d/i
  const skip = /^table\s+of\s+contents$/i
  const blocks: Record<string, string | null>[] = []
  let current: Record<string, string | null> = { [headingKey]: null, text: '' }
  const wsRun = new RegExp(`[${PY_WS}]+`, 'g')
  for (const para of soup.findAll(['div', 'p'])) {
    if (para.find(['div', 'p']) || para.findParent('table')) continue
    const text = pyStrip(para.getText(' ', true).replaceAll('\xa0', ' ').replace(wsRun, ' '))
    if (!text || itemHeader.test(text) || skip.test(text) || !stripMarkdownFooters(text)) continue
    if (isBoldParagraph(para)) {
      if (current[headingKey] || pyStrip(current.text!) !== '') blocks.push(current)
      current = { [headingKey]: text, text: '' }
    } else {
      current.text = current.text ? `${current.text}\n\n${text}` : text
    }
  }
  if (current[headingKey] || pyStrip(current.text!) !== '') blocks.push(current)
  for (const block of blocks) block.text = pyStrip(block.text!)
  return blocks.filter((b) => b.text || b[headingKey])
}

type Row = Record<string, string | null>

function cleanMarkdown(markdown: string): string {
  return markdown.replace(/<a\s[^>]*>\s*<\/a>/g, '').replace(/^(?:\[[^\]]*\]\(#[^)]*\)\s*)+/gm, '')
}

/** Normalize a Part marker to a Roman numeral. */
function partLabel(value: string): string {
  const v = value.toUpperCase()
  return ({ '1': 'I', '2': 'II', '3': 'III', '4': 'IV' } as Record<string, string>)[v] ?? v
}

/** Extract item sections from a filing's markdown, keyed by item id. */
export function extractItemSections(markdown: string): Record<string, ItemSection> {
  if (!markdown) return {}
  const lines = splitLines(cleanMarkdown(markdown))

  const headers: [number, string, string, string][] = []
  let part = 'I'
  lines.forEach((line, index) => {
    const stripped = pyStrip(line)
    if (!stripped) return
    const partMatch = PART_HEADER.exec(stripped)
    if (partMatch) part = partLabel(partMatch[1]!)
    const itemMatch = ITEM_HEADER.exec(stripped)
    if (!itemMatch) return
    const num = `${itemMatch[1]}${(itemMatch[2] ?? '').toUpperCase()}`
    const title = pyStrip(itemMatch[3]!).slice(0, 120)
    headers.push([index, num, title, part])
  })
  if (headers.length === 0) return {}

  const items: Record<string, ItemSection> = {}
  headers.forEach(([lineIndex, num, title, itemPart], position) => {
    const end = position + 1 < headers.length ? headers[position + 1]![0] : lines.length
    const text = pyStrip(lines.slice(lineIndex, end).join('\n'))
    let name = title
    if (!name) {
      for (let offset = lineIndex + 1; offset < Math.min(lineIndex + 4, lines.length); offset++) {
        const candidate = pyStrip(lines[offset]!)
        if (candidate) {
          name = pyStrip(candidate.replace(/^#+\s*|\*+/g, '')).slice(0, 120)
          break
        }
      }
    }
    const key = itemPart !== 'I' && itemPart !== '' ? `item_II_${num}` : `item_${num}`
    if (!(key in items)) items[key] = { name: name || `Item ${num}`, item_num: num, part: itemPart, text }
  })
  return items
}

const XREF_PART_LINE = /^\s*\|\s*Part\s+(I{1,3}|IV|[1-4])\s*\|/i
const XREF_ITEM_LINE = /^\s*\|\s*Item\s+(1[0-6]?|[2-9])([A-Ia-i])?\s*\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|\s*$/i
const XREF_ANCHOR_HREF = /\[\d+\]\(#([^)]+)\)/
const HTML_ANCHOR_ID = /<a\s+(?:[^>]*\s+)?id\s*=\s*["']([^"']+)["'][^>]*>\s*<\/a>/g

/** Build item sections from a 'Form 10-K Cross-Reference Index' anchor table. */
export function extractViaCrossReference(markdown: string): Record<string, ItemSection> {
  if (!markdown) return {}
  const anchorPositions = new Map<string, number>()
  for (const m of markdown.matchAll(HTML_ANCHOR_ID)) if (!anchorPositions.has(m[1]!)) anchorPositions.set(m[1]!, m.index!)
  if (anchorPositions.size === 0) return {}

  const rows: [number, string, string, string][] = []
  let currentPart = 'I'
  for (const line of splitLines(markdown)) {
    const partMatch = XREF_PART_LINE.exec(line)
    if (partMatch) {
      currentPart = partLabel(partMatch[1]!)
      continue
    }
    const itemMatch = XREF_ITEM_LINE.exec(line)
    if (!itemMatch) continue
    const anchorMatch = XREF_ANCHOR_HREF.exec(itemMatch[4]!)
    if (!anchorMatch) continue
    const pos = anchorPositions.get(anchorMatch[1]!)
    if (pos === undefined) continue
    const num = `${itemMatch[1]}${(itemMatch[2] ?? '').toUpperCase()}`
    rows.push([pos, num, pyStrip(itemMatch[3]!).slice(0, 120), currentPart])
  }
  if (rows.length === 0) return {}

  rows.sort((a, b) => a[0] - b[0])
  const items: Record<string, ItemSection> = {}
  rows.forEach(([pos, num, name, itemPart], index) => {
    const end = index + 1 < rows.length ? rows[index + 1]![0] : markdown.length
    const text = pyStrip(markdown.slice(pos, end).replace(HTML_ANCHOR_ID, ''))
    const key = itemPart !== 'I' && itemPart !== '' ? `item_II_${num}` : `item_${num}`
    if (!(key in items)) items[key] = { name, item_num: num, part: itemPart, text }
  })
  return items
}
