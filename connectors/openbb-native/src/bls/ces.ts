// bls/employment_situation/t1_employment_changes … t7_peak_trough and confidence_intervals, provider bls. Ported from
// openbb_bls/models/ces_analytical_tables.py and utils/ces_analytical_tables.py (OpenBB Platform 5.0.0, Apache-2.0);
// modified: readXlsx instead of openpyxl, plain rows keeping only the fields the Data models declare.
import { readXlsx, type Cell } from '../lib/xlsx.js'
import type { NativeCtx, NativeHandler, NativeParams, Row } from '../types.js'
import { BLS_USER_AGENT, decodeCharRefs, fetchFile, isoDate, squish, str } from './helpers.js'

const BASE = 'https://www.bls.gov/web/empsit'
const XLSX_ACCEPT = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,*/*'

const MONTHS: Record<string, number> = { jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12 }

const TITLES: Record<string, string> = {
  t1: 'Table 1. Employment: normal seasonal movements, over-the-month changes, and tests of significance',
  t2: 'Table 2. Detailed industry employment ranked by over-the-month changes, tests of significance, and prior 3-month average',
  t3a: 'Table 3A. Employment changes and tests of significance, seasonally adjusted',
  t3b: 'Table 3B. Over-the-month employment changes compared with recent averages, seasonally adjusted',
  t4: 'Table 4. Over-the-year employment changes and tests of significance, seasonally adjusted',
  t5: 'Table 5. Average weekly hours and average hourly earnings of all employees: normal seasonal movements, over-the-month changes, and tests of significance',
  t6: 'Table 6. Over-the-month and over-the-year changes in aggregate weekly hours and payrolls of all employees, seasonally adjusted',
  t7: 'Table 7. Most recent industry-specific employment peak and trough, and changes from peak and trough to current employment, seasonally adjusted',
  ci: 'Tables A-C2. 90 percent confidence intervals for employment, hours, overtime hours, and earnings',
}

const CI_SHEET_META: Record<string, [string, string | null]> = {
  'CI Industry Employment Chang': ['Employment', null],
  'CI AWH_AE': ['Average weekly hours', 'All employees'],
  'CI AHE_AE': ['Average hourly earnings', 'All employees'],
  'CI AWH_PE': ['Average weekly hours', 'Production employees'],
  'CI AHE_PE': ['Average hourly earnings', 'Production employees'],
  'CI AOT_AE': ['Average overtime hours', 'All employees'],
  'CI AOT_PE': ['Average overtime hours', 'Production employees'],
}

type Sheet = Cell[][]

/** Collapse newlines and non-breaking spaces in a header or label cell (`_norm`). */
const norm = (v: unknown): string => (v === null || v === undefined ? '' : squish(String(v).replace(/\u00a0/g, ' ')))

/** A CES numeric cell as (value, significant): a trailing `*` flags significance, `.` is not available (`_to_value`). */
function toValue(cell: Cell | undefined): [number | null, boolean] {
  if (cell === null || cell === undefined || typeof cell === 'boolean') return [null, false]
  if (typeof cell === 'number') return [cell, false]
  let text = cell.replace(/\u00a0/g, ' ').trim()
  const significant = text.endsWith('*')
  if (significant) text = text.slice(0, -1).trim()
  if (['', '.', '-', '(NA)', 'N.A.', 'NA'].includes(text)) return [null, significant]
  const n = text.replace(/,/g, '')
  return [/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(n) ? Number(n) : null, significant]
}

/** A peak/trough `MON-YYYY` cell as the first of that month (`_to_mon_year`). */
function toMonYear(cell: Cell | undefined): string | null {
  if (cell === null || cell === undefined) return null
  const text = String(cell).replace(/\u00a0/g, ' ').trim().replace(/\*+$/, '').trim()
  const m = /^([A-Za-z]{3})-(\d{4})/.exec(text)
  const month = m ? MONTHS[m[1]!.toLowerCase()] : undefined
  return m && month ? isoDate(Number(m[2]), month, 1) : null
}

/** Leading dots (one per hierarchy level) or spaces give the indent; the rest is the label (`_clean_label`). */
function cleanLabel(raw: Cell | undefined): [number, string] {
  const text = raw === null || raw === undefined ? '' : String(raw)
  let dots = 0
  while (dots < text.length && text[dots] === '.') dots++
  if (dots) return [dots, norm(text.slice(dots))]
  let spaces = 0
  while (spaces < text.length && [' ', ' ', '\t'].includes(text[spaces]!)) spaces++
  return [spaces, norm(text.slice(spaces))]
}

