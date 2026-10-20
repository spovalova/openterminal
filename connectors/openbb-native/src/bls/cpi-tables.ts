// bls/cpi/relative_importance, seasonal_factors and supplemental_tables, provider bls. Ported from
// openbb_bls/models/{cpi_relative_importance,cpi_seasonal_factors,cpi_supplemental_tables}.py and
// utils/cpi_supplemental_tables.py (OpenBB Platform 5.0.0, Apache-2.0); modified: readXlsx instead of openpyxl,
// plain rows, latest-file searches walk back from ctx.now().
import type { Cell } from '../lib/xlsx.js'
import type { NativeCtx, NativeHandler, NativeParams, Row } from '../types.js'
import { anchors, BLS_USER_AGENT, HTML_HEADERS, fetchPage, isoDate, loadSheets, parseHtml, squish, str, type Sheet } from './helpers.js'

const XLSX_ACCEPT = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,*/*'
const MONTHS: Record<string, number> = { jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12 }
const FLOAT_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/

const monthNum = (token: string): number | null => MONTHS[token.trim().toLowerCase().replace(/\.+$/, '')] ?? null
const ym = (d: string): number => Number(d.slice(0, 4)) * 12 + Number(d.slice(5, 7)) - 1
const monthsBetween = (a: string, b: string): number => Math.abs(ym(b) - ym(a))

function parseSinglePeriod(text: string): string | null {
  const m = /([A-Za-z]+)\.?\s+(\d{4})/i.exec(text)
  const month = m ? monthNum(m[1]!) : null
  return m && month ? isoDate(Number(m[2]), month, 1) : null
}

function parseRangePeriod(text: string): [string, string] | null {
  const m = /([A-Za-z]+)\.?\s*(\d{4})?\s*[-–]\s*([A-Za-z]+)\.?\s*(\d{4})/i.exec(text)
  if (!m) return null
  const startMonth = monthNum(m[1]!)
  const endMonth = monthNum(m[3]!)
  if (!startMonth || !endMonth || !m[4]) return null
  const endYear = Number(m[4])
  return [isoDate(m[2] ? Number(m[2]) : endYear, startMonth, 1), isoDate(endYear, endMonth, 1)]
}

function parseToFromSuper(text: string): string | null {
  const m = /percent change to\s+([A-Za-z]+)\.?\s*(\d{4})\s*from/i.exec(text)
  const month = m ? monthNum(m[1]!) : null
  return m && month ? isoDate(Number(m[2]), month, 1) : null
}

/** A numeric cell as a number; blanks and markers are null (`_to_float`). */
function toFloat(value: Cell | undefined): number | null {
  if (value === null || value === undefined || typeof value === 'boolean') return null
  if (typeof value === 'number') return value
  const text = value.trim()
  return FLOAT_RE.test(text) ? Number(text) : null
}

/** A cell as `int(str(cell).strip())` reads it: whole numbers only. */
function toInt(cell: Cell | undefined): number | null {
  if (cell === null || cell === undefined || cell === '') return null
  if (typeof cell === 'number') return Number.isInteger(cell) ? cell : null
  const text = String(cell).trim()
  return /^[+-]?\d+$/.test(text) ? Number(text) : null
}

const isXlsx = (b: Uint8Array): boolean => b[0] === 0x50 && b[1] === 0x4b && b[2] === 3 && b[3] === 4

/** One workbook, or null when BLS has not published it (a redirect, a 404 or a page that is not a workbook). */
function fetchWorkbook(ctx: NativeCtx, url: string): Promise<Uint8Array | null> {
  return ctx.cache(`bls:xlsx:${url}`, 3600 * 1000, async () => {
    const res = await ctx.http.response(url, { headers: { 'User-Agent': BLS_USER_AGENT, Accept: XLSX_ACCEPT }, timeoutMs: 60_000 })
    if (res.redirected || res.status === 404) return null
    if (res.status !== 200) throw new Error(`BLS returned HTTP ${res.status} fetching ${url}.`)
    const bytes = new Uint8Array(await res.arrayBuffer())
    return isXlsx(bytes) ? bytes : null
  })
}

