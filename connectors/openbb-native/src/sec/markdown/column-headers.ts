// html2markdown: multi-index column headers from colspan structure, provider sec. Ported from
// openbb_sec/utils/html2markdown.py `build_column_headers_from_colspan` (OpenBB Platform 5.0.0, Apache-2.0);
// modified: tuples are arrays.
import { MONTHS_PATTERN, type RowsWithColspan } from './table-clean.js'
import { strip } from './py.js'

const raw = String.raw

type Parsed = [string, number, number] // (text, colspan, start)
type HeaderInfo = [number, Parsed[], boolean, boolean] // (row_idx, parsed, is_year_row, is_category_row)

const ZW = /\u{200b}|\u{200c}|\u{200d}|\u{feff}/gu

/** Text with zero-width characters removed and stripped. */
function visible(t: string): string {
  return strip(t.replace(ZW, ''))
}

const BR_RE = /<[Bb][Rr]\s*\/?>/g
const NUMERIC_CELL_RE = /^\$?\s*[()]?\s*[\d,]+\.?\d*\s*[)%]?$/

/**
 * Build proper multi-index column headers.
 *
 * For tables with stacked category headers like:
 *     Row 0: [Title spanning all columns - SKIP]
 *     Row 1: "" | "EQUIPMENT" (colspan=8) | "FINANCIAL" (colspan=8) | ...
 *     Row 2: "" | "OPERATIONS" (colspan=8) | "SERVICES" (colspan=8) | "ELIMINATIONS" | "CONSOLIDATED"
 *     Row 3: "" | "2025" | "2024" | "2023" | "2025" | "2024" | "2023" | ...
 *
 * Output multi-index format:
 *     Row 1: ["", "EQUIPMENT OPERATIONS", "", "", "FINANCIAL SERVICES", "", "", ...]
 *     Row 2: ["", "2025", "2024", "2023", "2025", "2024", "2023", ...]
 *
 * POSITION-BASED vertical merge: if row N and row N+1 both have text at same
 * column position with large colspan, merge them into one category name.
 * Category name appears ONLY in the first cell of its span, not repeated.
 *
 * Returns (header_layers, header_row_count)
 *
 * `yearPosShift` is a one-element array used as a mutable output parameter so the caller can read back the computed
 * shift value. When called outside of `convert_table` it may be null; in that case a local array is used.
 */
