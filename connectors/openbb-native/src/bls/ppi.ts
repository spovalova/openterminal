// bls/ppi/relative_importance, seasonal_factors and detailed_report, provider bls. Ported from
// openbb_bls/models/{ppi_relative_importance,ppi_seasonal_factors,ppi_detailed_report}.py and utils/tables.py
// (OpenBB Platform 5.0.0, Apache-2.0); modified: readXlsx instead of openpyxl, node-html-parser instead of
// BeautifulSoup, the PPI series titles come from BLS's wp.series file instead of the bundled cache.
import type { HTMLElement } from 'node-html-parser'
import type { Cell } from '../lib/xlsx.js'
import type { NativeCtx, NativeHandler, NativeParams, Row } from '../types.js'
import { BLS_USER_AGENT, fetchFile, fetchPage, findAll, htmlTables, htmlTitle, isoDate, loadSheets, squish, str, textOf, type Sheet } from './helpers.js'
import { surveySeries } from './metadata.js'

const BASE = 'https://www.bls.gov/web'
const XLSX_ACCEPT = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,*/*'
const FLOAT_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const MONTHS: Record<string, number> = {}
MONTH_NAMES.forEach((name, i) => {
  MONTHS[name.toLowerCase()] = i + 1
  MONTHS[name.slice(0, 3).toLowerCase()] = i + 1
})
MONTHS.sept = 9
const monthNum = (token: string): number | null => MONTHS[token.trim().toLowerCase().replace(/\.+$/, '')] ?? null
const isXlsx = (b: Uint8Array): boolean => b[0] === 0x50 && b[1] === 0x4b && b[2] === 3 && b[3] === 4

// ---- relative importance -------------------------------------------------------------------------------------

const RI_TABLES: Record<string, { category: string; label: string; url: string }> = {
  'ppi-fdallrel': { category: 'final_demand', label: 'PPI Final Demand relative importance — by individual commodities', url: `${BASE}/ppi/ppi-fdallrel.xlsx` },
  'ppi-fdgrouprel': { category: 'final_demand', label: 'PPI Final Demand relative importance — by component series', url: `${BASE}/ppi/ppi-fdgrouprel.xlsx` },
  'ppi-idcallrel': { category: 'intermediate_demand_commodity', label: 'PPI Intermediate Demand by Commodity Type relative importance — individual', url: `${BASE}/ppi/ppi-idcallrel.xlsx` },
  'ppi-idcgrouprel': { category: 'intermediate_demand_commodity', label: 'PPI Intermediate Demand by Commodity Type relative importance — component', url: `${BASE}/ppi/ppi-idcgrouprel.xlsx` },
  'ppi-idpallrel': { category: 'intermediate_demand_flow', label: 'PPI Intermediate Demand by Production Flow relative importance — individual', url: `${BASE}/ppi/ppi-idpallrel.xlsx` },
  'ppi-idpgrouprel': { category: 'intermediate_demand_flow', label: 'PPI Intermediate Demand by Production Flow relative importance — component', url: `${BASE}/ppi/ppi-idpgrouprel.xlsx` },
  'ppi-comrlp': { category: 'commodity', label: 'PPI Commodities relative importance — all levels', url: `${BASE}/ppi/ppi-comrlp.xlsx` },
  'ppi-weprel': { category: 'service_construction', label: 'PPI Wherever-Provided Services and Construction relative importance', url: `${BASE}/ppi/ppi-weprel.xlsx` },
}
const RI_CANONICAL: Record<string, string> = {
  final_demand: 'ppi-fdallrel',
  intermediate_demand_commodity: 'ppi-idcallrel',
  intermediate_demand_flow: 'ppi-idpallrel',
  commodity: 'ppi-comrlp',
  service_construction: 'ppi-weprel',
}

async function relativeImportance(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const tableId = str(params.table_id) ?? RI_CANONICAL[str(params.category) ?? 'final_demand']!
  const entry = RI_TABLES[tableId]
  if (!entry) throw new Error(`Unknown relative-importance table_id '${tableId}'.`)
  const bytes = await fetchFile(ctx, entry.url, { 'User-Agent': BLS_USER_AGENT, Accept: XLSX_ACCEPT })
  const rows = loadSheets(bytes)[0]?.rows ?? []

  // Header row: the first whose second cell ends in "code".
  const headerIdx = rows.findIndex((row) => row.length >= 2 && row[1] !== null && row[1] !== undefined && String(row[1]).trim().toLowerCase().endsWith('code'))
  if (headerIdx < 0) throw new Error(`No rows parsed from BLS PPI table '${tableId}'.`)
  const headers = rows[headerIdx]!.map((c, i) => (c !== null && c !== undefined ? String(c).trim() : `col_${i}`))
  const valueCols: [number, string][] = []
  headers.forEach((h, i) => {
    const m = /(20\d{2})/.exec(h)
    if (m) valueCols.push([i, isoDate(Number(m[1]), 12, 1)])
  })
  const codeCols = headers.flatMap((h, i) => (h.toLowerCase().endsWith('code') ? [i] : []))
  const labelCol = headers.findIndex((h) => ['index', 'indexes'].includes(h.toLowerCase()))

  const out: Row[] = []
  for (const row of rows.slice(headerIdx + 1)) {
    if (row.length === 0 || valueCols.length === 0) continue
    let code: string | null = null
    for (const i of codeCols) {
      const cell = row[i]
      if (typeof cell !== 'string') continue
      const cleaned = cell.trim()
      if (cleaned === '') continue
      code = cleaned
      break
    }
    let label: string | null = null
    if (labelCol >= 0 && typeof row[labelCol] === 'string' && (row[labelCol] as string).trim()) label = (row[labelCol] as string).trim()
    const parsed: [string, number][] = []
    for (const [i, asOf] of valueCols) {
      const raw = row[i]
      if (raw === null || raw === undefined) continue
      let value: number
      if (typeof raw === 'string') {
        const cleaned = raw.trim()
        if (cleaned === '' || cleaned === '-' || !FLOAT_RE.test(cleaned)) continue
        value = Number(cleaned)
      } else if (typeof raw === 'number') value = raw
      else continue
      parsed.push([asOf, value])
    }
    if (parsed.length === 0 || (code === null && label === null)) continue
    for (const [asOf, value] of parsed) out.push({ date: asOf, code, label, relative_importance: value, table_id: tableId, table_name: entry.label })
  }
  if (out.length === 0) throw new Error(`No rows parsed from BLS PPI table '${tableId}'.`)
  const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
  return out.sort((a, b) => cmp(a.date as string, b.date as string) || cmp((a.code as string | null) ?? '', (b.code as string | null) ?? '') || cmp((a.label as string | null) ?? '', (b.label as string | null) ?? ''))
}

// ---- seasonal factors ----------------------------------------------------------------------------------------

const SF_TABLES: Record<string, { label: string; url: string }> = {
  'ppi-fdidsf': { label: 'PPI FD-ID aggregation index seasonal factors — previous five years', url: `${BASE}/ppi/ppi-fdidsf.htm` },
  'ppi-commsf': { label: 'PPI Commodity index seasonal factors — previous five years', url: `${BASE}/ppi/ppi-commsf.htm` },
  'ppi-seafac': { label: 'PPI Commodity forecasting seasonal factors — current year', url: `${BASE}/ppi/ppi-seafac.htm` },
}
const SF_CANONICAL: Record<string, string> = { fd_id: 'ppi-fdidsf', commodity: 'ppi-commsf', forecast: 'ppi-seafac' }

/** Trimmed, NBSP-cleaned text of a tag (`_cell_text`). */
const cellText = (node: HTMLElement | undefined): string => (node ? textOf(node).replace(/ /g, ' ').trim() : '')

