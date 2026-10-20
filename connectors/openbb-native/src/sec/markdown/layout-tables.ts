// html2markdown: table classification, layout tables and table-cell text, provider sec. Ported from
// openbb_sec/utils/html2markdown.py lines 7400-8228 (OpenBB Platform 5.0.0, Apache-2.0); modified: bs4 → ./soup.ts.
import { NavigableString, Tag, tagEquals } from './soup.js'
import { BULLET_CHARS, convertImageToHtml, pyInt, urljoin } from './table-clean.js'
import { isUpper, strip } from './py.js'

const BOLD_STYLE = /font-weight:\s*bold/i
const BOLD_STYLE_STRONG = /font-weight:\s*(?:bold|bolder|[6-9]00)/i
const SKIP_TEXTS = ['\xa0', ' ']
const SKIP_TEXTS3 = ['\xa0', ' ', '']

/** `cell.find(["b", "strong"]) or cell.find(style=re.compile(...))` */
function findBold(cell: Tag, style: RegExp = BOLD_STYLE): Tag | null {
  return cell.find(['b', 'strong']) ?? cell.find(null, { attrs: { style } })
}

/**
 * Unified table classifier. Returns one of:
 * - "BULLET": Table with bullet characters → extract as bullet list
 * - "FOOTNOTE": Table with footnote markers (*, (1), (a)) → extract as text
 * - "HEADER": Single-cell section header → extract as markdown header
 * - "DATA": Everything else → render as markdown table (DEFAULT)
 *
 * The key principle: be CONSERVATIVE about extracting as text.
 * When in doubt, render as a table. Tables are data; don't lose structure.
 */
export function classifyTable(tableElem: Tag): 'BULLET' | 'FOOTNOTE' | 'HEADER' | 'DATA' {
  const rows = tableElem.findAll('tr')
  if (rows.length === 0) return 'DATA'

  // Collect info about the table structure
  const nonEmptyRows: [Tag[], string[]][] = []
  for (const row of rows) {
    const cells = row.findAll(['td', 'th'])
    const cellTexts = cells.map((c) => c.getText('', true))
    const nonEmptyTexts = cellTexts.filter((t) => t)
    if (nonEmptyTexts.length) nonEmptyRows.push([cells, nonEmptyTexts])
  }

  if (nonEmptyRows.length === 0) return 'DATA'

  // Check for bullet list (actual bullet characters, not asterisk which is a footnote marker)
  let bulletRows = 0
  for (const [, texts] of nonEmptyRows) {
    for (const text of texts.slice(0, 2)) {
      if (BULLET_CHARS.has(text)) {
        bulletRows++
        break
      }
    }
  }

  if (bulletRows >= 1 && bulletRows >= nonEmptyRows.length * 0.5) return 'BULLET'

  // ===== CHECK FOR FOOTNOTE TABLE =====
  // Table where first non-empty cell is a footnote marker
  // Markers: *, **, †, ‡, (1), (2), (a), (b), etc.
  const footnotePattern = /^[*\u{2020}\u{2021}\u{a7}\u{b6}]+$|^\(\d+\)$|^\([a-z]\)$|^\d+[.)]$/u

  // Count rows that look like footnotes
  let footnoteRows = 0
  for (const [, texts] of nonEmptyRows) {
    if (texts.length >= 2) {
      const firstText = texts[0]!
      if (footnotePattern.test(firstText)) footnoteRows++
    }
  }

  // If ALL multi-column rows are footnote-style, treat as footnote table.
  // Single-column rows are neutral continuation text (e.g. "The following
  // table sets forth the reconciliation...") and should not disqualify the
  // table from FOOTNOTE classification.
  const candidateRows = nonEmptyRows.filter(([, texts]) => texts.length >= 2).length
  if (candidateRows >= 1 && footnoteRows === candidateRows) return 'FOOTNOTE'

  // ===== CHECK FOR SECTION HEADER =====
  // Single row, single non-empty cell, typically bold or has id attribute
  if (nonEmptyRows.length === 1) {
    const [cells, texts] = nonEmptyRows[0]!
    if (texts.length === 1) {
      const text = texts[0]!
      let cell: Tag | null = null
      for (const c of cells) {
        if (c.getText('', true) === text) {
          cell = c
          break
        }
      }

      if (cell && text.length < 100) {
        // Check for header indicators
        const hasTocId = cells.some((c) => c.getStr('id', '').startsWith('toc'))
        let isBold = cell.find(['b', 'strong']) !== null
        // Also check for font-weight:bold in CSS
        if (!isBold) isBold = cell.find(null, { attrs: { style: BOLD_STYLE } }) !== null
        // If it looks like a section header, extract as header
        if (hasTocId || (isBold && text.length < 60)) return 'HEADER'
      }
    }
  }

  // ===== DEFAULT: DATA TABLE =====
  return 'DATA'
}

