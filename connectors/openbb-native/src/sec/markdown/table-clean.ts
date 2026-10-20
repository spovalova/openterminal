// html2markdown helpers (table cleaning, continuation tables, header detection), provider sec. Ported from
// openbb_sec/utils/html2markdown.py lines 1-1626 (OpenBB Platform 5.0.0, Apache-2.0); modified: bs4 → ./soup.ts.
import { NavigableString, Tag, TagSet } from './soup.js'
import { hasAlpha, hasDigit, isLower, isUpper, split, strip, stripChars } from './py.js'

// ============================================================================
// PUNCTUATION RULES FOR TEXT JOINING
// ============================================================================

export const NO_SPACE_BEFORE = new Set(['.', ',', ':', ';', '!', '?', ')', ']', '}', '"', "'", '\u{201c}', '\u{201d}', '\u{2018}', '\u{2019}', '%'])
/** Characters that shouldn't have space AFTER them */
export const NO_SPACE_AFTER = new Set(['(', '[', '{', '"', "'", '\u{201c}', '\u{201d}', '\u{2018}', '\u{2019}', '$'])

/** Bullet characters used in SEC filings (superset of all variants) */
export const BULLET_CHARS = new Set(['\u{2022}', '\x95', '\u{b7}', '\u{25cb}', '\u{25ba}', '\u{25cf}', '\u{d8}', '-', '\u{2013}', '\u{2014}'])

/** Invisible/whitespace characters to strip */
export const INVISIBLE_CHARS = '\u{200b}\u{200c}\u{200d}\u{feff}\xa0'

/** Month names pattern for date parsing (full names and standard 3-letter abbreviations) */
export const MONTHS_PATTERN = '(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)'

export type Cells = string[]
export type RowsWithColspan = [string, number][][]

const FINANCIAL_SPACE_RE = /^(\$?)\s*(\(?)\s*(\$?)\s*([\d,]+\.?\d*)\s*(\)?)\s*([%*]*(?:pts)?)$/
const DOLLAR_DASH_RE = /^\$\s*([\u{2014}\u{2013}-])\s*(%?)$/u
const DASH_PERCENT_RE = /^([\u{2014}\u{2013}-])\s+(%)\s*$/u

/** Strip all whitespace and invisible characters from a string. */
export function stripAll(s: string): string {
  return strip(stripChars(strip(s), INVISIBLE_CHARS))
}

/**
 * Normalize one cell value to compact financial format.
 *
 *   '$ 1,787'     -> '$1,787'
 *   '( 135 )'     -> '(135)'
 *   '$ ( 471 )'   -> '$(471)'
 *   '( 0.2 ) %'   -> '(0.2)%'
 *   '$ —'         -> '$—'
 *   '— %'         -> '—%'
 */
export function normalizeFinancialCell(cell: string): string {
  const s = strip(cell)
  if (!s) return cell
  // Dollar-dash patterns: $ — -> $—
  let m = DOLLAR_DASH_RE.exec(s)
  if (m) return '$' + m[1]! + m[2]!
  // Dash-percent patterns: — % -> —%
  m = DASH_PERCENT_RE.exec(s)
  if (m) return m[1]! + m[2]!
  // Numeric values with optional $, parens, %
  m = FINANCIAL_SPACE_RE.exec(s)
  if (m) {
    const [, dollar1, oparen, dollar2, number, cparen, suffix] = m
    // Only normalize if there were extraneous spaces in the original
    const compact = dollar1! + oparen! + dollar2! + number! + cparen! + suffix!
    if (compact !== s) return compact
  }
  return cell
}

/** Normalize all cells in all rows. */
export function normalizeFinancialRows(rows: Cells[]): Cells[] {
  return rows.map((row) => row.map((c) => normalizeFinancialCell(c)))
}

/** Remove columns that are empty across all rows. */
export function removeEmptyColumns(rows: Cells[]): Cells[] {
  if (rows.length === 0) return rows
  const numCols = Math.max(...rows.map((row) => row.length))
  const colsToKeep: number[] = []
  for (let colIdx = 0; colIdx < numCols; colIdx++) {
    const hasAnyContent = rows.some((row) => colIdx < row.length && strip(row[colIdx]!) !== '' && stripChars(strip(row[colIdx]!), INVISIBLE_CHARS) !== '')
    if (hasAnyContent) colsToKeep.push(colIdx)
  }
  return rows.map((row) => colsToKeep.map((i) => (i < row.length ? row[i]! : '')))
}

/** Check if a row from data array is a header/title row that should be skipped. */
export function isDataRowHeader(row: Cells): boolean {
  const nonEmpty = row.map((c) => strip(c)).filter((c) => c)
  if (nonEmpty.length === 0) return true // Empty row - skip

  const rowText = nonEmpty.join(' ')

  // Title rows: "For the Years Ended...", "Unaudited", etc.
  // BUT only if the row has NO numeric data values.  Rows like
  // "Three months ended April 30, | 10 | $273.42 | $2,681" are DATA
  // rows whose first cell happens to contain "months ended" as a
  // label — they must NOT be skipped.
  if (/(years?\s+ended|months?\s+ended|weeks?\s+ended|unaudited|as of)/i.test(rowText)) {
    const hasNumericData = nonEmpty.filter((c) => !/^(19|20)\d{2}$/.test(strip(c))).some((c) => /^[+-]?\$?\(?\$?\s*[\d,]+\.?\d*\s*\)?%?$/.test(strip(c)))
    if (!hasNumericData) return true
  }

  // Check if this is a category header row (ALL CAPS words, no numbers)
  // EQUIPMENT, OPERATIONS, FINANCIAL, SERVICES, ELIMINATIONS, CONSOLIDATED
  const allCapsCount = nonEmpty.filter((c) => /^[A-Z]{2,}$/.test(c)).length
  if (allCapsCount >= 2 && !nonEmpty.some((c) => /\d/.test(c))) return true

  // Year-only rows: just years like 2025, 2024, 2023
  const yearCount = nonEmpty.filter((c) => /^(19|20)\d{2}$/.test(c)).length
  if (yearCount >= 2 && yearCount === nonEmpty.length) return true

  // Period rows: "May 1999", "November 1998", "Q1 2024",
  // "September 26, 2025", "Oct 27, 2024", etc.
  // These are date/period headers that should be skipped if they're ALL dates
  const periodPattern = /^(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|Q[1-4]|H[12])[\s.,]*(?:\d{1,2}[\s,]*)?\d{4}$/i
  const periodCount = nonEmpty.filter((c) => periodPattern.test(c)).length
  return periodCount >= 2 && periodCount === nonEmpty.length
}