export function buildColumnHeadersFromColspan(rowsWithColspan: RowsWithColspan, yearPosShift: number[] | null): [string[][] | null, number] {
  if (rowsWithColspan.length === 0) return [null, 0]

  // Extract colspan structure and text for each row
  // Structure: list of (text, colspan, start_col) tuples
  const parsedRows: Parsed[][] = []
  for (const row of rowsWithColspan) {
    const parsed: Parsed[] = []
    let colPos = 0
    for (const [text, colspan] of row) {
      const strippedText = strip(text)
      parsed.push([strippedText, colspan, colPos])
      colPos += colspan
    }
    parsedRows.push(parsed)
  }

  const isYear = (t: string): boolean => {
    // Strip trailing footnote markers like *, **, †, ‡, §
    const tClean = strip(t).replace(/[*\u{2020}\u{2021}\u{a7}+]+$/u, '')
    return /^(19|20)\d{2}$/.test(tClean)
  }

  /** Check if text looks like a category header (not a year, not data). */
  const isCategoryText = (t: string): boolean => {
    if (!t || isYear(t)) return false
    // Remove <br> tags before checking patterns (multi-line headers)
    let tClean = strip(t.replace(BR_RE, ' '))
    tClean = tClean.replace(/\s+/g, ' ') // Collapse whitespace
    // Remove trailing footnote markers like *, **, *+, **+
    tClean = tClean.replace(/\s*[*+]+$/, '')
    // Remove trailing superscript footnote numbers like "1,2,3" or "4"
    // These come from <sup> tags concatenated with the text
    tClean = tClean.replace(/\s+\d+(?:,\d+)*$/, '')
    // Also strip footnote digits directly attached to words (no whitespace)
    // e.g., "Net Interest2" → "Net Interest", "All Other3" → "All Other"
    tClean = tClean.replace(/(?<=[A-Za-z])\d+$/, '')
    if (NUMERIC_CELL_RE.test(tClean)) return false // It's data
    // Title Case: "Equipment Operations", "Operating Income/(Loss)"
    // Strip /()\- before checking to avoid catastrophic backtracking
    let tStripped = tClean.replace(/[/()-]/g, ' ')
    tStripped = strip(tStripped.replace(/\s+/g, ' '))
    // Also prepare a variant with leading symbol prefixes removed
    // so that headers like "% Average rate" or "# of Shares" are
    // recognized after stripping the leading punctuation.
    const tNoPrefix = tStripped.replace(/^[%#$&*~!@^]+\s*/, '')
    if (/^[A-Z][A-Za-z]*(\s+[A-Za-z&]+)*$/.test(tStripped) && tClean.length > 2) return true
    if (tNoPrefix !== tStripped && /^[A-Z][A-Za-z]*(\s+[A-Za-z&]+)*$/.test(tNoPrefix) && tNoPrefix.length > 2) return true
    // ALL CAPS: "EQUIPMENT", "FINANCIAL SERVICES", "LONG-LIVED ASSETS"
    if (/^[A-Z]{2,}(-[A-Z]+)?(\s+[A-Z]+(-[A-Z]+)?)*$/.test(tClean)) return true
    // ALL CAPS with periods/abbreviations: "WTD. AVG. EXERCISE PRICE", "NO. OF SHARES"
    // Pattern: uppercase word (optionally with period) followed by more words
    if (/^[A-Z]{2,}\.?(\s+[A-Z]{2,}\.?)*(\s+[A-Z]+)*$/.test(tClean) && tClean.length > 3) return true
    // Abbreviated ALL-CAPS with dots and dashes: "YR.-TO-YR."
    if (/^[A-Z]{2,}\.(-[A-Z]{2,}\.?)+$/.test(tClean)) return true
    // Abbreviations like "U.S.", "NON-U.S.", "U.K." - single letters with periods
    // Pattern: optional prefix (NON-), then letter-period pairs
    if (/^([A-Z]+-)?[A-Z]\.[A-Z]\.?$/.test(tClean)) return true
    // Abbreviations followed by words: "U.S. PLANS", "NON-U.S. PLANS"
    if (/^([A-Z]+-)?[A-Z]\.[A-Z]\.?(\s+[A-Z]+)+$/.test(tClean)) return true
    // Hyphenated categories: "NON-GAAP", "PRE-TAX"
    if (/^[A-Z]+-[A-Z]+$/.test(tClean)) return true
    // Hyphenated words followed by more words: "PPP-QUALIFIED PORTION"
    return /^[A-Z]+-[A-Z]+(\s+[A-Z]+)+$/.test(tClean)
  }

  /** Check if this row is a header row (years or categories). */
  const isHeaderRow = (parsed: Parsed[]): [boolean, boolean] => {
    // Filter truly empty cells and cells with only whitespace/invisible chars
    // Zero-width spaces (U+200B) and similar should be skipped
    const hasVisibleContent = (t: string): boolean => !!visible(t)

    const nonEmpty = parsed.filter(([t]) => t && hasVisibleContent(t))
    if (nonEmpty.length === 0) return [false, false] // empty, not header

    // Check if title row (one text spans >=80%)
    const totalSpan = parsed.reduce((acc, [, c]) => acc + c, 0)
    const maxSpan = nonEmpty.length ? Math.max(...nonEmpty.map(([, c]) => c)) : 0
    if (maxSpan >= totalSpan * 0.8) {
      // Don't classify date/year super-headers as title rows — even if a
      // date like "As of November 2007" spans ≥80% of the table width it
      // should still be treated as a year super-header row, not skipped.
      const spanningText = nonEmpty.find(([, c]) => c === maxSpan)?.[0] ?? null
      const isDateSpan = !!spanningText && new RegExp(raw`(?:As\s+of\s+)?(?:${MONTHS_PATTERN}\s+)?(?:\d{1,2},?\s*)?(19|20)\d{2}\b`, 'i').test(spanningText)
      if (!isDateSpan) return [false, true] // title row - skip but count
    }

    // Check for period description rows like "For the Three Months Ended..."
    // These are single-cell descriptions that should be treated as title rows
    if (nonEmpty.length === 1) {
      const [text, , start] = nonEmpty[0]!
      // Period descriptions in first column with phrases like "For the X Months/Weeks/Years Ended"
      if (start === 0 && /for\s+the\s+(\w+\s+)?(months?|weeks?|quarters?|years?|period)\s+ended/i.test(text)) {
        return [false, true] // title row - skip but count
      }

      // A single non-empty cell at position 0 that does NOT
      // reference any year or date is a table title / section
      // label (e.g. "Financial performance of JPMorganChase"),
      // NOT a category header.  Category headers appear at
      // start > 0 spanning data columns, typically with multiple
      // cells per row.  Mis-classifying titles as categories
      // breaks the header scan — it causes the scanner to stop
      // at the very next non-header row, never reaching the
      // actual year/period row further down.
      if (start === 0 && !/\b(19|20)\d{2}\b/.test(text) && !new RegExp(raw`(months?\s+ended|year\s+ended|weeks?\s+ended|${MONTHS_PATTERN}\s+\d{1,2})`, 'i').test(text)) {
        return [false, true] // title row - skip but count
      }
    }

    let hasYear = false
    let hasCategory = false
    let hasData = false
    let hasLabel = false // Line item label (text in col 0/1 with small colspan)

    for (const [t, colspan, start] of nonEmpty) {
      if (t.startsWith('(') && (t.toLowerCase().includes('million') || t.toLowerCase().includes('except'))) continue

      // Check for year before checking for numeric data
      if (isYear(t)) hasYear = true
      else if (NUMERIC_CELL_RE.test(t)) {
        // At position 0 (label column), a bare small number
        // (1-3 digits with no financial formatting) may be a
        // rendering artifact rather than a data value.
        if (start === 0 && /^\d{1,3}$/.test(t)) continue
        hasData = true
        break
      } else if (
        start > 0 &&
        new RegExp(
          raw`(months?\s+ended|year\s+ended|weeks?\s+ended|quarters?\s+ended|ended\s+${MONTHS_PATTERN}|${MONTHS_PATTERN}\s+\d{1,2}\s*,?(?:\s*(?:19|20)\d{2})?|(?:As\s+of\s+)?${MONTHS_PATTERN}\s+(19|20)\d{2}\b)`,
          'i',
        ).test(t)
      ) {
        // Catches "Three Months Ended May 31" / "January 26, 2025" / "Ended November"
        // / "November 2007" / "As of November 2007" / "October 31," (bare date fragment)
        // but NOT standalone unit labels like "Months", "Years", "10 Years"
        hasYear = true
      } else if (isCategoryText(t) && colspan >= 2) {
        // Category headers can have colspan >= 2
        hasCategory = true
      } else if (isCategoryText(t) && colspan === 1) {
        // Category text with colspan=1 can also be a header
        // (e.g., "NUMBER OF SHARES UNDER OPTION" at start > 1)
        if (start > 1) hasCategory = true
      } else if (start <= 1 && colspan === 1 && t.length > 3) {
        // Text in first column with small colspan = line item label (data row)
        // Unless it's a very short text that could be a spacer
        hasLabel = true
      } else if (t.endsWith(':')) {
        // Section labels like "Assets:", "Liabilities:", "Revenues:" indicate data rows
        hasLabel = true
      }
    }

    // Data rows always stop header scanning
    if (hasData) return [false, false]

    // If has_year or has_category, the label is just a row dimension header (e.g., "Risk Categories")
    if (hasLabel && !(hasYear || hasCategory)) return [false, false]

    // Staircase top-row: all non-empty cells in data columns (start > 0) with
    // uniform small colspan and no financial data.  Catches maturity-range
    // labels like "0 - 6", "6 - 12", "10 Years" that fail every single-cell
    // test but are clearly split column headers when they appear together with
    // equal colspan (e.g., all colspan=2 spanning gutter+value pairs).
    if (!hasYear && !hasCategory && !hasLabel) {
      const dataColCells = nonEmpty.filter(([, , s]) => s > 0)
      if (
        dataColCells.length >= 2 &&
        new Set(dataColCells.map(([, c]) => c)).size === 1 && // uniform colspan
        dataColCells[0]![1] >= 2 // not colspan-1 label cells
      ) {
        hasCategory = true
      }
    }

    return [hasYear || hasCategory, false]
  }

  // First pass: identify all header rows and classify them
  const headerInfo: HeaderInfo[] = [] // (row_idx, parsed, is_year_row, is_category_row)
  let headerRowCount = 0

  const hasVisibleText = (t: string): boolean => !!visible(t)

  const titlePeriodTexts: string[] = [] // Track period titles for super-header use

  for (let rowIdx = 0; rowIdx < parsedRows.length; rowIdx++) {
    const parsed = parsedRows[rowIdx]!
    const [isHeader, isTitle] = isHeaderRow(parsed)
    // Check if this row is completely empty (all cells empty after stripping)
    const nonEmptyCells = parsed.filter(([t]) => hasVisibleText(t))

    if (nonEmptyCells.length === 0) {
      // Empty row - skip it but count it toward header_row_count
      headerRowCount = rowIdx + 1
      continue
    }

    if (isTitle) {
      // Save period/date titles for potential use as super-headers
      for (const [tt] of parsed) {
        if (tt && hasVisibleText(tt) && new RegExp(raw`(months?|quarters?|years?|weeks?|period)\s+ended|ended\s+${MONTHS_PATTERN}|${MONTHS_PATTERN}\s+\d{1,2}`, 'i').test(tt)) titlePeriodTexts.push(tt)
      }
      headerRowCount = rowIdx + 1
      continue
    }

    if (!isHeader) {
      // Before breaking, check if this is a pre-header title row.
      // SEC filings often have company names and statement titles
      // in single cells at position 0 without large colspan.
      // These should be skipped before any real headers are found.
      if (headerInfo.length === 0) {
        // No headers found yet
        const nonEmptyCheck = parsed.filter(([t]) => hasVisibleText(t))
        if (nonEmptyCheck.length <= 1 && (nonEmptyCheck.length === 0 || nonEmptyCheck[0]![2] === 0 || nonEmptyCheck[0]![1] > 2)) {
          // Single text at position 0 (or empty) or with large colspan before headers → title row
          headerRowCount = rowIdx + 1
          continue
        }
      }
      break // Hit actual data row
    }

    // After year rows have been found, a single-cell row at position 0
    // is a section header (e.g., "Assets", "Liabilities"), not a column
    // category. Stop scanning for headers.
    if (headerInfo.length) {
      const hasYearAlready = headerInfo.some(([, , isYr]) => isYr)
      if (hasYearAlready && nonEmptyCells.length === 1 && nonEmptyCells[0]![2] === 0) break
    }

    // Classify: year row or category row?
    const nonEmpty = parsed.filter(([t]) => hasVisibleText(t))

    // Check if this row has large-colspan period phrases (super-headers)
    // E.g., "Three Months Ended May"[cs=7] is a category spanning year columns
    const hasLargeColspanPeriod = nonEmpty.some(([t, colspan]) => colspan > 2 && new RegExp(raw`(months?|quarters?|years?|weeks?)\s+ended|ended\s+${MONTHS_PATTERN}`, 'i').test(t))

    let hasYear = nonEmpty.some(
      ([t, colspan, s]) =>
        isYear(t) ||
        (new RegExp(raw`(ended|${MONTHS_PATTERN})`, 'i').test(t) && colspan <= 2 && s > 0) || // Skip first column (row labels like "AT DECEMBER 31:")
        // Full dates like "January 26, 2025", "September 26,2025",
        // or "September 26,<br>2025" (with <br> tag) are year indicators
        (new RegExp(raw`(${MONTHS_PATTERN})\s+\d{1,2},?\s*(19|20)\d{2}`, 'i').test(t.replace(BR_RE, ' ')) && s > 0) ||
        // "Month YYYY" (no day) or "As of Month YYYY" — period super-headers
        // with any colspan (e.g. "As of November 2007" cs=22 spans whole table)
        (new RegExp(raw`(?:As\s+of\s+)?${MONTHS_PATTERN}\s+(19|20)\d{2}\b`, 'i').test(t) && s > 0),
    )
    let hasCategory = nonEmpty.some(([t]) => isCategoryText(t) && !isYear(t))

    // Large-colspan period phrases are treated as categories
    if (hasLargeColspanPeriod) {
      const periodPhrasesHaveYear = nonEmpty.some(
        ([t, colspan]) => colspan > 2 && new RegExp(raw`(months?|quarters?|years?|weeks?)\s+ended|ended\s+${MONTHS_PATTERN}`, 'i').test(t) && /\b(19|20)\d{2}\b/.test(t.replace(BR_RE, ' ')),
      )
      if (!periodPhrasesHaveYear) hasYear = false
      hasCategory = true
    }

    headerInfo.push([rowIdx, parsed, hasYear, hasCategory])
    headerRowCount = rowIdx + 1
  }

  if (headerInfo.length === 0) return [null, 0]

  // A valid financial table must have at least one data row after
  // the header region, so bail out and let the caller fall back to
  // simple non-financial table processing.
  if (headerRowCount >= parsedRows.length) return [null, 0]

  const categoryRows: [number, Parsed[]][] = headerInfo.filter(([, p, isYr, isCat]) => (isCat && !isYr) || (!isYr && !isCat && p.some(([t, , s]) => hasVisibleText(t) && s > 0))).map(([idx, p]) => [idx, p])
  const yearRows: [number, Parsed[]][] = headerInfo.filter(([, , isYr]) => isYr).map(([idx, p]) => [idx, p])

  // Extract column headers from year rows
  let columnHeadersList: string[] = []
  let columnHeadersPositions: number[] = []

  for (const [, parsed] of yearRows) {
    for (const [text, , start] of parsed) {
      if (!text) continue

      if (start === 0 && !isYear(text)) continue

      // Skip notes/descriptors in parentheses
      if (text.startsWith('(') && (text.toLowerCase().includes('million') || text.toLowerCase().includes('except'))) continue

      columnHeadersList.push(text)
      columnHeadersPositions.push(start)
    }
  }

  // When the first year header is at position 0 (occupying the label
  // column), it means the year sub-header row lacks a separate label
  // cell — years start from the very first cell.  Data rows DO have
  // a label at position 0, so data values start at a later position.
  // Shift all year header positions right by the label column width
  // (= first category position) to align them with data columns.
  // `yearPosShift` may be null when the function is called outside
  // of convert_table (e.g. in tests); in that case use a local array.
  if (yearPosShift === null) yearPosShift = [0]
  yearPosShift[0] = 0
  if (columnHeadersPositions.length && columnHeadersPositions[0] === 0 && categoryRows.length) {
    // Use first category's start position as the label width
    outer: for (const [, catParsed] of categoryRows) {
      for (const [, , cs] of catParsed) {
        if (cs > 0) {
          yearPosShift[0] = cs
          break outer
        }
      }
      break
    }
    if (yearPosShift[0]! > 0) {
      const shift = yearPosShift[0]!
      columnHeadersPositions = columnHeadersPositions.map((p) => p + shift)
    }
  }

  // Check for stacked date + year header pattern:
  // Row A: "January 26," "October 27," "January 28," (dates with months)
  // Row B: "2025" "2024" "2024" (years)
  // Should combine to: "January 26, 2025", "October 27, 2024", etc.
  // Also handles extra non-month/non-year items at different positions:
  // Row A: "January 26" "January 28" "%"
  // Row B: "2025" "2024" "Change"
  // -> "January 26, 2025" "January 28, 2024" "% Change"
  if (yearRows.length >= 2) {
    const rowHeaders = (parsedRow: Parsed[]): [string, number][] => {
      const result: [string, number][] = []
      for (const [text, , start] of parsedRow) {
        const t = strip(text)
        if (!t) continue
        // Skip first-column labels but allow years at position 0
        if (start === 0 && !isYear(t)) continue
        if (t.startsWith('(') && (t.toLowerCase().includes('million') || t.toLowerCase().includes('except'))) continue
        result.push([t, start])
      }
      return result
    }

    /**
     * Try to merge two header rows by matching positions.
     * Returns (merged_texts, merged_positions) sorted by position,
     * or (None, None) if no month+year merges found.
     */
    const tryPositionMerge = (hdrsA: [string, number][], hdrsB: [string, number][]): [string[], number[]] | [null, null] => {
      // Build position maps
      const posA = new Map<number, string>(hdrsA.map(([t, s]) => [s, t]))
      const posB = new Map<number, string>(hdrsB.map(([t, s]) => [s, t]))
      const allPositions = [...new Set([...posA.keys(), ...posB.keys()])].sort((a, b) => a - b)

      const merged: string[] = []
      const mergedPos: number[] = []
      let monthYearMerges = 0
      const monthRe = new RegExp(MONTHS_PATTERN, 'i')
      for (const pos of allPositions) {
        const textA = posA.get(pos)
        const textB = posB.get(pos)
        if (textA && textB) {
          const aIsMonth = monthRe.test(textA)
          const bIsYear = isYear(textB)
          const aIsYear = isYear(textA)
          const bIsMonth = monthRe.test(textB)
          if (aIsMonth && bIsYear) {
            merged.push(`${strip(textA.replace(/,+$/, ''))}, ${textB}`)
            monthYearMerges++
          } else if (aIsYear && bIsMonth) {
            merged.push(`${strip(textB.replace(/,+$/, ''))}, ${textA}`)
            monthYearMerges++
          } else {
            // Generic vertical merge (e.g., "%" + "Change" -> "% Change")
            merged.push(strip(`${textA} ${textB}`))
          }
        } else if (textA) merged.push(textA)
        else if (textB) merged.push(textB)
        mergedPos.push(pos)
      }

      if (monthYearMerges > 0) return [merged, mergedPos]
      return [null, null]
    }

    const monthRe = new RegExp(MONTHS_PATTERN, 'i')
    merge: for (let i = 0; i < yearRows.length; i++) {
      for (let j = i + 1; j < yearRows.length; j++) {
        const rowA = yearRows[i]![1]
        const rowB = yearRows[j]![1]
        const hdrsA = rowHeaders(rowA)
        const hdrsB = rowHeaders(rowB)

        if (hdrsA.length === 0 || hdrsB.length === 0) continue

        // Check that at least one row has months and at least one has years
        const aHasMonths = hdrsA.some(([h]) => monthRe.test(h))
        const bHasMonths = hdrsB.some(([h]) => monthRe.test(h))
        const aHasYears = hdrsA.some(([h]) => isYear(h))
        const bHasYears = hdrsB.some(([h]) => isYear(h))

        if ((aHasMonths && bHasYears) || (aHasYears && bHasMonths)) {
          const [result, resultPositions] = tryPositionMerge(hdrsA, hdrsB)
          if (result && result.length) {
            columnHeadersList = result
            columnHeadersPositions = resultPositions!
            break merge
          }
        }
      }
    }
  }

  if (columnHeadersList.length && categoryRows.length) {
    const maxYearPos = Math.max(...columnHeadersPositions)
    const covered = new Set(columnHeadersPositions)
    for (const [, catParsed] of categoryRows) {
      for (const [text, , start] of catParsed) {
        const t = strip(text || '')
        if (!t || start <= maxYearPos || covered.has(start)) continue
        if (t.startsWith('(') && (t.toLowerCase().includes('million') || t.toLowerCase().includes('except'))) continue
        covered.add(start)
        columnHeadersList.push(t)
        columnHeadersPositions.push(start)
      }
    }
    if (columnHeadersPositions.length > 1) {
      const order = columnHeadersPositions.map((_, k) => k).sort((a, b) => columnHeadersPositions[a]! - columnHeadersPositions[b]! || a - b)
      columnHeadersList = order.map((k) => columnHeadersList[k]!)
      columnHeadersPositions = order.map((k) => columnHeadersPositions[k]!)
    }
  }

  if (columnHeadersList.length === 0) {
    // No year row headers found
    // Check for date-super-header pattern: one category row is a single
    // large-colspan date/period phrase spanning everything, and remaining
    // category rows have vertically-stacked text sub-column headers.
    // Example:
    //   Row 0: "Three Months Ended January 26, 2025" cs=11  (super-header)
    //   Row 1: "Retail Notes" cs=2, "Revolving" cs=2
    //   Row 2: "& Financing" cs=2, "Charge" cs=2, "Wholesale" cs=2
    //   Row 3: "Leases" cs=2, "Accounts" cs=2, "Receivables" cs=2, "Total" cs=2
    //   → merge sub-columns: "Retail Notes & Financing Leases", etc.
    if (categoryRows.length >= 2) {
      const firstParsed = categoryRows[0]![1]
      const firstNe = firstParsed.filter(([t]) => hasVisibleText(t))
      let isDateSuper = false
      let superText = ''
      if (firstNe.length === 1) {
        const superCs = firstNe[0]![1]
        superText = firstNe[0]![0]
        if (superCs > 2 && new RegExp(raw`(months?|quarters?|years?|weeks?|period)\s+ended|ended\s+${MONTHS_PATTERN}|${MONTHS_PATTERN}\s+\d{1,2}`, 'i').test(superText)) isDateSuper = true
      }

      if (isDateSuper) {
        // Vertically merge remaining category rows by position
        const posTexts = new Map<number, string[]>() // col_pos -> [text1, text2, ...]
        for (let catIdx = 1; catIdx < categoryRows.length; catIdx++) {
          const subParsed = categoryRows[catIdx]![1]
          for (const [subText, , subStart] of subParsed) {
            if (!subText || !hasVisibleText(subText) || subStart === 0) continue
            if (!posTexts.has(subStart)) posTexts.set(subStart, [])
            posTexts.get(subStart)!.push(subText)
          }
        }

        if (posTexts.size) {
          const sortedPos = [...posTexts.keys()].sort((a, b) => a - b)
          const mergedSubHeaders = sortedPos.map((p) => posTexts.get(p)!.join(' '))
          const nCols = mergedSubHeaders.length
          // Build 2-layer header
          const superRow = ['', superText]
          for (let k = 0; k < nCols - 1; k++) superRow.push('')
          const subRow = ['', ...mergedSubHeaders]
          return [[superRow, subRow], headerRowCount]
        }
      }
    }

    // Fallback: check if category rows can serve as column headers (flat header table)
    // Merge by POSITION across all category rows.  When two rows
    // have text at the same position, the WIDER row (more total
    // columns) wins — it placed its header at an explicit position
    // in a full-width row.  The displaced text from the shorter
    // row is appended at the end (first uncovered position).
    // Example (MS 10-Q):
    //   R2 (18 cols): Net Interest2@9, All Other3@12
    //   R3 (12 cols): Trading@3, Fees1@6, Total@9
    //   → pos 9 conflict: R2 wins (wider), "Total" displaced to end
    //   → result: Trading | Fees1 | Net Interest2 | All Other3 | Total
    if (categoryRows.length) {
      let firstColLabel = ''
      for (const [, catParsed] of categoryRows) {
        for (const [text, , start] of catParsed) {
          if (start === 0 && text && !firstColLabel) firstColLabel = text
        }
      }

      // Compute each row's total column span
      const rowWidths: number[] = []
      for (const [, catParsed] of categoryRows) rowWidths.push(catParsed.reduce((acc, [, cs]) => acc + cs, 0))

      // Build position -> (text, row_width) map.
      // Wider row wins at conflicts.
      const posMap = new Map<number, [string, number]>() // pos -> (text, row_width)
      const displaced: string[] = [] // texts displaced from conflicts
      categoryRows.forEach(([, catParsed], crIdx) => {
        const w = rowWidths[crIdx]!
        for (const [text, , start] of catParsed) {
          if (start === 0 || !text) continue
          const existing = posMap.get(start)
          if (!existing) posMap.set(start, [text, w])
          else {
            const [existingText, existingW] = existing
            if (w > existingW) {
              // New row is wider, it wins
              displaced.push(existingText)
              posMap.set(start, [text, w])
            } else if (w < existingW) {
              // Existing row is wider, it keeps the position
              displaced.push(text)
            } else {
              // Same width — later row overrides (more specific)
              displaced.push(existingText)
              posMap.set(start, [text, w])
            }
          }
        }
      })

      if (posMap.size) {
        // Collect headers in position order
        const finalHeaders = [...posMap.keys()].sort((a, b) => a - b).map((p) => posMap.get(p)![0])
        // Append displaced texts at the end
        finalHeaders.push(...displaced)

        const nCols = finalHeaders.length
        const headerLayers: string[][] = []

        if (titlePeriodTexts.length) {
          const superRow = ['', titlePeriodTexts[titlePeriodTexts.length - 1]!, ...Array.from({ length: nCols - 1 }, () => '')]
          headerLayers.push(superRow)
        }

        headerLayers.push([firstColLabel, ...finalHeaders])
        return [headerLayers, headerRowCount]
      }
    }

    // No year rows. If ≥ 2 category rows form a staircase (first row has
    // all cells in data columns with uniform colspan, like "0 - 6" / "6 - 12"
    // split from "Months" / "Months" below), merge them into one header row.
    if (categoryRows.length >= 2) {
      const firstCatParsed = categoryRows[0]![1]
      const firstNe = firstCatParsed.filter(([t]) => strip(t))
      const firstIsStaircaseTop = firstNe.length > 0 && firstNe.every(([, , s]) => s > 0) && new Set(firstNe.map(([, c]) => c)).size === 1 && firstNe[0]![1] >= 2
      if (firstIsStaircaseTop) {
        const smRows: Map<number, [string, number]>[] = []
        for (const [, catParsed] of categoryRows) {
          const sm = new Map<number, [string, number]>()
          for (const [text, colspan, start] of catParsed) {
            const t = strip(text.replace(/[\u{200b}\u{200c}\u{feff}]/gu, ''))
            if (t) sm.set(start, [t, start + colspan - 1])
          }
          if (sm.size) smRows.push(sm)
        }
        if (smRows.length) {
          const leafPos = [...new Set(smRows.flatMap((sm) => [...sm.keys()]))].filter((p) => p > 0).sort((a, b) => a - b)
          if (leafPos.length >= 1) {
            const mergedCols: string[] = []
            for (const lp of leafPos) {
              const parts: string[] = []
              let lastPart: string | null = null
              for (const sm of smRows) {
                for (const [s, [txt, end]] of sm) {
                  if (s <= lp && lp <= end) {
                    if (txt !== lastPart) {
                      parts.push(txt)
                      lastPart = txt
                    }
                    break
                  }
                }
              }
              mergedCols.push(parts.length ? parts.join(' ') : '')
            }
            // Label column: staircase-merge texts at position 0
            const firstColParts: string[] = []
            let lastFc: string | null = null
            for (const sm of smRows) {
              const zero = sm.get(0)
              if (zero) {
                const txt = zero[0]
                if (txt !== lastFc) {
                  firstColParts.push(txt)
                  lastFc = txt
                }
              }
            }
            const firstCol = firstColParts.join(' ')
            return [[[firstCol, ...mergedCols]], headerRowCount]
          }
        }
      }
    }
    // Still no headers — fall back
    return [null, 0]
  }

  const numHeaders = columnHeadersList.length

  // Check for "year-as-super-header" pattern:
  // Row 0: years with LARGE colspan (e.g., "2003" cs=5, "2002" cs=5)
  //   OR full dates with LARGE colspan (e.g., "January 26, 2025" cs=5)
  // Row 1: sub-headers with smaller colspan (e.g., "BENEFIT OBLIGATION" cs=2)
  // Result: merge year/date + sub-header -> "2003 BENEFIT OBLIGATION", etc.
  let yearSuperHeaders: [string, number, number][] = [] // [(year_text, start_col, end_col), ...]
  for (const [, parsed] of yearRows) {
    for (const [text, colspan, start] of parsed) {
      if (!text) continue
      // Skip first-column labels, but allow years at position 0
      if (start === 0 && !isYear(text)) continue
      const textClean = text.replace(BR_RE, ' ')
      // Bare year (e.g. "2007") OR full date (e.g. "November 26, 2007")
      const isStrongDate = isYear(text) || new RegExp(raw`(${MONTHS_PATTERN})\s+\d{1,2},?\s*(19|20)\d{2}`, 'i').test(textClean)
      // "Month YYYY" (no day) or "As of Month YYYY" — also a date
      const isMonthYear = new RegExp(raw`(As\s+of\s+)?(${MONTHS_PATTERN})\s+(19|20)\d{2}\b`, 'i').test(textClean)
      // Require colspan > 2 for bare dates; >= 2 is enough when the
      // match is explicit (month+year or full date) since gutter tables
      // pack one data column into cs=2.
      if ((isStrongDate && colspan > 2) || ((isStrongDate || isMonthYear) && colspan >= 2)) yearSuperHeaders.push([text, start, start + colspan])
    }
  }

  // Guard: if category rows have LARGER colspans than the year
  // super-headers, then years are children of the categories, not
  // super-headers.  E.g. "Three Months Ended May" cs=7 contains
  // "1999" cs=3 and "1998" cs=3.  The standard category-distribution
  // path handles this correctly.
  // Check ALL non-empty cells in category rows (not just those passing
  // is_category_text), since period phrases like "Three Months Ended
  // October 31," are valid category headers but may fail the strict
  // is_category_text check due to trailing numbers/punctuation.
  if (yearSuperHeaders.length && categoryRows.length) {
    const maxYearCs = Math.max(...yearSuperHeaders.map(([, start, end]) => end - start))
    let maxCatCs = 0
    for (const [, catParsed] of categoryRows) {
      for (const [t, c, s] of catParsed) if (t && s > 0 && c > maxCatCs) maxCatCs = c
    }
    if (maxCatCs > maxYearCs) yearSuperHeaders = [] // Not really super-headers
  }

  // Allow the path even when header_info has only the year row itself
  // (no other rows classified as headers) — the lookahead block below will
  // discover staircase rows that failed is_header_row (e.g. "Assets / 0-6 / 6-12"
  // which has a label at col 0 and non-category column text).
  if (yearSuperHeaders.length && headerInfo.length >= 1) {
    const yearRowIndices = new Set(yearRows.map(([idx]) => idx))

    // Pattern for words that are just date-label fragments (not real sub-headers).
    // A row made entirely of these is a continuation of a year label split
    // across two HTML rows (e.g., "As of" in row N, "November 2007" in row N+1).
    const dateFragRe = new RegExp(raw`^(as(\s+of)?|of|through|ended|and|or)$|^${MONTHS_PATTERN}$|^(19|20)\d{2}$`, 'i')

    /** Return True if every non-empty text cell is a bare date word fragment. */
    const isYearLabelFragRow = (parsedRow: Parsed[]): boolean => {
      const textVals = parsedRow.filter(([txt]) => txt && strip(txt) && /[A-Za-z]/.test(txt)).map(([txt]) => strip(txt))
      if (textVals.length === 0) return false
      return textVals.every((v) => dateFragRe.test(v))
    }

    // Collect all non-year header rows found during the initial scan,
    // also excluding rows that are purely year-label fragment rows.
    const subRows: [number, Parsed[]][] = headerInfo.filter(([idx, parsed]) => !yearRowIndices.has(idx) && !isYearLabelFragRow(parsed)).map(([idx, parsed]) => [idx, parsed])

    // Look ahead past header_row_count for additional staircase rows that
    // is_category_text() missed (e.g. "Owned, at", "Purchased, at" contain
    // commas which break the category-text regex).  Stop at first data row.
    let lookaheadCount = headerRowCount
    for (let extraIdx = headerRowCount; extraIdx < Math.min(headerRowCount + 10, parsedRows.length); extraIdx++) {
      const extraParsed = parsedRows[extraIdx]!
      const extraNe = extraParsed.filter(([t]) => t && strip(t))
      if (extraNe.length === 0) continue // blank spacer row — keep looking
      // Any purely numeric cell means we have hit a data row
      const hasNumeric = extraNe.some(([t]) => NUMERIC_CELL_RE.test(t))
      if (hasNumeric) break
      // Credit-rating / status values at data columns (start > 0) also
      // signal a data row.  These are short alphanumeric codes like F1,
      // A+, AA-, P-1, Stable, N/A that appear in ratings tables but are
      // NOT recognized by the numeric pattern above.
      const ratingRe = /^(?:[A-Z]{1,3}[+-]|[A-Z]{1,2}-\d|F\d[+-]?|[A-Z][a-z]{1,3}\d|Prime-\d)$/
      const statusWords = new Set(['stable', 'positive', 'negative', 'watch', 'developing', 'n/a', 'nm', 'nr', 'wd'])
      const hasRatingData = extraNe.filter(([, , s]) => s > 0).some(([t]) => ratingRe.test(t) || ['N/A', 'NM', 'NR', 'WD'].includes(t.toUpperCase()) || statusWords.has(t.toLowerCase())) // only data columns, not the label column
      if (hasRatingData) break
      // Skip year-label fragment rows in the lookahead too
      if (isYearLabelFragRow(extraParsed)) continue
      // Must contain at least some letter-bearing cells (not just blanks/punct)
      const textCells = extraNe.filter(([t]) => /[A-Za-z]/.test(t))
      if (textCells.length) {
        subRows.push([extraIdx, extraParsed])
        lookaheadCount = extraIdx + 1
      }
    }

    if (subRows.length) {
      // Build per-row start-maps: col_start -> (text, inclusive_end)
      const rowStartMaps: Map<number, [string, number]>[] = []
      for (const [, subParsedRow] of subRows) {
        const sm = new Map<number, [string, number]>()
        for (const [text, colspan, start] of subParsedRow) {
          const t = visible(text)
          if (t && /[A-Za-z]/.test(t)) sm.set(start, [t, start + colspan - 1])
          else if (t && !NUMERIC_CELL_RE.test(t)) {
            // Also include non-alpha cells that are NOT plain financial
            // data — e.g. maturity-range labels like "0 - 6", "1 - 5".
            sm.set(start, [t, start + colspan - 1])
          }
        }
        if (sm.size) rowStartMaps.push(sm)
      }

      if (rowStartMaps.length) {
        // Leaf positions = union of all non-empty cell starts across
        // every staircase row — ensures cells that only appear in one
        // row (e.g. "Total" in the bottom leaf row) are not missed.
        // Always exclude position 0: it is the label/row-header column.
        const leafPositionsSub = [...new Set(rowStartMaps.flatMap((sm) => [...sm.keys()]))].filter((p) => p > 0).sort((a, b) => a - b)

        if (leafPositionsSub.length >= 2) {
          // For each leaf position, walk every staircase row top-to-
          // bottom collecting the cell that covers that position.
          // Consecutive duplicates are suppressed so parent "2007"
          // spanning both sub-columns doesn't repeat within a column.
          // Date-fragment words (bare month names, "As of", "of" etc.)
          // are skipped — they are split pieces of the year super-header
          // label and must not contaminate sub-column names.
          const mergedSubs: string[] = []
          for (const leafPos of leafPositionsSub) {
            const parts: string[] = []
            let lastText: string | null = null
            for (const sm of rowStartMaps) {
              for (const [start, [text, end]] of sm) {
                if (start <= leafPos && leafPos <= end) {
                  if (!dateFragRe.test(text) && text !== lastText) {
                    parts.push(text)
                    lastText = text
                  }
                  break
                }
              }
            }
            mergedSubs.push(parts.length ? parts.join(' ') : '')
          }

          // Determine whether position 0 is a label column.
          // Merge staircase texts at position 0 the same way
          // data columns do — e.g. "Assets" / "Contract Type"
          // across two rows → "Assets Contract Type".
          const firstColParts: string[] = []
          let lastFirstCol: string | null = null
          for (const sm of rowStartMaps) {
            const zero = sm.get(0)
            if (zero) {
              const fcText = zero[0]
              if (!dateFragRe.test(fcText) && fcText !== lastFirstCol) {
                firstColParts.push(fcText)
                lastFirstCol = fcText
              }
            }
          }
          const firstColLabel = firstColParts.length ? firstColParts.join(' ') : ''

          // Build year layer using position-based assignment:
          // assign the year label to the FIRST leaf under each span,
          // and "" for subsequent leaves under the same span.
          // This correctly handles uneven splits like 4+1 rather
          // than assuming equal distribution.

          // Check whether this is a one-to-one mapping: every year
          // span covers exactly ONE leaf position.  In that case the
          // year cell and the sub-header cell at the same position
          // together form ONE column name (e.g. "As of" + "November
          // 2007" → "As of November 2007").  Producing a two-layer
          // structure would split them inappropriately.
          const leavesPerSpan = yearSuperHeaders.map(([, ys, ye]) => leafPositionsSub.filter((lp) => ys <= lp && lp < ye).length)
          const allOneToOne = leavesPerSpan.every((v) => v === 1)

          if (allOneToOne) {
            // Single-layer mode: merge ALL staircase rows (sub-rows
            // AND the year row) vertically per column position,
            // without filtering date-fragment words — they are
            // legitimate parts of the column label here.
            const allStaircase = [...subRows, ...yearRows].sort((a, b) => a[0] - b[0])
            const flatMaps: Map<number, [string, number]>[] = []
            for (const [, rowParsed] of allStaircase) {
              const sm = new Map<number, [string, number]>()
              for (const [txt, cs, st] of rowParsed) {
                const t = strip(txt.replace(/[\u{200b}\u{200c}\u{feff}]/gu, ''))
                if (t && /[A-Za-z0-9]/.test(t) && !NUMERIC_CELL_RE.test(t)) sm.set(st, [t, st + cs - 1])
              }
              if (sm.size) flatMaps.push(sm)
            }

            const flatSubs: string[] = []
            for (const leafPos of leafPositionsSub) {
              const parts: string[] = []
              let last: string | null = null
              for (const sm of flatMaps) {
                for (const [s, [t, end]] of sm) {
                  if (s <= leafPos && leafPos <= end) {
                    if (t !== last) {
                      parts.push(t)
                      last = t
                    }
                    break
                  }
                }
              }
              flatSubs.push(parts.length ? parts.join(' ') : '')
            }

            // Label column: merge position-0 texts from all rows
            const fcParts: string[] = []
            let lastFc: string | null = null
            for (const sm of flatMaps) {
              const zero = sm.get(0)
              if (zero) {
                const t = zero[0]
                if (t !== lastFc) {
                  fcParts.push(t)
                  lastFc = t
                }
              }
            }
            const firstCol = fcParts.join(' ')

            return [[[firstCol, ...flatSubs]], Math.max(headerRowCount, lookaheadCount)]
          }

          const yearRow = [firstColLabel]
          const seenYears = new Set<string>()
          for (const leafPos of leafPositionsSub) {
            let assignedYear = ''
            for (const [yearText, yearStart, yearEnd] of yearSuperHeaders) {
              if (yearStart <= leafPos && leafPos < yearEnd) {
                if (!seenYears.has(yearText)) {
                  assignedYear = yearText
                  seenYears.add(yearText)
                }
                break
              }
            }
            yearRow.push(assignedYear)
          }

          const subHeaderRowData = [firstColLabel, ...mergedSubs]
          return [[yearRow, subHeaderRowData], Math.max(headerRowCount, lookaheadCount)]
        }
      }
    }
  }

  // Extract categories with their positions, then merge vertically
  // Categories at same position merge: "EQUIPMENT" + "OPERATIONS" -> "EQUIPMENT OPERATIONS"
  // Only include cells with LARGE colspan (spanning multiple year columns)
  const positionTexts = new Map<number, string[]>() // col_pos -> [text1, text2, ...]
  const positionColspans = new Map<number, number>() // col_pos -> colspan

  for (const [, parsed] of categoryRows) {
    for (const [text, colspan, start] of parsed) {
      // Category headers must have large colspan (> 2) to span header columns
      if (text && colspan > 2 && start > 0 && (isCategoryText(text) || new RegExp(raw`(months?|quarters?|years?|weeks?)\s+ended|ended\s+${MONTHS_PATTERN}`, 'i').test(text))) {
        // Clean <br> tags from category text
        let cleanText = strip(text.replace(BR_RE, ' '))
        cleanText = cleanText.replace(/\s+/g, ' ')
        if (!positionTexts.has(start)) {
          positionTexts.set(start, [])
          positionColspans.set(start, colspan)
        } else {
          // Using the large parent colspan would incorrectly let the
          // first child gobble up headers belonging to siblings.
          positionColspans.set(start, Math.min(positionColspans.get(start)!, colspan))
        }
        positionTexts.get(start)!.push(cleanText)
      }
    }
  }

  // Build merged categories in position order
  const sortedPositions = [...positionTexts.keys()].sort((a, b) => a - b)
  const categories: string[] = [] // [(merged_name, num_years_under), ...]

  for (const pos of sortedPositions) {
    const mergedName = positionTexts.get(pos)!.join(' ')
    // Estimate headers under this category by colspan ratio
    // If all categories have same colspan, headers are evenly distributed
    categories.push(mergedName)
  }

  // Collect "orphan" header cells from category rows — cells at
  // start > 0 that are NOT categories (failed is_category_text) and
  // NOT inside any recognized category's column span.  These are
  // independent column headers (e.g., "Balance Dec. 31, 2024")
  // that should appear as their own columns in the output.
  const orphanHeaders: [string, number][] = [] // (text, start_pos)
  for (const [, parsed] of categoryRows) {
    for (const [text, , start] of parsed) {
      if (!text || start === 0) continue
      // Skip cells already captured as categories
      if (positionTexts.has(start)) continue
      // Skip cells inside a category span
      let insideCat = false
      for (const catPos of sortedPositions) {
        const catEnd = catPos + positionColspans.get(catPos)!
        if (catPos <= start && start < catEnd) {
          insideCat = true
          break
        }
      }
      if (insideCat) continue
      let cleanText = strip(text.replace(BR_RE, ' '))
      cleanText = cleanText.replace(/\s+/g, ' ')
      if (cleanText) orphanHeaders.push([cleanText, start])
    }
  }

  const numCategories = categories.length
  if (numCategories === 0 && orphanHeaders.length === 0) {
    // No categories - just column headers
    return [[['', ...columnHeadersList]], headerRowCount]
  }

  // When there are orphan headers alongside categories, build a
  // combined position-ordered structure: orphan headers appear as
  // independent leaf columns (1 column each) and categories expand
  // to hold their sub-headers from year_rows.
  if (orphanHeaders.length && numCategories > 0) {
    // Build a unified position list: each entry is either
    // ("orphan", text, start) or ("cat", name, start, colspan)
    const unified: ['orphan' | 'cat', string, number, number][] = []
    for (const [text, pos] of orphanHeaders) unified.push(['orphan', text, pos, 0])
    categories.forEach((catName, catIdx) => {
      const catPos = sortedPositions[catIdx]!
      const catCs = positionColspans.get(catPos)!
      unified.push(['cat', catName, catPos, catCs])
    })
    unified.sort((a, b) => a[2] - b[2]) // sort by start position (stable)

    const catRow = ['']
    const headerRow = ['']

    for (const entry of unified) {
      const kind = entry[0]
      if (kind === 'orphan') {
        const orphanText = entry[1]
        // Orphan headers are independent leaf columns —
        // they appear directly in the header row with empty
        // category text above.
        catRow.push('')
        headerRow.push(orphanText)
      } else {
        const catName = entry[1]
        const catPos = entry[2]
        const catCs = entry[3]
        const catEnd = catPos + catCs

        // Collect year headers whose positions fall within
        // this category's column range.
        const subHdrs: string[] = []
        for (let hi = 0; hi < numHeaders; hi++) {
          if (!columnHeadersPositions.length) break
          const hdrPos = columnHeadersPositions[hi]!
          if (catPos <= hdrPos && hdrPos < catEnd) subHdrs.push(columnHeadersList[hi]!)
        }

        if (subHdrs.length === 0) {
          catRow.push(catName)
          headerRow.push('')
        } else {
          catRow.push(catName)
          for (let k = 0; k < subHdrs.length - 1; k++) catRow.push('')
          for (const sh of subHdrs) headerRow.push(sh)
        }
      }
    }

    return [[catRow, headerRow], headerRowCount]
  }

  // Distribute column headers across categories
  // Use position-based matching when position info is available,
  // otherwise fall back to even distribution
  const catRow = [''] // Start with label column
  const headerRow = [''] // Start with label column

  if (columnHeadersPositions.length && columnHeadersPositions.length === numHeaders) {
    // Position-based distribution: match headers to categories
    // by checking which headers fall within each category's column range
    let headerIdx = 0

    // These are independent data columns (like unit-of-measure)
    // that don't belong under any period category.
    const firstCatPos = sortedPositions.length ? sortedPositions[0]! : 0
    while (headerIdx < numHeaders && columnHeadersPositions[headerIdx]! < firstCatPos) {
      catRow.push('')
      headerRow.push(columnHeadersList[headerIdx]!)
      headerIdx++
    }

    categories.forEach((catName, catIdx) => {
      const catPos = sortedPositions[catIdx]!
      const catCs = positionColspans.get(catPos)!
      const catEnd = catPos + catCs

      // Consume any gap/orphan headers that fall between the
      // previous category's end and this category's start.
      while (headerIdx < numHeaders && columnHeadersPositions[headerIdx]! < catPos) {
        catRow.push('')
        headerRow.push(columnHeadersList[headerIdx]!)
        headerIdx++
      }

      // Collect headers whose positions fall within [cat_pos, cat_end)
      const startIdx = headerIdx
      while (headerIdx < numHeaders) {
        const hdrPos = columnHeadersPositions[headerIdx]!
        if (catPos <= hdrPos && hdrPos < catEnd) headerIdx++
        else break
      }

      const count = headerIdx - startIdx
      if (count === 0) {
        // Category has no sub-headers; add a single empty slot
        catRow.push(catName)
        headerRow.push('')
      } else {
        catRow.push(catName)
        for (let k = 0; k < count - 1; k++) catRow.push('')

        for (let k = 0; k < count; k++) {
          const idx = startIdx + k
          if (idx < columnHeadersList.length) headerRow.push(columnHeadersList[idx]!)
          else headerRow.push('')
        }
      }
    })

    // Append any remaining unmatched headers
    while (headerIdx < numHeaders) {
      catRow.push('')
      headerRow.push(columnHeadersList[headerIdx]!)
      headerIdx++
    }
  } else {
    // Fallback: even distribution when positions not available
    let headersPerCategory = numCategories ? Math.floor(numHeaders / numCategories) : numHeaders
    if (headersPerCategory === 0) headersPerCategory = 1

    let headerIdx = 0
    for (const catName of categories) {
      catRow.push(catName)
      for (let k = 0; k < headersPerCategory - 1; k++) catRow.push('')
      for (let k = 0; k < headersPerCategory; k++) {
        if (headerIdx < columnHeadersList.length) {
          headerRow.push(columnHeadersList[headerIdx]!)
          headerIdx++
        } else headerRow.push('')
      }
    }
  }

  return [[catRow, headerRow], headerRowCount]
}