/**
 * Extract bullet list from table format.
 *
 * Note: * is NOT included as it's typically a footnote marker, not a bullet.
 *
 * Special handling: If the content cell has a bold header at the beginning,
 * format as a subsection header (#### Header) followed by the description.
 */
export function extractBulletList(tableElem: Tag): string | null {
  const bullets: string[] = []
  const rows = tableElem.findAll('tr')

  for (const row of rows) {
    const cells = row.findAll('td')
    if (cells.length >= 2) {
      let bulletCol = -1
      cells.slice(0, 2).forEach((cell, idx) => {
        if (bulletCol < 0 && BULLET_CHARS.has(cell.getText('', true))) bulletCol = idx
      })

      if (bulletCol >= 0) {
        const contentCell = bulletCol + 1 < cells.length ? cells[bulletCol + 1]! : null
        if (contentCell) {
          // Check if this cell starts with bold text (subsection header pattern)
          const boldElem = findBold(contentCell)

          if (boldElem) {
            // Use separator=" " to preserve spacing between inline elements
            let boldText = strip(boldElem.getText(' '))
            boldText = boldText.replace(/\s+/g, ' ') // Normalize whitespace
            let fullText = contentCell.getText(' ', true)
            fullText = cleanHtmlEntities(fullText)
            fullText = strip(fullText.replace(/\s+/g, ' '))

            // If bold text is at the start and there's more content after
            if (fullText.startsWith(boldText) && fullText.length > boldText.length + 5) {
              // This is a subsection header: "**Header**. Description..."
              let rest = strip(fullText.slice(boldText.length))
              if (rest.startsWith('.')) rest = strip(rest.slice(1))
              bullets.push(`**${boldText}**. ${rest}`)
            } else {
              // Just bold text with no description
              bullets.push(`**${boldText}**`)
            }
          } else {
            // Regular bullet item
            let text = cells
              .slice(bulletCol + 1)
              .map((c) => c.getText(' ', true))
              .join(' ')
            text = cleanHtmlEntities(text)
            text = strip(text.replace(/\s+/g, ' '))
            if (text && text.length > 3) bullets.push(`- ${text}`)
          }
        }
      }
    } else if (cells.length === 1) {
      let text = cells[0]!.getText(' ', true)
      text = cleanHtmlEntities(text)
      text = strip(text.replace(/\s+/g, ' '))
      if (text && BULLET_CHARS.has(text[0]!)) {
        text = strip(text.slice(1))
        if (text) bullets.push(`- ${text}`)
      }
    }
  }

  return bullets.length ? bullets.join('\n\n') : null
}

/** Extract footnote table as 'marker text' format. */
export function extractFootnoteText(tableElem: Tag): string | null {
  const parts: string[] = []
  const rows = tableElem.findAll('tr')

  for (const row of rows) {
    const cells = row.findAll(['td', 'th'])
    const texts: string[] = []
    for (const cell of cells) {
      let text = cell.getText(' ', true)
      text = cleanHtmlEntities(text)
      text = strip(text.replace(/\s+/g, ' '))
      if (text) texts.push(text)
    }

    if (texts.length >= 2) {
      // Join marker with its text
      parts.push(texts.join(' '))
    } else if (texts.length === 1) parts.push(texts[0]!)
  }

  return parts.length ? parts.join('\n\n') : null
}