/** `urllib.parse.urljoin` for http(s) bases (RFC 3986 with dot-segment removal). */
export function urljoin(base: string, url: string): string {
  if (!base) return url
  if (!url) return base
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):(\/\/[^/?#]*)?([^?#]*)(\?[^#]*)?(#.*)?$/.exec(base)
  if (!m) return url
  const [, bscheme, bnetloc = '', bpath = '', bquery = '', ] = m
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url) && !/^[a-zA-Z][a-zA-Z0-9+.-]*:\d/.test(url)) return url
  if (url.startsWith('//')) return `${bscheme}:${url}`
  const um = /^([^?#]*)(\?[^#]*)?(#.*)?$/.exec(url)!
  const upath = um[1]!
  const uquery = um[2] ?? ''
  const ufrag = um[3] ?? ''
  if (!upath && !uquery && ufrag) return `${bscheme}:${bnetloc}${bpath}${bquery}${ufrag}`
  let path: string
  let query = uquery
  if (!upath) {
    path = bpath
    if (!uquery) query = bquery
  } else if (upath.startsWith('/')) path = upath
  else {
    const baseSegs = bpath.split('/')
    baseSegs.pop()
    path = baseSegs.join('/') + '/' + upath
  }
  // remove dot segments
  const segs = path.split('/')
  const out: string[] = []
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]!
    if (seg === '..') {
      if (out.length > 1) out.pop()
      if (i === segs.length - 1) out.push('')
    } else if (seg === '.') {
      if (i === segs.length - 1) out.push('')
    } else out.push(seg)
  }
  let resolved = out.join('/')
  if (bnetloc && !resolved.startsWith('/')) resolved = '/' + resolved
  return `${bscheme}:${bnetloc}${resolved}${query}${ufrag}`
}

/**
 * Convert an img element to HTML with size preservation.
 *
 * Uses HTML <img> tag when size information is present to preserve
 * consistent rendering of checkmarks and icons.
 */
export function convertImageToHtml(img: Tag, baseUrl = ''): string {
  let src = img.getStr('src', '')
  const alt = img.getStr('alt', 'Image')
  if (!src) return ''

  // Resolve relative URLs
  if (baseUrl && !/^(http:\/\/|https:\/\/|data:)/.test(src)) src = urljoin(baseUrl, src)

  // Check for size information in style attribute
  const style = img.getStr('style', '')
  let width: string | null = null
  let height: string | null = null

  if (style) {
    // Parse width and height from style like "width:0.0950528in;height:0.0894847in"
    const widthMatch = /width:\s*([0-9.]+(?:in|px|em|pt|%))/.exec(style)
    const heightMatch = /height:\s*([0-9.]+(?:in|px|em|pt|%))/.exec(style)
    if (widthMatch) width = widthMatch[1]!
    if (heightMatch) height = heightMatch[1]!
  }

  // Also check for explicit width/height attributes
  if (!width && img.getStr('width')) {
    width = img.getStr('width')
    if (!hasAlpha(width)) width = `${width}px`
  }
  if (!height && img.getStr('height')) {
    height = img.getStr('height')
    if (!hasAlpha(height)) height = `${height}px`
  }

  // If we have size info, use HTML img tag to preserve it
  if (width || height) {
    const styleParts: string[] = []
    if (width) styleParts.push(`width:${width}`)
    if (height) styleParts.push(`height:${height}`)
    return `<img src="${src}" alt="${alt}" style="${styleParts.join(';')}"/>`
  }

  // No size info, use standard markdown
  return `![${alt}](${src})`
}

/** Text of a cell as the continuation checks read it. */
function cellText(cell: Tag): string {
  return strip(cell.getText().replaceAll('\u{200b}', '').replaceAll('\xa0', ' '))
}

/** Count the number of data columns in a table (from header row with years). */
export function countDataColumns(table: Tag): number {
  const rows = table.findAll('tr')
  for (const row of rows.slice(0, 5)) {
    const cells = row.findAll(['td', 'th'])
    const nonEmpty: string[] = []
    for (const cell of cells) {
      const text = cellText(cell)
      if (text) nonEmpty.push(text)
    }
    // Look for rows with multiple years
    const yearCount = nonEmpty.filter((t) => /^(19|20)\d{2}$/.test(t)).length
    if (yearCount >= 1) return yearCount
  }
  return 0
}

/**
 * Check if this table is a continuation of a previous table.
 *
 * Returns True if the table's first non-empty row is just a year like "2024" or "2023"
 * AND the column count matches the previous table (if provided).
 *
 * Also returns True for "headerless continuations": tables that have no header
 * rows (no years), start directly with data rows (containing dollar/numeric values),
 * have the same expanded column count as prev_table, and are immediate DOM siblings.
 */
export function isContinuationTable(table: Tag, prevTable: Tag | null = null): boolean {
  const rows = table.findAll('tr')
  let isYearOnlyStart = false
  for (const row of rows.slice(0, 3)) {
    // Check first 3 rows
    const cells = row.findAll(['td', 'th'])
    const nonEmpty: string[] = []
    for (const cell of cells) {
      const text = cellText(cell)
      if (text) nonEmpty.push(text)
    }
    if (nonEmpty.length === 0) continue
    // If first non-empty row has just one cell and it's a year
    if (nonEmpty.length === 1 && /^(19|20)\d{2}$/.test(nonEmpty[0]!)) {
      isYearOnlyStart = true
      break
    }
    // If has multiple cells but first is a year and rest are empty/whitespace
    break
  }

  if (isYearOnlyStart) {
    // Original year-only continuation check
    if (prevTable !== null) {
      const prevCols = countDataColumns(prevTable)
      const thisCols = countDataColumns(table)
      if (prevCols > 0 && thisCols > 0 && prevCols !== thisCols) return false
    }
    return true
  }

  // ── Headerless continuation detection ──────────────────────────────
  // A table that has NO header rows but matching column structure is
  // likely a page-break continuation of the previous table.
  if (prevTable === null) return false

  // 1. Check that they are immediate DOM siblings (no significant content between)
  if (!areImmediateSiblingTables(prevTable, table)) return false

  // 2. Must have matching expanded column counts
  const prevWidth = expandedColCount(prevTable)
  const thisWidth = expandedColCount(table)
  if (prevWidth === 0 || thisWidth === 0 || prevWidth !== thisWidth) return false

  // 3. Must have NO header row (no years or period phrases in the first
  //    non-empty row that would indicate an independent table)
  for (const row of rows.slice(0, 3)) {
    const cells = row.findAll(['td', 'th'])
    const nonEmpty: string[] = []
    for (const cell of cells) {
      const text = cellText(cell)
      if (text) nonEmpty.push(text)
    }
    if (nonEmpty.length === 0) continue
    // If ANY cell is a year or period phrase, it has its own header
    for (const t of nonEmpty) {
      if (/^(19|20)\d{2}$/.test(t)) return false
      if (/(months?\s+ended|year\s+ended|quarter\s+ended|weeks?\s+ended)/i.test(t)) return false
    }
    break
  }

  // 4. At least one of the first several rows must look like a data row
  //    (contains a dollar sign, or 2+ numeric/percentage cells).
  //    This allows section label rows (e.g., "Investment banking fees")
  //    to precede the actual data without blocking detection,
  //    while avoiding false merges on TOC tables (single page-number cells).
  for (const row of rows.slice(0, 10)) {
    const cells = row.findAll(['td', 'th'])
    const texts: string[] = []
    for (const cell of cells) {
      const text = cellText(cell)
      if (text) texts.push(text)
    }
    if (texts.length === 0) continue
    const hasDollar = texts.some((t) => t.includes('$'))
    if (hasDollar) return true
    const numericCount = texts.filter((t) => t !== '\u{2014}' && t !== '-' && t !== '\u{2013}' && /^[$()]?\s*[\d,]+\.?\d*\s*[)%]?$/.test(t)).length
    if (numericCount >= 2) return true
  }

  return false
}