/** The latest `Mon. YYYY` found in the header block (`_reference_date`). */
function referenceDate(headerRows: Sheet): string | null {
  let best: string | null = null
  for (const row of headerRows) {
    for (const cell of row ?? []) {
      if (typeof cell !== 'string') continue
      for (const m of cell.matchAll(/([A-Za-z]{3,9})\.?\s+(\d{4})/g)) {
        const month = MONTHS[m[1]!.trim().toLowerCase().replace(/\.+$/, '')]
        if (!month) continue
        const candidate = isoDate(Number(m[2]), month, 1)
        if (best === null || candidate > best) best = candidate
      }
    }
  }
  return best
}

/** Index of the first data row, after the Industry/Rank header (`_find_data_start`). */
function dataStart(rows: Sheet): number {
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (row && row.length > 0 && ['industry', 'rank'].includes(norm(row[0]).toLowerCase())) return i + 1
  }
  throw new Error("CES analytical table is missing the expected 'Industry'/'Rank' header row.")
}

const isFootnote = (raw0: Cell | undefined): boolean => norm(raw0).startsWith('*')
const title = (rows: Sheet, fallback: string): string => norm(rows[0]?.[0]) || fallback

type Parsed = { rows: Row[]; tableId: string; title: string }

/** The shared walk over data rows: skip blanks, stop at the footnotes, number the rest. */
function collect(rows: Sheet, start: number, ref: string | null, tableId: string, tableTitle: string, build: (row: Cell[], raw0: Cell | undefined) => Row | null): Parsed {
  const out: Row[] = []
  for (const row of rows.slice(start)) {
    const raw0 = row?.[0]
    if (!norm(raw0)) continue
    if (isFootnote(raw0)) break
    const built = build(row, raw0)
    if (built) out.push({ reference_date: ref, ...built, row_index: out.length + 1, table_id: tableId, table_title: tableTitle })
  }
  return { rows: out, tableId, title: tableTitle }
}

function table1(sheet: Sheet): Parsed {
  const start = dataStart(sheet)
  return collect(sheet, start, referenceDate(sheet.slice(0, start)), 'ces-anatab1', title(sheet, TITLES.t1!), (row, raw0) => {
    const [level, label] = cleanLabel(raw0)
    const [changeSa, sig] = toValue(row[3])
    return { indent_level: level, label, normal_seasonal_movement: toValue(row[1])[0], change_nsa: toValue(row[2])[0], change_sa: changeSa, change_sa_significant: sig, minimum_significant_change: toValue(row[4])[0] }
  })
}

function table2(sheet: Sheet): Parsed {
  const start = dataStart(sheet)
  return collect(sheet, start, referenceDate(sheet.slice(0, start)), 'ces-anatab2', title(sheet, TITLES.t2!), (row, raw0) => {
    const [changeSa, sig] = toValue(row[3])
    return { rank: norm(raw0), label: norm(row[1]), naics_code: norm(row[2]) || null, change_sa: changeSa, change_sa_significant: sig, minimum_significant_change: toValue(row[4])[0], prior_3month_average: toValue(row[5])[0] }
  })
}

/** Tables 3A and 3B: six change columns over an industry hierarchy; only 3A flags significance. */
function multiChange(sheet: Sheet, key: 't3a' | 't3b', fields: readonly string[]): Parsed {
  const start = dataStart(sheet)
  return collect(sheet, start, referenceDate(sheet.slice(0, start)), `ces-anatab${key.slice(1)}`, title(sheet, TITLES[key]!), (row, raw0) => {
    const [level, label] = cleanLabel(raw0)
    const record: Row = { indent_level: level, label }
    fields.forEach((field, i) => {
      const [value, significant] = toValue(row[i + 1])
      record[field] = value
      if (key === 't3a') record[`${field}_significant`] = significant
    })
    return record
  })
}

function table4(sheet: Sheet): Parsed {
  const start = dataStart(sheet)
  return collect(sheet, start, referenceDate(sheet.slice(0, start)), 'ces-anatab4', title(sheet, TITLES.t4!), (row, raw0) => {
    const [level, label] = cleanLabel(raw0)
    const [number, sig] = toValue(row[1])
    return { indent_level: level, label, oty_change_number: number, oty_change_number_significant: sig, oty_change_percent: toValue(row[2])[0], minimum_significant_change: toValue(row[3])[0] }
  })
}