function sfFloat(value: string): number | null {
  if (value === '' || value === '-' || value === '(NA)') return null
  return FLOAT_RE.test(value) ? Number(value) : null
}

/** `{WPS series id: title}` from BLS's wp.series file (`_wps_titles`). */
async function wpsTitles(ctx: NativeCtx): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  let rows
  try {
    rows = await surveySeries(ctx, 'wp')
  } catch {
    return out
  }
  for (const row of rows) {
    const sid = row.series_id
    let title = row.series_title
    if (sid === null || sid === undefined || title === null || title === undefined) continue
    const key = sid.trim()
    title = title.trim()
    if (title.startsWith('PPI Commodity data for ')) title = title.slice('PPI Commodity data for '.length)
    for (const suffix of [', seasonally adjusted', ', not seasonally adjusted']) {
      if (title.endsWith(suffix)) {
        title = title.slice(0, -suffix.length)
        break
      }
    }
    if (!out.has(key)) out.set(key, title)
  }
  return out
}

function parseFiveYearRows(table: HTMLElement): Row[] {
  const out: Row[] = []
  let code: string | null = null
  let title: string | null = null
  for (const th of findAll(table, ['th'])) {
    const text = cellText(th)
    if (text.startsWith('SERIES CODE')) {
      code = text.includes(':') ? text.split(':').slice(1).join(':').trim() : null
      title = null
      continue
    }
    if (text.startsWith('SERIES TITLE')) {
      title = text.includes(':') ? text.split(':').slice(1).join(':').trim() : null
      continue
    }
    const yearMatch = /^(20\d{2})$/.exec(text)
    if (!yearMatch || code === null) continue
    const year = Number(yearMatch[1])
    const cells: string[] = []
    let sib = th.nextElementSibling
    while (sib && sib.tagName === 'TD' && cells.length < 12) {
      cells.push(cellText(sib))
      sib = sib.nextElementSibling
    }
    if (cells.length < 12) continue
    cells.forEach((raw, i) => out.push({ date: isoDate(year, i + 1, 1), code, label: title, seasonal_factor: sfFloat(raw) }))
  }
  return out
}