/** `hasattr(node, "name") and node.name` branch of the sibling walks: a node with significant text. */
function significantText(node: Tag | NavigableString, min: number): boolean {
  if (node instanceof Tag) {
    const text = node.getText('', true)
    return !!text && text.length > min
  }
  return strip(node.text).length > min
}

/**
 * Check if two tables are nearby in the DOM with no significant content between.
 *
 * Tables may be in different wrapper divs (e.g. page-break divs) — walk
 * upward to find the containers, then check siblings between them.
 */
export function areImmediateSiblingTables(tableA: Tag, tableB: Tag): boolean {
  // Simple case: same parent
  if (tableA.parent === tableB.parent) {
    let node = tableA.nextSibling
    while (node !== null && node !== tableB) {
      if (significantText(node as Tag | NavigableString, 2)) return false
      node = node.nextSibling
    }
    return node === tableB
  }

  // Different parents: walk up to find wrapper containers and check
  // that the gap between them contains no significant content.
  // Typical pattern: <div><table17/></div><hr/><div><table18/></div>
  const containerA = tableA.parent
  const containerB = tableB.parent
  if (containerA === null || containerB === null) return false
  // Both containers must share the same grandparent
  if (containerA.parent !== containerB.parent) return false
  // Table must be the last element in its container
  // (no significant content after the table within the div)
  let node: Tag | NavigableString | null = tableA.nextSibling as Tag | NavigableString | null
  while (node !== null) {
    if (significantText(node, 2)) return false
    node = node.nextSibling as Tag | NavigableString | null
  }
  // Table_b must be the first significant element in its container
  node = tableB.previousSibling as Tag | NavigableString | null
  while (node !== null) {
    if (significantText(node, 2)) return false
    node = node.previousSibling as Tag | NavigableString | null
  }
  // Check gap between the two containers (page number, hr, etc. are ok)
  node = containerA.nextSibling as Tag | NavigableString | null
  while (node !== null && node !== containerB) {
    if (node instanceof Tag) {
      // Allow page numbers, empty divs, <hr> separators
      if (node.name === 'hr') {
        node = node.nextSibling as Tag | NavigableString | null
        continue
      }
      const text = node.getText('', true)
      if (text && text.length > 10) {
        // Substantial content between containers — not a continuation
        return false
      }
    } else if (strip(node.text).length > 10) return false
    node = node.nextSibling as Tag | NavigableString | null
  }
  return node === containerB
}

/** Get the expanded column count (sum of colspans) of a table's widest row. */
export function expandedColCount(table: Tag): number {
  let maxCols = 0
  for (const row of table.findAll('tr').slice(0, 10)) {
    const cells = row.findAll(['td', 'th'])
    const total = cells.reduce((acc, c) => acc + pyInt(c.getStr('colspan', '1')), 0)
    maxCols = Math.max(maxCols, total)
  }
  return maxCols
}

/** `int(x)`: Python raises on a malformed colspan; here it counts as 1 so a stray attribute cannot end the conversion. */
export function pyInt(s: string): number {
  const t = strip(s)
  return /^[+-]?\d+$/.test(t) ? parseInt(t, 10) : 1
}

/** Merge consecutive tables where later ones are continuations. */
export function mergeContinuationTables(soup: Tag): void {
  const tables = soup.findAll('table')
  const tablesToRemove = new TagSet()

  let i = 0
  while (i < tables.length) {
    const table = tables[i]!
    if (tablesToRemove.has(table)) {
      i++
      continue
    }

    // Find consecutive continuation tables.
    // Track last_ref so the proximity check is always between
    // adjacent tables (not base-vs-distant) when chaining
    // across multiple page-break boundaries.
    const continuations: Tag[] = []
    let j = i + 1
    let lastRef = table
    while (j < tables.length) {
      const nextTable = tables[j]!
      if (tablesToRemove.has(nextTable)) {
        j++
        continue
      }
      // Check if next_table immediately follows (no significant content between)
      // and is a continuation table
      if (isContinuationTable(nextTable, lastRef)) {
        continuations.push(nextTable)
        lastRef = nextTable
        j++
      } else break
    }

    if (continuations.length) {
      // For each continuation, prepend header copies and append to main table
      for (const contTable of continuations) {
        // Get all rows from continuation table
        const contRows = contTable.findAll('tr')
        // Find the main table's tbody or create one
        const tbody = table.find('tbody') ?? table

        // Append continuation rows to main table
        for (const contRow of contRows) tbody.append(contRow.extract())

        // Mark for removal
        tablesToRemove.add(contTable)
      }
    }

    i++
  }

  // Remove merged tables
  for (const table of tablesToRemove) table.decompose()
}

const FONT_SIZE_RE = /font-size:\s*(\d+)(?:pt|px)/

/** Check if element looks like a section header. */
export function isHeaderElement(tag: Tag): boolean {
  if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tag.name)) return true

  // Elements explicitly marked as body text by the reflow engine
  // should never be promoted to headings.
  if (tag.getStr('data-body-text')) return false

  // Check for TOC section headers - elements with toc* anchor IDs
  const elementId = tag.getStr('id', '')

  if (elementId && elementId.startsWith('toc')) {
    // Check if it contains bold/styled text indicating a section header
    const boldChild = tag.find(['b', 'strong']) ?? tag.find(null, { attrs: { style: /font-weight:\s*bold/i } })
    if (boldChild) {
      const text = strip(tag.getText())

      if (text && text.length < 150) return true
    }
  }

  // Check for divs/paragraphs styled as headers (large font-size)
  if (tag.name === 'div' || tag.name === 'p') {
    // Positioned layouts (Workiva) nest tables inside styled divs
    // whose font-size or bold spans would otherwise false-positive.
    if (tag.find('table')) return false

    const style = tag.getStr('style', '')
    // Look for font-size in style attribute
    const fontMatch = FONT_SIZE_RE.exec(style)

    if (fontMatch) {
      const fontSize = parseInt(fontMatch[1]!, 10)
      // Check if child spans have a SMALLER font size — if so, the
      // container font-size is just a fallback/default (common in
      // position-based layouts) and should NOT trigger header detection.
      let childFont: number | null = null

      for (const span of tag.findAll('span')) {
        const s = span.getStr('style', '')
        const cm = FONT_SIZE_RE.exec(s)

        if (cm) {
          childFont = parseInt(cm[1]!, 10)
          break
        }
      }

      const effectiveFont = childFont !== null ? childFont : fontSize
      // 11pt+ is typically header-sized in SEC filings
      if (effectiveFont >= 11) {
        const text = strip(tag.getText())
        // Should be reasonably short and have content
        if (text && text.length < 150) return true
      }
    }

    // Only trigger when the div has no bare text nodes — positioned divs always wrap text in spans.
    const hasBareText = tag.contents.some((c) => c instanceof NavigableString && strip(c.text))
    if (!hasBareText) {
      // Check for <p>/<div> whose only children are <b>/<strong> tags
      const nonWsChildren = tag.contents.filter((c) => !(c instanceof NavigableString && !strip(c.text)))
      const allBoldTags =
        nonWsChildren.length > 0 &&
        nonWsChildren.every((c) => (c instanceof Tag && (c.name === 'b' || c.name === 'strong')) || (c instanceof Tag && c.name === 'span' && !c.getText('', true))) &&
        // At least one child must be <b>/<strong>
        nonWsChildren.some((c) => c instanceof Tag && (c.name === 'b' || c.name === 'strong'))
      if (allBoldTags && !tag.find('img')) {
        const text = strip(tag.getText())
        if (text && text.length < 100 && /[a-zA-Z]/.test(text)) return true
      }

      const textSpans = tag.findAll('span').filter((s) => s.contents.some((c) => c instanceof NavigableString && strip(c.text)) && !s.getStr('style', '').replaceAll(' ', '').includes('display:inline-block'))
      if (textSpans.length) {
        // Count bold vs total characters across text spans.
        let boldChars = 0
        let totalChars = 0

        for (const s of textSpans) {
          const sty = s.getStr('style', '')
          const isB = /font-weight:\s*(bold|bolder|[6-9]00)/i.test(sty)
          for (const c of s.contents) {
            if (c instanceof NavigableString && strip(c.text)) {
              const n = strip(c.text).length
              totalChars += n
              if (isB) boldChars += n
            }
          }
        }

        const mostlyBold = totalChars > 0 && boldChars / totalChars >= 0.8

        if (mostlyBold) {
          const text = strip(tag.getText())

          if (text && text.length < 80 && /[a-zA-Z]/.test(text)) return true
        }
      }
    }
  }

  if (tag.name === 'b' || tag.name === 'strong') {
    const text = strip(tag.getText())

    if (/^ITEM\s+\d/i.test(text)) return true

    if (/^PART\s+[IVX]+/i.test(text)) return true

    const words = split(text)

    if (words.length >= 2 && text.length < 80 && isUpper(text)) return true
    // Single uppercase words that look like section titles
    if (words.length === 1 && isUpper(text) && text.length >= 4) return true
  }

  return false
}

