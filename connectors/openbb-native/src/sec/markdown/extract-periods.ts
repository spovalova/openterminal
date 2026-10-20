// html2markdown: column headers from header rows, provider sec. Ported from openbb_sec/utils/html2markdown.py
// `extract_periods_from_rows` (OpenBB Platform 5.0.0, Apache-2.0); modified: tuples are arrays.
import { buildColumnHeadersFromColspan } from './column-headers.js'
import { MONTHS_PATTERN, type RowsWithColspan } from './table-clean.js'
import { split, strip } from './py.js'

const raw = String.raw
const ZW4 = /\u{200b}|\u{200c}|\u{200d}|\u{feff}/gu
const NUMERIC_CELL_RE = /^\$?\s*[()]?\s*[\d,]+\.?\d*\s*[)%]?$/

const clean4 = (t: string): string => strip(t.replace(ZW4, ''))

/**
 * Extract column headers from header rows.
 *
 * @param rowsWithCs List of rows, each row is list of (text, colspan) tuples
 * @param rowHasThFlags Optional list of booleans indicating if each row has <th> elements
 *
 * Returns (header_layers, header_row_count) where:
 *     header_layers: list of rows (each row is list of strings for each column)
 *     header_row_count: number of source rows consumed
 *
 * For multi-level headers (e.g., "Equipment Operations" spanning 2025/2024/2023),
 * returns multiple header rows like:
 *     [["", "Equipment Operations", "Equipment Operations", ..., "Financial Services", ...],
 *      ["", "2025", "2024", "2023", "2025", ...]]
 */