async function parseForecastRows(table: HTMLElement, titleText: string, ctx: NativeCtx): Promise<Row[]> {
  const yearMatch = /(?<![A-Za-z0-9_])(20\d{2})(?![A-Za-z0-9_])/.exec(titleText)
  if (!yearMatch) return []
  const year = Number(yearMatch[1])
  const titles = await wpsTitles(ctx)
  const out: Row[] = []
  for (const tr of findAll(table, ['tr'])) {
    const cells = findAll(tr, ['th', 'td']).map(cellText)
    if (cells.length < 13) continue
    const first = cells[0]!
    if (!first.toUpperCase().startsWith('WPS')) continue
    const code = first.replace(/ /g, '')
    cells.slice(1, 13).forEach((raw, i) => out.push({ date: isoDate(year, i + 1, 1), code, label: titles.get(code), seasonal_factor: sfFloat(raw) }))
  }
  return out
}

async function seasonalFactors(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const tableId = SF_CANONICAL[str(params.category) ?? 'fd_id']!
  const entry = SF_TABLES[tableId]!
  const html = await fetchPage(ctx, entry.url)
  const tables = htmlTables(html)
  if (tables.length < 2) throw new Error(`No rows parsed from BLS seasonal-factor table '${tableId}'.`)
  const dataTable = tables[1]!
  const rows = tableId === 'ppi-seafac' ? await parseForecastRows(dataTable, htmlTitle(html), ctx) : parseFiveYearRows(dataTable)
  if (rows.length === 0) throw new Error(`No rows parsed from BLS seasonal-factor table '${tableId}'.`)
  const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
  const withTable: Row[] = rows.map((r) => ({ ...r, table_id: tableId, table_name: entry.label }))
  return withTable.sort((a, b) => cmp(a.date as string, b.date as string) || cmp(a.code as string, b.code as string))
}

// ---- detailed report -----------------------------------------------------------------------------------------

