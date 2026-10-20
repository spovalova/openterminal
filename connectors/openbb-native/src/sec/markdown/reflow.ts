// html2markdown: absolute-positioned layout reflow, provider sec. Ported from openbb_sec/utils/html2markdown.py
// `_reflow_absolute_layout` (lines 5226-6100) (OpenBB Platform 5.0.0, Apache-2.0); modified: tuples are arrays.
import { splitCompositeTable } from './convert-table.js'
import { htmlEscape } from './html-to-markdown.js'
import { isLower, isUpper, strip } from './py.js'
import { parse, Tag } from './soup.js'
import { REFLOW_ENTITIES } from './win1252.js'

// ============================================================================
// ABSOLUTE-POSITIONED LAYOUT REFLOW
// ============================================================================
// Some SEC filings (notably Canadian bank 40-F exhibits like TD) are
// generated from PDF-to-HTML converters that render every text fragment
// as an absolutely-positioned <div> with pixel left/top coordinates.
// These documents contain ZERO <table> tags and thousands of positioned
// divs.  The regular html_to_markdown converter cannot reconstruct
// paragraphs or tables from these.
//
// reflowAbsoluteLayout detects such documents and rewrites the HTML
// into flowing <p> / <table> elements so the rest of the pipeline works.
// ============================================================================

// Regex to detect the "Page N" footer divs.
const PAGE_FOOTER_RE = /(?:Page\s+\d+|TD\s+BANK\s+GROUP)/i

/** (top, left, text, bold, font_size) */
type Frag = [number, number, string, boolean, number]
/** (left, text, bold, font_size) */
type LineFrag = [number, string, boolean, number]

/** Python tuple ordering for the arrays this module sorts. */
function cmpTuple(a: readonly (number | string | boolean)[], b: readonly (number | string | boolean)[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i]!
    const y = b[i]!
    if (x === y) continue
    return x < y ? -1 : 1
  }
  return a.length - b.length
}

/** Python's `round(x, 1)` (ties to even on the exact value). */
function round1(x: number): number {
  const y = x * 10
  const f = Math.floor(y)
  const diff = y - f
  let r: number
  if (diff === 0.5) r = f % 2 === 0 ? f : f + 1
  else r = Math.round(y)
  return r / 10
}

/** Python's `round(x)` for a float: ties to even. */
function roundInt(x: number): number {
  const f = Math.floor(x)
  const diff = x - f
  if (diff === 0.5) return f % 2 === 0 ? f : f + 1
  return Math.round(x)
}

const BOLD_TAG = /<\/?b>/g

/**
 * Rewrite position:absolute HTML into flowing HTML.
 *
 * Uses a *rule-based* approach: the Certent CDM (and similar PDF-to-HTML
 * generators) encode table row separators as thin (≤ 2 px high), full-width
 * (≥ 500 px) ``position:absolute`` divs.  These horizontal rules provide
 * deterministic table detection — text fragments between consecutive rules
 * belong to the same table, and their horizontal positions map to columns.
 *
 * Non-table text (paragraphs, headings, chart annotations) is rendered
 * outside the rule-delimited zones.  When the page contains a side-by-side
 * layout (body text on the left, chart on the right), the fragments are
 * split into two columns so chart content doesn't pollute paragraph text.
 *
 * Returns the rewritten HTML string, or ``null`` if the document does
 * not use an absolute-positioned layout and should be processed normally.
 */
