// bls/productivity/tables, provider bls. Ported from openbb_bls/models/productivity_tables.py and
// utils/productivity_tables.py (OpenBB Platform 5.0.0, Apache-2.0); modified: readXlsx instead of openpyxl, plain rows.
import type { Cell } from '../lib/xlsx.js'
import type { NativeCtx, NativeHandler, NativeParams, Row } from '../types.js'
import { BLS_USER_AGENT, fetchFile, isoDate, loadSheets, str } from './helpers.js'

const BASE = 'https://www.bls.gov/web/prod2'
const HEADERS = { 'User-Agent': BLS_USER_AGENT, Accept: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,*/*' }

const DATASET_FILE: Record<string, [string, string]> = {
  'major-sectors-quarterly': ['labor-productivity-major-sectors.xlsx', 'MachineReadable'],
  'major-sectors-annual': ['labor-productivity-major-sectors.xlsx', 'MachineReadable'],
  'major-sectors-business-cycles': ['labor-productivity-major-sectors.xlsx', 'BusinessCycles'],
  'total-economy-hours-employment': ['total-economy-hours-employment.xlsx', 'MachineReadable'],
}

const DATASET_LABELS: Record<string, string> = {
  'major-sectors-quarterly': 'Quarterly labor productivity and related measures, major sectors.',
  'major-sectors-annual': 'Annual labor productivity and related measures, major sectors.',
  'major-sectors-business-cycles': 'Labor productivity major sectors, compound annual growth rates by approximate business cycle period.',
  'total-economy-hours-employment': 'Quarterly hours worked and employment, total U.S. economy and subsectors.',
}

const QTR_TO_MONTH: Record<number, number> = { 1: 1, 2: 4, 3: 7, 4: 10 }
const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
const FLOAT_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/

/** A cell as (number, raw text when it is not numeric) (`_parse_value`). */
function parseValue(cell: Cell | undefined): [number | null, string | null] {
  if (cell === null || cell === undefined) return [null, null]
  if (typeof cell === 'boolean') return [cell ? 1 : 0, String(cell)]
  if (typeof cell === 'number') return [cell, null]
  const text = cell.trim()
  if (!text) return [null, null]
  const n = text.replace(/,/g, '')
  return FLOAT_RE.test(n) ? [Number(n), null] : [null, text]
}

/** `int(x)` for a cell: numbers truncate, numeric strings parse, anything else is null. */
function pyInt(cell: Cell | undefined): number | null {
  if (typeof cell === 'number') return Number.isFinite(cell) ? Math.trunc(cell) : null
  if (typeof cell === 'string' && /^\s*[+-]?\d+\s*$/.test(cell)) return Number(cell.trim())
  return null
}

/** (Year, Qtr) as a first-of-quarter date and the kind of period (`_quarter_to_date`). */
function quarterToDate(year: Cell | undefined, qtr: Cell | undefined): [string | null, string] {
  if (year === null || year === undefined) return [null, 'unknown']
  const y = pyInt(year)
  if (y === null) return [null, 'unknown']
  if (typeof qtr === 'string' && qtr.trim().toLowerCase() === 'annual') return [isoDate(y, 1, 1), 'annual']
  const q = pyInt(qtr)
  if (q === null) return [isoDate(y, 1, 1), 'unknown']
  const month = QTR_TO_MONTH[q]
  return month === undefined ? [isoDate(y, 1, 1), 'unknown'] : [isoDate(y, month, 1), `Q${q}`]
}

/** The 'Data released <Month> <d>, <yyyy>' date in the first rows of a sheet (`_detect_release_date`). */
function detectReleaseDate(rows: Cell[][]): string | null {
  for (const row of rows.slice(0, 5)) {
    for (const cell of row) {
      if (typeof cell !== 'string') continue
      const m = /Data\s+released\s+(\w+)\s+(\d{1,2}),\s+(\d{4})/i.exec(cell)
      if (!m) continue
      const month = MONTH_NAMES.indexOf(m[1]!.trim().toLowerCase()) + 1
      if (month === 0) continue
      const d = new Date(Date.UTC(Number(m[3]), month - 1, Number(m[2])))
      return d.getUTCMonth() === month - 1 && d.getUTCDate() === Number(m[2]) ? isoDate(Number(m[3]), month, Number(m[2])) : null
    }
  }
  return null
}

const strip = (cell: Cell | undefined): string | null => (cell === null || cell === undefined ? null : String(cell).trim())

function parseMachineReadable(rows: Cell[][], dataset: string, releaseDate: string | null, filename: string): Row[] {
  if (rows.length === 0) return []
  const cols = rows[0]!.map((c) => (c !== null && c !== undefined ? String(c).trim() : ''))
  const idx = (name: string): number => {
    const i = cols.indexOf(name)
    if (i < 0) throw new Error(`Productivity MachineReadable header is missing an expected column: '${name}' is not in list`)
    return i
  }
  const sectorIdx = idx('Sector')
  const basisIdx = idx('Basis')
  const measureIdx = idx('Measure')
  const unitsIdx = idx('Units')
  const yearIdx = idx('Year')
  const qtrIdx = idx('Qtr')
  const valueIdx = idx('Value')
  const componentIdx = cols.includes('Component') ? cols.indexOf('Component') : null
  const keepQtr = dataset === 'major-sectors-quarterly' ? 'quarterly' : dataset === 'major-sectors-annual' ? 'annual' : dataset === 'total-economy-hours-employment' ? 'any' : null

  const out: Row[] = []
  const tableId = `productivity-${dataset}`
  let sortOrder = 0
  for (const row of rows.slice(1)) {
    if (row.length === 0 || row.every((c) => c === null)) continue
    const qtrCell = row[qtrIdx]
    const yearCell = row[yearIdx]
    const [periodDate, periodKind] = quarterToDate(yearCell, qtrCell)
    if (keepQtr === 'quarterly' && periodKind === 'annual') continue
    if (keepQtr === 'annual' && periodKind !== 'annual') continue
    const [value, valueString] = parseValue(row[valueIdx])
    sortOrder++
    out.push({
      date: periodDate,
      period_kind: periodKind,
      year: typeof yearCell === 'number' ? Math.trunc(yearCell) : null,
      quarter: typeof qtrCell === 'number' ? Math.trunc(qtrCell) : qtrCell !== null && qtrCell !== undefined ? String(qtrCell).trim() : null,
      sector: strip(row[sectorIdx]),
      basis: strip(row[basisIdx]),
      component: componentIdx !== null && componentIdx < row.length ? strip(row[componentIdx]) : null,
      measure: strip(row[measureIdx]) ?? '',
      units: strip(row[unitsIdx]) ?? '',
      value,
      value_string: valueString,
      row_index: sortOrder,
      table_id: tableId,
      table_title: DATASET_LABELS[dataset],
      source_file: filename,
      release_date: releaseDate,
    })
  }
  return out
}

/** A business-cycle column header 'YYYY Qn - YYYY Qn' as (start, end) (`_parse_cycle_period`). */
function parseCyclePeriod(label: string): [string | null, string | null] {
  const m = /(\d{4})\s*Q(\d)\s*-\s*(\d{4})\s*Q(\d)/.exec(label)
  if (!m) return [null, null]
  return [isoDate(Number(m[1]), QTR_TO_MONTH[Number(m[2])] ?? 1, 1), isoDate(Number(m[3]), QTR_TO_MONTH[Number(m[4])] ?? 1, 1)]
}

function parseBusinessCycles(rows: Cell[][], dataset: string): Row[] {
  const releaseDate = detectReleaseDate(rows)
  const headerIdx = rows.findIndex((row) => {
    const first = row[0] ? String(row[0]).trim().toLowerCase() : ''
    return first === 'sector'
  })
  if (headerIdx < 0) throw new Error("Productivity BusinessCycles sheet is missing the 'Sector' header row.")
  const cycleHeaders: [number, string][] = []
  rows[headerIdx]!.forEach((cell, i) => {
    if (i < 4 || cell === null || cell === undefined) return
    const text = String(cell).trim()
    if (text) cycleHeaders.push([i, text])
  })
  if (cycleHeaders.length === 0) throw new Error('Productivity BusinessCycles sheet has no business-cycle column headers after the Sector / Basis / Measure / Units columns.')
  const out: Row[] = []
  const tableId = `productivity-${dataset}`
  let sortOrder = 0
  for (const row of rows.slice(headerIdx + 1)) {
    if (row.length === 0 || row.every((c) => c === null)) continue
    const sector = row[0] !== null && row[0] !== undefined ? String(row[0]).trim() : null
    if (!sector) continue
    const basis = row.length > 1 && row[1] !== null && row[1] !== undefined ? String(row[1]).trim() : null
    const measure = row.length > 2 && row[2] !== null && row[2] !== undefined ? String(row[2]).trim() : ''
    const units = row.length > 3 && row[3] !== null && row[3] !== undefined ? String(row[3]).trim() : ''
    if (measure.toLowerCase().startsWith('data released') || sector.toLowerCase().startsWith('data released')) continue
    for (const [col, cycleLabel] of cycleHeaders) {
      const [value, valueString] = parseValue(row[col])
      if (value === null && valueString === null) continue
      sortOrder++
      const [start, end] = parseCyclePeriod(cycleLabel)
      out.push({
        date: start,
        period_kind: 'business_cycle',
        year: null,
        quarter: null,
        sector,
        basis,
        component: null,
        measure,
        units,
        value,
        value_string: valueString,
        row_index: sortOrder,
        table_id: tableId,
        table_title: DATASET_LABELS[dataset],
        source_file: 'labor-productivity-major-sectors.xlsx',
        release_date: releaseDate,
        cycle_period: cycleLabel,
        cycle_start_date: start,
        cycle_end_date: end,
      })
    }
  }
  return out
}

async function tables(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const dataset = str(params.dataset) ?? 'major-sectors-quarterly'
  const file = DATASET_FILE[dataset]
  if (!file) throw new Error(`Unknown productivity dataset '${dataset}'.`)
  const [filename, sheetName] = file
  const bytes = await fetchFile(ctx, `${BASE}/${filename}`, HEADERS)
  if (!(bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4)) throw new Error(`BLS returned non-XLSX content for ${BASE}/${filename} (length=${bytes.length}).`)
  const sheets = loadSheets(bytes)
  const byName = new Map(sheets.map((s) => [s.name, s.rows] as const))
  if (!byName.has(sheetName)) throw new Error(`Productivity workbook '${filename}' does not contain a '${sheetName}' sheet.`)

  let all: Row[]
  if (dataset === 'major-sectors-business-cycles') all = parseBusinessCycles(byName.get(sheetName)!, dataset)
  else {
    let releaseDate: string | null = null
    for (const name of ['Quarterly', 'Annual']) {
      const rows = byName.get(name)
      if (!rows) continue
      releaseDate = detectReleaseDate(rows)
      if (releaseDate !== null) break
    }
    all = parseMachineReadable(byName.get(sheetName)!, dataset, releaseDate, filename)
  }
  // The "Level - not available" placeholder rows carry no value and are dropped.
  const rows = all.filter((r) => r.units !== 'Level - not available')
  const lower = (v: unknown): string | null => (typeof v === 'string' && v ? v.trim().toLowerCase() : null)
  const sector = lower(params.sector)
  const measure = lower(params.measure)
  const units = lower(params.units)
  const start = str(params.start_date)
  const end = str(params.end_date)
  const out = rows.filter((r) => {
    if (sector !== null && ((r.sector as string | null) ?? '').toLowerCase() !== sector) return false
    if (measure !== null && ((r.measure as string | null) ?? '').toLowerCase() !== measure) return false
    if (units !== null && ((r.units as string | null) ?? '').toLowerCase() !== units) return false
    if (start || end) {
      const d = r.date as string | null
      if (d === null) return false
      if (start && d < start) return false
      if (end && d > end) return false
    }
    return true
  })
  if (out.length === 0) throw new Error('No BLS productivity table rows matched the query.')
  return out
}

export const productivityTableRoutes: Record<string, NativeHandler> = {
  'bls/productivity/tables': tables,
}