const TABLE_TITLES: Record<number, string> = {
  1: 'Producer Price Index percentage changes and weights for Final Demand-Intermediate Demand (FD-ID) aggregation system, seasonally adjusted.',
  2: 'Producer Price Index percentage changes for selected Final Demand-Intermediate Demand (FD-ID) aggregations, seasonally adjusted.',
  3: 'Producer Price Indexes for Final Demand-Intermediate Demand (FD-ID) aggregations, seasonally adjusted.',
  4: 'Producer Price Index percentage changes and weights for Final Demand-Intermediate Demand (FD-ID) aggregation system, not seasonally adjusted.',
  5: 'Producer Price Indexes for Final Demand-Intermediate Demand (FD-ID) aggregations, not seasonally adjusted.',
  6: 'Producer Price Index percentage changes for selected commodity groupings, seasonally adjusted.',
  7: 'Producer Price Index percentage changes for commodity and service groupings and individual items, not seasonally adjusted.',
  8: 'Producer Price Indexes and percentage changes for selected commodity groupings, seasonally adjusted.',
  9: 'Producer Price Indexes for commodity and service groupings and individual items, not seasonally adjusted.',
  10: 'Producer Price Indexes and percentage changes for the net output of selected NAICS industry sector and 3-digit subsector groups, not seasonally adjusted.',
  11: 'Producer Price Indexes for the net output of selected NAICS industries and their products, not seasonally adjusted.',
  12: 'Producer Price Index percentage changes for the net output of selected NAICS industries and their products, not seasonally adjusted.',
  13: 'Producer Price Indexes and percentage changes for special commodity groupings, not seasonally adjusted.',
  14: 'Producer Price Indexes and percentage changes for inputs to construction industries and selected construction outputs, not seasonally adjusted.',
}

const cleanHeader = (text: Cell | undefined): string => (text === null || text === undefined ? '' : squish(String(text).replace(/\n/g, ' ')))
/** Drop a trailing `(N)`/`(p)` footnote marker from a header label. */
const stripFootnoteMarker = (text: string): string => text.replace(/\s*\(\w+\)\s*$/, '').trim()

/** The end date of a period label (`_period_label_to_date`). */
function periodLabelToDate(label: string | null, reportYear: number, reportMonth: number, isRange: boolean): string | null {
  if (!label) return null
  const text = stripFootnoteMarker(label)
  if (isRange) {
    const m = /\bto\s+([A-Za-z]+)\.?\s*(\d{4})?/i.exec(text)
    if (!m) return null
    const month = monthNum(m[1]!)
    if (month === null) return null
    if (m[2] !== undefined) return isoDate(Number(m[2]), month, 1)
    return isoDate(month <= reportMonth ? reportYear : reportYear - 1, month, 1)
  }
  const m = /\b([A-Za-z]+)\.?\s+(\d{4})\b/i.exec(text)
  if (!m) return null
  const month = monthNum(m[1]!)
  return month === null ? null : isoDate(Number(m[2]), month, 1)
}

type Column = { kind: string; period: string | null }

function classifyHeaderPair(superRow: Cell[], subRow: Cell[]): Column[] {
  const n = Math.max(superRow.length, subRow.length)
  const filledSuper: string[] = []
  let last = ''
  for (let i = 0; i < n; i++) {
    const cell = cleanHeader(superRow[i])
    if (cell) last = cell
    filledSuper.push(last)
  }
  const out: Column[] = []
  for (let i = 0; i < n; i++) {
    const s = filledSuper[i]!
    const sub = cleanHeader(subRow[i])
    const sLo = s.toLowerCase()
    const subLo = sub.toLowerCase()
    let kind: string
    let period: string | null = null
    if (i === 0 || sLo === 'indent level') kind = 'indent'
    else if (['grouping', 'title', 'title(1)'].includes(sLo)) kind = 'label'
    else if (sLo === 'group code' || subLo === 'group code') kind = 'group_code'
    else if (sLo === 'item code' || subLo === 'item code') kind = 'item_code'
    else if (sLo.includes('industry code') || subLo.includes('industry code')) kind = 'industry_code'
    else if (sLo.includes('product code') || subLo.includes('product code')) kind = 'product_code'
    else if (sLo.includes('other index base') || sLo === 'index base') kind = 'other_index_base'
    else if (sLo.includes('relative importance')) {
      kind = 'relative_importance'
      period = stripFootnoteMarker(s.replace(/\s*\(\w+\)\s*$/, '').replace('Relative Importance', '').replace('relative importance', '').trim())
    } else if (sLo.includes('12-month percent change')) {
      kind = 'pct_change_12m'
      period = sub ? stripFootnoteMarker(sub) : null
    } else if (sLo.includes('1-month percent change')) {
      kind = sLo.includes('seasonally adjusted') ? 'pct_change_1m_sa' : 'pct_change_1m_nsa'
      period = sub ? stripFootnoteMarker(sub) : null
    } else if (sLo.includes('index') && !sLo.includes('code') && !sLo.includes('base')) {
      kind = sLo.includes('seasonally adjusted') ? 'index_sa' : 'index_nsa'
      period = sub ? stripFootnoteMarker(sub) : null
    } else kind = 'skip'
    out.push({ kind, period })
  }
  return out
}