/** Determine header level. */
export function getHeaderLevel(tag: Tag): number {
  const text = strip(tag.getText())
  if (/^PART\s+[IVX]+/i.test(text)) return 1
  if (/^ITEM\s+\d/i.test(text)) return 2
  if (tag.name === 'h1') return 1
  if (tag.name === 'h2') return 2
  if (tag.name === 'h3') return 3

  // Check font-size for styled divs/paragraphs
  if (tag.name === 'div' || tag.name === 'p') {
    const style = tag.getStr('style', '')
    const fontMatch = FONT_SIZE_RE.exec(style)
    if (fontMatch) {
      const fontSize = parseInt(fontMatch[1]!, 10)
      if (fontSize >= 15) return 2 // Large headers (15-16pt)
      if (fontSize >= 11) return 3 // Subsection headers (11-14pt)
    }
  }
  return 3
}

// ============================================================================
// CONVERT_TABLE HELPER FUNCTIONS (extracted from convert_table)
// ============================================================================

/**
 * Merge currency symbols and parentheses with values.
 *
 * Handles common SEC filing table patterns:
 * - $ in one cell, value in next: "$" + "12,211" → "$12,211"
 * - Opening paren with value: "(" + "2,257" + ")" → "(2,257)"
 * - Split negative with note: "(2,257" + ")(b)" → "(2,257)(b)"
 * - Value + trailing note: "7" + "(a)" → "7 (a)"
 */
export function cleanTableCells(rows: Cells[]): Cells[] {
  const cleaned: Cells[] = []
  for (const row of rows) {
    let newRow = [...row]

    // Pass 1: Merge $ or ( prefix with following value
    let i = 0
    while (i < newRow.length) {
      const cell = strip(newRow[i]!)
      if (['$', '(', '$(', '($'].includes(cell) && i + 1 < newRow.length) {
        for (let j = i + 1; j < Math.min(i + 4, newRow.length); j++) {
          const nextVal = strip(newRow[j]!)
          if (nextVal && !['$', ')', '%', ''].includes(nextVal)) {
            newRow[i] = cell + nextVal
            for (let k = i + 1; k <= j; k++) newRow[k] = ''
            break
          }
          if (nextVal === ')' || nextVal === '%') break
        }
      }
      i++
    }

    // Pass 2: Merge split negatives like "(2,257" + ")(b)" or "(2,257" + ")"
    // Also handle "(2,257" + close paren in any form
    // And handle "$(171" + ")" patterns (currency + open paren)
    i = 0
    while (i < newRow.length) {
      const cell = strip(newRow[i]!)
      // Check if cell has an open paren that isn't closed
      // Handles both "(2,257" and "$(171" patterns
      const hasOpenParen = cell.includes('(') && !cell.endsWith(')')
      if (hasOpenParen && i + 1 < newRow.length) {
        // Look for closing paren in following cells
        for (let j = i + 1; j < Math.min(i + 3, newRow.length); j++) {
          const nextVal = strip(newRow[j]!)
          if (nextVal.startsWith(')')) {
            // Merge: "(2,257" + ")(b)" → "(2,257)(b)"
            newRow[i] = cell + nextVal
            newRow[j] = ''
            break
          }
          if (nextVal === '') continue
          break
        }
      }
      i++
    }

    // Pass 3: Merge value with trailing ), %, pts., footnote markers (*, **)
    // SEC tables often split suffixes into narrow separate columns
    i = 0
    while (i < newRow.length) {
      const cell = strip(newRow[i]!)
      if (cell && i + 1 < newRow.length) {
        for (let j = i + 1; j < Math.min(i + 4, newRow.length); j++) {
          const nextVal = strip(newRow[j]!)
          // Match suffix patterns: ), %, )%, %*, )pts., pts., *, **, etc.
          if (nextVal && /^[)%]*(?:pts\.?)?[*]*$/.test(nextVal)) {
            newRow[i] = cell + nextVal
            for (let k = i + 1; k <= j; k++) newRow[k] = ''
            break
          }

          if (nextVal && nextVal !== '' && nextVal !== ' ') break
        }
      }

      i++
    }

    // Pass 4: Merge numeric value with following note like "(a)", "(b)"
    // Pattern: "7" + "(a)" → "7 (a)" or "5,754" + "(a)" → "5,754 (a)"
    i = 0

    while (i < newRow.length) {
      const cell = strip(newRow[i]!)
      // Check if cell is a numeric value
      if (cell && /^[\d,.$()-]+$/.test(cell.replaceAll(' ', '')) && i + 1 < newRow.length) {
        const nextVal = strip(newRow[i + 1]!)
        // Check if next cell is a note reference like "(a)", "(b)"
        if (nextVal && /^\([a-z]\)$/.test(nextVal)) {
          newRow[i] = cell + ' ' + nextVal
          newRow[i + 1] = ''
        }
      }
      i++
    }

    newRow = newRow.map((c) => strip(c))
    cleaned.push(newRow)
  }

  return cleaned
}