// ---- footnotes (shared by the relative-importance and supplemental parsers) -----------------------------------

function parseFootnotes(rows: Sheet['rows']): Map<string, string> {
  const out = new Map<string, string>()
  for (const row of rows) {
    if (!row || row.length === 0) continue
    for (const cell of row) {
      if (typeof cell !== 'string') continue
      const text = cell.trim()
      const m = /^\(([^)]+)\)\s*(.*)$/.exec(text)
      if (!m) continue
      out.set(`(${m[1]})`, m[2]!.trim() || text)
      break
    }
  }
  return out
}

function resolveFootnotes(label: string | null, footnotes: Map<string, string>): string | null {
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

/** The Data models serialise a label with a footnote as {value, footnote}. */
function withFootnoteLabel(row: Row): Row {
  const out: Row = {}
  for (const [k, v] of Object.entries(row)) if (v !== null && v !== undefined) out[k] = v
  if (typeof out.label === 'string' && typeof out.footnote === 'string' && out.footnote) out.label = { value: out.label, footnote: out.footnote }
  return out
}

// ---- relative importance -------------------------------------------------------------------------------------

/** First year with a published file, searching back from this year: BLS stops redirecting once it exists. */
async function latestYear<T>(ctx: NativeCtx, fetchYear: (year: number) => Promise<T | null>, what: string): Promise<[number, T]> {
  const thisYear = ctx.now().getUTCFullYear()
  for (let year = thisYear; year > thisYear - 6; year--) {
    const content = await fetchYear(year)
    if (content !== null) return [year, content]
  }
  throw new Error(`Could not locate a recent ${what} XLSX — the BLS publication URL pattern may have changed.`)
}

function classifyRiColumns(superHeaders: Cell[], subHeaders: Cell[]): { col: number; area: string | null; basket: string }[] {
  const out: { col: number; area: string | null; basket: string }[] = []
  const n = Math.max(superHeaders.length, subHeaders.length)
  for (let i = 0; i < n; i++) {
    const sub = subHeaders[i]
    if (typeof sub !== 'string') continue
    const token = sub.trim().toUpperCase()
    if (token !== 'CPI-U' && token !== 'CPI-W') continue
    const sup = superHeaders[i]
    out.push({ col: i, area: typeof sup === 'string' && sup.trim() ? squish(sup) : null, basket: token })
  }
  return out
}

function parseRiSheet(sheet: Cell[][], year: number, tableNumber: number): Row[] {
  const tableId = `cpi-ri-${year}-t${tableNumber}`
  const tableName = `CPI Relative Importance ${year} — Table ${tableNumber}`
  let superHeaders: Cell[] = []
  let subHeaders: Cell[] = []
  let dataStart = 0
  for (let idx = 0; idx < sheet.length; idx++) {
    const row = sheet[idx]!
    if (row.length > 0 && typeof row[0] === 'string' && row[0].trim().toLowerCase() === 'indent level') {
      superHeaders = row
      subHeaders = sheet[idx + 1] ?? []
      dataStart = idx + 2
      break
    }
  }
  if (superHeaders.length === 0) return []
  const basketCols = classifyRiColumns(superHeaders, subHeaders)
  if (basketCols.length === 0) return []
  const body = sheet.slice(dataStart)
  const footnotes = parseFootnotes(body)
  const referenceDate = isoDate(year - 1, 12, 1)
  const perSeries = new Map<string, Row[]>()
  let currentSection: string | null = null
  body.forEach((row, sourceIdx) => {
    const label1 = row.length > 1 && typeof row[1] === 'string' ? row[1] : null
    if (label1 !== null && ['expenditure category', 'special aggregate indexes', 'items'].includes(label1.trim().toLowerCase()) && row.length >= 2) {
      if (label1) currentSection = label1.trim()
      return
    }
    if (row[0] === null || row[0] === undefined || row[0] === '') return
    const level = toInt(row[0])
    if (level === null) return
    const label = typeof row[1] === 'string' && row[1].trim() ? row[1].trim() : null
    if (label === null) return
    const footnote = resolveFootnotes(label, footnotes)
    for (const { col, area, basket } of basketCols) {
      const cell = row[col]
      let value: number | null
      if (cell === null || cell === undefined) value = null
      else if (typeof cell === 'number') value = cell
      else {
        const text = String(cell).trim()
        value = text === '' || text === '-' || !FLOAT_RE.test(text) ? null : Number(text)
      }
      const key = `${area ?? '\u0000none'}\u0001${basket}`
      if (!perSeries.has(key)) perSeries.set(key, [])
      perSeries.get(key)!.push({ date: referenceDate, label, level, section: currentSection, area, basket, relative_importance: value, footnote, _source_idx: sourceIdx, table_id: tableId, table_name: tableName })
    }
  })
  const out: Row[] = []
  let rowIndex = 0
  for (const bucket of perSeries.values()) {
    bucket.sort((a, b) => (a._source_idx as number) - (b._source_idx as number))
    for (const { _source_idx, ...entry } of bucket) {
      void _source_idx
      rowIndex++
      out.push(withFootnoteLabel({ ...entry, row_index: rowIndex }))
    }
  }
  return out
}

async function relativeImportance(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const tableNumber = params.table === undefined ? 1 : Number(params.table)
  const url = (year: number): string => `https://www.bls.gov/cpi/tables/relative-importance/${year}.xlsx`
  let year: number
  let content: Uint8Array
  if (params.year === undefined || params.year === '') [year, content] = await latestYear(ctx, (y) => fetchWorkbook(ctx, url(y)), 'CPI Relative Importance')
  else {
    year = Number(params.year)
    const got = await fetchWorkbook(ctx, url(year))
    if (got === null) throw new Error(`BLS CPI Relative Importance file for ${year} not found.`)
    content = got
  }
  const sheet = loadSheets(content).find((s) => s.name === `Table ${tableNumber}`)
  if (!sheet) throw new Error(`CPI Relative Importance ${year} does not contain sheet 'Table ${tableNumber}'.`)
  const rows = parseRiSheet(sheet.rows, year, tableNumber)
  if (rows.length === 0) throw new Error(`No rows parsed from CPI RI table 'cpi-ri-${year}-t${tableNumber}'.`)
  return rows
}

// ---- seasonal factors ----------------------------------------------------------------------------------------

const MONTH_COLUMNS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']

function parseSaSheet(raw: Cell[][], year: number): Row[] {
  const tableId = `cpi-sa-${year}`
  const tableName = `CPI Revised Seasonally Adjusted Indexes and Factors — file ${year}`
  const headerIdx = raw.findIndex((row) => row.length > 0 && typeof row[0] === 'string' && row[0].trim().toUpperCase() === 'ITEM')
  if (headerIdx < 0) return []
  const headers = raw[headerIdx]!.map((c) => (c === null || c === undefined ? '' : String(c).trim().toUpperCase()))
  const colIdx = new Map<string, number>()
  headers.forEach((name, i) => {
    if (name && !colIdx.has(name)) colIdx.set(name, i)
  })
  if (!['ITEM', 'TITLE', 'SERIESID', 'DATA_TYPE', 'YEAR'].every((k) => colIdx.has(k))) return []
  const monthCols = MONTH_COLUMNS.flatMap((m, i) => (colIdx.has(m) ? [{ month: i + 1, col: colIdx.get(m)! }] : []))
  if (monthCols.length !== 12) return []

  type Slot = { item: string; title: string | null; seriesId: string | null; year: number; index: Map<number, number>; factor: Map<number, number> }
  const pivots = new Map<string, Slot>()
  for (const row of raw.slice(headerIdx + 1)) {
    const itemCell = row[colIdx.get('ITEM')!]
    if (row.length === 0 || itemCell === null || itemCell === undefined) continue
    const item = String(itemCell).trim()
    const title = row[colIdx.get('TITLE')!]
    const seriesId = row[colIdx.get('SERIESID')!]
    const dataType = row[colIdx.get('DATA_TYPE')!]
    const rowYear = toInt(row[colIdx.get('YEAR')!])
    if (rowYear === null || dataType === null || dataType === undefined) continue
    const dataTypeNorm = String(dataType).trim().toUpperCase()
    const key = `${item}\u0000${rowYear}`
    let slot = pivots.get(key)
    if (!slot) {
      slot = { item, title: typeof title === 'string' && title.trim() ? title.trim() : null, seriesId: typeof seriesId === 'string' && seriesId.trim() ? seriesId.trim() : null, year: rowYear, index: new Map(), factor: new Map() }
      pivots.set(key, slot)
    }
    for (const { month, col } of monthCols) {
      const value = col < row.length ? toFloat(row[col]) : null
      if (value === null) continue
      if (dataTypeNorm.includes('FACTOR')) slot.factor.set(month, value)
      else slot.index.set(month, value)
    }
  }
  const out: Row[] = []
  for (const slot of pivots.values()) {
    for (let month = 1; month <= 12; month++) {
      const index = slot.index.get(month)
      const factor = slot.factor.get(month)
      if (index === undefined && factor === undefined) continue
      out.push({ date: isoDate(slot.year, month, 1), item_code: slot.item, series_id: slot.seriesId ?? '', title: slot.title, seasonally_adjusted_index: index, seasonal_factor: factor, table_id: tableId, table_name: tableName })
    }
  }
  return out.sort((a, b) => (a.date === b.date ? (a.item_code === b.item_code ? 0 : (a.item_code as string) < (b.item_code as string) ? -1 : 1) : (a.date as string) < (b.date as string) ? -1 : 1))
}

async function seasonalFactors(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const url = (year: number): string => `https://www.bls.gov/cpi/tables/seasonal-adjustment/revised-seasonally-adjusted-indexes-${year}.xlsx`
  let year: number
  let content: Uint8Array
  if (params.year === undefined || params.year === '') [year, content] = await latestYear(ctx, (y) => fetchWorkbook(ctx, url(y)), 'CPI Seasonal Adjustment')
  else {
    year = Number(params.year)
    const got = await fetchWorkbook(ctx, url(year))
    if (got === null) throw new Error(`BLS CPI Seasonal Adjustment file for ${year} not found.`)
    content = got
  }
  const rows = parseSaSheet(loadSheets(content)[0]?.rows ?? [], year)
  if (rows.length === 0) throw new Error(`No rows parsed from CPI seasonal-factor table 'cpi-sa-${year}'.`)
  return rows
}

// ---- supplemental tables -------------------------------------------------------------------------------------

type TableSpec = { key: string; stem: string; sheet: string | null; label: string }

const TABLE_REGISTRY: Record<string, TableSpec> = {
  'c-cpi-u': { key: 'c-cpi-u', stem: 'c-cpi-u', sheet: null, label: 'Chained CPI-U U.S. city average, by item.' },
  'cpi-u-us': { key: 'cpi-u-us', stem: 'cpi-u', sheet: 'US', label: 'CPI-U U.S. city average, by expenditure category.' },
  'cpi-u-regional': { key: 'cpi-u-regional', stem: 'cpi-u', sheet: 'Regional', label: 'CPI-U selected areas, all items index.' },
  'cpi-w': { key: 'cpi-w', stem: 'cpi-w', sheet: null, label: 'CPI-W U.S. city average, by expenditure category.' },
  'historical-cpi-u-index': { key: 'historical-cpi-u-index', stem: 'historical-cpi-u', sheet: 'Index values', label: 'Historical CPI-U U.S. city average, all items, monthly indexes.' },
  'historical-cpi-u-averages': { key: 'historical-cpi-u-averages', stem: 'historical-cpi-u', sheet: 'Index averages', label: 'Historical CPI-U U.S. city average, all items, semiannual and annual averages.' },
}

const SUPP_BASE = 'https://www.bls.gov/cpi/tables/supplemental-files'
const stemUrl = (stem: string, year: number, month: number): string => `${SUPP_BASE}/${stem}-${String(year).padStart(4, '0')}${String(month).padStart(2, '0')}.xlsx`

/** Snapshot months listed on the supplemental-files home page, by file stem (`list_supp_index`). */
async function listSuppIndex(ctx: NativeCtx): Promise<Map<string, string[]>> {
  const soup = parseHtml(await fetchPage(ctx, `${SUPP_BASE}/home.htm`, HTML_HEADERS))
  const byStem = new Map<string, Set<string>>()
  for (const { href } of anchors(soup)) {
    const m = /^\/cpi\/tables\/supplemental-files\/([a-z0-9-]+)-(\d{4})(\d{2})\.xlsx$/i.exec(href)
    if (!m) continue
    const month = Number(m[3])
    if (month < 1 || month > 12) continue
    const stem = m[1]!.toLowerCase()
    if (!byStem.has(stem)) byStem.set(stem, new Set())
    byStem.get(stem)!.add(isoDate(Number(m[2]), month, 1))
  }
  return new Map([...byStem].map(([stem, dates]) => [stem, [...dates].sort()]))
}

async function discoverLatest(ctx: NativeCtx, stem: string): Promise<[number, number, Uint8Array]> {
  const index = (await listSuppIndex(ctx)).get(stem)
  const candidates: [number, number][] = []
  if (index) for (const d of [...index].reverse()) candidates.push([Number(d.slice(0, 4)), Number(d.slice(5, 7))])
  const today = ctx.now()
  let year = today.getUTCFullYear()
  let month = today.getUTCMonth() + 1
  for (let i = 0; i < 6; i++) {
    candidates.push([year, month])
    month--
    if (month === 0) {
      month = 12
      year--
    }
  }
  const seen = new Set<string>()
  for (const [y, m] of candidates) {
    const k = `${y}-${m}`
    if (seen.has(k)) continue
    seen.add(k)
    const content = await fetchWorkbook(ctx, stemUrl(stem, y, m))
    if (content !== null) return [y, m, content]
  }
  throw new Error(`Could not locate a published CPI supplemental XLSX for stem '${stem}' within the last six months.`)
}

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

const norm = (text: Cell | undefined): string => (text === null || text === undefined ? '' : squish(String(text).replace(/[\n\r]/g, ' ')))
const isHeaderRow = (row: Cell[]): boolean => row.length > 0 && row[0] !== null && row[0] !== undefined && ['indent level', 'indent\nlevel'].includes(String(row[0]).trim().toLowerCase())
const isBlankRow = (row: Cell[]): boolean => row.every((c) => c === null || c === undefined || (typeof c === 'string' && !c.trim()))

function isNoteRow(row: Cell[]): boolean {
  const first = row.find((c) => typeof c === 'string' && c.trim())
  if (typeof first !== 'string') return false
  const text = first.trim()
  return text.toUpperCase().startsWith('NOTE:') || /^\(([^)]+)\)\s*(.*)$/.test(text) || text.toLowerCase().startsWith('indexes are issued') || text.toLowerCase().startsWith('footnote')
}