/** Table 5: average weekly hours and hourly earnings, two blocks (the Data model has no indent_level). */
function table5(sheet: Sheet): Parsed {
  const start = dataStart(sheet)
  const ref = referenceDate(sheet.slice(0, start))
  const tableTitle = title(sheet, TITLES.t5!)
  let measure = 'Average weekly hours'
  const out: Row[] = []
  for (const row of sheet.slice(start)) {
    const raw0 = row?.[0]
    const label = norm(raw0)
    if (!label) continue
    if (isFootnote(raw0)) break
    const lowered = label.toLowerCase()
    if (lowered === 'average weekly hours' || lowered === 'average hourly earnings') {
      measure = label
      continue
    }
    if (lowered === 'industry' || norm(row[1]).toLowerCase().startsWith('normal')) continue
    const [changeSa, sig] = toValue(row[3])
    out.push({ reference_date: ref, measure, label, normal_seasonal_movement: toValue(row[1])[0], change_nsa: toValue(row[2])[0], change_sa: changeSa, change_sa_significant: sig, minimum_significant_change: toValue(row[4])[0], row_index: out.length + 1, table_id: 'ces-anatab5', table_title: tableTitle })
  }
  return { rows: out, tableId: 'ces-anatab5', title: tableTitle }
}

/** Table 6: aggregate weekly hours and payrolls, two blocks introduced by repeated Industry header rows. */
function table6(sheet: Sheet): Parsed {
  const start = dataStart(sheet) - 1
  const ref = referenceDate(sheet.slice(0, start + 1))
  const tableTitle = title(sheet, TITLES.t6!)
  let measure = 'Aggregate weekly hours'
  const out: Row[] = []
  for (const row of sheet.slice(start)) {
    const raw0 = row?.[0]
    const label = norm(raw0)
    if (!label) continue
    if (isFootnote(raw0)) break
    if (label.toLowerCase() === 'industry') {
      measure = norm(row[1]).toLowerCase().includes('payroll') ? 'Aggregate weekly payrolls' : 'Aggregate weekly hours'
      continue
    }
    out.push({ reference_date: ref, measure, label, aggregate_value: toValue(row[1])[0], otm_change_number: toValue(row[2])[0], otm_change_percent: toValue(row[3])[0], oty_change_number: toValue(row[4])[0], oty_change_percent: toValue(row[5])[0], row_index: out.length + 1, table_id: 'ces-anatab6', table_title: tableTitle })
  }
  return { rows: out, tableId: 'ces-anatab6', title: tableTitle }
}

function table7(sheet: Sheet): Parsed {
  const start = dataStart(sheet)
  return collect(sheet, start, referenceDate(sheet.slice(0, start)), 'ces-anatab7', title(sheet, TITLES.t7!), (row, raw0) => {
    const [level, label] = cleanLabel(raw0)
    return { indent_level: level, label, current_employment: toValue(row[1])[0], peak_date: toMonYear(row[2]), peak_employment: toValue(row[3])[0], trough_date: toMonYear(row[4]), trough_employment: toValue(row[5])[0], change_from_peak: toValue(row[6])[0], change_from_trough: toValue(row[7])[0] }
  })
}

const T3A_FIELDS = ['otm_change_latest', 'otm_change_prior_1', 'otm_change_prior_2', 'current_3month_change', 'current_6month_change', 'current_12month_change'] as const
const T3B_FIELDS = ['otm_change_latest', 'otm_change_prior_1', 'otm_change_prior_2', 'prior_3month_average', 'prior_6month_average', 'prior_12month_average'] as const