/** Merge consecutive rows that are continuations of split text. */
export function mergeSplitRows(rows: Cells[], rowsWithColspan: RowsWithColspan): [Cells[], RowsWithColspan] {
  const mergedData: Cells[] = []
  const mergedColspan: RowsWithColspan = []
  let i = 0
  while (i < rows.length) {
    const row = rows[i]!
    const rowCs = i < rowsWithColspan.length ? rowsWithColspan[i]! : []
    const rowText = row
      .map((c) => strip(c))
      .filter((c) => c)
      .join(' ')

    // ── New: label-continuation merge ──────────────────────────────────
    // Detect rows whose label cell (col 0) has text but all other cells
    // are empty, AND the next row's label starts with a lowercase word
    // (i.e. it is a sentence continuation, e.g.
    //   Row A: "Level 3 assets for which we do not"
    //   Row B: "bear economic exposure (7)" | (14,437) | …
    // → Merge to: "Level 3 assets for which we do not bear economic exposure (7)"
    // and take the data values from Row B.
    const nonEmptyCols: number[] = []
    row.forEach((c, j) => {
      if (strip(c)) nonEmptyCols.push(j)
    })
    if (nonEmptyCols.length === 1 && nonEmptyCols[0] === 0 && i + 1 < rows.length) {
      const nextRow = rows[i + 1]!
      const nextLabel = nextRow.length ? strip(nextRow[0]!) : ''
      // Continuation: next label starts with a lowercase letter
      if (nextLabel && isLower(nextLabel[0]!)) {
        const labelA = strip(row[0]!)
        const mergedLabel = labelA + ' ' + nextLabel
        // Build merged row: combined label, then data columns from next row
        const newRow = [mergedLabel, ...nextRow.slice(1)]
        const nextCs = i + 1 < rowsWithColspan.length ? rowsWithColspan[i + 1]! : []
        mergedData.push(newRow)
        mergedColspan.push(nextCs)
        i += 2
        continue
      }
    }
    // ───────────────────────────────────────────────────────────────────

    // Check if this row starts an incomplete parenthetical
    // Pattern: starts with ( but doesn't end with )
    // BUT only if the first non-empty cell itself has an unbalanced paren.
    // e.g., "(in millions, except per" is incomplete → merge with "share amounts)"
    // but "(in millions)" is complete → do NOT merge even if other cells follow.
    // Also "(Benefit from) provision for taxes" has balanced parens even
    // though it doesn't end with ")" — still complete, don't merge.
    if (rowText.startsWith('(') && !rowText.endsWith(')')) {
      // Check if the first non-empty cell has balanced parentheses
      let firstCell = ''
      for (const c of row) {
        if (strip(c)) {
          firstCell = strip(c)
          break
        }
      }
      const firstCellBalanced = firstCell.split('(').length === firstCell.split(')').length
      if (firstCellBalanced) {
        // First cell has balanced parens like "(in millions)" or
        // "(Benefit from) provision for income taxes" —
        // don't try to merge with subsequent rows
        mergedData.push(row)
        mergedColspan.push(rowCs)
        i++
        continue
      }

      // If non-label columns have content, this is a header row
      // where the descriptor sits at col 0 alongside date/year
      // columns.  Don't merge — the unbalanced paren is just the
      // descriptor wrapping across the HTML row, and the data in
      // other columns must be preserved.
      const nonLabelContent = row.slice(1).some((c) => strip(c))
      if (nonLabelContent) {
        mergedData.push(row)
        mergedColspan.push(rowCs)
        i++
        continue
      }

      // Look ahead for continuation
      let mergedText = rowText
      let j = i + 1
      while (j < rows.length) {
        const nextRow = rows[j]!
        const nextText = nextRow
          .map((c) => strip(c))
          .filter((c) => c)
          .join(' ')
        // Check if next row is continuation (ends with ) or has amounts/share text)
        if (nextText && (nextText.endsWith(')') || nextText.toLowerCase().includes('amount') || nextText.toLowerCase().includes('share') || nextText.startsWith('and '))) {
          mergedText += ' ' + nextText
          j++
          if (nextText.endsWith(')')) break
        } else break
      }

      if (j > i + 1) {
        // We merged rows - create single row with combined text
        const newRow = [mergedText, ...Array.from({ length: row.length - 1 }, () => '')]
        mergedData.push(newRow)
        // For colspan, just use first row's structure
        mergedColspan.push(rowCs)
        i = j
        continue
      }
    }

    mergedData.push(row)
    mergedColspan.push(rowCs)
    i++
  }

  return [mergedData, mergedColspan]
}

/**
 * Merge cells that contain parts of the same value.
 *
 * IMPORTANT: When merging, we add an empty placeholder to maintain column
 * alignment across all rows. Otherwise, rows with merged cells would have
 * fewer columns than rows without merges, causing misalignment.
 */
export function mergeSplitCells(rows: Cells[]): Cells[] {
  const result: Cells[] = []
  for (const row of rows) {
    const mergedRow: string[] = []
    let i = 0
    while (i < row.length) {
      const cell = row[i]!
      const cellStripped = strip(cell)

      // Look ahead to see if next cell should be merged
      if (i + 1 < row.length) {
        const nextCell = strip(row[i + 1]!)

        // Case 1: Cell ends with "(" and next cell is just ")"
        // e.g., "(306" + ")" → "(306)"
        if (cellStripped.endsWith('(') && nextCell === ')') {
          mergedRow.push(cellStripped + ')')
          mergedRow.push('') // Placeholder to maintain column count
          i += 2
          continue
        }

        // Case 2: Cell is a number and next cell is just a closing paren
        // e.g., "(306" in cell, ")" in next cell for alignment
        // This handles negative numbers where open paren is with number
        if (/^\([\d,.]+$/.test(cellStripped) && nextCell === ')') {
          mergedRow.push(cellStripped + ')')
          mergedRow.push('') // Placeholder to maintain column count
          i += 2
          continue
        }

        // Case 3: Cell is a number and next cell is a footnote marker
        // e.g., "2,264" + "(1)" → "2,264 (1)"
        // Only merge footnotes with 1-2 digits; 3+ digits like
        // "(193)" are negative financial values, not footnotes.
        if (/^\$?[\d,.]+$/.test(cellStripped) && /^\(\d{1,2}\)$/.test(nextCell)) {
          mergedRow.push(cellStripped + ' ' + nextCell)
          mergedRow.push('') // Placeholder to maintain column count
          i += 2
          continue
        }

        // Case 4: Cell is a number and a nearby cell is "%" or "pts"
        // SEC tables split "22%" across cells: "22"[cs=2] + "%"[cs=1]
        // After colspan expansion this becomes: "22", "", "%"
        // Also handles: "(1.2)" + "" + "pts" → "(1.2)pts"
        if (/^[()]?[\d,.]+[)]?$/.test(cellStripped)) {
          // Look for "%" or "pts" up to 2 cells ahead (skipping empties)
          let suffixOffset: number | null = null
          for (let look = 1; look < Math.min(3, row.length - i); look++) {
            const lookCell = strip(row[i + look]!)
            if (lookCell === '%' || lookCell === 'pts') {
              suffixOffset = look
              break
            }
            if (lookCell !== '') break // Non-empty, non-suffix cell - stop
          }

          if (suffixOffset !== null) {
            const suffix = strip(row[i + suffixOffset]!)
            mergedRow.push(cellStripped + suffix)
            // Add empty placeholders for all consumed cells
            for (let k = 0; k < suffixOffset; k++) mergedRow.push('')
            i += suffixOffset + 1
            continue
          }
        }
      }

      mergedRow.push(cell)
      i++
    }

    result.push(mergedRow)
  }
  return result
}