type ColumnKind = { kind: string; payload: string | [string, string] | null } | null

function classifySuppColumns(superRow: Cell[], subRow: Cell[] | null): ColumnKind[] {
  const n = superRow.length
  const filledSuper: string[] = []
  let last = ''
  for (let i = 0; i < n; i++) {
    const cell = norm(superRow[i])
    if (cell) last = cell
    filledSuper.push(last)
  }
  const sub = subRow ?? Array.from<Cell>({ length: n }).fill(null)
  const out: ColumnKind[] = []
  for (let i = 0; i < n; i++) {
    const s = filledSuper[i]!
    const subText = norm(sub[i])
    const sLo = s.toLowerCase()
    if (i === 0 || sLo === 'indent level' || ['expenditure category', 'special aggregate', 'title', 'item', 'area'].some((p) => sLo.startsWith(p))) {
      out.push(null)
      continue
    }
    if (sLo.includes('relative importance') && !subText) {
      out.push({ kind: 'relative_importance', payload: null })
      continue
    }
    if (sLo.includes('pricing schedule') && !subText) {
      out.push({ kind: 'pricing_schedule', payload: null })
      continue
    }
    if (sLo.includes('unadjusted index') || sLo.endsWith('indexes')) {
      out.push({ kind: 'index_value', payload: parseSinglePeriod(subText) })
      continue
    }
    if (sLo.includes('seasonally adjusted index')) {
      out.push({ kind: 'sa_index_value', payload: parseSinglePeriod(subText) })
      continue
    }
    if (sLo.includes('seasonally adjusted percent change')) {
      const rng = parseRangePeriod(subText)
      out.push({ kind: 'pct_change_1m_sa', payload: rng ? rng[1] : null })
      continue
    }
    if (sLo.includes('percent change to')) {
      const end = parseToFromSuper(s)
      const start = parseSinglePeriod(subText)
      if (end === null || start === null) {
        out.push(null)
        continue
      }
      const months = monthsBetween(start, end)
      if (months >= 12) out.push({ kind: 'pct_change_12m', payload: end })
      else if (months === 1) out.push({ kind: 'pct_change_1m_nsa', payload: end })
      else out.push({ kind: 'pct_change_window', payload: [start, end] })
      continue
    }
    if (sLo.includes('unadjusted percent change') || sLo === 'percent change') {
      const rng = parseRangePeriod(subText)
      if (!rng) {
        out.push(null)
        continue
      }
      out.push({ kind: monthsBetween(rng[0], rng[1]) >= 12 ? 'pct_change_12m' : 'pct_change_1m_nsa', payload: rng[1] })
      continue
    }
    out.push(null)
  }
  return out
}