/** The two-row header block and its column kinds (`_detect_columns`). */
function detectColumns(rows: Cell[][]): { columns: Column[]; dataStart: number } {
  for (let idx = 0; idx < rows.length; idx++) {
    const row = rows[idx]!
    if (row.length === 0 || row[0] === null || row[0] === undefined) continue
    if (cleanHeader(row[0]).toLowerCase() !== 'indent level') continue
    return { columns: classifyHeaderPair(row, rows[idx + 1] ?? []), dataStart: idx + 2 }
  }
  return { columns: [], dataStart: 0 }
}

const coerceNumber = (value: Cell | undefined): number | null => {
  if (value === null || value === undefined || typeof value === 'boolean') return null
  if (typeof value === 'number') return value
  const text = value.trim()
  return ['', '-', '(NA)', '–'].includes(text) || !FLOAT_RE.test(text) ? null : Number(text)
}

const VALUE_KINDS = new Set(['relative_importance', 'pct_change_12m', 'pct_change_1m_sa', 'pct_change_1m_nsa', 'index_sa', 'index_nsa'])

/** One worksheet row as one record per (series, date) (`_row_to_records`). */
function rowToRecords(row: Cell[], columns: Column[], reportYear: number, reportMonth: number): Row[] {
  if (row.length === 0 || row[0] === null || row[0] === undefined || row[0] === '') return []
  const indentText = String(row[0]).trim()
  if (!/^[+-]?\d+$/.test(indentText)) return []
  const level = Number(indentText)

  let label: string | null = null
  let groupCode: string | null = null
  let itemCode: string | null = null
  let industryCode: string | null = null
  let productCode: string | null = null
  let otherIndexBase: string | null = null
  let seasonallyAdjusted: boolean | null = null
  const perDate = new Map<string, Row>()

  for (let i = 0; i < columns.length; i++) {
    const { kind, period } = columns[i]!
    if (i >= row.length) break
    if (kind === 'indent' || kind === 'skip') continue
    const raw = row[i]
    if (raw === null || raw === undefined) continue
    let cleaned: Cell = raw
    if (typeof raw === 'string') {
      cleaned = raw.trim()
      if (cleaned === '') continue
    }
    if (kind === 'label' && label === null) {
      label = String(cleaned)
      continue
    }
    if (kind === 'group_code' && typeof cleaned === 'string') {
      groupCode = cleaned
      continue
    }
    if (kind === 'item_code' && typeof cleaned === 'string') {
      itemCode = cleaned
      continue
    }
    if (kind === 'industry_code' && typeof cleaned === 'string') {
      industryCode = cleaned
      continue
    }
    if (kind === 'product_code' && typeof cleaned === 'string') {
      productCode = cleaned
      continue
    }
    if (kind === 'other_index_base') {
      otherIndexBase = String(cleaned)
      continue
    }
    if (!VALUE_KINDS.has(kind)) continue
    const isRange = kind === 'pct_change_12m' || kind === 'pct_change_1m_sa' || kind === 'pct_change_1m_nsa'
    const dateKey = periodLabelToDate(period, reportYear, reportMonth, isRange)
    if (dateKey === null) continue
    const num = coerceNumber(cleaned)
    if (num === null) continue
    if (!perDate.has(dateKey)) perDate.set(dateKey, {})
    const slot = perDate.get(dateKey)!
    if (kind === 'relative_importance') slot.relative_importance = num
    else if (kind === 'pct_change_12m') slot.pct_change_12m = num
    else if (kind === 'pct_change_1m_sa' || kind === 'pct_change_1m_nsa') {
      slot.pct_change_1m = num
      seasonallyAdjusted = kind === 'pct_change_1m_sa'
    } else {
      slot.index_value = num
      seasonallyAdjusted = kind === 'index_sa'
    }
  }
  if (perDate.size === 0) return []
  const codeParts = [groupCode, itemCode, industryCode, productCode].filter(Boolean)
  const code = codeParts.length ? codeParts.join('') : null
  if (code === null && label === null) return []
  return [...perDate.keys()].sort().map((d) => ({ date: d, code, label, level, group_code: groupCode, item_code: itemCode, industry_code: industryCode, product_code: productCode, other_index_base: otherIndexBase, seasonally_adjusted: seasonallyAdjusted, ...perDate.get(d)! }))
}

