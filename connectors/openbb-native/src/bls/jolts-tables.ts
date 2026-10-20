// bls/jolts/change_analysis and bls/jolts/revisions, provider bls. Ported from openbb_bls/models/jolts_tables.py,
// jolts_revisions.py and utils/jolts_tables.py (OpenBB Platform 5.0.0, Apache-2.0); modified: readXlsx instead of
// openpyxl, plain rows.
import type { Cell } from '../lib/xlsx.js'
import type { NativeCtx, NativeHandler, NativeParams, Row } from '../types.js'
import { BLS_USER_AGENT, decodeHtml, fetchFile, isoDate, loadSheets } from './helpers.js'

const BASE_NATIONAL = 'https://www.bls.gov/web/jolts'
const BASE_STATE = 'https://www.bls.gov/web/jltst'
const HEADERS = { 'User-Agent': BLS_USER_AGENT, Accept: 'text/plain, application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, */*' }

const NATIONAL_TABLE_MEASURES: Record<number, [string, string]> = {
  1: ['Job openings', 'over-the-month'],
  2: ['Hires', 'over-the-month'],
  3: ['Total separations', 'over-the-month'],
  4: ['Quits', 'over-the-month'],
  5: ['Layoffs and discharges', 'over-the-month'],
  6: ['Other separations', 'over-the-month'],
  7: ['Job openings', 'over-the-year'],
  8: ['Hires', 'over-the-year'],
  9: ['Total separations', 'over-the-year'],
  10: ['Quits', 'over-the-year'],
  11: ['Layoffs and discharges', 'over-the-year'],
  12: ['Other separations', 'over-the-year'],
}
const STATE_TABLE_MEASURES: Record<number, [string, string]> = {
  1: ['Job openings', 'over-the-month'],
  2: ['Hires', 'over-the-month'],
  3: ['Total separations', 'over-the-month'],
  4: ['Quits', 'over-the-month'],
  5: ['Layoffs and discharges', 'over-the-month'],
  6: ['Job openings', 'over-the-year'],
  7: ['Hires', 'over-the-year'],
  8: ['Total separations', 'over-the-year'],
  9: ['Quits', 'over-the-year'],
  10: ['Layoffs and discharges', 'over-the-year'],
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']

/** A month name, possibly truncated, as 1..12 (`_month_to_int`). */
function monthToInt(name: string): number | null {
  const norm = name.trim().toLowerCase().replace(/\.+$/, '')
  const exact = MONTHS.indexOf(norm)
  if (exact >= 0) return exact + 1
  const prefix = MONTHS.findIndex((m) => m.startsWith(norm))
  return prefix >= 0 ? prefix + 1 : null
}

/** A real calendar date or null. */
function validDate(y: number, m: number, d: number): string | null {
  const t = new Date(Date.UTC(y, m - 1, d))
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d && y >= 1 ? isoDate(y, m, d) : null
}

/** Python's `str.splitlines()` for the separators that can occur in these files. */
const splitLines = (text: string): string[] => {
  // Python's str.splitlines boundaries, file separators included.
  // eslint-disable-next-line no-control-regex
  const lines = text.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/)
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

const TITLE_RE = /^TABLE\s+(\d+):\s*(.+?)\s+estimated.*?between\s+(\w+)\s+(\d{4})\s+and\s+(\w+)\s+(\d{4})\s*[,.]?/i
const DATA_LINE_RE = /^(.+?)\s{2,}(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)(?:\s+(YES))?\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)(?:\s+(YES))?\s*$/
const SOURCE_RE = /SOURCE:.*?,\s*(\w+)\s+(\d{1,2}),\s+(\d{4})/i
const SECTION_RE = /^\s+([A-Z][A-Z -]+)\s*$/