type Snapshot = { snapshotDate: string; tableId: string; tableName: string; spec: TableSpec }

function suppRecord(snap: Snapshot, fields: Row): Row {
  return {
    snapshot_date: snap.snapshotDate,
    frequency: 'monthly',
    index_value: null,
    sa_index_value: null,
    pct_change_1m_nsa: null,
    pct_change_1m_sa: null,
    pct_change_12m: null,
    pct_change_window: null,
    pct_change_window_start_date: null,
    relative_importance: null,
    pricing_schedule: null,
    half: null,
    value_string: null,
    footnote: null,
    table_key: snap.spec.key,
    table_id: snap.tableId,
    table_name: snap.tableName,
    sheet: snap.spec.sheet ?? '',
    ...fields,
  }
}

function parseIndexValuesSheet(rows: Cell[][], snap: Snapshot): Row[] {
  const headerIdx = rows.findIndex(isHeaderRow)
  if (headerIdx < 0) return []
  const monthCols: [number, number][] = []
  rows[headerIdx]!.slice(2).forEach((cell, k) => {
    const m = monthNum(norm(cell))
    if (m !== null) monthCols.push([k + 2, m])
  })
  const out: Row[] = []
  let rowIndex = 0
  for (const row of rows.slice(headerIdx + 1)) {
    if (row.length === 0 || isBlankRow(row)) continue
    if (isNoteRow(row)) break
    const year = toInt(row.length > 1 ? row[1] : null)
    if (year === null) continue
    for (const [col, month] of monthCols) {
      const [value, valueString] = parseValue(row[col])
      if (value === null && valueString === null) continue
      rowIndex++
      out.push(suppRecord(snap, { date: isoDate(year, month, 1), label: 'All items', indent_level: 0, index_value: value, value_string: valueString, row_index: rowIndex }))
    }
  }
  return out
}