export function extractPeriodsFromRows(rowsWithCs: RowsWithColspan, rowHasThFlags: boolean[] | null = null, yearPosShift: number[] | null = null): [string[][], number] {
  if (rowsWithCs.length === 0) return [[], 0]

  // Calculate total columns from first row
  const totalCols = rowsWithCs.length ? rowsWithCs[0]!.reduce((acc, [, cs]) => acc + cs, 0) : 0

  /**
   * Merge consecutive header rows that have text at same column positions.
   *
   * For tables like:
   *     Row 1: "Retail Notes"[cs=2] | "Revolving"[cs=2]
   *     Row 2: "& Financing"[cs=2] | "Charge"[cs=2] | "Wholesale"[cs=2]
   *     Row 3: "Leases"[cs=2] | "Accounts"[cs=2] | "Receivables"[cs=2] | "Total"[cs=2]
   *
   * Merges to: ["Retail Notes & Financing Leases", "Revolving Charge Accounts",
   *            "Wholesale Receivables", "Total"]
   */
  const mergeVerticalHeaders = (rows: RowsWithColspan, totalCols: number, thFlags: boolean[] | null): [string[][] | null, number] => {
    if (rows.length === 0) return [null, 0]

    // Helper to check if text looks like a header (not data, not a year)
    const isHeaderText = (t: string): boolean => {
      if (!t) return false
      // Remove zero-width chars
      t = clean4(t)
      if (!t) return false
      // Years are headers
      if (/^(19|20)\d{2}$/.test(t)) return true
      // Year-range labels like "2009 -", "2011 –", "2013-" are headers
      // (the trailing dash signals the start of a date range spanning the
      // child row, e.g. "2009 - 2010").
      if (/^(19|20)\d{2}\s*[-\u{2013}\u{2014}]/u.test(t)) return true
      // Data patterns - not headers
      if (NUMERIC_CELL_RE.test(t)) return false
      // Single punctuation - not a header
      if (t.length <= 1) return false
      // Numeric range labels like "0 - 6", "6 - 12", "1 - 5" are maturity
      // bucket column headers — they contain no letters but are clearly headers.
      if (/^\d+\s*[-\u{2013}\u{2014}]\s*\d+$/u.test(t)) return true
      // Text with letters is likely a header
      return /[A-Za-z]/.test(t)
    }

    // Helper to check if row is a data row (has numeric values OR rating-like values)
    const isDataRow = (row: [string, number][]): boolean => {
      let colPos = 0
      for (const [text, cs] of row) {
        const t = clean4(text)
        if (t && NUMERIC_CELL_RE.test(t) && !/^(19|20)\d{2}$/.test(t)) {
          // At position 0 (label column), a bare small number
          // (1-3 digits with no financial formatting) may be a
          // rendering artifact rather than a data value.
          if (colPos === 0 && /^\d{1,3}$/.test(t)) {
            colPos += cs
            continue
          }
          // Check if it's a year (years in header rows are ok)
          return true
        }
        // Also check for rating-like values (A+, A1, Prime-1, F1, Stable, etc.)
        // These are alphanumeric but short and look like data, not headers
        if (t && t.length <= 10) {
          // Short alphanumeric codes that are likely ratings/data
          // Examples: A+, A1, Aa1, BBB+, Prime-1, F1, Stable, Positive, Negative
          // IMPORTANT: Must end with a modifier (+/-/digit) to distinguish from words like "Tax"
          if (/^[A-Z][a-z]{0,2}[+-][0-9]?$/.test(t)) return true // A+, Aa+, Baa+
          if (/^[A-Z][a-z]{0,2}[0-9]$/.test(t)) return true // A1, Aa1, Baa1
          if (/^[A-Z]{1,3}[+-]$/.test(t)) return true // AA+, BBB-
          if (/^Prime-\d$/.test(t)) return true // Prime-1
          if (/^[A-Z]\d$/.test(t)) return true // F1
          // Common outlook/status values
          if (['stable', 'positive', 'negative', 'watch', 'developing'].includes(t.toLowerCase())) return true
        }
        colPos += cs
      }
      return false
    }

    // Helper to check if row is a title row (single cell spanning most of table)
    const isTitleRow = (row: [string, number][], totalCols: number): boolean => {
      // Check if this row is a title/description spanning most of the table.
      const nonEmptyCells: [string, number][] = []
      for (const [text, colspan] of row) {
        const t = clean4(text)
        if (t) nonEmptyCells.push([t, colspan])
      }

      // If single text cell spans majority of the table width, it's a title row
      // This catches company names, statement titles, period descriptions, etc.
      if (nonEmptyCells.length === 1) {
        const colspan = nonEmptyCells[0]![1]
        // Single cell spanning >= 40% of columns is a title/category row
        // Lower threshold to catch super-headers like "Total Stockholders' Equity"
        if (colspan >= totalCols * 0.4) return true
      }
      return false
    }

    // Find consecutive header rows (non-empty, non-data rows)
    const headerRows: [number, [string, number][]][] = []

    // Only use <th>/<td> as a hard "data row" signal when the table mixes
    // them.  Old SEC HTML often uses <td> for every cell — including headers
    // — so when every row is all-<td> we must rely on is_data_row() alone.
    const someThRows = !!(thFlags && thFlags.some((f) => f))

    for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
      const row = rows[rowIdx]!
      // In tables that mix <th> and <td>, a row with only <td> cells is
      // definitely a data row — stop collecting headers here.
      if (someThRows && thFlags !== null && rowIdx < thFlags.length && !thFlags[rowIdx]) {
        // Row has only <td> elements in a table that mixes th/td - data row
        break
      }

      // Check for empty row
      const hasContent = row.some(([text]) => isHeaderText(text))
      if (!hasContent) continue

      // Check if this is a data row
      if (isDataRow(row)) break

      // Skip title/description rows that span most of the table
      if (isTitleRow(row, totalCols)) continue

      // Check if this is a section label in column 0 (like "Assets:" or "Liabilities:")
      // Section labels can have colspan > 1 for formatting but are still a single label
      const nonEmptyCells: [string, number, number][] = []
      row.forEach(([text, cs], idx) => {
        const tt = strip(text.replaceAll('\u{200b}', ''))
        if (tt) nonEmptyCells.push([tt, cs, idx])
      })
      if (nonEmptyCells.length === 1) {
        const [text, cs, cellIdx] = nonEmptyCells[0]!
        // Section label detection:
        // 1. Single non-empty cell at the start of the row (first few positions)
        // 2. Text ends with ":" (like "Assets:", "Liabilities and Equity:")
        // 3. OR small colspan (1-3) in first position - generic label
        // BUT: Don't treat years as section labels - they're data markers
        const isYearLabel = /^(19|20)\d{2}$/.test(strip(text))
        let isSectionLabel = false
        if (!isYearLabel && (cellIdx === 0 || cs >= 2)) {
          // First cell or spanning cell
          if (text.endsWith(':')) {
            // Explicit section label like "Assets:" or "Liabilities:"
            isSectionLabel = true
          } else if (cs <= 3 && cellIdx === 0) {
            // Small colspan single text at start - likely a label
            isSectionLabel = true
          }
        }

        if (isSectionLabel) {
          if (headerRows.length) break
          continue
        }
      }

      headerRows.push([rowIdx, row])
    }

    // Need at least 2 header rows for vertical merging to be useful
    if (headerRows.length < 2) return [null, 0]

    // Build per-row cell maps: start_pos -> (text, end_pos_inclusive)
    //
    // We intentionally store only the START position of each cell (not all
    // positions within its span).  Parent cells like "2007" (colspan=6) and
    // child cells like "Instruments" (colspan=2) therefore get distinct
    // entries at their respective starting positions.  The "covers" check
    // below (start <= leaf_pos <= end) is then used to find the cell that
    // covers any given leaf column position.
    const rowCellStartMaps: Map<number, [string, number]>[] = []
    for (const [, row] of headerRows) {
      const startMap = new Map<number, [string, number]>()
      let colPos = 0
      for (const [text, colspan] of row) {
        const t = clean4(text)
        if (t && isHeaderText(t)) {
          // (text, inclusive_end_position)
          startMap.set(colPos, [t, colPos + colspan - 1])
        }
        colPos += colspan
      }
      if (startMap.size) rowCellStartMaps.push(startMap)
    }

    if (rowCellStartMaps.length === 0) return [null, 0]

    // Leaf column positions = the UNION of all cell starting positions across
    // every header row.  Using the union (rather than just the row with the
    // most cells) ensures we capture columns that only appear in some rows.
    const leafPositions = [...new Set(rowCellStartMaps.flatMap((m) => [...m.keys()]))].sort((a, b) => a - b)

    if (leafPositions.length === 0 || leafPositions.length < 2) return [null, 0]

    // For each leaf position, walk all header rows top-to-bottom and collect
    // the text of the cell that COVERS that position
    // (i.e. cell_start <= leaf_pos <= cell_end).  Consecutive identical
    // texts are deduplicated so a parent "2007" that covers multiple leaf
    // columns doesn't repeat within the merged string for a single column.
    const mergedHeaders: string[] = []
    for (const leafPos of leafPositions) {
      const parts: string[] = []
      let lastText: string | null = null
      for (const sm of rowCellStartMaps) {
        for (const [start, [text, end]] of sm) {
          if (start <= leafPos && leafPos <= end) {
            if (text !== lastText) {
              parts.push(text)
              lastText = text
            }
            break // only one cell can cover a position per row
          }
        }
      }
      if (parts.length) mergedHeaders.push(parts.join(' '))
    }

    if (mergedHeaders.length === 0) return [null, 0]

    // If position 0 is not a leaf column it is the empty label column.
    const isLabelCol = !leafPositions.includes(0)

    // Return as a single merged header layer.
    const headerRowCount = Math.max(...headerRows.map(([rowIdx]) => rowIdx)) + 1
    const prefix = isLabelCol ? [''] : []
    return [[[...prefix, ...mergedHeaders]], headerRowCount]
  }

  // Try multi-level header extraction first
  let [headerLayers, headerRowCount] = buildColumnHeadersFromColspan(rowsWithCs, yearPosShift)
  // Only attempt vertical merging when build_column_headers_from_colspan found
  // nothing.  If it already returned a proper multi-layer result (e.g. 2007/2006
  // parent rows spanning child sub-headers) we must NOT flatten it into a single
  // merged row — that destroys the multi-index structure the caller depends on.
  let verticalHeaders: string[][] | null = null
  let verticalRowCount = 0
  const colspanHasYearRangeFragments =
    headerLayers !== null &&
    headerLayers.length === 1 &&
    headerLayers[0]!.filter((h) => h).some(
      // Match incomplete year-range fragments like "2009 -" that need
      // merging with a row below (e.g. "2010"), but NOT complete ranges
      // like "2027-2028" or "2029 - 2030" which are valid headers.
      (h) => /^(19|20)\d{2}\s*[-\u{2013}\u{2014}]/u.test(strip(h)) && !/^(19|20)\d{2}\s*[-\u{2013}\u{2014}]\s*(19|20)\d{2}$/u.test(strip(h)),
    )
  if (headerRowCount === 0 || colspanHasYearRangeFragments) {
    // Also try vertical header merging for two cases:
    //   1. Colspan extraction found nothing (header_row_count == 0).
    //      Example: "2009 -" / "2010" stacked → merged to "2009 - 2010"
    //   2. Colspan returned a flat single-layer with incomplete year-range fragments
    //      like "2009 -" (companion row wasn't merged by the month-year logic).
    //      Vertical merging will produce the correct e.g. "2009 - 2010" strings.
    if (colspanHasYearRangeFragments) {
      // Discard the useless flat result so the vertical output wins below
      headerLayers = null
      headerRowCount = 0
    }
    ;[verticalHeaders, verticalRowCount] = mergeVerticalHeaders(rowsWithCs, totalCols, rowHasThFlags)
  }
  // Decide which approach produced better headers
  // Prefer vertical merge if it created multi-word headers (indicating successful merge)
  let useVertical = false

  const multiWord = (layers: string[][]): boolean => layers.some((layer) => layer.some((h) => h && !/^[()]*$/.test(h) && !/^(19|20)\d{2}$/.test(h) && split(h).length >= 2))

  if (verticalHeaders && verticalHeaders.length && verticalRowCount > 0) {
    // Check if vertical merge created multi-word headers
    const verticalMultiWord = multiWord(verticalHeaders)

    // Check if build_column_headers_from_colspan produced multi-word headers
    let colspanMultiWord = false
    if (headerLayers && headerLayers.length) colspanMultiWord = multiWord(headerLayers)

    // Prefer vertical if it merged headers but colspan approach didn't
    if (verticalMultiWord && !colspanMultiWord) useVertical = true
    // Also prefer vertical if it has more non-year headers (better merging)
    else if (verticalMultiWord) {
      const verticalNonYear = verticalHeaders.reduce((acc, layer) => acc + layer.filter((h) => h && !/^(19|20)\d{2}$/.test(strip(h))).length, 0)
      const colspanNonYear = headerLayers && headerLayers.length ? headerLayers.reduce((acc, layer) => acc + layer.filter((h) => h && !/^(19|20)\d{2}$/.test(strip(h))).length, 0) : 0
      if (verticalNonYear >= colspanNonYear) useVertical = true
    }
  }

  if (useVertical && verticalHeaders) {
    // Validate: check for years/periods or financial terms
    const allHeaderText = verticalHeaders.flat().join(' ')
    const hasYearInHeaders = /\b(19|20)\d{2}\b/.test(allHeaderText)
    const hasPeriodInHeaders = /(months?\s+ended|year\s+ended|weeks?\s+ended|quarter|period|fiscal)/i.test(allHeaderText)
    const hasYearInRows = rowsWithCs.slice(0, verticalRowCount).some((row) => row.some(([text]) => /\b(19|20)\d{2}\b/.test(text)))
    const hasYearAfterHeaders = verticalRowCount < rowsWithCs.length ? rowsWithCs.slice(verticalRowCount, verticalRowCount + 2).some((row) => row.some(([text]) => /\b(19|20)\d{2}\b/.test(text))) : false

    // Check for financial terms
    const financialTerms = [
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
      raw`\bweighted\b`,
      raw`\baverage\b`,
      raw`\baggregate\b`,
      raw`\bintrinsic\b`,
      raw`\bcontractual\b`,
      raw`\bremaining\b`,
      raw`\bexercisable\b`,
      raw`\bAmount\b`,
      raw`\bCredit\b`,
      raw`\bDebit\b`,
      raw`\bBalance\b`,
      raw`\bReceivables?\b`,
      raw`\bLeases?\b`,
      raw`\bNotes?\b`,
      raw`\bAccounts?\b`,
      raw`\bWholesale\b`,
      raw`\bRetail\b`,
      raw`\bFinancing\b`,
      raw`\bTotal\b`,
      raw`\bAllowance\b`,
      raw`\bProvision\b`,
      raw`\bRevolving\b`,
      raw`\bTax\b`,
      raw`\bExpense\b`,
      raw`\bIncome\b`,
      raw`\bLoss\b`,
      raw`\bGain\b`,
    ]
    const hasFinancialTerms = financialTerms.some((term) => new RegExp(term, 'i').test(allHeaderText))

    const mergedMultiWord = verticalHeaders.some((layer) => layer.some((h) => h && !/^[()]*$/.test(h) && split(h).length >= 2))

    if (hasYearInHeaders || hasPeriodInHeaders || hasYearInRows || hasYearAfterHeaders) return [verticalHeaders, verticalRowCount]

    if (mergedMultiWord && hasFinancialTerms) return [verticalHeaders, verticalRowCount]
  }

  // Fall back to colspan-based headers if available
  if (headerLayers && headerLayers.length && headerRowCount > 0) {
    // Check if we have meaningful multi-level headers
    // Look for years in any layer
    let hasYears = false

    for (const layer of headerLayers) {
      for (const h of layer) {
        if (/\b(19|20)\d{2}\b/.test(h)) {
          hasYears = true
          break
        }
      }

      if (hasYears) break
    }

    if (hasYears && headerLayers.length >= 1) return [headerLayers, headerRowCount]
  }

  // Fall back to original single-row logic
  let periodPrefixes: string[] = []
  let years: string[] = []
  let genericHeaders: string[] = []
  let fullDateHeaders: string[] = []
  let subHeaders: string[] = []
  let periodParts: string[] = []
  let endedParts: string[] = []
  let asOfPrefix = ''

  // Only look at first 10 rows for headers (not data rows at the bottom)
  for (let rowIdx = 0; rowIdx < Math.min(10, rowsWithCs.length); rowIdx++) {
    const row = rowsWithCs[rowIdx]!
    const texts = row.map(([t]) => strip(t)).filter((t) => t)
    if (texts.length === 0) continue

    const rowText = texts.join(' ')

    // Look for period descriptions (e.g., "Three Months Ended May")
    if (/(months?\s+ended|year\s+ended|quarter\s+ended|weeks?\s+ended)/i.test(rowText)) {
      const prefixes = texts.filter((t) => /(months?|year|quarter|weeks?)\s+ended/i.test(t))
      if (prefixes.length) periodPrefixes = prefixes
    }

    // Check individual cells, not the joined row_text
    const periodCellMatches = texts.filter((t) => /^(Three|Six|Nine|Twelve|[1-9]|[1-4]\d|5[0-3])\s+(Months?|Weeks?|Week Ended)$/i.test(t) || /^(Fiscal\s+)?(Year|Quarter)$/i.test(t))

    if (periodCellMatches.length) periodParts = periodCellMatches

    // Look for "Ended May" or "Ended" continuation row
    const endedCellMatches = texts.filter((t) => /^Ended\b/i.test(t))

    if (endedCellMatches.length && periodParts.length) {
      endedParts = endedCellMatches
      // Combine with period_parts to make full prefixes
      if (endedParts.length === periodParts.length) {
        periodPrefixes = periodParts.map((p, i) => `${p} ${endedParts[i]}`)
      } else if (endedParts.length === 1) {
        // Same "Ended X" for all periods
        periodPrefixes = periodParts.map((p) => `${p} ${endedParts[0]}`)
      }
    }

    // Look for "As of" prefix row (for balance sheets)
    if (/^As\s+of$/i.test(rowText)) asOfPrefix = 'As of'

    // These are Month + Year in a single cell (possibly with "As of" prefix)
    const datePattern = new RegExp(raw`^(As\s+of\s+)?(${MONTHS_PATTERN})\s+((?:19|20)\d{2})$`, 'i')
    const dateMatches = texts.filter((t) => datePattern.test(t))
    if (dateMatches.length >= 2) fullDateHeaders = dateMatches

    // Look for sub-headers like "Assets | Liabilities" that should combine with parent headers
    // These typically appear in rows with repeating short column labels
    const subHeaderPattern = /^(Assets|Liabilities|Actual|Pro\s*Forma|Adjustments)$/i
    const subMatches = texts.filter((t) => subHeaderPattern.test(t))
    if (subMatches.length >= 2) subHeaders = subMatches

    // Look for years - but only standalone years, not years in parentheses (effective dates)
    // or years embedded in long descriptive text
    const yearCells: string[] = []
    for (const t of texts) {
      // Skip cells that are too long to be column headers
      if (t.length > 50) continue
      // Skip cells with years in parentheses like "(2020)" - these are effective dates
      if (/\(\d{4}\)/.test(t)) continue
      // Skip cells where year is part of a longer descriptive header
      // like "Executive Contributions in FY 2025 ($)" or "Aggregate Balance at FY 2025-end"
      // These are descriptive column headers, not year column headers
      if (t.length > 20 && /(contributions?|balance|earnings|aggregate|withdrawals?|distributions?)/i.test(t)) continue
      // Skip cells that are full dates (e.g., "April 7, 2025")
      // These are data values, not year column headers
      if (new RegExp(raw`^(${MONTHS_PATTERN})\s+\d{1,2},?\s*(19|20)\d{2}`, 'i').test(t)) continue
      // Look for standalone years or years in simple header formats
      const match = /\b((?:19|20)\d{2})\b/.exec(t)
      if (match) yearCells.push(match[1]!)
    }
    if (yearCells.length >= 2 && years.length === 0) years = yearCells

    // Look for generic column headers ONLY in first few rows
    // Must be: non-numeric text, multiple items, short length, row has no data
    if (rowIdx < 5 && genericHeaders.length === 0) {
      // Skip descriptor rows like "(in millions...)"
      if (rowText.startsWith('(')) continue
      // Skip rows with numbers that look like data (commas in numbers or decimals)
      if (/\d{1,3}(,\d{3})+|\d+\.\d{2}/.test(rowText)) continue
      // Candidates: short text items that are not numbers
      const candidates = texts.filter((t) => t.length >= 2 && t.length <= 30 && !/^[\d.,x-]+$/.test(t) && !t.startsWith('('))
      if (candidates.length >= 2) {
        // Check if these look like headers (mostly alphabetic)
        const alphaCount = candidates.filter((c) => /^[A-Za-z]/.test(c)).length
        if (alphaCount >= 2) genericHeaders = candidates
      }
    }
  }

  // Priority 1: Full date headers with sub-headers (e.g., "As of May 1999" + "Assets/Liabilities")
  if (fullDateHeaders.length && subHeaders.length) {
    // Combine parent headers with sub-headers
    const combined: string[] = []
    const subsPerParent = Math.floor(subHeaders.length / fullDateHeaders.length)

    if (subsPerParent > 0) {
      fullDateHeaders.forEach((parent, i) => {
        for (let j = 0; j < subsPerParent; j++) {
          const subIdx = i * subsPerParent + j
          if (subIdx < subHeaders.length) combined.push(`${parent} ${subHeaders[subIdx]}`)
        }
      })

      if (combined.length) {
        // Return as two rows: parent row and sub row
        const parentRow = ['']
        const subRow = ['']

        fullDateHeaders.forEach((parent, i) => {
          for (let j = 0; j < subsPerParent; j++) {
            parentRow.push(parent)
            const subIdx = i * subsPerParent + j
            if (subIdx < subHeaders.length) subRow.push(subHeaders[subIdx]!)
          }
        })

        return [[parentRow, subRow], 2]
      }
    }
  }

  // Priority 2: Full date headers without sub-headers
  if (fullDateHeaders.length) {
    const headers = asOfPrefix ? fullDateHeaders.map((d) => `${asOfPrefix} ${d}`) : fullDateHeaders
    return [[['', ...headers]], 1]
  }

  // Priority 3: Combine prefixes with years
  if (periodPrefixes.length && years.length) {
    // Check if prefixes already contain years (e.g., "For the Three Months Ended January 26, 2025")
    // Count how many years are mentioned in the prefixes
    const prefixYearCounts: number[] = []

    for (const p of periodPrefixes) {
      const yearMatches = p.match(/\b(19|20)\d{2}\b/g) ?? []
      prefixYearCounts.push(yearMatches.length)
    }

    // If any prefix contains multiple years (describes multiple periods),
    // skip using prefixes and just use the years
    if (prefixYearCounts.some((count) => count > 1)) return [[['', ...years]], 1]

    // If each prefix has exactly one year and matches the number of years,
    // use prefixes directly (they're full period descriptions)
    if (prefixYearCounts.every((count) => count === 1) && periodPrefixes.length === years.length) return [[['', ...periodPrefixes]], 1]

    const periods: string[] = []
    let prefixIdx = 0

    years.forEach((year, i) => {
      if (prefixIdx < periodPrefixes.length) {
        const prefix = periodPrefixes[prefixIdx]!
        // Only append year if prefix doesn't already have it
        if (!new RegExp(raw`\b${year}\b`).test(prefix)) periods.push(`${prefix} ${year}`)
        else periods.push(prefix)
        // Advance prefix index every N years based on ratio
        const yearsPerPrefix = Math.floor(years.length / periodPrefixes.length)
        if (yearsPerPrefix > 0 && (i + 1) % yearsPerPrefix === 0) prefixIdx++
      } else periods.push(year)
    })
    return [[['', ...periods]], 1]
  }

  if (years.length) return [[['', ...years]], 1]

  if (genericHeaders.length) {
    // No financial periods, use generic headers
    return [[['', ...genericHeaders]], 1]
  }

  return [[], 0]
}