const TABLES: Record<string, { stem: string; parse: (sheet: Sheet) => Parsed }> = {
  'bls/employment_situation/t1_employment_changes': { stem: 'cesanatab1', parse: table1 },
  'bls/employment_situation/t2_ranked_industries': { stem: 'cesanatab2', parse: table2 },
  'bls/employment_situation/t3a_employment_changes_sa': { stem: 'cesanatab3a', parse: (s) => multiChange(s, 't3a', T3A_FIELDS) },
  'bls/employment_situation/t3b_changes_vs_averages': { stem: 'cesanatab3b', parse: (s) => multiChange(s, 't3b', T3B_FIELDS) },
  'bls/employment_situation/t4_over_the_year_changes': { stem: 'cesanatab4', parse: table4 },
  'bls/employment_situation/t5_hours_earnings': { stem: 'cesanatab5', parse: table5 },
  'bls/employment_situation/t6_aggregate_hours_payrolls': { stem: 'cesanatab6', parse: table6 },
  'bls/employment_situation/t7_peak_trough': { stem: 'cesanatab7', parse: table7 },
}

/** Download one CES workbook (`fetch_table_xlsx`). */
async function fetchWorkbook(ctx: NativeCtx, stem: string): Promise<Uint8Array> {
  const url = `${BASE}/${stem}.xlsx`
  const bytes = await fetchFile(ctx, url, { 'User-Agent': BLS_USER_AGENT, Accept: XLSX_ACCEPT })
  if (!(bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4)) throw new Error(`BLS returned non-XLSX content for ${url} (length=${bytes.length}).`)
  return bytes
}

/** The workbook's sheets with numeric character references decoded in every text cell. */
function loadSheets(bytes: Uint8Array): { name: string; rows: Sheet }[] {
  return readXlsx(bytes).map((s) => ({ name: decodeCharRefs(s.name), rows: s.rows.map((r) => r.map((c) => (typeof c === 'string' ? decodeCharRefs(c) : c))) }))
}

function tableHandler(stem: string, parse: (sheet: Sheet) => Parsed): NativeHandler {
  return async (_params: NativeParams, ctx: NativeCtx): Promise<Row[]> => {
    const sheets = loadSheets(await fetchWorkbook(ctx, stem))
    const parsed = parse(sheets[0]?.rows ?? [])
    if (parsed.rows.length === 0) throw new Error(`No rows parsed from CES analytical table '${parsed.tableId}'.`)
    return parsed.rows
  }
}

/** Tables A-C2: seven sheets of confidence intervals (`parse_confidence_intervals`). */
async function confidenceIntervals(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const sheets = loadSheets(await fetchWorkbook(ctx, 'cesconfidenceintervals'))
  const out: Row[] = []
  let rowIndex = 0
  for (const sheet of sheets) {
    const rows = sheet.rows
    if (rows.length === 0) continue
    const sheetTitle = title(rows, '')
    const ciMatch = /TABLE\s+([A-C][12]?)/i.exec(sheetTitle)
    const ciTable = ciMatch ? ciMatch[1]!.toUpperCase() : sheet.name
    const [measure, group] = CI_SHEET_META[sheet.name] ?? [sheet.name, null]
    const start = dataStart(rows)
    // openpyxl pads every row to the sheet's widest column, so the header row's width is the sheet's.
    const wide = rows.reduce((w, r) => Math.max(w, r?.length ?? 0), 0) >= 7
    for (const row of rows.slice(start)) {
      const raw0 = row?.[0]
      if (!norm(raw0)) continue
      if (isFootnote(raw0)) break
      const [level, label] = cleanLabel(raw0)
      rowIndex++
      out.push({
        ci_table: ciTable,
        measure,
        employee_group: group,
        indent_level: level,
        label,
        ci_1month_first: toValue(row[1])[0],
        ci_1month_second: wide ? toValue(row[2])[0] : null,
        ci_1month_third: wide ? toValue(row[3])[0] : null,
        ci_3month: toValue(row[wide ? 4 : 2])[0],
        ci_6month: toValue(row[wide ? 5 : 3])[0],
        ci_12month: toValue(row[wide ? 6 : 4])[0],
        row_index: rowIndex,
        table_id: 'ces-confidence-intervals',
        table_title: TITLES.ci!,
      })
    }
  }
  const filter = str(params.ci_table)
  const rows = filter ? out.filter((r) => r.ci_table === filter) : out
  if (rows.length === 0) throw new Error(`No rows parsed from the CES confidence-interval tables (ci_table=${filter ?? 'None'}).`)
  return rows
}

export const cesRoutes: Record<string, NativeHandler> = {
  ...Object.fromEntries(Object.entries(TABLES).map(([route, t]) => [route, tableHandler(t.stem, t.parse)] as const)),
  'bls/employment_situation/confidence_intervals': confidenceIntervals,
}