function parseIndexAveragesSheet(rows: Cell[][], snap: Snapshot): Row[] {
  const headerIdx = rows.findIndex(isHeaderRow)
  if (headerIdx < 0) return []
  const superRow = rows[headerIdx]!
  const subRow = rows[headerIdx + 1] ?? []
  const colKinds: ({ kind: string; half: string | null } | null)[] = []
  for (let i = 0; i < superRow.length; i++) {
    const top = norm(superRow[i]).toLowerCase()
    const sub = norm(subRow[i])
    if (i <= 1) colKinds.push(null)
    else if (top.includes('semiannual')) colKinds.push({ kind: 'semiannual_index', half: sub.toLowerCase().includes('1st') ? '1st' : sub.toLowerCase().includes('2nd') ? '2nd' : null })
    else if (top.includes('annual avg') && !sub) colKinds.push({ kind: 'annual_index', half: null })
    else if (top.includes('percent change from previous')) colKinds.push(sub.toLowerCase().includes('dec') ? { kind: 'annual_pct_change_dec', half: null } : sub.toLowerCase().includes('annual') ? { kind: 'annual_pct_change_avg', half: null } : null)
    else colKinds.push(null)
  }
  const out: Row[] = []
  let rowIndex = 0
  for (const row of rows.slice(headerIdx + 2)) {
    if (row.length === 0 || isBlankRow(row)) continue
    if (isNoteRow(row)) break
    const year = toInt(row.length > 1 ? row[1] : null)
    if (year === null) continue
    colKinds.forEach((cl, i) => {
      if (cl === null || i >= row.length) return
      const [value, valueString] = parseValue(row[i])
      if (value === null && valueString === null) return
      let refDate: string
      let frequency: string
      let half: string | null = null
      let measure: 'index_value' | 'pct_change_12m'
      if (cl.kind === 'semiannual_index') {
        refDate = isoDate(year, cl.half === '1st' ? 1 : 7, 1)
        frequency = 'semiannual'
        half = cl.half
        measure = 'index_value'
      } else if (cl.kind === 'annual_index') {
        refDate = isoDate(year, 1, 1)
        frequency = 'annual'
        measure = 'index_value'
      } else if (cl.kind === 'annual_pct_change_dec') {
        refDate = isoDate(year, 12, 1)
        frequency = 'monthly'
        measure = 'pct_change_12m'
      } else {
        refDate = isoDate(year, 1, 1)
        frequency = 'annual'
        measure = 'pct_change_12m'
      }
      rowIndex++
      out.push(suppRecord(snap, { date: refDate, label: 'All items', indent_level: 0, frequency, half, value_string: valueString, row_index: rowIndex, [measure]: value }))
    })
  }
  return out
}