/**
 * Collapse adjacent duplicate header cells from colspan expansion.
 *
 * When header cells have colspan>1, they get expanded to multiple cells
 * with the same text. Data cells in those spans typically only fill one
 * position. After remove_empty_columns, we may have:
 *   Header: ["Name", "Fiscal Year", "", "Salary", "", "Bonus", ...]
 *   Data:   ["Ellison", "", "2025", "", "950,000", "", ...]
 *
 * This function collapses repeated adjacent headers and shifts data to align:
 *   Header: ["Name", "Fiscal Year", "Salary", "Bonus", ...]
 *   Data:   ["Ellison", "2025", "950,000", ...]
 */
export function collapseRepeatedHeaders(rows: Cells[]): Cells[] {
  if (rows.length === 0 || rows.length < 2) return rows

  const header = rows[0]!
  if (header.length < 2) return rows

  // Identify positions to collapse: where header[i] == header[i-1] and both non-empty
  // OR where header[i] is empty but header[i-1] is not (empty trailing from colspan)
  const colsToRemove = new Set<number>()
  for (let i = 1; i < header.length; i++) {
    const prev = header[i - 1] ? strip(header[i - 1]!) : ''
    const curr = header[i] ? strip(header[i]!) : ''

    // If current is duplicate of previous OR empty with non-empty prev
    // AND the data rows mostly have content in current (not prev)
    if (prev && (curr === prev || !curr)) {
      // Check if data rows have content in THIS column vs PREV column
      // If data is in current column, keep current and remove previous
      // If data is in previous column, remove current
      const prevHasData = rows.slice(1).some((row) => i - 1 < row.length && strip(row[i - 1]!))
      const currHasData = rows.slice(1).some((row) => i < row.length && strip(row[i]!))

      if (currHasData && !prevHasData) {
        // Data is in current column, remove the previous header duplicate
        // and copy header text to current
        header[i] = prev // Copy header to data position
        colsToRemove.add(i - 1)
      } else if (!currHasData && prevHasData) {
        // Data is in previous column, just remove current empty
        colsToRemove.add(i)
      } else if (!currHasData && !prevHasData) {
        // Neither has data, remove the empty trailing
        if (!curr) colsToRemove.add(i)
      } else if (currHasData && prevHasData && !curr) {
        // Both have data, but header is only in prev (curr is empty).
        // Check if data is complementary: no row has data in BOTH columns.
        // This happens with $ prefix columns in SEC tables where dollar rows
        // put merged $+value at a different position than non-dollar rows.
        let isComplementary = true
        for (const row of rows.slice(1)) {
          const p = i - 1 < row.length ? strip(row[i - 1]!) : ''
          const c = i < row.length ? strip(row[i]!) : ''
          if (p && c) {
            isComplementary = false
            break
          }
        }
        if (isComplementary) {
          // Merge: move curr's data into prev's empty slots, remove curr
          for (const row of rows.slice(1)) {
            const c = i < row.length ? strip(row[i]!) : ''
            const p = i - 1 < row.length ? strip(row[i - 1]!) : ''
            if (c && !p) row[i - 1] = row[i]!
          }
          colsToRemove.add(i)
        }
      }
    }
  }

  // Second pass: detect complementary adjacent columns caused by
  // $ prefix merging offset. When $ is in a separate cell, the merged
  // $+value lands at a different expanded position than non-dollar values.
  // Result: adjacent columns with complementary data (never both non-empty
  // in the same row). Merge the smaller into the larger regardless of
  // whether rows[0] has header text.
  for (let i = 1; i < header.length; i++) {
    if (colsToRemove.has(i) || colsToRemove.has(i - 1)) continue // Already handled

    // Check if columns i-1 and i are strictly complementary across ALL rows
    let isComplementary = true
    let colPrevCount = 0
    let colCurrCount = 0
    for (const row of rows) {
      const p = i - 1 < row.length ? strip(row[i - 1]!) : ''
      const c = i < row.length ? strip(row[i]!) : ''
      if (p && c) {
        isComplementary = false
        break
      }
      if (p) colPrevCount++
      if (c) colCurrCount++
    }

    if (!isComplementary) continue
    if (colCurrCount === 0) continue // col i is fully empty, remove_empty_columns handles it

    // Merge smaller into larger (by count of non-empty rows)
    if (colPrevCount >= colCurrCount) {
      // Merge col i data into col i-1
      for (const row of rows) {
        const c = i < row.length ? strip(row[i]!) : ''
        const p = i - 1 < row.length ? strip(row[i - 1]!) : ''
        if (c && !p) row[i - 1] = row[i]!
      }
      colsToRemove.add(i)
    } else {
      // Merge col i-1 data into col i
      for (const row of rows) {
        const p = i - 1 < row.length ? strip(row[i - 1]!) : ''
        const c = i < row.length ? strip(row[i]!) : ''
        if (p && !c) row[i] = row[i - 1]!
      }
      colsToRemove.add(i - 1)
    }
  }

  // Also remove trailing empty columns (both header and all data empty)
  const numCols = header.length
  for (let colIdx = numCols - 1; colIdx >= 0; colIdx--) {
    const headerEmpty = colIdx < header.length ? !strip(header[colIdx]!) : true
    const dataEmpty = rows.slice(1).every((row) => (colIdx < row.length ? !strip(row[colIdx]!) : true))
    if (headerEmpty && dataEmpty) colsToRemove.add(colIdx)
    else break // Stop at first non-empty column from the right
  }

  if (colsToRemove.size === 0) return rows

  // Rebuild all rows without the collapsed columns
  const colsToKeep: number[] = []
  for (let i = 0; i < header.length; i++) if (!colsToRemove.has(i)) colsToKeep.push(i)
  return rows.map((row) => colsToKeep.map((i) => (i < row.length ? row[i]! : '')))
}

