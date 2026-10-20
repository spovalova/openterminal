// html2markdown: HTML table → markdown table, provider sec. Ported from openbb_sec/utils/html2markdown.py lines
// 3685-5132 (`_extract_chart_legend`, `_split_composite_table`, `_make_sub_table`, `convert_table`) (OpenBB Platform
// 5.0.0, Apache-2.0); modified: bs4 → ./soup.ts.
import { extractPeriodsFromRows } from './extract-periods.js'
import { Tag } from './soup.js'
import {
  BULLET_CHARS,
  cleanTableCells,
  collapseRepeatedHeaders,
  detectAndMergeMultiindexHeaders,
  isDataRowHeader,
  isEquityStatementTable,
  mergeSplitCells,
  mergeSplitRows,
  normalizeFinancialRows,
  parseRowSemantic,
  processEquityStatementTable,
  pyInt,
  removeEmptyColumns,
  stripAll,
  type Cells,
  type RowsWithColspan,
} from './table-clean.js'
import { classifyTable, convertLayoutTable, extractBulletList, extractCellText, extractFootnoteText, extractHeaderText } from './layout-tables.js'
import { hasDigit, isUpper, split, strip } from './py.js'

const raw = String.raw

// ── Chart-legend helper ─────────────────────────────────────────────
const LEGEND_BG_RE = /background-color:\s*(#[0-9a-fA-F]{6})/

/**
 * Detect a chart-legend table and return an inline legend string.
 *
 * SEC filings embed bar/pie charts as ``<img>`` tags followed by
 * small HTML tables that use tiny coloured ``<td>`` cells as colour
 * swatches paired with label text (typically font-family 'Gotham
 * Narrow Book', font-size ~5 pt, rows of height ~3 pt).
 *
 * The standard table converter turns these into single-column
 * markdown tables like::
 *
 *     | Affiliates |
 *     |---|
 *     | Europe |
 *
 * This helper detects the pattern and emits a more useful format
 * that preserves the colour-to-label mapping so the chart can be
 * interpreted::
 *
 *     **Legend:** ■ (#009dd9) United States · ■ (#0b2d71) Other Americas · …
 *
 * Returns ``null`` if the table is *not* a chart legend.
 */
export function extractChartLegend(table: Tag): string | null {
  const rows = table.findAll('tr')
  if (rows.length === 0 || rows.length > 30) return null

  // Quick pre-check: reject tables that look like financial data.
  // Real chart legends never contain numeric data, dollar signs,
  // parenthesised negatives, or percentage values in their cells.
  const dataCellRe = /(?:^\s*[-\u{2014}]?\s*\$|\d[\d,]+\.\d|^\s*\(\s*\d|\d\s*%\s*$|^\s*\d{4}\s*$)/u
  let dataCellCount = 0
  for (const row of rows) {
    for (const td of row.findAll('td')) {
      const cellText = td.getText('', true)
      if (cellText && dataCellRe.test(cellText)) dataCellCount++
    }
  }
  if (dataCellCount >= 2) return null

  // Chart-legend tables use tiny coloured cells as colour swatches.
  // A "swatch cell" MUST be a cell whose ONLY purpose is to show
  // a background colour — it must have NO text content (or at most
  // a single non-breaking space).  Cells that combine colour with
  // text are header/data cells, NOT swatches.
  //
  // Additionally, swatch cells should be physically small (height
  // ≤ 8px or width ≤ 30px via inline style).
  const heightRe = /height:\s*(\d+(?:\.\d+)?)\s*(?:px|pt)/i
  const widthRe = /width:\s*(\d+(?:\.\d+)?)\s*(?:px|pt)/i
  let swatchCount = 0
  const allLabels: string[] = []
  const allColors: string[] = []
  // Track how many rows have non-empty text in > 2 columns — a sign
  // this is a real data table, not a legend.
  let multiColTextRows = 0

  for (const row of rows) {
    const tds = row.findAll('td')
    let rowColor: string | null = null
    let rowLabel: string | null = null
    let textCellCount = 0
    for (const td of tds) {
      const style = td.getStr('style', '') || ''
      const bg = LEGEND_BG_RE.exec(style)
      const cellText = td.getText('', true)

      // A swatch cell: has background-color, is NOT white,
      // and has NO meaningful text content.
      if (bg && !['#ffffff', '#fff'].includes(bg[1]!.toLowerCase()) && !cellText) {
        // Check for small dimensions (strong swatch signal)
        const hM = heightRe.exec(style)
        const wM = widthRe.exec(style)
        const isTiny = (hM && parseFloat(hM[1]!) <= 8) || (wM && parseFloat(wM[1]!) <= 30)
        if (isTiny) {
          rowColor = bg[1]!
          swatchCount++
        } else {
          // Empty cell with colour but not tiny — could
          // still be a swatch if no dimension is specified
          // (some legends omit explicit sizes).  Count it
          // but don't bump swatch_count (only truly tiny
          // cells are confident swatch detections).
          rowColor = bg[1]!
        }
        // Cell has BOTH colour and text → NOT a swatch.
        // This is typically a header or data cell with shading.
      }

      if (cellText && cellText.length < 80) {
        rowLabel = cellText
        textCellCount++
      }
    }

    if (textCellCount > 2) multiColTextRows++
    if (rowColor && !rowLabel) allColors.push(rowColor)
    else if (rowLabel && !rowColor) allLabels.push(rowLabel)
    else if (rowColor && rowLabel) {
      // Both in one row — paired directly
      allColors.push(rowColor)
      allLabels.push(rowLabel)
    }
  }

  // If many rows have text in 3+ columns, this is a data table.
  if (multiColTextRows >= 2) return null

  // Require enough CONFIDENT swatch detections (tiny empty colour
  // cells) and at least two labels.
  if (swatchCount < 2 || allLabels.length < 2) return null

  // Labels should be category names, NOT numbers/years/percentages.
  const numericLabelRe = /^\s*[\d,.%$\u{20ac}\u{a3}()\-\u{2014}]+\s*$/u
  const nonNumericLabels = allLabels.filter((lab) => !numericLabelRe.test(lab))
  if (nonNumericLabels.length < 2) return null

  // Final sanity: the raw text of the whole table should be short
  // (legends are just a handful of category names).
  const fullText = table.getText('', true)
  if (fullText.length > 500) return null

  // Pair colours and labels.  The HTML structure typically puts the
  // label row immediately before its colour swatch row, so
  // all_labels[i] corresponds to all_colors[i].
  // Only include labels that have a paired colour swatch.
  // Unpaired labels (more labels than colours) are typically chart
  // titles/descriptions embedded in the legend table — omit them.
  const nPairs = Math.min(nonNumericLabels.length, allColors.length)
  if (nPairs < 2) return null

  // Build an HTML legend with actual CSS-styled colour swatches.
  // Using background-color on inline-block spans is the most reliable
  // way to render coloured boxes across markdown renderers.
  const swatch = (color: string): string => `<span style="display:inline-block;width:12px;height:12px;background:${color};vertical-align:middle;border-radius:2px"></span>`
  const items: string[] = []
  for (let idx = 0; idx < nPairs; idx++) {
    const box = swatch(allColors[idx]!)
    items.push(`${box} ${nonNumericLabels[idx]}`)
  }

  const legendBody = items.join(' &nbsp;&middot;&nbsp; ')
  return `<div style="margin:4px 0;font-size:0.9em"><b>Legend:</b> ${legendBody}</div>`
}

// ── Table-title pattern for composite-table splitting ──────────────
const TABLE_TITLE_RE = /^TABLE\s+\d+/i

/**
 * Split a single <table> that contains multiple sub-tables.
 *
 * Certent CDM and similar absolute-position SEC filings often group
 * several logical tables (e.g. TABLE 5, TABLE 6, TABLE 7) plus
 * connecting body-text paragraphs into **one** horizontal-rule zone,
 * so ``_build_table_from_zone`` emits a single ``<table>`` for the
 * whole lot.
 *
 * This function detects "TABLE X:" header rows and splits the
 * original table element into a list of BS4 ``<table>`` elements (and
 * plain-text string fragments for body-text sections) ready for
 * independent conversion.
 */
export function splitCompositeTable(table: Tag): (Tag | string)[] {
  const allRows = table.findAll('tr')
  if (allRows.length < 4) return [table]

  // Find rows whose first cell matches "TABLE X: …"
  const splitIndices: number[] = []
  allRows.forEach((row, idx) => {
    const cells = row.findAll(['td', 'th'])
    if (cells.length === 0) return
    const firstText = cells[0]!.getText('', true)
    if (TABLE_TITLE_RE.test(firstText)) splitIndices.push(idx)
  })

  // Need at least 2 sub-table headers to justify splitting
  if (splitIndices.length < 2) return [table]

  // Helper: detect if a row-set is purely body text
  // (all data in column 0, rest empty)
  const isBodyTextSection = (rows: Tag[]): boolean => {
    if (rows.length === 0) return true
    for (const row of rows) {
      const cells = row.findAll(['td', 'th'])
      // Check if any cell beyond the first has content
      if (cells.slice(1).some((c) => c.getText('', true))) return false
    }
    return true
  }

  // Build segments: each segment is a slice of rows
  // Segments between TABLE headers that are all single-cell → body text
  // TABLE header row + data rows after it → sub-table
  const parts: (Tag | string)[] = []

  // Rows before the first TABLE header (belong to whatever table was at top)
  if (splitIndices[0]! > 0) {
    const preRows = allRows.slice(0, splitIndices[0])
    // Check if there's a "TABLE X:" in the very first rows
    // If so, this is the main table data; otherwise check for body text
    parts.push(makeSubTable(preRows, table))
  }

  for (let si = 0; si < splitIndices.length; si++) {
    const start = splitIndices[si]!
    const end = si + 1 < splitIndices.length ? splitIndices[si + 1]! : allRows.length

    // Find where body text starts between this and next TABLE header
    // The sub-table continues until rows become single-cell body text
    const subRows = allRows.slice(start, end)

    // Within this slice, find where the data rows end and body text begins
    // Body text: every cell after col 0 is empty AND text is long (>60 chars),
    // OR an all-caps heading followed by body text paragraphs.
    let dataEnd = subRows.length
    for (let ri = 1; ri < subRows.length; ri++) {
      const row = subRows[ri]!
      const cells = row.findAll(['td', 'th'])
      const first = cells.length ? cells[0]!.getText('', true) : ''
      const restEmpty = !cells.slice(1).some((c) => c.getText('', true))
      if (!restEmpty || !first) continue
      if (TABLE_TITLE_RE.test(first)) continue

      // Long body text paragraph
      let isBodyStart = first.length > 60
      // Or: all-caps section heading followed by body text
      if (!isBodyStart && isUpper(first) && first.length > 5) {
        // Check if the NEXT row is long body text
        const ni = ri + 1
        if (ni < subRows.length) {
          const ncells = subRows[ni]!.findAll(['td', 'th'])
          const nfirst = ncells.length ? ncells[0]!.getText('', true) : ''
          const nrest = !ncells.slice(1).some((c) => c.getText('', true))
          if (nrest && nfirst.length > 60) isBodyStart = true
        }
      }

      if (isBodyStart) {
        const remaining = subRows.slice(ri)
        if (isBodyTextSection(remaining)) {
          dataEnd = ri
          break
        }
      }
    }

    // Table data part
    const tableRows = subRows.slice(0, dataEnd)
    if (tableRows.length) parts.push(makeSubTable(tableRows, table))

    // Body text part
    if (dataEnd < subRows.length) {
      const bodyRows = subRows.slice(dataEnd)
      const bodyText = bodyRows
        .filter((row) => {
          const cells = row.findAll(['td', 'th'])
          return cells.length > 0 && !!cells[0]!.getText('', true)
        })
        .map((row) => row.findAll(['td', 'th'])[0]!.getText('', true))
        .join('\n')
      if (strip(bodyText)) parts.push(bodyText)
    }
  }

  return parts
}

/** Create a new <table> element from a subset of rows. */
export function makeSubTable(rows: Tag[], originalTable: Tag): Tag {
  const newTable = new Tag('table')
  // Copy attributes from original
  for (const [attr, val] of originalTable.attrs) newTable.set(attr, Array.isArray(val) ? [...val] : val)
  for (const row of rows) newTable.append(row.copy())
  return newTable
}

const CURRENCY_PREFIXES = new Set(['$', '$(', '($', '$-', '\u{20ac}', '\u{20ac}(', '(\u{20ac}', '\u{20ac}-', '\u{a3}', '\u{a3}(', '(\u{a3}', '\u{a3}-'])

const NUM_RE = /^\(?\s*[\d,]+\.?\d*\s*\)?%?$/

const VAL_RE = /^[+-]?[$\u{20ac}]?\s*\(?[$\u{20ac}]?\s*[\d,]+\.?\d*\s*\)?\s*[*%]*(pts)?$/u
const DASH_VALS = new Set(['\u{2014}', '\u{2013}', '-', '$\u{2014}', '$\u{2013}', '$-', '\u{20ac}\u{2014}', '\u{20ac}\u{2013}', '\u{20ac}-', 'N/A', 'n/a', 'NM', 'nm'])
const DATA_CELL_VALS = new Set([
  '\u{2014}',
  '\u{2013}',
  '-',
  '$\u{2014}',
  '$\u{2013}',
  '$-',
  '$ \u{2014}',
  '$ \u{2013}',
  '$ -',
  '\u{20ac}\u{2014}',
  '\u{20ac}\u{2013}',
  '\u{20ac}-',
  '\u{2014}%',
  '\u{2013}%',
  '-%',
  '\u{2014} %',
  '\u{2013} %',
  '- %',
  'N/A',
  'n/a',
  'NM',
  'nm',
])

const FINANCIAL_HEADER_TERMS = [
  raw`\bshares?\b`,
  raw`\bprice\b`,
  raw`\bvalue\b`,
  raw`\bterm\b`,
  raw`\bexercise\b`,
  raw`\bgranted?\b`,
  raw`\bvested\b`,
  raw`\bforfeited?\b`,
  raw`\b(?:thousands?|millions?|billions?)\b`,
  raw`\bper\s+share\b`,
  raw`\baggregate\b`,
  raw`\bintrinsic\b`,
  raw`\bcontractual\b`,
  raw`\bremaining\b`,
  raw`\bweighted[-\s]?average\b`,
  raw`\bexercisable\b`,
  raw`\bAmount\b`,
  raw`\bCredit\b`,
  raw`\bDebit\b`,
  raw`\bBalance\b`,
  raw`\bReceivables?\b`,
  raw`\bLeases?\b`,
  raw`\bFinancing\b`,
  raw`\bWholesale\b`,
  // Maturity / time-duration bucket labels
  raw`\bmonths?\b`,
  raw`\byears?\b`,
  raw`\bor\s+greater\b`,
  raw`\bmaturity\b`,
].map((t) => new RegExp(t, 'i'))

const MATURITY_BUCKET_RE = new RegExp(
  raw`^\s*(` + raw`\d+\s*[-\u{2013}\u{2014}]\s*(\d+|\w+)\s*(months?|years?)` + raw`|\d+\s+(months?|years?)(\s+or\s+(greater|more|less))?` + raw`|less\s+than\s+\d+` + raw`|or\s+(greater|more|less)` + raw`|n/?a` + raw`|total` + raw`|thereafter` + raw`)\s*$`,
  'iu',
)

/** Wrap rows in the markdown pipe-table lines (separator after the first row only). */
function pipeTable(data: Cells[], maxCols: number, headerBrRows: number): string {
  const lines: string[] = []
  data.forEach((row, i) => {
    while (row.length < maxCols) row.push('')
    // Ensure no cell contains newlines
    const cleanRow: string[] = []
    for (const cell of row) {
      // Replace any newlines with space
      let cleanCell = cell.replace(/[\r\n]+/g, ' ')
      // Remove <br>/<BR> tags from header cells (first few rows)
      // This handles multi-row headers where row 1 also has column names
      if (i < Math.max(headerBrRows, 2)) cleanCell = cleanCell.replace(/<[Bb][Rr]\s*\/?>/g, ' ')
      // Collapse multiple spaces
      cleanCell = strip(cleanCell.replace(/ +/g, ' '))
      cleanRow.push(cleanCell)
    }
    lines.push('| ' + cleanRow.join(' | ') + ' |')
    // Add separator after the first header row only — this is standard markdown.
    // Additional header layers (Layer 1, Layer 2...) render as normal rows below
    // the separator, acting as visual sub-headers.
    if (i === 0) lines.push('|' + Array.from({ length: maxCols }, () => '---').join('|') + '|')
  })
  return lines.join('\n')
}

/**
 * Convert HTML table to markdown table or text.
 *
 * Uses a single classification to determine table type:
 * - BULLET: Tables with bullet chars in first column → bullet list
 * - FOOTNOTE: Tables with (1), (a), * markers → "marker text" format
 * - HEADER: Single-cell tables with section titles → markdown header
 * - LAYOUT: Tables with multi-line content cells → section headers + bullet lists
 * - DATA: Everything else → markdown table (the default)
 */
export function convertTable(table: Tag, baseUrl = ''): string {
  // ── Chart-legend detection ──────────────────────────────────────
  // SEC filings embed bar / pie charts as <img> tags with adjacent
  // HTML tables that use tiny coloured cells as colour swatches
  // paired with label text (font-family: 'Gotham Narrow Book' /
  // similar, font-size ~5pt, rows of height 3pt).  The standard
  // table converter turns these into useless single-column markdown
  // tables.  Detect them early and emit a compact inline legend.
  const legend = extractChartLegend(table)
  if (legend !== null) return legend

  // Classify the table
  const tableType = classifyTable(table)

  if (tableType === 'BULLET') {
    const result = extractBulletList(table)
    if (result) return result
  } else if (tableType === 'FOOTNOTE') {
    const result = extractFootnoteText(table)
    if (result) return result
  } else if (tableType === 'HEADER') {
    const result = extractHeaderText(table)
    if (result) return result
  }

  // For LAYOUT-classified tables (or unhandled types), try layout conversion.
  // Skip for DATA tables — they should always go through the data-table path.
  if (tableType !== 'DATA') {
    const layoutResult = convertLayoutTable(table, baseUrl)
    if (layoutResult) return layoutResult
  }

  // Default: process as data table (markdown table format)
  const rows = table.findAll('tr')
  if (rows.length === 0) return ''

  // Shared state: when year sub-headers start at position 0 (label
  // column), build_column_headers_from_colspan computes the offset
  // needed to align year positions with data-column positions.  The
  // semantic extraction code reads this to apply the same shift.
  const yearPosShift = [0] // mutable container so nested functions can write

  // First pass: Extract all rows WITHOUT merge/shift
  // We need to identify $ positions across all rows first
  const rawExtractedRows: Cells[] = []
  const rawExtractedColspans: RowsWithColspan = []
  const rawRowHasTh: boolean[] = [] // Track whether each row has <th> elements

  // Track grid positions occupied by cells with rowspan > 1 from
  // earlier rows.  Maps grid_col -> remaining row count.
  let rowspanGrid = new Map<number, number>()

  for (const row of rows) {
    const cells = row.findAll(['td', 'th'])
    const rowData: string[] = []
    const rowWithColspan: [string, number][] = [] // (text, colspan) pairs
    const hasTh = cells.some((cell) => cell.name === 'th')

    let gridCol = 0
    let cellIdx = 0
    while (cellIdx < cells.length) {
      // Insert empty placeholders for positions occupied by
      // rowspan from earlier rows before placing the current cell.
      while (rowspanGrid.has(gridCol)) {
        rowData.push('')
        rowWithColspan.push(['', 1])
        gridCol++
      }

      const cell = cells[cellIdx]!

      // Check for id attribute on cell - emit anchor if present
      const cellId = cell.getStr('id', '')
      let anchorPrefix = ''
      if (cellId) anchorPrefix = `<a id="${cellId}"></a>`

      // For table cells, extract text while preserving links
      // but without the full recursive processing that introduces newlines
      let text = extractCellText(cell, baseUrl)

      // Clean up text - remove zero-width spaces and normalize whitespace
      text = text.replaceAll('\u{200b}', '')
      text = text.replaceAll('\xa0', ' ') // Non-breaking space
      text = text.replace(/\s+/g, ' ')
      text = strip(text)
      text = text.replaceAll('|', '\\|') // Escape pipes
      // Prepend anchor if cell had an id
      if (anchorPrefix) text = anchorPrefix + text

      // Handle colspan and rowspan
      const colspan = pyInt(cell.getStr('colspan', '1') || '1')
      const rowspan = pyInt(cell.getStr('rowspan', '1') || '1')

      rowData.push(text)
      rowWithColspan.push([text, colspan])

      // Register this cell's grid positions for future rows
      if (rowspan > 1) for (let c = 0; c < colspan; c++) rowspanGrid.set(gridCol + c, rowspan)

      for (let k = 0; k < colspan - 1; k++) rowData.push('')

      gridCol += colspan
      cellIdx++
    }

    // Fill any trailing positions still occupied by rowspan
    while (rowspanGrid.has(gridCol)) {
      rowData.push('')
      rowWithColspan.push(['', 1])
      gridCol++
    }

    rawExtractedRows.push(rowData)
    rawExtractedColspans.push(rowWithColspan)
    rawRowHasTh.push(hasTh)

    // Decrement rowspan counts; drop positions that have expired.
    const next = new Map<number, number>()
    for (const [pos, rem] of rowspanGrid) if (rem > 1) next.set(pos, rem - 1)
    rowspanGrid = next
  }

  // Identify positions that have currency prefixes ($, €, £) in ANY row.
  // These are the only positions where "empty + numeric" shift should apply.
  const dollarPositions = new Set<number>()
  for (const rowData of rawExtractedRows) {
    rowData.forEach((cell, i) => {
      if (CURRENCY_PREFIXES.has(stripAll(cell))) dollarPositions.add(i)
    })
  }

  // Extract all rows, preserving colspan info for headers
  let data: Cells[] = []
  let rawRowsWithColspan: RowsWithColspan = [] // For header detection - stores (text, colspan) pairs
  const rowHasThFlags: boolean[] = [] // Track which rows have <th> elements
  for (let rowIdx = 0; rowIdx < rawExtractedRows.length; rowIdx++) {
    let rowData = rawExtractedRows[rowIdx]!
    let rowWithColspan = rawExtractedColspans[rowIdx]!
    const hasTh = rawRowHasTh[rowIdx]!
    // Merge currency prefix cells with their following value cells.
    // SEC tables often have $ in one cell and the number in the next.
    // 20-F filings frequently use € with colspan=3, placing the number
    // up to 3 positions away after empty expansion cells.
    const mergedRow: string[] = []
    const mergedRowWithColspan: [string, number][] = []
    let i = 0
    while (i < rowData.length) {
      const cell = stripAll(rowData[i]!)
      // Check if this is a currency prefix cell ($, €, £, etc.)
      if (CURRENCY_PREFIXES.has(cell) && i + 1 < rowData.length) {
        // Look ahead up to 3 positions for the number
        // (currency cell may have colspan>1 producing empty gaps)
        let foundOffset: number | null = null
        for (let look = 1; look < Math.min(4, rowData.length - i); look++) {
          const ahead = stripAll(rowData[i + look]!)
          if (ahead && NUM_RE.test(ahead)) {
            foundOffset = look
            break
          }
          if (ahead) break // non-empty non-numeric → stop
        }
        if (foundOffset !== null) {
          const mergedVal = cell + stripAll(rowData[i + foundOffset]!)
          mergedRow.push(mergedVal)
          // Add empty placeholders for all consumed cells
          for (let k = 0; k < foundOffset; k++) mergedRow.push('')
          // Preserve colspan tracking for all consumed cells
          for (let j = 0; j < foundOffset + 1; j++) if (i + j < rowWithColspan.length) mergedRowWithColspan.push(rowWithColspan[i + j]!)
          i += foundOffset + 1
          continue
        }
      }
      // Handle rows WITHOUT currency prefix: empty cell followed by
      // a numeric value.  Secondary data rows may omit the currency
      // symbol shown on the first row.  Shift the value to the
      // currency position to keep alignment.  Also use look-ahead
      // (up to 3 cells) for €-style tables with colspan>1 gaps.
      else if (cell === '' && i + 1 < rowData.length && dollarPositions.has(i)) {
        let foundOffset2: number | null = null
        for (let look2 = 1; look2 < Math.min(4, rowData.length - i); look2++) {
          const ahead2 = stripAll(rowData[i + look2]!)
          if (ahead2 && NUM_RE.test(ahead2)) {
            foundOffset2 = look2
            break
          }
          if (ahead2) break
        }
        if (foundOffset2 !== null) {
          mergedRow.push(stripAll(rowData[i + foundOffset2]!))
          for (let k = 0; k < foundOffset2; k++) mergedRow.push('')
          for (let j = 0; j < foundOffset2 + 1; j++) if (i + j < rowWithColspan.length) mergedRowWithColspan.push(rowWithColspan[i + j]!)
          i += foundOffset2 + 1
          continue
        }
      }
      mergedRow.push(rowData[i]!)
      if (i < rowWithColspan.length) mergedRowWithColspan.push(rowWithColspan[i]!)
      i++
    }

    rowData = mergedRow
    rowWithColspan = mergedRowWithColspan

    // Merge footnote cells with the ROW LABEL (first non-empty cell)
    // SEC tables have footnote markers like <sup>12</sup> in their own cells
    // These belong on the label, not on data values
    const footnoteMergedRow: string[] = []
    const collectedFootnotes: string[] = []
    let labelIndex = -1 // Track which cell is the row label

    for (const cellText of rowData) {
      // Check if this cell is ONLY a superscript footnote
      if (/^\s*<sup>\d{1,3}<\/sup>\s*$/.test(cellText)) {
        // Collect footnotes to append to label later
        collectedFootnotes.push(cellText)
      } else {
        footnoteMergedRow.push(cellText)
        // First non-empty cell is the label
        if (labelIndex === -1 && strip(cellText)) labelIndex = footnoteMergedRow.length - 1
      }
    }

    // Append all collected footnotes to the row label
    if (collectedFootnotes.length && labelIndex >= 0) footnoteMergedRow[labelIndex] = footnoteMergedRow[labelIndex]! + collectedFootnotes.join('')

    rowData = footnoteMergedRow

    if (rowData.some((c) => c)) {
      // Skip empty rows
      data.push(rowData)
      rawRowsWithColspan.push(rowWithColspan)
      rowHasThFlags.push(hasTh)
    }
  }

  if (data.length === 0) return ''

  // Filter out page footer tables
  if (data.length <= 2) {
    const nonEmpty = data[0]!.filter((c) => strip(c))
    if (nonEmpty.length === 2) {
      const firstCell = strip(nonEmpty[0]!)
      const secondCell = strip(nonEmpty[1]!)
      const firstLower = firstCell.toLowerCase()
      const secondLower = secondCell.toLowerCase()
      const formKeywords = ['form 10-', '10-k', '10-q', 'annual report']
      if ((/^\p{Nd}+$/u.test(firstCell) && formKeywords.some((kw) => secondLower.includes(kw))) || (/^\p{Nd}+$/u.test(secondCell) && formKeywords.some((kw) => firstLower.includes(kw)))) {
        return '' // Skip page footer
      }
    }
  }

  // Check if this is a section header table (single cell with TOC anchor)
  // Header like: <td id="toc..."><div style="font-weight:bold">Section Title</div></td>
  if (data.length === 1 && data[0]!.filter((c) => strip(c)).length === 1) {
    const cellText = data[0]!.filter((c) => strip(c))[0]!
    // Check if it has a TOC anchor
    if (cellText.includes('<a id="toc') || cellText.includes('<a id="TOC')) {
      // Extract the text after the anchor
      const textMatch = /<\/a>(.*)/.exec(cellText)
      const anchorMatch = /(<a id="[^"]+"><\/a>)/.exec(cellText)
      if (textMatch && anchorMatch) {
        const anchor = anchorMatch[1]!
        const headerText = strip(textMatch[1]!)
        if (headerText) return `\n\n${anchor}\n\n### ${headerText}\n\n`
      }
    }
  }

  // Check if this is a bullet-list layout table
  // Must have actual bullet characters, not just empty cells
  let isBulletList = false
  const bulletItems: string[] = []
  for (const row of data) {
    const nonEmpty = row.filter((c) => strip(c))
    if (nonEmpty.length === 2 && BULLET_CHARS.has(nonEmpty[0]!)) {
      // Actual bullet + text pattern
      bulletItems.push(nonEmpty[1]!)
      isBulletList = true
    } else if (nonEmpty.length === 1 && isBulletList) {
      // Continuation of bullet list (single items after we've seen bullets)
      bulletItems.push(nonEmpty[0]!)
    } else if (nonEmpty.length >= 1 && !isBulletList) {
      // Single row with content but not a bullet pattern
      // Join all non-empty cells as text (preserves both image and text)
      if (data.length === 1) return nonEmpty.join(' ')
      break
    } else {
      isBulletList = false
      break
    }
  }

  if (isBulletList && bulletItems.length) return bulletItems.map((item) => `- ${item}`).join('\n')

  // Normalize column count
  let maxCols = Math.max(...data.map((row) => row.length))
  for (const row of data) while (row.length < maxCols) row.push('')

  // Clean up financial table formatting

  data = cleanTableCells(data)

  // Normalize financial values to compact format.
  // SEC filings use spacer elements between $ signs, parentheses, and
  // numbers, producing inconsistent formats like "$ 1,787" vs "$1,787"
  // or "( 135 )" vs "(135)".  Normalize everything to compact form.
  data = normalizeFinancialRows(data)

  // Merge consecutive rows that contain split text (e.g., "(in millions, except per" + "share amounts)")
  // This happens when HTML has multi-line text split across separate TR elements

  ;[data, rawRowsWithColspan] = mergeSplitRows(data, rawRowsWithColspan)

  // Merge cells that contain split values within each row
  // Old SEC HTML often splits negative numbers like "(306" and ")" across cells
  // and puts footnote markers like "(1)" in separate cells

  data = mergeSplitCells(data)

  // Normalize column count after cleaning
  if (data.length) {
    maxCols = Math.max(...data.map((row) => row.length))
    for (const row of data) while (row.length < maxCols) row.push('')
  }

  // Remove columns that are completely empty

  // Step 1: Extract period headers from header rows

  // Step 2: Parse each row semantically - first text is label, numbers are values

  // Detect multi-level headers directly from DATA (not raw_rows_with_colspan)
  // This handles SEC tables where categories are stacked vertically:
  //   Row: EQUIPMENT | FINANCIAL | | | ...
  //   Row: OPERATIONS | SERVICES | ELIMINATIONS | CONSOLIDATED | ...
  //   Row: 2025 | 2024 | 2023 | 2025 | 2024 | 2023 | ...

  // Try to detect multi-index headers from data
  const multiindexResult = detectAndMergeMultiindexHeaders(data)

  let headerLayers: string[][]
  let numPeriods: number
  let isFinancialPeriods: boolean
  let headerRowCount: number
  if (multiindexResult[0] && multiindexResult[0].length >= 1) {
    headerLayers = multiindexResult[0]
    const dataStartIdx = multiindexResult[1]
    numPeriods = multiindexResult[2]
    isFinancialPeriods = true
    headerRowCount = dataStartIdx
  } else {
    // Fall back to original approach
    let extractedHeaderCount: number
    ;[headerLayers, extractedHeaderCount] = extractPeriodsFromRows(rawRowsWithColspan, rowHasThFlags, yearPosShift)

    numPeriods = 0

    if (headerLayers.length) {
      // Count columns that have content in ANY header layer, but
      // collapse adjacent positions with identical composite text
      // (from colspan expansion).  E.g., "2025" at positions 3,4,5
      // from a cs=3 header counts as ONE period, not three.
      const maxHeaderCols = Math.max(...headerLayers.map((layer) => layer.length))
      numPeriods = 0
      let prevKey: string | null = null
      for (let colIdx = 1; colIdx < maxHeaderCols; colIdx++) {
        // Skip first col (label)
        const keyParts: string[] = []
        let hasContent = false
        for (const layer of headerLayers) {
          const text = colIdx < layer.length ? strip(layer[colIdx]!) : ''
          keyParts.push(text)
          if (text) hasContent = true
        }
        if (hasContent) {
          const key = keyParts.join('|')
          if (key !== prevKey) numPeriods++
          prevKey = key
        } else prevKey = null
      }

      // When all header layers have the same size they are already
      // compact (from the flat-header / multi-category-row path).
      // Empty trailing columns still represent real data columns
      // (e.g., a total column with no header text), so trust the
      // layer size as the minimum column count.
      const layerSizes = new Set(headerLayers.map((hl) => hl.length))

      if (layerSizes.size === 1) {
        const layersCols = [...layerSizes][0]! - 1 // subtract label col
        numPeriods = Math.max(numPeriods, layersCols)
      }
    }

    // Check if headers are financial periods (years, dates, "months ended",
    // or maturity-bucket labels like "0 - 6 Months" / "1 - 5 Years")
    isFinancialPeriods = false

    if (headerLayers.length) {
      for (const layer of headerLayers) {
        for (const h of layer) {
          if (/\b(19|20)\d{2}\b/.test(h)) {
            // Has a year
            isFinancialPeriods = true
            break
          }
          if (/(months?\s+ended|year\s+ended|quarter|as\s+of)/i.test(h)) {
            isFinancialPeriods = true
            break
          }
          // Maturity-bucket labels: "0 - 6 Months", "1 - 5 Years",
          // "10 Years or Greater", "Less than 1 Year", etc.
          if (/\d+\s*[-\u{2013}\u{2014}]\s*\d+\s*(months?|years?)|\d+\s+(months?|years?)(\s+or\s+(greater|more|less))?|less\s+than\s+\d+\s+(months?|years?)/iu.test(h)) {
            isFinancialPeriods = true
            break
          }
        }

        if (isFinancialPeriods) break
      }
    }

    // Use extracted_header_count if available
    headerRowCount = extractedHeaderCount
  }

  // These need special handling to merge headers and align columns

  // Try equity statement processing first
  if (isEquityStatementTable(data)) {
    const [equityResult, equityHeaderCount] = processEquityStatementTable(data, rawRowsWithColspan)
    if (equityResult && equityResult.length) {
      data = equityResult
      const numHeaderRows = equityHeaderCount
      // Skip the usual processing - go directly to markdown output
      if (data.length && data[0]!.length) {
        const equityMaxCols = Math.max(...data.map((row) => row.length))
        return pipeTable(data, equityMaxCols, numHeaderRows)
      }
    }
  }

  // Build output table
  const newData: Cells[] = []

  // Helper to check if a row from data array is a header/title row (should be skipped)
  let hasMeaningfulHeaders = false
  let hasFinancialHeaderTerms = false
  if (headerLayers.length) {
    const allHeaderText = headerLayers.flat().join(' ')

    for (const layer of headerLayers) {
      // Check for multi-word headers that indicate merged vertical labels
      for (const rawH of layer) {
        const h = strip(rawH)
        // Multi-word headers (e.g., "Retail Notes & Financing Leases")
        if (h && split(h).length >= 2 && !/^(19|20)\d{2}$/.test(h)) {
          hasMeaningfulHeaders = true
          break
        }
      }
      if (hasMeaningfulHeaders) break
    }

    // Check for financial terms in headers that indicate structured financial table
    // These terms indicate the table should be parsed semantically even without years
    hasFinancialHeaderTerms = FINANCIAL_HEADER_TERMS.some((term) => term.test(allHeaderText))
  }

  let hasMixedHeaders = false

  if (headerLayers.length === 1) {
    // Single header row - check if it mixes years with non-year columns.
    // "Mixed" means the non-year columns OUTNUMBER the year/year-range
    // columns, implying the headers are different dimensions (e.g.,
    // "2024 | 2023 | % Change | Useful Lives") rather than a year-period
    // table with a summary column ("2008 | 2009-2010 | ... | Total").
    const lastLayer = headerLayers[headerLayers.length - 1]!
    let yearCols = 0
    let nonYearCols = 0

    for (const rawH of lastLayer.slice(1)) {
      // Skip label column
      const h = strip(rawH)
      if (!h) continue
      if (/\b(19|20)\d{2}\b/.test(h)) yearCols++
      else nonYearCols++
    }

    // Mixed only when non-year columns are the majority, or there are NO
    // year columns at all AND the headers don't form a cohesive maturity-
    // bucket set (e.g. "0 - 6 Months", "1 - 5 Years", "Total").
    // Maturity-bucket tables look like year-range tables but use time
    // durations instead of calendar years — they are NOT truly mixed.
    if (yearCols === 0) {
      // All non-empty, non-label headers are maturity buckets → not mixed
      const allMaturity = lastLayer.slice(1).filter((h) => strip(h)).every((h) => MATURITY_BUCKET_RE.test(h))
      if (!allMaturity) hasMixedHeaders = true
    } else if (nonYearCols > yearCols) hasMixedHeaders = true
  }

  let useSemanticParsing = isFinancialPeriods && headerLayers.length > 0 && !hasMixedHeaders

  if (!useSemanticParsing && headerLayers.length > 0 && hasMeaningfulHeaders && hasFinancialHeaderTerms && !hasMixedHeaders) {
    // Treat merged vertical headers with financial terms as financial tables
    useSemanticParsing = true
  }

  // Guard: verify num_periods matches the actual data width.
  // Complex multi-index headers (e.g., "Economic value sensitivity" spanning
  // date sub-headers spanning country sub-sub-headers) can cause the header
  // detection to undercount periods.  When data rows consistently have more
  // non-empty values than num_periods, the header structure is wrong and we
  // must fall back to positional (non-semantic) rendering.
  if (useSemanticParsing && numPeriods > 0 && headerRowCount < data.length) {
    for (const dr of data.slice(headerRowCount)) {
      const n = dr.slice(1).filter((c) => strip(c) && (VAL_RE.test(strip(c)) || DASH_VALS.has(strip(c)))).length
      if (n > numPeriods * 2) {
        useSemanticParsing = false
        break
      }
    }
  }

  let numHeaderRows: number

  if (useSemanticParsing) {
    // For multi-level headers, derive column positions from year cells
    // in the expanded data array. This enables position-aware extraction
    // for sparse data rows (where values have gaps between columns).
    let headerColPositions: number[] | null = null

    if (headerLayers.length >= 2) {
      let yearPositions: number[] = []
      for (let rowIdx = 0; rowIdx < Math.min(headerRowCount, data.length); rowIdx++) {
        data[rowIdx]!.forEach((cell, colIdx) => {
          const cellClean = strip(strip(cell).replace(/^\u{200b}+|\u{200b}+$/gu, ''))
          // Strip footnote markers
          const cellStripped = cellClean.replace(/[*\u{2020}\u{2021}\u{a7}+]+$/u, '')

          if (cellStripped && /^(19|20)\d{2}$/.test(cellStripped) && !yearPositions.includes(colIdx)) yearPositions.push(colIdx)
        })
      }

      yearPositions.sort((a, b) => a - b)

      if (yearPositions.length === numPeriods && numPeriods > 0) {
        // When year headers start at column 0 (label column),
        // they are offset from data values.  Apply the same shift
        // that was computed during header extraction so positions
        // align with actual data columns.
        if (yearPositions[0] === 0 && yearPosShift[0]! > 0) yearPositions = yearPositions.map((p) => p + yearPosShift[0]!)
        headerColPositions = yearPositions
      }

      // When year_positions alone don't cover all periods (e.g.,
      // tables with "% Change" or "Basis Point Change" columns
      // alongside date columns), augment with positions of other
      // non-empty header texts from the header data rows.  Exclude
      // category texts (from Layer 0) and financial data values.
      if (!headerColPositions && yearPositions.length && yearPositions.length < numPeriods && numPeriods > 0) {
        const categoryTextsSet = new Set<string>()
        for (const h of headerLayers[0]!) {
          const ht = strip(h)
          if (ht) categoryTextsSet.add(ht)
        }

        const allLeafPositions = new Set<number>(yearPositions)
        for (let rowIdx = 0; rowIdx < Math.min(headerRowCount, data.length); rowIdx++) {
          data[rowIdx]!.forEach((cell, colIdx) => {
            if (colIdx === 0 || allLeafPositions.has(colIdx)) return
            const cellClean = strip(strip(cell).replace(/^\u{200b}+|\u{200b}+$/gu, ''))
            const cellStripped = cellClean.replace(/[*\u{2020}\u{2021}\u{a7}+]+$/u, '')
            if (!cellStripped) return
            // Skip years (already collected)
            if (/^(19|20)\d{2}$/.test(cellStripped)) return
            // Skip financial data values
            if (/^\$?\s*[()]?\s*[\d,]+\.?\d*\s*[)%]?$/.test(cellStripped)) return
            // Skip category header texts (from colspan expansion)
            if (categoryTextsSet.has(cellStripped)) return
            // Skip descriptor text in parentheses
            if (cellStripped.startsWith('(') && /(million|except|thousand|billion|percent)/i.test(cellStripped)) return
            allLeafPositions.add(colIdx)
          })
        }

        const sortedAll = [...allLeafPositions].sort((a, b) => a - b)
        if (sortedAll.length === numPeriods) headerColPositions = sortedAll
      }

      // For tables with text sub-headers (no year values),
      // dollar signs mark the start of each data column
      if (!headerColPositions && dollarPositions.size) {
        const sortedDollar = [...dollarPositions].sort((a, b) => a - b)

        if (sortedDollar.length === numPeriods && numPeriods > 0) headerColPositions = sortedDollar
      }

      if (!headerColPositions && headerLayers.length) {
        // Build a list of (col_idx_in_layer, text, layer_idx) for all
        // non-empty header positions, then deduplicate by column index.
        const allHeaderEntries: [number, string, number][] = [] // (col_pos, text, layer_idx)

        headerLayers.forEach((layer, li) => {
          for (let colPos = 1; colPos < layer.length; colPos++) {
            const h = strip(layer[colPos]!)

            if (h) allHeaderEntries.push([colPos, h, li])
          }
        })

        // Deduplicate
        const colToText = new Map<number, [string, number]>()

        for (const [colPos, h, li] of allHeaderEntries) {
          const existing = colToText.get(colPos)
          if (!existing || li > existing[1]) colToText.set(colPos, [h, li])
        }

        const subTexts = [...colToText.keys()].sort((a, b) => a - b).map((cp) => colToText.get(cp)![0])

        if (subTexts.length === numPeriods && numPeriods > 0) {
          const foundPositions: number[] = []
          const usedCols = new Set<number>()

          for (const target of subTexts) {
            let matched = false
            for (let rowIdx = 0; rowIdx < Math.min(headerRowCount, data.length); rowIdx++) {
              const dataRow = data[rowIdx]!
              for (let colIdx = 0; colIdx < dataRow.length; colIdx++) {
                if (usedCols.has(colIdx)) continue

                if (strip(dataRow[colIdx]!) === target) {
                  foundPositions.push(colIdx)
                  usedCols.add(colIdx)
                  matched = true
                  break
                }
              }

              if (matched) break
            }
          }

          if (foundPositions.length === numPeriods) headerColPositions = [...foundPositions].sort((a, b) => a - b)
        }
      }
    }

    // Single-layer header fallback: find where each unique header text
    // first appears in the raw (colspan-expanded) data header rows.
    // E.g., header_layers=[['', '2025', '2024', '% Change']] and the
    // raw data row is ['', '', '2025', '2025', '', '2024', '2024', '',
    // '% Change', ''].  We need header_col_positions=[2, 5, 8] so the
    // position-aware extraction maps data cells to correct columns.
    if (!headerColPositions && headerLayers.length === 1) {
      const uniqueHeaders = headerLayers[0]!.slice(1).filter((h) => strip(h))
      if (uniqueHeaders.length === numPeriods && numPeriods > 0) {
        const foundPositions: number[] = []
        const usedCols = new Set<number>()
        for (const target of uniqueHeaders) {
          for (let rowIdx = 0; rowIdx < Math.min(headerRowCount, data.length); rowIdx++) {
            let matched = false
            const dataRow = data[rowIdx]!
            for (let colIdx = 0; colIdx < dataRow.length; colIdx++) {
              if (usedCols.has(colIdx)) continue
              if (strip(dataRow[colIdx]!) === target) {
                foundPositions.push(colIdx)
                usedCols.add(colIdx)
                matched = true
                break
              }
            }
            if (matched) break
          }
        }
        if (foundPositions.length === numPeriods) headerColPositions = foundPositions
      }
    }

    if (headerLayers.length) {
      for (const layer of headerLayers) {
        if (layer.length === numPeriods + 1) {
          newData.push([...layer])
          continue
        }

        // Pad on the right to match the expected column count rather than collapsing.
        if (layer.length <= numPeriods + 1) {
          const padded = [...layer, ...Array.from({ length: numPeriods + 1 - layer.length }, () => '')]
          newData.push(padded.slice(0, numPeriods + 1))
          continue
        }

        // Collapse adjacent identical texts from colspan expansion.
        // E.g., ['', '', '', '2025', '2025', '2025', '', '', '',
        //         '2024', '2024', '2024', ...]
        // becomes ['', '2025', '2024', '2023']
        const collapsed: string[] = []
        let prevText: string | null = null
        layer.forEach((text, idx) => {
          const t = strip(text)

          if (idx === 0) {
            // Always keep the label column as-is
            collapsed.push(text)
            prevText = null
            return
          }

          if (t) {
            if (t !== prevText) collapsed.push(text)
            prevText = t
          } else prevText = null // Reset on empty
        })

        // Ensure it has the right number of columns
        while (collapsed.length < numPeriods + 1) collapsed.push('')
        newData.push(collapsed.slice(0, numPeriods + 1))
      }
    }

    // Process data rows - use header_row_count to skip header rows
    // Use a two-pass approach: first extract values into *groups*
    // per header range, then flatten.  This correctly interleaves
    // sub-column values (e.g. absolute change + percentage under a
    // single "2025 vs. 2024" header) instead of appending overflows
    // to the end.
    const extractedRows: [string | null, string[][]][] = []
    let hasSubColumns = false
    const numHeaderEntries = newData.length // header rows already added

    for (let i = 0; i < data.length; i++) {
      const row = data[i]!
      // Skip rows before data starts (headers already extracted)
      if (i < headerRowCount) continue

      // Also skip any remaining header-like rows by content
      if (isDataRowHeader(row)) continue

      if (headerColPositions && headerColPositions.length) {
        // Position-aware extraction: map data cells to headers
        // by checking which header column range each cell falls in
        const ranges: [number, number][] = []

        headerColPositions.forEach((pos, hi) => {
          const end = hi + 1 < headerColPositions!.length ? headerColPositions![hi + 1]! : row.length
          ranges.push([pos, end])
        })

        const labelParts: string[] = []
        const valueGroups: string[][] = Array.from({ length: numPeriods }, () => [])

        row.forEach((cellText, colIdx) => {
          const cellClean = strip(strip(cellText).replace(/^\u{200b}+|\u{200b}+$/gu, ''))

          if (!cellClean || cellClean === '$' || cellClean === '\u{20ac}') return
          // Before first header position = label column
          if (colIdx < headerColPositions![0]!) {
            labelParts.push(cellClean)
            return
          }

          // Find which header range this cell falls into
          for (let hi = 0; hi < ranges.length; hi++) {
            const [start, end] = ranges[hi]!
            if (start <= colIdx && colIdx < end) {
              // Numeric/dash values go as data
              if (VAL_RE.test(cellClean) || DATA_CELL_VALS.has(cellClean)) {
                valueGroups[hi]!.push(cellClean)
                if (valueGroups[hi]!.length > 1) hasSubColumns = true
              } else if (/^(bps?|pts?|pps?|x)$/i.test(cellClean) && valueGroups[hi]!.length) {
                // Unit suffix (e.g. "bps", "pts") that
                // belongs to the preceding numeric value
                // in the same header range — merge rather
                // than creating a spurious extra column.
                valueGroups[hi]![valueGroups[hi]!.length - 1] = `${valueGroups[hi]![valueGroups[hi]!.length - 1]} ${cellClean}`
              } else if (labelParts.length === 0) {
                // Non-numeric before any data = part of label
                labelParts.push(cellClean)
              } else {
                valueGroups[hi]!.push(cellClean)
                if (valueGroups[hi]!.length > 1) hasSubColumns = true
              }

              break
            }
          }
        })

        const label = labelParts.length ? labelParts.join(' ') : null
        extractedRows.push([label, valueGroups])
      } else {
        const [label, values] = parseRowSemantic(row, numPeriods)
        // Wrap each value as a single-element group
        extractedRows.push([label, values.map((v) => (v ? [v] : []))])
      }
    }

    // Determine max sub-column count per period across all rows.
    const maxGroupSizes: number[] = Array.from({ length: numPeriods }, () => 1)
    if (hasSubColumns) {
      for (const [, groups] of extractedRows) {
        for (let hi = 0; hi < Math.min(numPeriods, groups.length); hi++) maxGroupSizes[hi] = Math.max(maxGroupSizes[hi]!, groups[hi]!.length)
      }
    }

    const actualPeriods = maxGroupSizes.reduce((a, b) => a + b, 0)

    // Flatten each row's value groups into a flat value list.
    for (const [label, groups] of extractedRows) {
      if (label === null && groups.every((g) => g.length === 0)) continue

      const flatValues: string[] = []
      for (let hi = 0; hi < numPeriods; hi++) {
        const g = hi < groups.length ? [...groups[hi]!] : []
        while (g.length < maxGroupSizes[hi]!) g.push('')
        flatValues.push(...g)
      }

      while (flatValues.length < actualPeriods) flatValues.push('')

      newData.push([label || '', ...flatValues])
    }

    // Expand header layers if sub-columns were detected.
    if (hasSubColumns && actualPeriods > numPeriods) {
      for (let li = 0; li < numHeaderEntries; li++) {
        const oldHdr = newData[li]!
        const expanded = [oldHdr[0]!] // label column
        for (let hi = 0; hi < numPeriods; hi++) {
          const h = hi + 1 < oldHdr.length ? oldHdr[hi + 1]! : ''
          expanded.push(h)
          for (let k = 0; k < maxGroupSizes[hi]! - 1; k++) expanded.push('')
        }
        while (expanded.length < actualPeriods + 1) expanded.push('')
        newData[li] = expanded
      }
      numPeriods = actualPeriods
    }

    data = newData
    numHeaderRows = headerLayers.length ? headerLayers.length : 1

    // Re-align single-layer period headers to match actual data column
    // positions.  When a year header like "September 2025" (cs=6) spans
    // multiple physical data columns (e.g. amount + percentage), the
    // collapsed header row places it at col 1 while "December 2024" lands
    // at col 2 — even though the December data starts at col 3.
    // Fix: scan the first data row for dollar-prefixed values ($xxx) and
    // move each period name to the column where its period's $ amount sits.
    if (headerLayers.length === 1 && numPeriods >= 2 && headerLayers[0]!.length === numPeriods + 1 && data.length > numHeaderRows) {
      const periodNames = headerLayers[0]!.slice(1).filter((h) => strip(h))
      if (periodNames.length === numPeriods) {
        let dollarCols: number[] = []
        for (const drow of data.slice(numHeaderRows)) {
          const positions: number[] = []
          drow.forEach((c, ci) => {
            if (c && c.startsWith('$')) positions.push(ci)
          })
          if (positions.length === numPeriods) {
            dollarCols = positions
            break
          }
        }
        if (dollarCols.length && Math.max(...dollarCols) >= numPeriods) {
          // Only realign if dollar cols are NOT already sequential
          // from 1..num_periods (which would mean no change needed)
          const expected = Array.from({ length: numPeriods }, (_, k) => k + 1)
          if (dollarCols.length !== expected.length || dollarCols.some((v, k) => v !== expected[k])) {
            const maxDc = Math.max(...data.map((r) => r.length))
            const newHdr = Array.from({ length: maxDc }, () => '')
            dollarCols.forEach((pos, pi) => {
              if (pos < maxDc) newHdr[pos] = periodNames[pi]!
            })
            data[0] = newHdr
          }
        }
      }
    }
  } else if (hasMixedHeaders && headerLayers.length) {
    // Mixed-header table (has non-year columns like "Useful Lives")
    let headerPart = data.slice(0, headerRowCount)
    let filteredRows: Cells[]
    if (isFinancialPeriods) filteredRows = data.slice(headerRowCount).filter((row) => !isDataRowHeader(row))
    else filteredRows = [...data.slice(headerRowCount)]
    data = [...headerPart, ...filteredRows]

    // Check if this is a simple flat table
    if (headerRowCount === 1) {
      data = removeEmptyColumns(data)
      data = collapseRepeatedHeaders(data)
      numHeaderRows = 1
    } else {
      // Multi-row header structure with mixed headers.
      headerPart = data.slice(0, headerRowCount)
      const dataRowsOnly = data.slice(headerRowCount)

      let actualHeaderRows: Cells[] = []
      for (const row of headerPart) {
        const nonEmpty = row.filter((c) => strip(c))

        if (nonEmpty.length >= 2) {
          // Multiple cells with content → column-defining header
          actualHeaderRows.push(row)
        }
      }

      if (actualHeaderRows.length === 0) {
        // Fallback: use the last header row
        actualHeaderRows = [headerPart[headerPart.length - 1]!]
      }

      let combined = [...actualHeaderRows, ...dataRowsOnly]
      combined = removeEmptyColumns(combined)
      combined = collapseRepeatedHeaders(combined)

      data = combined
      numHeaderRows = actualHeaderRows.length
    }
  } else {
    // Non-financial table - filter out header-like rows from data portion
    if (headerRowCount > 0) {
      const headerPart = data.slice(0, headerRowCount)
      const filteredRows = data.slice(headerRowCount).filter((row) => !isDataRowHeader(row))
      data = [...headerPart, ...filteredRows]
    }
    data = removeEmptyColumns(data)
    // This handles tables where header has colspan=2 but data only fills one position
    data = collapseRepeatedHeaders(data)
    numHeaderRows = 0
  }

  if (data.length === 0 || data[0]!.length === 0) return ''

  maxCols = data.length ? Math.max(...data.map((row) => row.length)) : 0
  return pipeTable(data, maxCols, numHeaderRows)
}

// Kept for sibling modules.
export { hasDigit }