/** The most recent value of `key` at any indent shallower than `indent` (`_inherit_from_stack`). */
function inheritFromStack(stack: Map<number, { industry_code: string | null; group_code: string | null }>, indent: number, key: 'industry_code' | 'group_code'): string | null {
  for (let lvl = indent - 1; lvl >= 0; lvl--) {
    const value = stack.get(lvl)?.[key]
    if (value) return value
  }
  return null
}

/** `{'(3)': 'text'}` from the table's footnote legend (`_parse_table_footnotes`). */
function parseTableFootnotes(trailing: Cell[][]): Map<string, string> {
  let foundHeader = false
  const out = new Map<string, string>()
  for (const row of trailing) {
    if (row.length < 2) continue
    const cell = row[1]
    if (typeof cell !== 'string') continue
    const text = cell.trim()
    if (!text) continue
    if (/^footnotes?\b/i.test(text)) {
      foundHeader = true
      continue
    }
    if (!foundHeader) continue
    const m = /^\(([^)]+)\)\s*(.*)$/.exec(text)
    if (!m) continue
    out.set(`(${m[1]})`, m[2]!.trim() || text)
  }
  return out
}

function resolveLabelFootnotes(label: string | null, footnotes: Map<string, string>): string | null {
  if (!label || footnotes.size === 0) return null
  const matched: string[] = []
  const seen = new Set<string>()
  for (const m of label.matchAll(/\(([^)]+)\)/g)) {
    if (!footnotes.has(m[0]) || seen.has(m[0])) continue
    seen.add(m[0])
    matched.push(footnotes.get(m[0])!)
  }
  return matched.length ? matched.join('\n\n') : null
}

function buildCode(r: Row): string | null {
  const { product_code: product, industry_code: industry, group_code: group, item_code: item } = r as Record<string, string | null>
  if (product) return product
  if (group && item) return `${group}${item}`
  if (industry) return industry
  if (group) return group
  if (item) return item
  return null
}

function parseDetailedTable(sheet: Sheet['rows'], tableNumber: number, year: number, month: number): Row[] {
  const releasePeriod = `${MONTH_NAMES[month - 1]} ${year}`
  const tableId = `ppi-dr-${year}-${String(month).padStart(2, '0')}-t${tableNumber}`
  const tableName = `PPI Detailed Report ${releasePeriod} — Table ${tableNumber}: ${TABLE_TITLES[tableNumber]}`
  const { columns, dataStart } = detectColumns(sheet)
  if (columns.length === 0) return []
  const body = sheet.slice(dataStart)
  const footnotes = parseTableFootnotes(body)
  const out: Row[] = []
  const stack = new Map<number, { industry_code: string | null; group_code: string | null }>()
  for (const sourceRow of body) {
    const records = rowToRecords(sourceRow, columns, year, month)
    if (records.length === 0) continue
    const first = records[0]!
    const indent = (first.level as number) || 0
    const ownIndustry = first.industry_code as string | null
    const ownGroup = first.group_code as string | null
    const effectiveIndustry = ownIndustry ? ownIndustry : inheritFromStack(stack, indent, 'industry_code')
    const effectiveGroup = ownGroup ? ownGroup : inheritFromStack(stack, indent, 'group_code')
    stack.set(indent, { industry_code: effectiveIndustry, group_code: effectiveGroup })
    for (const lvl of [...stack.keys()]) if (lvl > indent) stack.delete(lvl)
    const footnote = resolveLabelFootnotes(first.label as string | null, footnotes)
    for (const record of records) {
      record.industry_code = effectiveIndustry
      record.group_code = effectiveGroup
      record.code = buildCode(record)
      record.footnote = footnote
      record.table_id = tableId
      record.table_name = tableName
      record.table_number = tableNumber
      record.release_period = releasePeriod
      out.push(record)
    }
  }
  const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
  out.sort((a, b) => cmp(b.date as string, a.date as string) || cmp((a.code as string | null) ?? '', (b.code as string | null) ?? '') || ((a.level as number | null) ?? 0) - ((b.level as number | null) ?? 0) || cmp((a.label as string | null) ?? '', (b.label as string | null) ?? ''))
  // The Data model serialises a label with a footnote as {value, footnote}.
  return out.map((r) => {
    const o: Row = {}
    for (const [k, v] of Object.entries(r)) if (v !== null && v !== undefined) o[k] = v
    if (typeof o.label === 'string' && typeof o.footnote === 'string' && o.footnote) o.label = { value: o.label, footnote: o.footnote }
    return o
  })
}