export function reflowAbsoluteLayout(htmlContent: string): string | null {
  // Quick heuristic: is this an abs-positioned document?
  // Must have MANY absolute-positioned elements, very few <table> tags,
  // AND the characteristic Certent CDM id="aNN" text-fragment pattern.
  const sample = htmlContent.slice(0, 50_000)
  const absCount = (sample.match(/position:\s*absolute/gi) ?? []).length
  const tableCount = (htmlContent.slice(0, 200_000).match(/<table\b/gi) ?? []).length
  if (absCount < 30 || tableCount > 2) return null

  const absTotal = (htmlContent.match(/position:\s*absolute/gi) ?? []).length
  const divTotal = (htmlContent.match(/<div\b/gi) ?? []).length
  if (divTotal === 0 || absTotal / divTotal < 0.4) return null

  // Require the Certent CDM text-fragment pattern: divs with
  // id="aNN" (numeric IDs) that carry the actual text content.
  // This is the hallmark of PDF-to-HTML absolute-positioned layouts.
  // Without this, normal filings with many absolute-positioned logos
  // or headers would be incorrectly rewritten.
  const textFragCount = (sample.match(/<div[^>]+id="a\d+"/gi) ?? []).length
  if (textFragCount < 15) return null

  // ---- Parse page boundaries ----
  const pageBoundaries = [...htmlContent.matchAll(/id="Page(\d+)"/g)]
  if (pageBoundaries.length === 0) return null

  const pageMap = new Map<number, number>()
  for (const m of pageBoundaries) pageMap.set(parseInt(m[1]!, 10), m.index!)
  const totalPages = Math.max(...pageMap.keys())

  // ---- Regex toolbox ----
  const tagRe = /<[^>]+>/g
  const boldRe = /font-weight:\s*bold/i
  const fsizeRe = /font-size:\s*([\d.]+)px/i
  const contentRe = /^([\s\S]*?)(?=<div\s+id="a\d+"|<div\s+style="[^"]*position:\s*absolute)/
  const contentEndRe = /^([\s\S]*?)<\/div>/

  const decodeEntities = (text: string): string => {
    for (const [ent, ch] of REFLOW_ENTITIES) text = text.replaceAll(ent, ch)
    text = text.replace(/&#(\d+);/g, (_m, d: string) => (parseInt(d, 10) < 0x10000 ? String.fromCharCode(parseInt(d, 10)) : ''))
    return text
  }

  const stripTags = (rawText: string): string => strip(decodeEntities(rawText.replace(tagRe, '')))

  // ---- Per-page parser ----
  /**
   * Extract horizontal rules and text fragments from a page.
   *
   * Returns ``(hrules, text_frags)`` where *hrules* is a sorted list
   * of ``top`` positions of full-width rules and *text_frags* is a
   * list of ``(top, left, text, bold, font_size)`` tuples.
   */
  const parsePage = (pageNum: number): [number[], Frag[]] => {
    if (!pageMap.has(pageNum)) throw new Error(`KeyError: ${pageNum}`)
    const pStart = pageMap.get(pageNum)!
    const pEnd = pageMap.has(pageNum + 1) ? pageMap.get(pageNum + 1)! : htmlContent.length
    const pageHtml = htmlContent.slice(pStart, pEnd)

    const hrulesRaw: number[] = []
    const textFrags: Frag[] = []

    for (const m of pageHtml.matchAll(/<div\s[^>]*?style="([^"]*position:\s*absolute[^"]*)"[^>]*>/gi)) {
      const style = m[1]!
      const mStart = m.index!
      const mEnd = mStart + m[0].length

      const leftM = /left:([\d.]+)px/.exec(style)
      const topM = /top:([\d.]+)px/.exec(style)
      if (!(leftM && topM)) continue
      const left = parseFloat(leftM[1]!)
      const top = parseFloat(topM[1]!)

      const widthM = /width:([\d.]+)px/.exec(style)
      const heightM = /height:([\d.]+)px/.exec(style)
      const width = widthM ? parseFloat(widthM[1]!) : 0
      const height = heightM ? parseFloat(heightM[1]!) : 0

      // Horizontal rule: thin + wide-enough + explicit dimensions.
      // Full-width rules (≥ 500 px) delimit major tables.
      // Medium rules (200–499 px) delimit smaller tables such as
      // "Fiscal Year 2026 Targets" boxes or split-page layouts.
      if (heightM && widthM && height <= 2 && width >= 200) {
        hrulesRaw.push(top)
        continue
      }

      // Skip vertical rules (explicit narrow width, e.g. 1px bars)
      if (widthM && width <= 2) continue
      // Skip coloured rectangles (chart bars) that have no text id
      if (widthM && heightM && width > 5 && height > 5) {
        const divTag = pageHtml.slice(mStart, mEnd)
        if (!/id="a\d+"/.test(divTag)) continue
      }

      // Text fragment — must have id="aNN"
      const divTag = pageHtml.slice(mStart, mEnd)
      const idM = /id="(a\d+)"/.exec(divTag)
      if (!idM) continue

      const rest = pageHtml.slice(mEnd, mEnd + 2000)
      let cm = contentRe.exec(rest)
      if (!cm) cm = contentEndRe.exec(rest)
      if (!cm) continue

      const text = stripTags(cm[1]!)
      if (!text) continue

      if (PAGE_FOOTER_RE.test(text) && top > 950) continue

      const bold = boldRe.test(style)
      const fsM = fsizeRe.exec(style)
      const fontSize = fsM ? parseFloat(fsM[1]!) : 10.0

      textFrags.push([top, left, text, bold, fontSize])
    }

    const hrules = [...new Set(hrulesRaw.map((r) => round1(r)))].sort((a, b) => a - b)
    textFrags.sort(cmpTuple)
    return [hrules, textFrags]
  }

  // ---- Table-zone detection ----
  /**
   * Group consecutive full-width rules into table zones.
   *
   * Rules separated by < 300 px are considered part of the same table.
   * Returns a list of ``(zone_top, zone_bottom)`` pairs.
   */
  const identifyTableZones = (hrules: number[]): [number, number][] => {
    if (hrules.length < 2) return []
    const zones: [number, number][] = []
    let zoneStart = hrules[0]!
    let zoneEnd = hrules[0]!
    for (let i = 1; i < hrules.length; i++) {
      if (hrules[i]! - hrules[i - 1]! < 300) zoneEnd = hrules[i]!
      else {
        if (zoneEnd > zoneStart) zones.push([zoneStart, zoneEnd])
        zoneStart = hrules[i]!
        zoneEnd = hrules[i]!
      }
    }
    if (zoneEnd > zoneStart) zones.push([zoneStart, zoneEnd])
    return zones
  }

  // ---- Dedup consecutive identical rows ----
  /** Remove consecutive duplicate rows (same text ignoring bold). */
  const dedupRows = (rows: string[][]): string[][] => {
    if (rows.length === 0) return rows
    const result: string[][] = [rows[0]!]
    for (const row of rows.slice(1)) {
      const prevText = result[result.length - 1]!.map((c) => c.replace(BOLD_TAG, ''))
      const curText = row.map((c) => c.replace(BOLD_TAG, ''))
      const same = curText.length === prevText.length && curText.every((c, i) => c === prevText[i])
      if (!same) result.push(row)
      else {
        const prevBold = result[result.length - 1]!.filter((c) => c.includes('<b>')).length
        const curBold = row.filter((c) => c.includes('<b>')).length
        if (curBold > prevBold) result[result.length - 1] = row
      }
    }
    return result
  }

  // ---- Build table from a rule-delimited zone ----
  const buildTableFromZone = (frags: Frag[], rulesIn: number[]): string => {
    if (frags.length === 0 || rulesIn.length < 2) return ''

    const rules = [...rulesIn].sort((a, b) => a - b)

    // Build row bands: text between consecutive rules
    const rowBands: Frag[][] = []
    for (let i = 0; i < rules.length - 1; i++) {
      const bandTop = rules[i]!
      const bandBot = rules[i + 1]!
      const bandFrags = frags.filter((f) => bandTop - 2 <= f[0] && f[0] <= bandBot + 2)
      if (bandFrags.length) rowBands.push(bandFrags)
    }

    if (rowBands.length === 0) return ''

    // Determine column positions (cluster left coordinates ±20 px)
    const allLefts: number[] = []
    for (const band of rowBands) for (const [, lf, , , fs] of band) if (fs >= 7) allLefts.push(lf)
    if (allLefts.length === 0) return ''

    allLefts.sort((a, b) => a - b)
    const cols: number[] = []
    const colN: number[] = []
    for (const lf of allLefts) {
      let merged = false
      for (let ci = 0; ci < cols.length; ci++) {
        if (Math.abs(lf - cols[ci]!) <= 20) {
          cols[ci] = (cols[ci]! * colN[ci]! + lf) / (colN[ci]! + 1)
          colN[ci]!++
          merged = true
          break
        }
      }
      if (!merged) {
        cols.push(lf)
        colN.push(1)
      }
    }
    cols.sort((a, b) => a - b)
    const ncols = cols.length

    // Build raw row data
    let rawRows: string[][] = []
    for (const band of rowBands) {
      band.sort(cmpTuple)
      const lines: LineFrag[][] = []
      let curTop = band[0]![0]
      let cur: LineFrag[] = []
      for (const [top, lf, text, bold, fs] of band) {
        if (Math.abs(top - curTop) <= 3) cur.push([lf, text, bold, fs])
        else {
          if (cur.length) lines.push(cur)
          curTop = top
          cur = [[lf, text, bold, fs]]
        }
      }
      if (cur.length) lines.push(cur)

      for (const line of lines) {
        // Skip superscript footnote markers
        const main = line.filter(([, t, , f]) => !(f < 7 && /^\d[\d,]*$/.test(strip(t))))
        if (main.length === 0) continue

        const cells: string[] = Array.from({ length: ncols }, () => '')
        const bolds: boolean[] = Array.from({ length: ncols }, () => false)
        for (const [lf, text, bold] of main) {
          let best = 0
          let bestDist = Math.abs(lf - cols[0]!)
          for (let ci = 1; ci < ncols; ci++) {
            const d = Math.abs(lf - cols[ci]!)
            if (d < bestDist) {
              bestDist = d
              best = ci
            }
          }
          if (cells[best]) cells[best] += ' ' + text
          else cells[best] = text
          if (bold) bolds[best] = true
        }

        const formatted: string[] = []
        for (let ci = 0; ci < ncols; ci++) {
          let c = htmlEscape(cells[ci]!)
          if (bolds[ci] && c) c = `<b>${c}</b>`
          formatted.push(c)
        }
        rawRows.push(formatted)
      }
    }

    rawRows = dedupRows(rawRows)
    if (rawRows.length === 0) return ''

    // ---- Pre-merge currency-symbol cells (per-row) ----
    // Absolute-positioned layouts produce "$" / "€" / "£" as
    // separate fragments in their own column.  For each row,
    // merge a lone currency cell with the nearest numeric cell
    // to its right so that convert_table() receives clean data
    // (e.g. "$4,602" instead of "$" + "" + "4,602" in three
    // separate cells).
    const currPlain = new Set(['$', '€', '£']) // $, €, £
    const reNumval = /^\(?\s*[\d,]+\.?\d*\s*\)?\s*%?$/

    for (const row of rawRows) {
      let ci = 0
      while (ci < row.length) {
        const plain = strip(row[ci]!.replace(BOLD_TAG, ''))
        if (!currPlain.has(plain) || !plain) {
          ci++
          continue
        }
        // Look right: skip empties, merge into first numeric
        for (let cj = ci + 1; cj < row.length; cj++) {
          const tgtPlain = strip(row[cj]!.replace(BOLD_TAG, ''))
          if (!tgtPlain) continue // skip empty cells
          if (reNumval.test(tgtPlain)) {
            const symBold = row[ci]!.includes('<b>')
            const tgtBold = row[cj]!.includes('<b>')
            let combo = plain + tgtPlain
            if (symBold || tgtBold) combo = `<b>${combo}</b>`
            row[cj] = combo
            row[ci] = ''
          }
          break // stop on first non-empty (merge or not)
        }
        ci++
      }
    }

    // Remove columns that are entirely empty
    const nonEmpty: number[] = []
    for (let ci = 0; ci < ncols; ci++) if (rawRows.some((row) => ci < row.length && strip(row[ci]!))) nonEmpty.push(ci)

    const parts: string[] = ['<table>\n']
    for (const row of rawRows) {
      parts.push('<tr>')
      for (const ci of nonEmpty) parts.push(`<td>${row[ci]}</td>`)
      parts.push('</tr>\n')
    }
    parts.push('</table>\n')
    return parts.join('')
  }

  // ---- Fragment classification ----
  /**
   * Classify free fragments as body text, chart content, or footnotes.
   *
   * Uses **per-page body-font detection** so the same logic works on
   * pages where body text is set in 10 px *and* pages where it is set
   * in 8 px (common in the business-segment detail pages).
   *
   * 1. Detect the page's body font size — the most frequent font size
   *    among left-margin (left < 75 px) fragments.
   * 2. *Body text*: fragment whose font size is within +/-0.5 px of
   *    the detected body font and sits at the left margin, **or**
   *    within +/-0.3 px at any position (right-column text / unruled
   *    tables).  Large headings (font > 18 px) and bold subheadings
   *    at the left margin are also body text.
   * 3. *Footnotes*: fragments near the page bottom (top > 950 px).
   * 4. *Chart content*: everything else — axis ticks, legend labels,
   *    chart titles whose font deviates from the body font.
   *
   * Returns ``(body_frags, chart_frags, footnote_frags)``.
   */
  const classifyFragments = (frags: Frag[]): [Frag[], Frag[], Frag[]] => {
    if (frags.length === 0) return [[], [], []]

    // ---- Detect per-page body font size ----
    // Use a tight left margin (< 55 px) so chart axis labels that
    // sit at left ≈ 62–82 px don't bias the detection.
    const bodyMarginSizes = frags.filter(([top, left, , , fs]) => left < 55 && top < 950 && fs > 5.0 && fs < 18.0).map(([, , , , fs]) => round1(fs))
    let bodyFs = 10.0
    if (bodyMarginSizes.length >= 3) {
      const counts = new Map<number, number>()
      for (const v of bodyMarginSizes) counts.set(v, (counts.get(v) ?? 0) + 1)
      let best = -1
      for (const [k, c] of counts) {
        if (c > best) {
          best = c
          bodyFs = k
        }
      }
    }

    // ---- Classify each fragment ----
    // Short numeric/currency tokens that look like chart axis ticks
    // are excluded from body text even when their font matches.
    const chartVal = /^-?[$]\d[\d,.]*$|^-?\d+[%]$|^\d{4}$/

    const body: Frag[] = []
    const chart: Frag[] = []
    const footnotes: Frag[] = []

    for (const frag of frags) {
      const [top, left, text, bold, fontSize] = frag
      const stripped = strip(text)
      const isAxis = stripped.length < 10 && chartVal.test(stripped)

      if (top > 950) footnotes.push(frag)
      else if (fontSize > 18) {
        // Large section heading (e.g. "Net Income" at 22.7 px)
        body.push(frag)
      } else if (left < 75 && Math.abs(fontSize - bodyFs) <= 0.5 && !isAxis) {
        // Body-font fragment at the left margin
        body.push(frag)
      } else if (Math.abs(fontSize - bodyFs) <= 0.3 && !isAxis) {
        // Body-font fragment anywhere (right column, unruled table)
        body.push(frag)
      } else if (left < 75 && bold && stripped.length > 8) {
        // Bold subheading at the left margin
        body.push(frag)
      } else chart.push(frag)
    }

    return [body, chart, footnotes]
  }

  // ---- Free-content (paragraph / heading) builder ----
  /**
   * Build body text as flowing HTML with lists, headings, paragraphs.
   *
   * Handles bullet lists (●/•), section headings (detected by gap),
   * first-line-indent paragraph breaks, and preserves per-fragment
   * bold formatting.
   */
  const buildFreeContent = (fragsIn: Frag[]): string => {
    if (fragsIn.length === 0) return ''

    const frags = [...fragsIn].sort(cmpTuple)

    // ---- Build lines: group fragments by top (± 2 px) ----
    // Each line: (top, min_left, fragments)
    let lines: [number, number, LineFrag[]][] = []
    let curTop = frags[0]![0]
    let cur: LineFrag[] = []
    for (const [top, left, text, bold, fs] of frags) {
      if (Math.abs(top - curTop) <= 2) cur.push([left, text, bold, fs])
      else {
        if (cur.length) {
          cur.sort(cmpTuple)
          lines.push([curTop, cur[0]![0], cur])
        }
        curTop = top
        cur = [[left, text, bold, fs]]
      }
    }
    if (cur.length) {
      cur.sort(cmpTuple)
      lines.push([curTop, cur[0]![0], cur])
    }

    // ---- Split ALL-CAPS heading prefixes from mixed-case text ----
    // Certent CDM layouts place section headers like
    // "BUSINESS SEGMENT ANALYSIS" and subsection names like
    // "Business Focus" at the same top coordinate, forming a
    // multi-fragment line.  Split the ALL-CAPS bold prefix into
    // its own line so the single-bold H2 check can fire for each.
    const allCapsRe = /^[A-Z][A-Z &,\-/’\u00a0']+$/
    const splitLines: [number, number, LineFrag[]][] = []
    for (const [lineTop, lineLeft, lineFrags] of lines) {
      if (lineFrags.length <= 1) {
        splitLines.push([lineTop, lineLeft, lineFrags])
        continue
      }

      // Find the boundary: consecutive bold ALL-CAPS fragments
      // at the start, followed by non-ALL-CAPS or non-bold text.
      let capsEnd = 0
      for (let idx = 0; idx < lineFrags.length; idx++) {
        const [, ftext, fbold] = lineFrags[idx]!
        const t = strip(ftext)
        if (fbold && t && allCapsRe.test(t)) capsEnd = idx + 1
        else break
      }

      if (capsEnd > 0 && capsEnd < lineFrags.length) {
        // Verify the remaining text starts mixed-case
        const restText = strip(
          lineFrags
            .slice(capsEnd)
            .map(([, t]) => strip(t))
            .join(' '),
        )
        if (restText && !allCapsRe.test(restText)) {
          const capsFrags = lineFrags.slice(0, capsEnd)
          const restFrags = lineFrags.slice(capsEnd)
          splitLines.push([lineTop, capsFrags[0]![0], capsFrags])
          splitLines.push([lineTop + 0.1, restFrags[0]![0], restFrags])
          continue
        }
      }

      splitLines.push([lineTop, lineLeft, lineFrags])
    }

    lines = splitLines

    // ---- Helpers ----
    const bullet = new Set(['●', '•'])

    const hasBullet = (lf: LineFrag[]): boolean => lf.some(([, t]) => bullet.has(strip(t)))

    const stripBullet = (lf: LineFrag[]): LineFrag[] => lf.filter(([, t]) => !bullet.has(strip(t)))

    /** Combine fragments preserving per-fragment bold. */
    const rich = (lf: LineFrag[]): string => {
      const parts: string[] = []
      for (const [, text, bold] of lf) {
        const esc = htmlEscape(text)
        if (bold && strip(esc)) parts.push(`<b>${esc}</b>`)
        else parts.push(esc)
      }
      return parts.join(' ')
    }

    // Detect common body-left margin for indent paragraph detection
    const leftVals = lines.filter(([, , lf]) => lf.length).map(([, , lf]) => lf[0]![0])
    let bodyLeft: number
    if (leftVals.length) {
      const leftCounts = new Map<number, number>()
      for (const lv of leftVals) {
        const k = roundInt(lv)
        leftCounts.set(k, (leftCounts.get(k) ?? 0) + 1)
      }
      let bestC = -1
      bodyLeft = 48
      for (const [k, c] of leftCounts) {
        if (c > bestC) {
          bestC = c
          bodyLeft = k
        }
      }
    } else bodyLeft = 48

    // Regex for detecting sentence verbs — a strong signal that
    // the text is body-paragraph content, not a heading title.
    const sentenceVerbRe = /\b(?:is|are|was|were|has|have|had|offers?|provides?|includes?|presents?|enables?|allows?|consists?|describes?|involves?|ensures?|continues?|represents?|reflects?|operates?|serves?|manages?|oversees?|supports?|covers?|conform[s]?|should|shall|will|would|could)\b/i
    const abbrevEndRe = /\b(?:INC|CORP|LTD|LLC|CO|JR|SR|DR|MR|MS|U\.S)\.\s*$/i

    // ---- Main loop ----
    const out: string[] = []
    let inList = false
    let i = 0

    while (i < lines.length) {
      const [lineTop, lineLeft, lineFrags] = lines[i]!
      const prevTop = i > 0 ? lines[i - 1]![0] : null
      const gap = prevTop !== null ? lineTop - prevTop : 999

      // ---- H2: single bold fragment ----
      // In absolute-positioned SEC layouts a standalone bold
      // line is always a heading — no gap threshold needed.
      // However, bold body-text paragraphs can also appear as
      // single fragments per line; exclude those based on
      // length, casing, and verb-based sentence detection.
      if (lineFrags.length === 1) {
        const [, text, bold, fs] = lineFrags[0]!
        const t = strip(text)
        if (bold && fs >= 9.5 && t.length > 3) {
          let isHeading = true
          // Starts lowercase → mid-sentence fragment
          if (isLower(t[0]!) || (t.length > 120 && !isUpper(t)) || (t.length > 60 && !isUpper(t) && sentenceVerbRe.test(t)) || (t.endsWith('.') && !abbrevEndRe.test(t))) isHeading = false

          if (inList) {
            out.push('</ul>\n')
            inList = false
          }
          if (isHeading) out.push(`<h2>${htmlEscape(t)}</h2>\n`)
          else out.push(`<p data-body-text="1"><b>${htmlEscape(t)}</b></p>\n`)
          i++
          continue
        }
      }

      // ---- H2: very large font ----
      const maxFs = Math.max(...lineFrags.map(([, , , f]) => f))
      if (maxFs >= 18) {
        if (inList) {
          out.push('</ul>\n')
          inList = false
        }
        const parts = lineFrags.map(([, t]) => htmlEscape(t))
        out.push(`<h2>${parts.join(' ')}</h2>\n`)
        i++
        continue
      }

      // ---- Section heading: large gap + short + followed by bullet ----
      const plain = strip(lineFrags.map(([, t]) => t).join(' '))
      const nextIsBullet = i + 1 < lines.length && hasBullet(lines[i + 1]![2])
      if (gap > 22 && lineLeft <= 55 && plain.length < 50 && !hasBullet(lineFrags) && nextIsBullet) {
        if (inList) {
          out.push('</ul>\n')
          inList = false
        }
        out.push(`<h3>${rich(lineFrags)}</h3>\n`)
        i++
        continue
      }

      // ---- Bullet line: absorb continuations ----
      if (hasBullet(lineFrags)) {
        if (!inList) {
          out.push('<ul>\n')
          inList = true
        }
        const clean = stripBullet(lineFrags)
        const partsList = [rich(clean)]
        let j = i + 1
        while (j < lines.length) {
          const [ntop, , nfrags] = lines[j]!
          const ngap = ntop - lines[j - 1]![0]
          if (ngap <= 18 && !hasBullet(nfrags)) {
            const nmax = Math.max(...nfrags.map(([, , , f]) => f))
            if (nmax >= 18) break
            if (nfrags.length === 1 && nfrags[0]![2] && nfrags[0]![3] >= 9.5) break
            partsList.push(rich(nfrags))
            j++
          } else break
        }
        out.push(`<li>${partsList.join(' ')}</li>\n`)
        i = j
        continue
      }

      // ---- Close list if we fell out of bullets ----
      if (inList) {
        out.push('</ul>\n')
        inList = false
      }

      // ---- Paragraph: collect lines (gap ≤ 18 px) ----
      const para = [rich(lineFrags)]
      let j = i + 1
      while (j < lines.length) {
        const [ntop, , nfrags] = lines[j]!
        const ngap = ntop - lines[j - 1]![0]
        if (ngap <= 18 && !hasBullet(nfrags)) {
          const nmax = Math.max(...nfrags.map(([, , , f]) => f))
          if (nmax >= 18) break
          if (nfrags.length === 1 && nfrags[0]![2] && nfrags[0]![3] >= 9.5) break
          // First-line indent → new paragraph
          if (nfrags[0]![0] > bodyLeft + 5) break
          para.push(rich(nfrags))
          j++
        } else break
      }

      out.push(`<p>${para.join(' ')}</p>\n`)
      i = j
    }

    if (inList) out.push('</ul>\n')

    return out.join('')
  }

  // ---- Chart-summary builder ----
  /**
   * Build a chart placeholder rendered as a <div class="chart">.
   *
   * Extracts bold titles and parenthesised descriptions.  The
   * resulting ``<div>`` is preserved as raw HTML in the final
   * markdown output so downstream consumers can identify and
   * render chart blocks with their own styling.
   */
  const buildChartSummary = (frags: Frag[]): string => {
    if (frags.length === 0) return ''

    const titles: string[] = []
    const descs: string[] = []
    const seenTitles = new Set<string>()
    const seenDescs = new Set<string>()

    for (const [, , text, bold, fs] of [...frags].sort(cmpTuple)) {
      const t = strip(text)
      if (!t) continue
      if (bold && fs > 9 && t.length > 3 && !seenTitles.has(t)) {
        titles.push(t)
        seenTitles.add(t)
      } else if (t.startsWith('(') && t.length > 10 && !seenDescs.has(t)) {
        descs.push(t)
        seenDescs.add(t)
      }
    }

    if (titles.length === 0) return ''

    const label = titles.join(' / ')
    // Build as a SINGLE line so post-processing cleanup steps
    // (e.g. _remove_repeated_page_elements) cannot split the div
    // into individual lines and strip them as short repeats.
    let inner = `<span>${htmlEscape(label)}</span>`
    if (descs.length) inner += `<span class="chart-desc">${htmlEscape(descs.join('; '))}</span>`
    return `<div class="chart">${inner}</div>\n`
  }

  // ---- Per-page reflow orchestrator ----
  const reflowPage = (pageNum: number): string => {
    const [hrules, textFrags] = parsePage(pageNum)
    const zones = identifyTableZones(hrules)

    // Classify fragments into table zones vs. free
    const tableFrags: Frag[][] = zones.map(() => [])
    const freeFrags: Frag[] = []

    for (const frag of textFrags) {
      const top = frag[0]
      let placed = false
      for (let zi = 0; zi < zones.length; zi++) {
        const [zt, zb] = zones[zi]!
        if (zt - 5 <= top && top <= zb + 15) {
          tableFrags[zi]!.push(frag)
          placed = true
          break
        }
      }
      if (!placed) freeFrags.push(frag)
    }

    // Classify free fragments into body text, chart, and footnotes
    const [bodyFrags, chartFrags, footnoteFrags] = classifyFragments(freeFrags)

    // Collect page segments in vertical order
    const segments: [number, string][] = []

    zones.forEach(([zt, zb], zi) => {
      if (tableFrags[zi]!.length) {
        const rulesIn = hrules.filter((r) => zt - 1 <= r && r <= zb + 1)
        const tHtml = buildTableFromZone(tableFrags[zi]!, rulesIn)
        if (tHtml) {
          // Split composite tables (TABLE 5 + 6 + 7 in one
          // zone) into independent <table> elements so each
          // gets converted separately by convert_table().
          const tSoup = parse(tHtml, 'html.parser')
          const tTag = tSoup.find('table')
          if (tTag) {
            const parts = splitCompositeTable(tTag)
            if (parts.length > 1) {
              let offset = 0.0
              for (const p of parts) {
                if (typeof p === 'string') segments.push([zt + offset, `<p>${p}</p>`])
                else segments.push([zt + offset, (p as Tag).toString()])
                offset += 0.01
              }
            } else segments.push([zt, tHtml])
          } else segments.push([zt, tHtml])
        }
      }
    })

    // Body text → paragraphs / headings
    if (bodyFrags.length) {
      bodyFrags.sort(cmpTuple)
      const groups: Frag[][] = []
      let curGroup: Frag[] = [bodyFrags[0]!]
      for (let i = 1; i < bodyFrags.length; i++) {
        const gap = bodyFrags[i]![0] - bodyFrags[i - 1]![0]
        const crossesZone = zones.some(([zt, zb]) => bodyFrags[i - 1]![0] < zt && bodyFrags[i]![0] > zb)
        if (crossesZone || gap > 40) {
          groups.push(curGroup)
          curGroup = [bodyFrags[i]!]
        } else curGroup.push(bodyFrags[i]!)
      }
      groups.push(curGroup)

      for (const g of groups) {
        const content = buildFreeContent(g)
        if (strip(content)) segments.push([g[0]![0], content])
      }
    }

    // Chart content → compact annotation
    if (chartFrags.length) {
      const chartHtml = buildChartSummary(chartFrags)
      if (strip(chartHtml)) {
        const avgTop = chartFrags.reduce((acc, f) => acc + f[0], 0) / chartFrags.length
        segments.push([avgTop, chartHtml])
      }
    }

    // Footnotes → rendered as body paragraphs at page bottom
    if (footnoteFrags.length) {
      const fnHtml = buildFreeContent(footnoteFrags)
      if (strip(fnHtml)) segments.push([footnoteFrags[0]![0], fnHtml])
    }

    segments.sort((a, b) => a[0] - b[0])
    return segments.map((s) => s[1]).join('')
  }

  // ---- Main loop: process every page ----
  const outParts: string[] = ['<html><body>\n']

  for (let pg = 1; pg <= totalPages; pg++) {
    const pageHtml = reflowPage(pg)
    if (pageHtml) outParts.push(pageHtml)
  }

  outParts.push('</body></html>')
  return outParts.join('')
}