/**
 * Convert layout tables with multi-line content cells to formatted sections.
 *
 * Detects tables where cells contain multiple block elements (like bullet lists
 * of checkmark items) and converts them to section headers with bullet lists
 * instead of trying to force them into markdown table format.
 *
 * Handles three patterns:
 * 1. Single-column tables with cells containing multiple divs (checkmark lists)
 * 2. Multi-column tables where one column has headers and another has bullet items (same row)
 * 3. Tables with alternating header rows and bullet rows
 */
export function convertLayoutTable(tableElem: Tag, baseUrl = ''): string | null {
  const rows = tableElem.findAll('tr')

  if (rows.length === 0) return null

  // Check if this is a multi-column data table with a header row (not a layout table)
  // Look for a row that has 3+ cells with bold text (indicating a header row)
  for (const row of rows) {
    const cells = row.findAll(['td', 'th'])
    let boldContentCells = 0
    for (const cell of cells) {
      const text = cell.getText('', true)
      if (text && !SKIP_TEXTS3.includes(text)) {
        // Check if this cell has bold text
        const bold = findBold(cell, BOLD_STYLE_STRONG)
        if (bold) boldContentCells++
      }
    }
    // If this row has 3+ bold content cells, it's a real data table header
    if (boldContentCells >= 3) return null // Let regular table processing handle this
  }

  /** Extract bullet items from a cell containing divs with bullets at start. */
  const extractBulletItems = (cell: Tag): string[] => {
    const items: string[] = []
    const divs = cell.findAll('div')
    for (const div of divs) {
      // Skip empty divs
      const divText = div.getText('', true)
      if (!divText || SKIP_TEXTS3.includes(divText)) continue
      // Skip divs that are purely containers of other divs
      if (div.find('div') && div.findAllStrings({ string: true, recursive: false }).length === 0) continue

      // Check if this div starts with a bullet character
      const firstChar = divText ? divText[0]! : ''
      if (BULLET_CHARS.has(firstChar)) {
        // Convert images in this div
        for (const img of div.findAll('img')) img.replaceWith(convertImageToHtml(img, baseUrl))

        let text = div.getText(' ', true)
        text = cleanHtmlEntities(text)
        text = strip(text.replace(/\s+/g, ' '))
        // Remove leading bullet
        if (text && BULLET_CHARS.has(text[0]!)) text = strip(text.slice(1))
        if (text) items.push(text)
      }
    }
    return items
  }

  /**
   * Extract header text and anchor ID, handling multi-line name cells.
   *
   * Returns tuple of (anchor_id, text) where anchor_id may be None.
   */
  const extractHeaderTextOf = (cell: Tag): [string | null, string] => {
    const lines: string[] = []
    let anchorId: string | null = cell.getStr('id') || null

    // Also check nested divs for anchor ID
    if (!anchorId) {
      for (const div of cell.findAll('div')) {
        const divId = div.getStr('id')
        if (divId) {
          anchorId = divId
          break
        }
      }
    }

    // First try to get text from bold elements
    for (const bold of cell.findAll(['b', 'strong'])) {
      let text = bold.getText(' ', true)
      text = strip(text.replace(/\s+/g, ' '))
      if (text && !SKIP_TEXTS.includes(text)) lines.push(text)
    }

    // Also check for font-weight:bold in style
    if (lines.length === 0) {
      const boldStyled = cell.find(null, { attrs: { style: BOLD_STYLE } })
      if (boldStyled) {
        let text = boldStyled.getText(' ', true)
        text = strip(text.replace(/\s+/g, ' '))
        if (text && !SKIP_TEXTS.includes(text)) lines.push(text)
      }
    }

    // If no bold elements, try divs
    if (lines.length === 0) {
      for (const div of cell.findAll('div', { recursive: false })) {
        let text = div.getText(' ', true)
        text = strip(text.replace(/\s+/g, ' '))
        if (text && !SKIP_TEXTS.includes(text)) lines.push(text)
      }
    }

    const text = lines.length ? lines.join(' ') : strip(cell.getText(' ', true))
    return [anchorId, text]
  }

  /** Check if this row contains only header text (bold, no bullets). */
  const isHeaderRow = (row: Tag): boolean => {
    const cells = row.findAll(['td', 'th'])
    let rowText = ''
    let hasBold = false
    let hasBullets = false

    for (const cell of cells) {
      const text = cell.getText('', true)
      if (text && !SKIP_TEXTS.includes(text)) {
        rowText += text
        // Check for bold
        if (findBold(cell)) hasBold = true
        // Check for bullets
        if (extractBulletItems(cell).length) hasBullets = true
      }
    }

    // It's a header row if it has bold text, no bullets, and reasonable length
    return hasBold && !hasBullets && !!rowText && rowText.length < 150
  }

  // ===== PATTERN 0: Bio-style tables with rowspan paragraph cells =====
  // Detect tables that have cells with rowspan containing paragraph content
  // (e.g., director biographies in proxy statements)
  const bioSections: { name: string | null; metadata: string[]; paragraphs: string[] }[] = []
  for (const row of rows) {
    const cells = row.findAll(['td', 'th'])
    for (const cell of cells) {
      const rowspan = pyInt(cell.getStr('rowspan', '1') || '1')
      if (rowspan > 1) {
        // This cell spans multiple rows - check if it has paragraph content
        const cellText = cell.getText('', true)
        // Bio cells typically have 200+ characters of paragraph text
        if (cellText.length > 200) {
          // Found a potential bio cell - extract header from same or nearby rows
          // Look for a bold name cell in an earlier row of this table
          let nameText: string | null = null

          // Search backward through rows for header
          const rowIdx = rows.findIndex((r) => tagEquals(r, row))
          for (let prevIdx = rowIdx - 1; prevIdx >= 0; prevIdx--) {
            const prevRow = rows[prevIdx]!
            const prevCells = prevRow.findAll(['td', 'th'])
            for (const prevCell of prevCells) {
              const prevText = prevCell.getText('', true)
              if (!prevText || SKIP_TEXTS.includes(prevText)) continue
              // Check for bold name
              const bold = findBold(prevCell)
              // A name is typically short, bold, and all caps or title case
              if (bold && prevText.length < 50 && isUpper(prevText)) {
                nameText = prevText
                break
              }
            }
            if (nameText) break
          }

          // Also extract metadata from the same row (title, tenure, age, etc.)
          const metadataItems: string[] = []
          const seenMetadata = new Set<string>()
          for (const otherCell of cells) {
            if (tagEquals(otherCell, cell)) continue
            const otherText = otherCell.getText('', true)
            if (!otherText || SKIP_TEXTS.includes(otherText)) continue
            // Skip if too long (probably another bio)
            if (otherText.length > 150) continue
            // Extract items from divs (direct children only)
            for (const div of otherCell.findAll('div', { recursive: false })) {
              let divText = div.getText('', true)
              divText = cleanHtmlEntities(divText)
              divText = strip(divText.replace(/\s+/g, ' '))
              if (divText && !SKIP_TEXTS3.includes(divText) && !seenMetadata.has(divText)) {
                metadataItems.push(divText)
                seenMetadata.add(divText)
              }
            }
          }

          // Extract bio paragraphs from the cell
          // Only get top-level divs to avoid duplicates from nested divs
          const bioParagraphs: string[] = []
          const seenTexts = new Set<string>()
          for (const div of cell.findAll('div', { recursive: false })) {
            let divText = div.getText('', true)
            divText = cleanHtmlEntities(divText)
            divText = strip(divText.replace(/\s+/g, ' '))
            if (divText && !SKIP_TEXTS3.includes(divText) && divText.length > 20 && !seenTexts.has(divText)) {
              bioParagraphs.push(divText)
              seenTexts.add(divText)
            }
          }

          if (bioParagraphs.length) bioSections.push({ name: nameText, metadata: metadataItems, paragraphs: bioParagraphs })
        }
      }
    }
  }

  // If we found bio sections, format them
  if (bioSections.length) {
    const resultParts: string[] = []
    for (const section of bioSections) {
      if (section.name) resultParts.push(`\n**${section.name}**\n`)
      for (const item of section.metadata) resultParts.push(`- ${item}`)
      if (section.metadata.length) resultParts.push('') // Blank line after metadata
      for (const para of section.paragraphs) {
        resultParts.push(para)
        resultParts.push('') // Blank line after each paragraph
      }
    }
    if (resultParts.length) return resultParts.join('\n')
  }

  // ===== PATTERN 2: Multi-column table with headers and bullet content in SAME row =====
  // Check if this is a table with header column + bullet column
  const resultSections: [string | null, string, string[]][] = []

  for (const row of rows) {
    const cells = row.findAll(['td', 'th'])
    if (cells.length === 0) continue

    // Find cells with content
    let headerCell: Tag | null = null
    let bulletCell: [Tag, string[]] | null = null

    for (const cell of cells) {
      const cellText = cell.getText('', true)
      if (!cellText || SKIP_TEXTS.includes(cellText)) continue

      // Check if this cell contains bullet items
      const bulletItems = extractBulletItems(cell)
      if (bulletItems.length) bulletCell = [cell, bulletItems]
      else {
        // Check if this looks like a header cell (bold, short text)
        const bold = findBold(cell)
        if (bold && cellText.length < 200) headerCell = cell
      }
    }

    if (bulletCell) {
      let headerAnchor: string | null = null
      let headerText = ''
      if (headerCell) [headerAnchor, headerText] = extractHeaderTextOf(headerCell)

      resultSections.push([headerAnchor, headerText, bulletCell[1]])
    }
  }

  // If we found header+bullet sections (same row), format them
  // Only use this pattern if we found headers for at least some rows
  if (resultSections.length) {
    const hasHeaders = resultSections.some(([, h]) => h)
    if (hasHeaders) {
      const resultParts: string[] = []
      for (const [headerAnchor, headerText, bulletItems] of resultSections) {
        if (headerText) {
          if (headerAnchor) resultParts.push(`\n<a id="${headerAnchor}"></a>**${headerText}**\n`)
          else resultParts.push(`\n**${headerText}**\n`)
        }
        for (const item of bulletItems) resultParts.push(`- ${item}`)
        resultParts.push('')
      }

      if (resultParts.length) return resultParts.join('\n')
    }
  }

  // ===== PATTERN 3: Alternating header rows and bullet rows =====
  // Process rows in sequence, building sections
  const sections: [string | null, string, string[]][] = []
  let currentHeader = ''
  let currentAnchor: string | null = null
  let currentBullets: string[] = []

  for (const row of rows) {
    const cells = row.findAll(['td', 'th'])
    if (cells.length === 0) continue

    const rowText = cells.map((c) => c.getText('', true)).join('')
    if (!rowText || SKIP_TEXTS.includes(rowText)) continue

    // Collect all bullet items from this row
    const rowBullets: string[] = []
    for (const cell of cells) rowBullets.push(...extractBulletItems(cell))

    if (rowBullets.length) {
      // This is a bullet row
      currentBullets.push(...rowBullets)
    } else if (isHeaderRow(row)) {
      // This is a header row
      // Save previous section if exists
      if (currentBullets.length) {
        sections.push([currentAnchor, currentHeader, currentBullets])
        currentBullets = []
      }

      // Get header text and anchor from this row
      const headerParts: string[] = []
      currentAnchor = null
      for (const cell of cells) {
        const [anchorId, text] = extractHeaderTextOf(cell)
        if (anchorId && !currentAnchor) currentAnchor = anchorId
        if (text && !SKIP_TEXTS.includes(text)) headerParts.push(text)
      }
      currentHeader = headerParts.join(' ')
    }
  }

  // Don't forget the last section
  if (currentBullets.length) sections.push([currentAnchor, currentHeader, currentBullets])

  // If we found alternating sections, format them
  if (sections.length >= 1) {
    // Verify this looks like a structured document (not just random bullets)
    const totalBullets = sections.reduce((acc, s) => acc + s[2].length, 0)
    if (totalBullets >= 3) {
      const resultParts: string[] = []
      for (const [headerAnchor, headerText, bulletItems] of sections) {
        if (headerText) {
          if (headerAnchor) resultParts.push(`\n<a id="${headerAnchor}"></a>**${headerText}**\n`)
          else resultParts.push(`\n**${headerText}**\n`)
        }
        for (const item of bulletItems) resultParts.push(`- ${item}`)
        resultParts.push('')
      }

      if (resultParts.length) return resultParts.join('\n')
    }
  }

  // ===== PATTERN 1: Single column with multi-div cells (checkmark lists) =====
  // First, find the header row (if any) and content rows
  const headerCells: string[] = []
  const contentCells: string[][] = []

  for (const row of rows) {
    const cells = row.findAll(['td', 'th'])

    // Check if this row looks like a header row
    let isHeader = false
    if (row.find('th')) isHeader = true
    else {
      // Check if cells have bold text and minimal content (header-like)
      for (const cell of cells) {
        const text = cell.getText('', true)
        if (text && text.length < 80) {
          const bold = findBold(cell)
          if (bold) {
            isHeader = true
            break
          }
        }
      }
    }

    if (isHeader && headerCells.length === 0) {
      for (const cell of cells) {
        const text = cell.getText('', true)
        if (text && !SKIP_TEXTS.includes(text)) headerCells.push(text)
      }
    } else {
      // This is a content row - check for multi-line cells
      for (const cell of cells) {
        // Count meaningful divs in this cell
        const contentDivs: Tag[] = []
        for (const div of cell.findAll('div', { recursive: false })) {
          const divText = div.getText('', true)
          if (divText && !SKIP_TEXTS3.includes(divText)) contentDivs.push(div)
        }

        if (contentDivs.length >= 3) {
          // This cell has multiple items - extract them
          const items: string[] = []
          for (const div of contentDivs) {
            // Convert images in this div
            for (const img of div.findAll('img')) img.replaceWith(convertImageToHtml(img, baseUrl))

            let text = div.getText(' ', true)
            text = cleanHtmlEntities(text)
            text = strip(text.replace(/\s+/g, ' '))
            if (text) items.push(text)
          }

          if (items.length) contentCells.push(items)
        }
      }
    }
  }

  // If we didn't find any multi-line content cells, this isn't a layout table
  if (contentCells.length === 0) return null

  // Build the output: pair headers with their content lists
  const resultParts: string[] = []

  contentCells.forEach((items, i) => {
    if (i < headerCells.length) {
      // Add header
      resultParts.push(`\n**${headerCells[i]}**\n`)
    }

    // Add items as bullet list
    for (const item of items) resultParts.push(`- ${item}`)
    resultParts.push('') // Blank line after each section
  })

  if (resultParts.length) return resultParts.join('\n')

  return null
}