const monthUrl = (year: number, month: number): string => `https://www.bls.gov/ppi/detailed-report/ppi-detailed-report-${MONTH_NAMES[month - 1]!.toLowerCase()}-${year}.xlsx`

function fetchMonthXlsx(ctx: NativeCtx, year: number, month: number): Promise<Uint8Array | null> {
  const url = monthUrl(year, month)
  return ctx.cache(`bls:ppidr:${url}`, 3600 * 1000, async () => {
    const res = await ctx.http.response(url, { headers: { 'User-Agent': BLS_USER_AGENT, Accept: XLSX_ACCEPT }, timeoutMs: 60_000 })
    if (res.redirected || res.status === 404) return null
    if (res.status !== 200) throw new Error(`BLS returned HTTP ${res.status} fetching ${url}.`)
    const bytes = new Uint8Array(await res.arrayBuffer())
    return isXlsx(bytes) ? bytes : null
  })
}

async function detailedReport(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const tableNumber = params.table === undefined ? 1 : Number(params.table)
  const date = str(params.date)
  let year: number
  let month: number
  let content: Uint8Array | null = null
  if (!date) {
    const today = ctx.now()
    year = today.getUTCFullYear()
    month = today.getUTCMonth() + 1
    for (let i = 0; i < 6 && content === null; i++) {
      content = await fetchMonthXlsx(ctx, year, month)
      if (content === null) {
        month--
        if (month === 0) {
          month = 12
          year--
        }
      }
    }
    if (content === null) throw new Error('Could not locate a recent BLS PPI Detailed Report XLSX within the last six months — the publication URL pattern may have changed.')
  } else {
    if (date < '2022-01-01') throw new Error(`BLS publishes the PPI Detailed Report as XLSX only from January 2022 onward; requested date ${date} is too early.`)
    year = Number(date.slice(0, 4))
    month = Number(date.slice(5, 7))
    content = await fetchMonthXlsx(ctx, year, month)
    if (content === null) throw new Error(`BLS has no PPI Detailed Report XLSX for ${MONTH_NAMES[month - 1]} ${year}.`)
  }
  const sheet = loadSheets(content).find((s) => s.name === `Table ${tableNumber}`)
  if (!sheet) throw new Error(`BLS PPI Detailed Report for ${MONTH_NAMES[month - 1]} ${year} does not contain sheet 'Table ${tableNumber}'.`)
  const rows = parseDetailedTable(sheet.rows, tableNumber, year, month)
  if (rows.length === 0) throw new Error(`No rows parsed from BLS PPI Detailed Report 'ppi-dr-${year}-${String(month).padStart(2, '0')}-t${tableNumber}'.`)
  return rows
}

export const ppiRoutes: Record<string, NativeHandler> = {
  'bls/ppi/relative_importance': relativeImportance,
  'bls/ppi/seasonal_factors': seasonalFactors,
  'bls/ppi/detailed_report': detailedReport,
}