/** Parse a row into (label, values) like non_xbrl_parser does. */
export function parseRowSemantic(row: Cells, numExpectedCols = 0): [string | null, string[]] {
  let label: string | null = null
  let values: string[] = []
  const additionalText: string[] = [] // Text that might be values if no numeric values found

  for (const cell of row) {
    const c = strip(cell)

    if (!c || c === '$') continue

    // Em dashes represent "not applicable" - they're values
    // Handle plain dashes AND dollar+dash like "$—" or "$ —" (spaced)
    if (((c === '\u{2014}' || c === '\u{2013}' || c === '-') && c.length === 1) || /^\$\s*[\u{2014}\u{2013}-]$/u.test(c)) {
      values.push(c)
    }
    // Check if this is a number (with optional $ prefix, commas, parens for negative)
    else if (/^[+-]?\$?\s*\(?\$?\s*\d[\d,]*\.?\d*\s*\)?\s*%?(?:pts\.?)?\s*\*{0,2}\s*(\(\d+\)|\([a-z]\))?$/.test(c.replaceAll(',', ''))) {
      // It's a number (possibly with footnote) - it's a value
      values.push(c)
    } else if (label === null) label = c
    else {
      // Additional text - might be a text value (like credit ratings)
      // Keep it separate so we can decide later
      additionalText.push(c)
    }
  }

  // If we found no numeric values but have additional text, and we expect columns,
  // treat the additional text as values (e.g., credit ratings like "P-1", "A1")
  if (values.length === 0 && additionalText.length && numExpectedCols > 0) {
    // Use additional text as values (up to expected count)
    values = additionalText.slice(0, numExpectedCols)
  } else if (values.length === 0 && additionalText.length) {
    // No expected columns info - append to label as before
    label = (label || '') + ' ' + additionalText.join(' ')
  } else if (values.length && additionalText.length && values.length < numExpectedCols && numExpectedCols > 0) {
    // We have some numeric values but fewer than expected. Fill remaining
    // slots with extra text items — e.g., a "Valuation Technique" text
    // column that appears alongside a numeric "Fair Value" column.
    const needed = numExpectedCols - values.length
    values.push(...additionalText.slice(0, needed))
  }

  // If we have values but no label, it's likely a total row
  // Use "Total" as the label if values look like currency totals
  if (values.length && !label) {
    // Check if values contain dollar amounts (start with $ or have commas)
    const hasCurrency = values.some((v) => v.startsWith('$') || /^\(?\d{1,3}(,\d{3})+/.test(v))
    if (hasCurrency) label = 'Total'
  }

  return [label, values]
}

/**
 * Detect and merge multi-index column headers from data rows.
 *
 * Returns (header_rows, data_start_index, num_value_cols) where:
 *     header_rows: list of COMPRESSED header rows [label_col, val1, val2, ...]
 *     data_start_index: index into data_rows where actual data begins
 *     num_value_cols: number of value columns (for data extraction)
 */
export function detectAndMergeMultiindexHeaders(dataRows: Cells[]): [Cells[] | null, number, number] {
  if (dataRows.length === 0 || dataRows.length < 3) return [null, 0, 0]

  const isYear = (t: string): boolean => {
    // Strip trailing footnote markers like *, **, †, ‡, §
    const tClean = strip(t).replace(/[*\u{2020}\u{2021}\u{a7}+]+$/u, '')
    return /^(19|20)\d{2}$/.test(tClean)
  }

  const isAllCapsWord = (t: string): boolean => {
    t = strip(t)
    return /^[A-Z]{2,}$/.test(t) && t.length > 1
  }

  const isNumeric = (t: string): boolean => {
    t = strip(t)
    return /^\$?\s*[()]?\s*[\d,]+\.?\d*\s*[)%]?$/.test(t) && hasDigit(t)
  }

  const rowHasYears = (row: Cells): boolean => {
    const nonEmpty = row.map((c) => strip(c)).filter((c) => c)
    const yearCount = nonEmpty.filter((c) => isYear(c)).length
    return yearCount >= 3 // At least 3 years
  }

  const rowIsAllCapsCategories = (row: Cells): boolean => {
    const nonEmpty = row.map((c) => strip(c)).filter((c) => c)
    if (nonEmpty.length < 2) return false
    const capsCount = nonEmpty.filter((c) => isAllCapsWord(c)).length
    return capsCount >= 2 && capsCount >= nonEmpty.length * 0.5
  }

  const rowHasData = (row: Cells): boolean => row.some((c) => isNumeric(c))

  const rowIsTitle = (row: Cells): boolean => {
    const nonEmpty = row.map((c) => strip(c)).filter((c) => c)

    if (nonEmpty.length === 0) return true

    const rowText = nonEmpty.join(' ')

    return /(years?\s+ended|months?\s+ended|weeks?\s+ended|unaudited|as\s+of|income\s+statement|balance\s+sheet|statement\s+of)/i.test(rowText)
  }

  // Scan for header structure
  const categoryRowsData: [number, string[]][] = [] // List of (row_idx, [cat_texts])
  let yearRowIdx: number | null = null
  let yearsList: string[] = [] // Actual year values in order
  let dataStart = 0

  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i]!
    // Check for year row FIRST (before data check, since years look numeric)
    if (rowHasYears(row)) {
      yearRowIdx = i
      yearsList = row.map((c) => strip(c)).filter((c) => c && isYear(c))
      dataStart = i + 1
      continue // Keep scanning to find where data actually starts
    }

    if (rowHasData(row)) {
      dataStart = i
      break
    }

    if (rowIsTitle(row)) continue

    if (rowIsAllCapsCategories(row)) {
      // Extract category texts
      const cats = row.map((c) => strip(c)).filter((c) => c && isAllCapsWord(c))
      categoryRowsData.push([i, cats])
    }
  }

  if (yearRowIdx === null || yearsList.length === 0) return [null, 0, 0]

  const numYears = yearsList.length

  // Merge category rows vertically
  // EQUIPMENT + OPERATIONS = "EQUIPMENT OPERATIONS"
  // FINANCIAL + SERVICES = "FINANCIAL SERVICES"
  // Build categories by position (first row gives base, subsequent rows add)
  let mergedCategories: string[]
  if (categoryRowsData.length) {
    // Use max categories from any row
    const maxCats = Math.max(...categoryRowsData.map(([, cats]) => cats.length))
    mergedCategories = Array.from({ length: maxCats }, () => '')

    for (const [, cats] of categoryRowsData) {
      cats.forEach((cat, j) => {
        if (j < mergedCategories.length) {
          if (mergedCategories[j]) mergedCategories[j] += ' ' + cat
          else mergedCategories[j] = cat
        } else mergedCategories.push(cat)
      })
    }
  } else {
    // No ALL CAPS categories found - return None to use fallback
    // which can detect Title Case categories like "Pensions", "OPEB"
    // via colspan analysis in extract_periods_from_rows
    return [null, 0, 0]
  }
  const numCategories = mergedCategories.length

  // Calculate years per category
  let yearsPerCat = Math.floor(numYears / numCategories)
  if (yearsPerCat === 0) yearsPerCat = 1

  // Build COMPRESSED headers
  // Format: ["", "CAT1", "", "", "CAT2", "", "", ...]  (category in first cell of span)
  // Format: ["", "2025", "2024", "2023", "2025", "2024", "2023", ...]

  const catRow = [''] // Label column
  const yearRow = [''] // Label column

  let yearIdx = 0
  for (const cat of mergedCategories) {
    // Category name in first cell
    catRow.push(cat)
    // Empty cells for remaining years under this category
    for (let k = 0; k < yearsPerCat - 1; k++) catRow.push('')

    // Years for this category
    for (let k = 0; k < yearsPerCat; k++) {
      if (yearIdx < numYears) {
        yearRow.push(yearsList[yearIdx]!)
        yearIdx++
      } else yearRow.push('')
    }
  }

  const headerRows = [catRow, yearRow]
  const numValueCols = numCategories * yearsPerCat

  // Find actual data start
  for (let i = dataStart; i < dataRows.length; i++) {
    const row = dataRows[i]!
    if (rowHasData(row)) {
      dataStart = i
      break
    }
    if (!rowIsTitle(row) && !rowIsAllCapsCategories(row) && !rowHasYears(row)) {
      dataStart = i
      break
    }
  }

  return [headerRows, dataStart, numValueCols]
}

/** Detect if this is an equity statement with stacked column headers. */
export function isEquityStatementTable(rows: Cells[]): boolean {
  if (rows.length < 5) return false

  const equityKeywords = ['stockholders', 'common', 'treasury', 'retained', 'accumulated', 'comprehensive', 'noncontrolling', 'redeemable', 'equity']
  let keywordCount = 0
  for (const row of rows.slice(0, 10)) {
    const rowText = row
      .filter((c) => strip(c))
      .map((c) => strip(c).toLowerCase())
      .join(' ')
    for (const kw of equityKeywords) {
      if (rowText.includes(kw)) keywordCount++
    }
  }
  return keywordCount >= 4 // Need multiple equity-related headers
}