/** Extract single-cell header table as markdown header, preserving anchors. */
export function extractHeaderText(tableElem: Tag): string | null {
  const rows = tableElem.findAll('tr')
  for (const row of rows) {
    const cells = row.findAll(['td', 'th'])
    for (const cell of cells) {
      let text = cell.getText('', true)
      if (text) {
        text = cleanHtmlEntities(text)
        text = strip(text.replace(/\s+/g, ' '))

        // Look for anchor id on the cell or nested divs
        let anchorId: string | null = cell.getStr('id') || null
        if (!anchorId) {
          // Check nested divs for id attribute
          for (const div of cell.findAll('div')) {
            const divId = div.getStr('id')
            if (divId) {
              anchorId = divId
              break
            }
          }
        }

        // Return as bold header with anchor if present
        if (anchorId) return `\n<a id="${anchorId}"></a>**${text}**\n`
        return `\n**${text}**\n`
      }
    }
  }
  return null
}

const W = String.raw`[\p{L}\p{N}_]`
const WORD_SUFFIXES = 'MENTS|MENT|TIONS|ATED|TING|NESS|ABLE|IBLE'
const SOFT_HYPHEN_RE = new RegExp(`(${W})- (?!<br>)(${W})`, 'gu')
const HYPHEN_BR_SUFFIX_RE = new RegExp(`(${W})- (?:<br> ?)+(${WORD_SUFFIXES})\\b`, 'gu')
const HYPHEN_BR_RE = new RegExp(`(${W})- (?:<br> ?)+(${W})`, 'gu')
const SPLIT_SUFFIX_RE = new RegExp(`\\b([A-Z]{2,}) (${WORD_SUFFIXES})\\b`, 'g')