function parseSuppTable(sheets: Sheet[], spec: TableSpec, year: number, month: number): Row[] {
  const sheetName = spec.sheet ?? sheets[0]?.name
  const sheet = sheets.find((s) => s.name === sheetName)
  if (!sheet) throw new Error(`CPI XLSX for ${spec.key} ${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')} has no sheet named '${sheetName}'.`)
  const raw = sheet.rows
  const ymText = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`
  const snap: Snapshot = { snapshotDate: isoDate(year, month, 1), tableId: `cpi-${spec.key}-${String(year).padStart(4, '0')}${String(month).padStart(2, '0')}`, tableName: `BLS CPI Supplemental — ${spec.label} (${ymText}).`, spec }
  if (spec.key === 'historical-cpi-u-index') return parseIndexValuesSheet(raw, snap)
  if (spec.key === 'historical-cpi-u-averages') return parseIndexAveragesSheet(raw, snap)

  const headerIdx = raw.findIndex(isHeaderRow)
  if (headerIdx < 0) throw new Error(`CPI XLSX for ${spec.key} ${ymText} has no 'Indent Level' header row.`)
  const headerRow1 = raw[headerIdx]!
  let headerRow2: Cell[] | null = null
  const nxt = raw[headerIdx + 1]
  if (nxt && nxt.some((cell, j) => j >= 2 && cell !== null && cell !== undefined && String(cell).trim() !== '' && (j >= headerRow1.length || headerRow1[j] !== nxt[j]))) headerRow2 = nxt
  const classifications = classifySuppColumns(headerRow1, headerRow2)
  const dataStart = headerIdx + (headerRow2 !== null ? 2 : 1)

  const body: Cell[][] = []
  const trailing: Cell[][] = []
  let inTrailing = false
  for (const row of raw.slice(dataStart)) {
    if (isBlankRow(row)) {
      if (inTrailing) continue
      body.push(row)
      continue
    }
    if (isNoteRow(row)) inTrailing = true
    if (inTrailing) trailing.push(row)
    else body.push(row)
  }
  const footnotes = parseFootnotes(trailing)

  const out: Row[] = []
  let rowIndex = 0
  for (const sourceRow of body) {
    if (sourceRow.length === 0 || sourceRow.every((c) => c === null || c === undefined)) continue
    const indentCell = sourceRow[0]
    const labelCell = sourceRow.length > 1 ? sourceRow[1] : null
    let indentLevel: number | null
    if (typeof indentCell === 'string' && !indentCell.trim()) indentLevel = null
    else if (typeof indentCell === 'number') indentLevel = Math.trunc(indentCell)
    else indentLevel = null
    if (labelCell === null || labelCell === undefined) continue
    const label = norm(labelCell)
    if (!label) continue

    let relImp: number | null = null
    let pricingSchedule: string | null = null
    const perDate = new Map<string, Row>()
    const slotOf = (d: string): Row => {
      if (!perDate.has(d)) perDate.set(d, {})
      return perDate.get(d)!
    }
    classifications.forEach((cl, i) => {
      if (cl === null || i >= sourceRow.length) return
      const [value, valueString] = parseValue(sourceRow[i])
      if (cl.kind === 'relative_importance') {
        if (value !== null) relImp = value
        return
      }
      if (cl.kind === 'pricing_schedule') {
        const raw = sourceRow[i]
        if (typeof raw === 'string' && raw.trim()) pricingSchedule = raw.trim()
        return
      }
      if (value === null && valueString === null) return
      if (cl.kind === 'pct_change_window') {
        const [start, end] = cl.payload as [string, string]
        const slot = slotOf(end)
        slot.pct_change_window = value
        slot.pct_change_window_start_date = start
        return
      }
      if (cl.payload === null) return
      slotOf(cl.payload as string)[cl.kind] = value
    })
    const footnote = resolveFootnotes(label, footnotes)
    if (perDate.size === 0 && relImp === null && pricingSchedule === null) continue
    if (perDate.size === 0) {
      rowIndex++
      out.push(suppRecord(snap, { date: snap.snapshotDate, label, indent_level: indentLevel, relative_importance: relImp, pricing_schedule: pricingSchedule, footnote, sheet: sheet.name, row_index: rowIndex }))
      continue
    }
    for (const [refDate, measures] of perDate) {
      rowIndex++
      out.push(suppRecord(snap, { date: refDate, label, indent_level: indentLevel, relative_importance: relImp, pricing_schedule: pricingSchedule, footnote, sheet: sheet.name, row_index: rowIndex, ...measures }))
    }
  }
  return out.sort((a, b) => (a.date === b.date ? (a.row_index as number) - (b.row_index as number) : (a.date as string) < (b.date as string) ? 1 : -1))
}

async function supplementalTables(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const table = str(params.table) ?? 'cpi-u-us'
  const spec = TABLE_REGISTRY[table]
  if (!spec) throw new Error(`Unknown CPI supplemental table '${table}'.`)
  const date = str(params.date)
  let year: number
  let month: number
  let content: Uint8Array
  if (!date) [year, month, content] = await discoverLatest(ctx, spec.stem)
  else {
    year = Number(date.slice(0, 4))
    month = Number(date.slice(5, 7))
    const got = await fetchWorkbook(ctx, stemUrl(spec.stem, year, month))
    if (got === null) throw new Error(`BLS does not publish the '${table}' CPI supplemental XLSX for ${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}.`)
    content = got
  }
  const rows = parseSuppTable(loadSheets(content), spec, year, month).map(withFootnoteLabel)
  if (rows.length === 0) throw new Error(`No rows parsed from BLS CPI supplemental table '${table}'.`)
  return rows
}

export const cpiTableRoutes: Record<string, NativeHandler> = {
  'bls/cpi/relative_importance': relativeImportance,
  'bls/cpi/seasonal_factors': seasonalFactors,
  'bls/cpi/supplemental_tables': supplementalTables,
}