/**
 * Process equity statement table with stacked vertical headers.
 *
 * Returns (processed_rows, header_count) or (None, 0) if not applicable.
 */
export function processEquityStatementTable(rows: Cells[], rowsWithColspan: RowsWithColspan): [Cells[] | null, number] {
  // Step 1: Find first data row (row with actual numeric values)
  let dataStartIdx = 0

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!
    const nonEmpty = row.map((c) => strip(c)).filter((c) => c)
    if (nonEmpty.length === 0) continue

    const rowTextLower = nonEmpty.map((c) => c.toLowerCase()).join(' ')

    // Check for $ followed by number pattern (indicates data row)
    // Look for actual balance/value data with $ prefix
    let hasBalanceData = false
    for (let j = 0; j < row.length; j++) {
      const c = strip(row[j]!)
      const nextC = j + 1 < row.length ? strip(row[j + 1]!) : ''

      // Pattern 1: Combined dollar amounts like "$21,789" or "$5,303"
      if (((c.startsWith('$') && c.length > 1 && hasDigit(c)) || (c === '$' && nextC && hasDigit(nextC))) && rowTextLower.includes('balance')) {
        hasBalanceData = true
        break
      }
    }

    if (hasBalanceData) {
      dataStartIdx = i
      break
    }
  }

  if (dataStartIdx === 0 || dataStartIdx >= rows.length) return [null, 0]

  // Step 2: Analyze a data row to find the column structure
  // Each logical value column has: possibly spacer + $ cell + number cell
  // Find all columns that directly contain $ + number format
  const sampleRow = rows[dataStartIdx]!
  const valuePositions: number[] = [] // (col_index, value_with_$)

  sampleRow.forEach((cell, j) => {
    const c = strip(cell)
    // Match "$21,789" or "$(24,094)" or "$5,165" patterns
    if (c && /^\$[()]?[\d,]+[)]?$/.test(c)) valuePositions.push(j)
  })

  // If $ and value are in separate cells, find pairs
  if (valuePositions.length === 0) {
    for (let j = 0; j < sampleRow.length - 1; j++) {
      const c = strip(sampleRow[j]!)
      const nextC = j + 1 < sampleRow.length ? strip(sampleRow[j + 1]!) : ''
      // $ in current cell, number in next
      if (c === '$' && nextC && /^[()]?[\d,]+[)]?$/.test(nextC)) {
        valuePositions.push(j) // Use the $ cell position as anchor
      } else if ((c === '$(' || c === '($') && nextC && /^[\d,]+\)?$/.test(nextC)) {
        valuePositions.push(j)
      }
    }
  }

  const numValueCols = valuePositions.length
  if (numValueCols < 2) return [null, 0]

  // Step 3: Build headers from header rows (rows before data_start_idx)
  // For each value position, find the corresponding header by looking at
  // which header text appears above or near that column

  /** Identify if a row is a title/descriptor row that should be skipped from headers. */
  const isTitleRow = (rowIdx: number): boolean => {
    if (rowIdx >= rows.length) return false
    const row = rows[rowIdx]!
    const nonEmpty = row.map((c) => strip(c)).filter((c) => c)

    if (nonEmpty.length === 0) return true // Empty row - skip it

    if (nonEmpty.length === 1 && rowIdx < rowsWithColspan.length) {
      // Single non-empty cell - check if it spans most of the row
      // Also check rows_with_colspan for actual colspan info
      const csRow = rowsWithColspan[rowIdx]!
      const csNonEmpty = csRow.filter(([t]) => strip(t))

      if (csNonEmpty.length === 1) {
        const colspan = csNonEmpty[0]![1]
        const totalSpan = csRow.reduce((acc, [, cs]) => acc + cs, 0)

        if (colspan >= totalSpan * 0.4) {
          // Title spans 40%+ of table
          return true
        }
      }
    }

    return false
  }

  // Filter header rows to exclude title rows
  const headerRows: number[] = []
  for (let i = 0; i < dataStartIdx; i++) if (!isTitleRow(i)) headerRows.push(i)
  // First, find all unique header column positions from header rows
  const headerPositions = new Map<number, string[]>() // col_idx -> [text1, text2, ...]

  for (const rowIdx of headerRows) {
    const row = rows[rowIdx]!
    row.forEach((cell, colIdx) => {
      const text = strip(cell)
      if (text && !/^[$\d,.()]+$/.test(text)) {
        if (!headerPositions.has(colIdx)) headerPositions.set(colIdx, [])
        const list = headerPositions.get(colIdx)!
        if (!list.includes(text)) list.push(text)
      }
    })
  }

  // Get unique header columns in sorted order (by position)
  const sortedHeaderCols = [...headerPositions.keys()].sort((a, b) => a - b)
  // Build headers from the stacked text at each position
  const stackedHeaders: string[] = []

  for (const hPos of sortedHeaderCols) {
    const parts = headerPositions.get(hPos)!
    stackedHeaders.push(parts.join(' '))
  }

  // Match headers to values by sequence
  // If we have N values and M headers, match them by index
  const finalHeaders: string[] = []

  valuePositions.forEach((_vPos, idx) => {
    if (idx < stackedHeaders.length) finalHeaders.push(stackedHeaders[idx]!)
    else finalHeaders.push(`Column ${idx + 1}`)
  })

  // Step 4: Build output table
  const result: Cells[] = []

  // Add header row (empty label + column headers)
  result.push(['', ...finalHeaders])

  // Process each data row
  for (const row of rows.slice(dataStartIdx)) {
    // Extract label (first cell, or first non-$ non-empty cell)
    let label = ''
    for (const cell of row.slice(0, 3)) {
      // Label is usually in first few cells
      const c = strip(cell)
      if (c && !c.startsWith('$') && !/^\s*[()]?\s*[\d,]+\.?\d*\s*[)%]?$/.test(c) && !['$', '(', ')', '%', '\u{2014}', '\u{2013}', '-'].includes(c)) {
        label = c
        break
      }
    }

    // Extract values from value positions
    const values: string[] = []
    for (const vPos of valuePositions) {
      let val = ''
      if (vPos < row.length) {
        const c = strip(row[vPos]!)
        // Check if this cell has the complete value ($ + number)
        if (c && (c.startsWith('$') || /^[()]?[\d,]+/.test(c))) {
          val = c
          // If it's just $, look at next cell
          if ((c === '$' || c === '$(' || c === '($') && vPos + 1 < row.length) {
            const nextC = strip(row[vPos + 1]!)
            if (nextC) val = c + nextC
          }
        } else if (vPos + 1 < row.length) {
          // Value might be in next cell
          const nextC = strip(row[vPos + 1]!)
          if (nextC && /^[()]?[\d,]+/.test(nextC)) val = nextC
        }
      }
      values.push(val)
    }

    // Skip rows with no label and no values
    if (!label && !values.some((v) => strip(v))) continue

    result.push([label, ...values])
  }

  return [result, 1] // 1 header row
}

// Kept for sibling modules: character class helpers used across the port.
export { hasAlpha, hasDigit }