/**
 * Extract text from a table cell, preserving links and images as markdown.
 *
 * If preserve_line_breaks is True, detects cells with multiple block elements
 * (like divs with checkmark images) and preserves them as separate lines.
 *
 * Always preserves <br> tags within cells as HTML line breaks.
 */
export function extractCellText(cell: Tag, baseUrl = '', preserveLineBreaks = false): string {
  // Check if this cell contains ONLY a footnote reference (sup tag with a number)
  // These appear in SEC tables as separate cells and should be merged with the label
  const supTags = cell.findAll('sup')
  if (supTags.length) {
    // Get all text content excluding sup tags and invisible content
    let nonSupText = ''
    for (const elem of cell.descendants()) {
      if (elem instanceof NavigableString) {
        let parent: Tag | null = elem.parent
        // Skip text inside sup tags
        let isInSup = false
        while (parent) {
          if (parent.name === 'sup') {
            isInSup = true
            break
          }
          parent = parent.parent
        }
        if (!isInSup) {
          // Not inside a sup tag - check if it's visible text
          const text = strip(elem.text)
          // Skip hidden/invisible content (zero-width spaces, nbsp, etc)
          if (text && !['\u{200b}', '\xa0', ' ', ''].includes(text)) nonSupText += text
        }
      }
    }

    nonSupText = strip(nonSupText)
    if (!nonSupText) {
      // Cell only has sup content - check if it's a footnote reference (small number)
      const supText = supTags.map((sup) => sup.getText('', true)).join(' ')
      // Footnote references are typically 1-3 digit numbers
      if (/^\s*\d{1,3}\s*$/.test(supText)) {
        // Return as superscript HTML - will be merged with previous cell later
        return `<sup>${strip(supText)}</sup>`
      }
    }
  }

  // Work on a copy so we don't mutate the original
  const cellCopy = cell.copy()

  // Convert BR tags to a space so they don't leak as literal "<br>" into markdown.
  // In preserve_line_breaks mode keep a newline marker instead.
  for (const br of cellCopy.findAll('br')) br.replaceWith(!preserveLineBreaks ? ' ' : '\n')

  // Check if this cell has multiple block-level divs with content (like bullet lists)
  // This detects layout cells that should NOT be flattened
  const contentDivs: Tag[] = []
  for (const div of cellCopy.findAll('div', { recursive: false })) {
    const divText = div.getText('', true)
    // Skip empty divs and spacer divs (just nbsp)
    if (divText && !SKIP_TEXTS3.includes(divText)) contentDivs.push(div)
  }

  // If cell has 3+ content divs, treat as multi-line content
  if (preserveLineBreaks && contentDivs.length >= 3) {
    const lines: string[] = []
    for (const div of contentDivs) {
      // Convert images in this div
      for (const img of div.findAll('img')) img.replaceWith(convertImageToHtml(img, baseUrl))
      // Convert links in this div
      for (const a of div.findAll('a')) {
        let href = a.getStr('href', '')
        const linkText = a.getText('', true)
        if (href && linkText) {
          if (baseUrl && !(href.startsWith('#') || href.startsWith('http://') || href.startsWith('https://'))) href = urljoin(baseUrl, href)
          a.replaceWith(`[${linkText}](${href})`)
        } else if (linkText) a.replaceWith(linkText)
      }

      let text = div.getText(' ', true)
      text = cleanHtmlEntities(text)
      text = strip(text.replace(/\s+/g, ' '))
      if (text) lines.push(text)
    }

    if (lines.length) {
      // Return with special marker for multi-line cells
      return lines.join('\n')
    }
  }

  // Standard single-line extraction
  // Convert links to markdown format
  for (const a of cellCopy.findAll('a')) {
    let href = a.getStr('href', '')
    const linkText = a.getText('', true)
    if (href && linkText) {
      if (baseUrl && !(href.startsWith('#') || href.startsWith('http://') || href.startsWith('https://'))) href = urljoin(baseUrl, href)
      a.replaceWith(`[${linkText}](${href})`)
    } else if (linkText) a.replaceWith(linkText)
  }

  // Strip images from table cells — SEC filings use <img> for decorative
  // elements (brackets, braces, spacers) that have no textual meaning.
  // Use the alt attribute only if it carries actual content (not the generic
  // "Image" placeholder that BeautifulSoup/browsers supply by default).
  for (const img of cellCopy.findAll('img')) {
    const alt = strip(img.getStr('alt', ''))
    img.replaceWith(alt && !['image', 'img', ''].includes(alt.toLowerCase()) ? alt : '')
  }

  // Get text with space separator
  let text = cellCopy.getText(' ', true)
  text = cleanHtmlEntities(text)
  text = strip(text.replace(/\s+/g, ' '))
  // Common word-fragment suffixes that indicate a broken word, not a compound
  // Rejoin words broken by line wrapping in narrow HTML columns
  // Pattern 1: "ADJUST- MENTS" → "ADJUSTMENTS" (soft hyphen, no <br>)
  text = text.replace(SOFT_HYPHEN_RE, '$1$2')
  // Pattern 2a: "ADJUST- <br> MENTS" → "ADJUSTMENTS" (word-break hyphen + br)
  // When the continuation is a word fragment (suffix), remove the hyphen
  text = text.replace(HYPHEN_BR_SUFFIX_RE, '$1$2')
  // Pattern 2b: "PERCENTAGE- <br> POINT" → "PERCENTAGE-POINT" (compound + br)
  // When the continuation is a full word, keep the hyphen
  text = text.replace(HYPHEN_BR_RE, '$1-$2')
  // Pattern 3: "ADJUST MENTS" → "ADJUSTMENTS" (space from word-wrap in source)
  text = text.replace(SPLIT_SUFFIX_RE, '$1$2')
  // Normalize <br> spacing: " <br> " → "<br>"
  text = text.replace(/\s*<br>\s*/g, '<br>')
  return text
}

/** Clean common HTML entities. */
export function cleanHtmlEntities(text: string): string {
  const replacements: [string, string][] = [
    ['&nbsp;', ' '],
    ['&amp;', '&'],
    ['&lt;', '<'],
    ['&gt;', '>'],
    ['&quot;', '"'],
    ['&#39;', "'"],
    ['&apos;', "'"],
    ['&#149;', '\u{2022}'],
    ['&#160;', ' '],
    ['\xa0', ' '],
    ['\u{200b}', ''],
    ['\u{d8}', '\u{2022}'],
  ]

  for (const [entity, replacement] of replacements) text = text.replaceAll(entity, replacement)

  return text
}