/** Python's `str.title()` for the upper-case section names. */
const titleCase = (s: string): string => s.toLowerCase().replace(/(^|[^a-z])([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase())

function parseChangeAnalysis(content: string, scope: string, tableNumber: number): Row[] {
  const lines = splitLines(content)
  if (lines.length === 0) throw new Error(`Empty JOLTS ${scope} table ${tableNumber} TXT response.`)
  const title = TITLE_RE.exec(lines[0]!)
  if (!title) throw new Error(`JOLTS ${scope} table ${tableNumber} TXT header is missing the expected 'TABLE N: <measure> estimated ... between A YYYY and B YYYY' line.`)
  const measure = title[2]!.trim()
  const sm = monthToInt(title[3]!)
  const em = monthToInt(title[5]!)
  const periodStart = sm ? validDate(Number(title[4]), sm, 1) : null
  const periodEnd = em ? validDate(Number(title[6]), em, 1) : null
  const startDate = periodStart
  const endDate = periodEnd

  const second = (lines[1] ?? '').toLowerCase()
  const seasonallyAdjusted = second.includes('not seasonally adjusted') ? false : second.includes('seasonally adjusted') ? true : null
  const periodKind = startDate && endDate && Number(endDate.slice(0, 4)) - Number(startDate.slice(0, 4)) >= 1 ? 'over-the-year' : 'over-the-month'

  let sourceDate: string | null = null
  for (const line of lines) {
    const m = SOURCE_RE.exec(line)
    if (!m) continue
    const mn = monthToInt(m[1]!)
    if (mn === null) continue
    sourceDate = validDate(Number(m[3]), mn, Number(m[2]))
    break
  }

  const tableId = `jolts-${scope}-t${tableNumber}`
  let tableTitle = lines[0]!.trim()
  if (lines.length > 1 && lines[1]!.trim()) tableTitle = `${tableTitle} ${lines[1]!.trim()}`

  const out: Row[] = []
  let section: string | null = null
  let sortOrder = 0
  for (const rawLine of lines.slice(2)) {
    const line = rawLine.trimEnd()
    if (!line.trim()) continue
    if (SOURCE_RE.test(line) || line.trimStart().startsWith('*NOTE')) break
    if (line.trimStart().startsWith('NOTE:') || line.trimStart().startsWith('*')) continue
    if (line.trimStart().toLowerCase().startsWith('is used in testing')) continue
    const sec = SECTION_RE.exec(line)
    if (sec && !/\d/.test(line)) {
      section = titleCase(sec[1]!.trim())
      continue
    }
    const data = DATA_LINE_RE.exec(line)
    if (!data) continue
    const labelRaw = data[1]!.trimEnd()
    const label = labelRaw.trim()
    if (!label) continue
    sortOrder++
    out.push({
      table_id: tableId,
      table_title: tableTitle,
      scope,
      table_number: tableNumber,
      measure,
      period: periodKind,
      seasonally_adjusted: seasonallyAdjusted,
      period_start: startDate,
      period_end: endDate,
      source_date: sourceDate,
      row_index: sortOrder,
      section,
      indent_spaces: labelRaw.length - labelRaw.replace(/^ +/, '').length,
      label,
      rate_change: Number(data[2]),
      rate_min_significant: Number(data[3]),
      rate_passes_significance: Boolean(data[4]),
      level_change_thousands: Number(data[5]),
      level_min_significant_thousands: Number(data[6]),
      level_passes_significance: Boolean(data[7]),
    })
  }
  return out
}

async function changeAnalysis(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const scope = typeof params.scope === 'string' && params.scope ? params.scope : 'national'
  const tableNumber = params.table_number === undefined ? 1 : Number(params.table_number)
  const scopeMap = scope === 'national' ? NATIONAL_TABLE_MEASURES : STATE_TABLE_MEASURES
  if (!(tableNumber in scopeMap)) {
    const keys = Object.keys(scopeMap).map(Number)
    throw new Error(`JOLTS ${scope} table ${tableNumber} does not exist (valid range: ${Math.min(...keys)}-${Math.max(...keys)}).`)
  }
  const url = scope === 'national' ? `${BASE_NATIONAL}/jlt_table${tableNumber}.txt` : `${BASE_STATE}/jltst_table${tableNumber}.txt`
  const rows = parseChangeAnalysis(decodeHtml(await fetchFile(ctx, url, HEADERS)), scope, tableNumber)
  if (rows.length === 0) throw new Error(`No rows parsed from BLS JOLTS ${scope} table ${tableNumber}.`)
  return rows
}

// ---- revisions -------------------------------------------------------------------------------------------------

const REVISION_MEASURES = ['JOB OPENINGS', 'HIRES', 'TOTAL SEPARATIONS', 'QUITS', 'LAYOFFS & DISCHARGES', 'OTHER SEPARATIONS']
const REVISION_FIELD_KEYS = ['level_1st', 'level_2nd', 'level_benchmark', 'revision_1st_to_2nd_level', 'revision_1st_to_2nd_pct', 'revision_2nd_to_benchmark_level', 'revision_2nd_to_benchmark_pct']
const FLOAT_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/

function cellToFloat(cell: Cell | undefined): number | null {
  if (cell === null || cell === undefined || typeof cell === 'boolean') return null
  if (typeof cell === 'number') return cell
  const text = cell.trim().replace(/,/g, '')
  return text && FLOAT_RE.test(text) ? Number(text) : null
}

function parseRevisionWorkbook(bytes: Uint8Array, seasonallyAdjusted: boolean): Row[] {
  const tableId = seasonallyAdjusted ? 'jolts-revisions-sa' : 'jolts-revisions-nsa'
  const tableTitle = seasonallyAdjusted ? 'JOLTS revision tables — seasonally adjusted' : 'JOLTS revision tables — not seasonally adjusted'
  const out: Row[] = []
  let sortOrder = 0
  for (const sheet of loadSheets(bytes)) {
    const rows = sheet.rows
    if (rows.length < 5) continue
    const titleCell = rows[0]?.[0]
    let industryName = ''
    if (typeof titleCell === 'string') {
      const text = titleCell.trim()
      for (const marker of [', seasonally adjusted', ', not seasonally adjusted']) {
        const idx = text.toLowerCase().indexOf(marker)
        if (idx >= 0) {
          industryName = text.slice(0, idx).trim()
          break
        }
      }
      if (!industryName) industryName = text
    }
    const header = rows[1] ?? []
    const blockStarts = header.flatMap((c, i) => (typeof c === 'string' && REVISION_MEASURES.includes(c.trim().toUpperCase()) ? [i] : []))
    for (const colStart of blockStarts) {
      const measure = titleCase((header[colStart] as string).trim())
      for (let rowIdx = 4; rowIdx < rows.length; rowIdx++) {
        const row = rows[rowIdx]!
        if (colStart - 1 >= row.length) break
        const monthCell = row[colStart - 1]
        if (monthCell === null || monthCell === undefined) continue
        // Only date cells count: readXlsx gives them as ISO strings.
        if (typeof monthCell !== 'string' || !/^\d{4}-\d{2}-\d{2}(T|$)/.test(monthCell)) continue
        const monthDate = isoDate(Number(monthCell.slice(0, 4)), Number(monthCell.slice(5, 7)), 1)
        const values: Record<string, number | null> = {}
        REVISION_FIELD_KEYS.forEach((key, offset) => {
          const col = colStart + offset
          values[key] = col >= row.length ? null : cellToFloat(row[col])
        })
        if (Object.values(values).every((v) => v === null)) continue
        sortOrder++
        out.push({ date: monthDate, industry_code: sheet.name, industry_name: industryName, seasonally_adjusted: seasonallyAdjusted, measure, row_index: sortOrder, table_id: tableId, table_title: tableTitle, ...values })
      }
    }
  }
  const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
  return out.sort((a, b) => cmp(b.date as string, a.date as string) || cmp(a.industry_code as string, b.industry_code as string) || cmp(a.measure as string, b.measure as string))
}

async function revisions(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const sa = params.seasonally_adjusted === undefined ? true : params.seasonally_adjusted === true || params.seasonally_adjusted === 'true'
  const url = `${BASE_NATIONAL}/${sa ? 'sa-revision-tables' : 'nsa-revision-tables'}.xlsx`
  const bytes = await fetchFile(ctx, url, HEADERS)
  if (!(bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4)) throw new Error(`BLS returned non-XLSX content for ${url} (length=${bytes.length}).`)
  let rows = parseRevisionWorkbook(bytes, sa)
  const industry = typeof params.industry_code === 'string' && params.industry_code ? params.industry_code.trim().toUpperCase() : null
  const measure = typeof params.measure === 'string' && params.measure ? params.measure.trim().toLowerCase() : null
  if (industry !== null) rows = rows.filter((r) => (r.industry_code as string).toUpperCase() === industry)
  if (measure !== null) rows = rows.filter((r) => (r.measure as string).toLowerCase() === measure)
  if (rows.length === 0) throw new Error('No rows matched the JOLTS revisions query.')
  return rows
}

export const joltsTableRoutes: Record<string, NativeHandler> = {
  'bls/jolts/change_analysis': changeAnalysis,
  'bls/jolts/revisions': revisions,
}
