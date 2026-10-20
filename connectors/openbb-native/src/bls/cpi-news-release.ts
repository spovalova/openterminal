// bls/cpi/t1_expenditure_category … t7_12m_analysis, provider bls. Ported from openbb_bls/models/cpi_news_release.py
// (OpenBB Platform 5.0.0, Apache-2.0); modified: readXlsx instead of openpyxl, plain rows keeping the fields each
// Data model declares, the latest-release search walks back from ctx.now().
import { readXlsx, type Cell } from '../lib/xlsx.js'
import type { NativeCtx, NativeHandler, NativeParams, Row } from '../types.js'
import { BLS_USER_AGENT, decodeCharRefs, isoDate, squish, str } from './helpers.js'

const TABLE_TITLES: Record<number, string> = {
  1: 'CPI-U U.S. city average, by expenditure category',
  2: 'CPI-U U.S. city average, by detailed expenditure category',
  3: 'CPI-U U.S. city average, special aggregate indexes',
  4: 'CPI-U selected areas, all items index',
  5: 'Chained CPI (C-CPI-U) and CPI-U U.S. city average, all items 1-month and 12-month percent changes',
  6: 'CPI-U U.S. city average, by expenditure category, 1-month analysis',
  7: 'CPI-U U.S. city average, by expenditure category, 12-month analysis',
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const MONTHS: Record<string, number> = {}
MONTH_NAMES.forEach((name, i) => {
  MONTHS[name.toLowerCase()] = i + 1
  MONTHS[name.slice(0, 3).toLowerCase()] = i + 1
})
MONTHS.sept = 9

const COMMON = ['date', 'label', 'row_index', 'footnote', 'table_id', 'table_name', 'release_period']
const INDEX_COLUMNS = ['level', 'relative_importance', 'index_value', 'index_value_prior_month', 'index_value_year_ago', 'pct_change_12m', 'pct_change_1m_nsa', 'pct_change_1m_sa', 'pct_change_1m_sa_prior', 'pct_change_1m_sa_two_back']
/** The columns each table's Data model declares (extra="ignore" drops the rest). */
const MODEL_FIELDS: Record<number, string[]> = {
  1: [...COMMON, ...INDEX_COLUMNS],
  2: [...COMMON, 'level', 'relative_importance', 'pct_change_12m', 'pct_change_1m_nsa', 'pct_change_1m_sa', 'pct_change_1m_sa_prior', 'pct_change_1m_sa_two_back'],
  3: [...COMMON, ...INDEX_COLUMNS],
  4: [...COMMON, 'level', 'pricing_schedule', 'pct_change_12m', 'pct_change_1m_nsa', 'pct_change_window', 'pct_change_window_start_date', 'pct_change_12m_prior', 'pct_change_1m_nsa_prior', 'pct_change_window_prior', 'pct_change_window_prior_start_date'],
  5: [...COMMON, 'pct_change_1m_nsa', 'pct_change_12m'],
  6: [...COMMON, 'level', 'relative_importance', 'pct_change_1m_sa', 'effect_on_all_items_sa', 'standard_error_median_price_change', 'largest_or_smallest_since_marker', 'largest_or_smallest_since_pct'],
  7: [...COMMON, 'level', 'relative_importance', 'pct_change_12m', 'effect_on_all_items_nsa', 'standard_error_median_price_change', 'largest_or_smallest_since_marker', 'largest_or_smallest_since_pct'],
}

type Sheet = Cell[][]
type Kind = 'relative_importance' | 'index_nsa' | 'pct_change_12m_nsa' | 'pct_change_1m_nsa' | 'pct_change_1m_sa' | 'pct_change_window'
type Classification = { kind: Kind; period: string | null; extra: string | null } | null

// ---- dates are "YYYY-MM-01" strings ------------------------------------------------------------------------

const monthNum = (token: string): number | null => MONTHS[token.trim().toLowerCase().replace(/\.+$/, '')] ?? null
const ym = (d: string): number => Number(d.slice(0, 4)) * 12 + Number(d.slice(5, 7)) - 1
const fromYm = (n: number): string => isoDate(Math.floor(n / 12), (n % 12) + 1, 1)
const shiftMonth = (d: string, delta: number): string => fromYm(ym(d) + delta)
const monthsBetween = (a: string, b: string): number => Math.abs(ym(b) - ym(a))

/** `'Apr. 2026'` or `'May 2025'` anywhere in the text (`_parse_single_period`). */
function parseSinglePeriod(text: string): string | null {
  const m = /([A-Za-z]+)\.?\s+(\d{4})/i.exec(text)
  const month = m ? monthNum(m[1]!) : null
  return m && month ? isoDate(Number(m[2]), month, 1) : null
}

/** `'Apr. 2025-Apr. 2026'` as (start, end) (`_parse_range_period`). */
function parseRangePeriod(text: string): [string, string] | null {
  const m = /([A-Za-z]+)\.?\s*(\d{4})?\s*[-–]\s*([A-Za-z]+)\.?\s*(\d{4})/i.exec(text)
  if (!m) return null
  const startMonth = monthNum(m[1]!)
  const endMonth = monthNum(m[3]!)
  if (!startMonth || !endMonth || !m[4]) return null
  const endYear = Number(m[4])
  const startYear = m[2] ? Number(m[2]) : endYear
  return [isoDate(startYear, startMonth, 1), isoDate(endYear, endMonth, 1)]
}

/** The 'to <date>' anchor of a 'Percent change to X from:' super-header (`_parse_to_from_super`). */
function parseToFromSuper(text: string): string | null {
  const m = /percent change to\s+([A-Za-z]+)\.?\s*(\d{4})\s*from/i.exec(text)
  const month = m ? monthNum(m[1]!) : null
  return m && month ? isoDate(Number(m[2]), month, 1) : null
}

/** A 'Month YYYY' row label (`_parse_month_year_label`). */
function parseMonthYearLabel(text: string): string | null {
  const m = /^([A-Za-z]+)\.?\s+(\d{4})$/.exec(text.trim())
  const month = m ? monthNum(m[1]!) : null
  return m && month ? isoDate(Number(m[2]), month, 1) : null
}

// ---- cells -------------------------------------------------------------------------------------------------

const FLOAT_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/

/** A BLS numeric cell as a number; blanks and markers are null (`_to_float`). */
function toFloat(value: Cell | undefined): number | null {
  if (value === null || value === undefined || typeof value === 'boolean') return null
  if (typeof value === 'number') return value
  const text = value.trim()
  return FLOAT_RE.test(text) ? Number(text) : null
}

/** Header cell with newlines and runs of whitespace collapsed (`_clean_header`). */
const cleanHeader = (text: Cell | undefined): string => (text === null || text === undefined ? '' : squish(String(text).replace(/\n/g, ' ')))

/** A cell as `int(str(cell).strip())` would read it: whole numbers only. */
function toLevel(cell: Cell | undefined): number | null {
  if (cell === null || cell === undefined || cell === '') return null
  if (typeof cell === 'number') return Number.isInteger(cell) ? cell : null
  const text = String(cell).trim()
  return /^[+-]?\d+$/.test(text) ? Number(text) : null
}

const trimmedString = (cell: Cell | undefined): string | null => (typeof cell === 'string' && cell.trim() ? cell.trim() : null)

// ---- footnotes ---------------------------------------------------------------------------------------------

/** `{'(N)': 'definition'}` from trailing footnote-definition rows (`_parse_nr_footnotes`). */
function parseFootnotes(rows: Sheet): Map<string, string> {
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

/** Footnote text for every `(N)` marker in the label (`_resolve_nr_footnotes`). */
function resolveFootnotes(label: string | null, footnotes: Map<string, string>): string | null {
  if (!label || footnotes.size === 0) return null
  const matched: string[] = []
  const seen = new Set<string>()
  for (const m of label.matchAll(/\(([^)]+)\)/g)) {
    const marker = m[0]
    if (!footnotes.has(marker) || seen.has(marker)) continue
    seen.add(marker)
    matched.push(footnotes.get(marker)!)
  }
  return matched.length ? matched.join('\n\n') : null
}

// ---- the table parsers -------------------------------------------------------------------------------------

type Ctx = { year: number; month: number; tableId: string; tableName: string; releasePeriod: string; releaseDate: string }

/** Which measure each column holds, from the two header rows (`_classify_columns`). */
function classifyColumns(superRow: Cell[], subRow: Cell[], reportYear: number, reportMonth: number): Classification[] {
  const n = Math.max(superRow.length, subRow.length)
  const filledSuper: string[] = []
  let last = ''
  for (let i = 0; i < n; i++) {
    const cell = cleanHeader(superRow[i])
    if (cell) last = cell
    filledSuper.push(last)
  }
  const out: Classification[] = []
  for (let i = 0; i < n; i++) {
    const s = filledSuper[i]!
    const sub = cleanHeader(subRow[i])
    const sLo = s.toLowerCase()
    const none = (): void => void out.push(null)
    if (i === 0 || sLo === 'indent level') {
      none()
      continue
    }
    if (['expenditure category', 'special aggregate', 'title', 'item', 'area', 'pricing schedule'].some((p) => sLo.startsWith(p))) {
      none()
      continue
    }
    if (sLo.includes('relative importance')) {
      out.push({ kind: 'relative_importance', period: null, extra: null })
      continue
    }
    if (sLo.includes('unadjusted index') || sLo.endsWith('indexes')) {
      out.push({ kind: 'index_nsa', period: parseSinglePeriod(sub), extra: null })
      continue
    }
    if (sLo.includes('seasonally adjusted percent change')) {
      const rng = parseRangePeriod(sub)
      out.push({ kind: 'pct_change_1m_sa', period: rng ? rng[1] : null, extra: null })
      continue
    }
    if (sLo.includes('percent change to')) {
      const endDate = parseToFromSuper(s)
      const startDate = sub ? parseSinglePeriod(sub) : null
      if (endDate === null || startDate === null) {
        none()
        continue
      }
      const months = monthsBetween(startDate, endDate)
      if (months >= 12) out.push({ kind: 'pct_change_12m_nsa', period: endDate, extra: null })
      else if (months === 1) out.push({ kind: 'pct_change_1m_nsa', period: endDate, extra: null })
      else out.push({ kind: 'pct_change_window', period: endDate, extra: startDate })
      continue
    }
    if (sLo.includes('twelve month') || sLo === 'twelve') {
      const rng = parseRangePeriod(sub)
      const d = rng ? rng[1] : parseSinglePeriod(sub)
      out.push({ kind: 'pct_change_12m_nsa', period: d ?? isoDate(reportYear, reportMonth, 1), extra: null })
      continue
    }
    if (sLo.includes('one month') || sLo === 'month') {
      const rng = parseRangePeriod(sub)
      const kind: Kind = sub.toLowerCase().includes('seasonally adjusted') ? 'pct_change_1m_sa' : 'pct_change_1m_nsa'
      const d = rng ? rng[1] : parseSinglePeriod(sub)
      out.push({ kind, period: d ?? isoDate(reportYear, reportMonth, 1), extra: null })
      continue
    }
    if (sLo.includes('unadjusted percent change') || sLo.includes('percent change')) {
      const rng = parseRangePeriod(sub)
      if (!rng) {
        none()
        continue
      }
      out.push({ kind: monthsBetween(rng[0], rng[1]) >= 12 ? 'pct_change_12m_nsa' : 'pct_change_1m_nsa', period: rng[1], extra: null })
      continue
    }
    none()
  }
  return out
}

function pricingScheduleColumn(superRow: Cell[], subRow: Cell[]): number | null {
  const n = Math.max(superRow.length, subRow.length)
  for (let i = 0; i < n; i++) if (cleanHeader(superRow[i]).toLowerCase().includes('pricing schedule')) return i
  return null
}

type Slot = Partial<Record<'index_value' | 'pct_change_12m' | 'pct_change_1m_nsa' | 'pct_change_1m_sa' | 'pct_change_window' | 'pct_change_window_start_date', number | string>>

/** Collapse a per-date measure map into one item row with offset-named columns (`_pivot_per_item_row`). */
function pivotItemRow(perDate: Map<string, Slot>, c: Ctx, a: { label: string; level: number; sourceIdx: number; ri: number | null; pricingSchedule: string | null; footnote: string | null }): Row {
  const anchor = perDate.size ? [...perDate.keys()].sort().at(-1)! : c.releaseDate
  const latest = perDate.get(anchor) ?? {}
  const prior = perDate.get(shiftMonth(anchor, -1)) ?? {}
  const twoBack = perDate.get(shiftMonth(anchor, -2)) ?? {}
  const yearAgo = perDate.get(shiftMonth(anchor, -12)) ?? {}
  return {
    date: anchor,
    label: a.label,
    level: a.level,
    row_index: a.sourceIdx,
    relative_importance: a.ri,
    pricing_schedule: a.pricingSchedule,
    footnote: a.footnote,
    index_value: latest.index_value,
    index_value_prior_month: prior.index_value,
    index_value_year_ago: yearAgo.index_value,
    pct_change_12m: latest.pct_change_12m,
    pct_change_1m_nsa: latest.pct_change_1m_nsa,
    pct_change_1m_sa: latest.pct_change_1m_sa,
    pct_change_1m_sa_prior: prior.pct_change_1m_sa,
    pct_change_1m_sa_two_back: twoBack.pct_change_1m_sa,
    pct_change_window: latest.pct_change_window,
    pct_change_window_start_date: latest.pct_change_window_start_date,
    pct_change_12m_prior: prior.pct_change_12m,
    pct_change_1m_nsa_prior: prior.pct_change_1m_nsa,
    pct_change_window_prior: prior.pct_change_window,
    pct_change_window_prior_start_date: prior.pct_change_window_start_date,
    table_id: c.tableId,
    table_name: c.tableName,
    release_period: c.releasePeriod,
  }
}

/** Tables 1-4: one row per item, its measures spread over the columns by period. */
function parseItemTable(body: Sheet, superRow: Cell[], subRow: Cell[], c: Ctx, footnotes: Map<string, string>): Row[] {
  const classifications = classifyColumns(superRow, subRow, c.year, c.month)
  const pricingCol = pricingScheduleColumn(superRow, subRow)
  const out: Row[] = []
  let sourceIdx = 0
  for (const row of body) {
    if (!row || row.length === 0 || row[0] === null || row[0] === undefined || row[0] === '') continue
    const level = toLevel(row[0])
    if (level === null) continue
    const label = trimmedString(row[1])
    if (label === null) continue
    sourceIdx++

    let ri: number | null = null
    let pricingSchedule: string | null = null
    if (pricingCol !== null && pricingCol < row.length) {
      const pcell = row[pricingCol]
      if (typeof pcell === 'string' && pcell.trim()) pricingSchedule = pcell.trim()
      else if (pcell !== null && pcell !== undefined) pricingSchedule = String(pcell).trim() || null
    }
    const perDate = new Map<string, Slot>()
    const slotOf = (d: string): Slot => {
      if (!perDate.has(d)) perDate.set(d, {})
      return perDate.get(d)!
    }
    classifications.forEach((cl, i) => {
      if (i >= row.length || cl === null) return
      const value = row[i]
      if (value === null || value === undefined) return
      const cleaned = typeof value === 'string' ? value.trim() : value
      if (cleaned === '') return
      const num = toFloat(cleaned)
      if (num === null) return
      if (cl.kind === 'relative_importance') ri = num
      else if (cl.period === null) return
      else if (cl.kind === 'index_nsa') slotOf(cl.period).index_value = num
      else if (cl.kind === 'pct_change_12m_nsa') slotOf(cl.period).pct_change_12m = num
      else if (cl.kind === 'pct_change_1m_nsa') slotOf(cl.period).pct_change_1m_nsa = num
      else if (cl.kind === 'pct_change_1m_sa') slotOf(cl.period).pct_change_1m_sa = num
      else if (cl.kind === 'pct_change_window') {
        const slot = slotOf(cl.period)
        slot.pct_change_window = num
        if (cl.extra !== null) slot.pct_change_window_start_date = cl.extra
      }
    })
    if (perDate.size === 0 && ri === null && pricingSchedule === null) continue
    out.push(pivotItemRow(perDate, c, { label, level, sourceIdx, ri, pricingSchedule, footnote: resolveFootnotes(label, footnotes) }))
  }
  return out.sort((a, b) => (a.row_index as number) - (b.row_index as number))
}

/** Table 5: months down the side, C-CPI-U and CPI-U changes across (`_parse_nr_table_5`). */
function parseTable5(body: Sheet, superRow: Cell[], subRow: Cell[], c: Ctx, footnotes: Map<string, string>): Row[] {
  const n = Math.max(superRow.length, subRow.length)
  const filledSuper: string[] = []
  let last = ''
  for (let i = 0; i < n; i++) {
    const cell = cleanHeader(superRow[i])
    if (cell) last = cell
    filledSuper.push(last)
  }
  const columns: ({ kind: 'pct_change_12m' | 'pct_change_1m_nsa'; basket: string } | null)[] = []
  for (let i = 0; i < n; i++) {
    const sLo = filledSuper[i]!.toLowerCase()
    const sub = cleanHeader(subRow[i])
    const subNorm = sub.toUpperCase().replace('(1)', '').trim()
    if (i <= 1 || !sub) {
      columns.push(null)
      continue
    }
    let kind: 'pct_change_12m' | 'pct_change_1m_nsa'
    if (sLo.includes('12-month') || sLo.includes('twelve')) kind = 'pct_change_12m'
    else if (sLo.includes('1-month') || sLo.includes('one')) kind = 'pct_change_1m_nsa'
    else {
      columns.push(null)
      continue
    }
    const basket = subNorm.includes('C-CPI-U') ? 'C-CPI-U' : subNorm.includes('CPI-U') ? 'CPI-U' : null
    columns.push(basket === null ? null : { kind, basket })
  }
  const grouped = new Map<string, Row>()
  for (const row of body) {
    if (!row || row.length === 0 || row[1] === null || row[1] === undefined || row[1] === '') continue
    if (typeof row[1] !== 'string') continue
    const rowLabel = row[1].trim()
    const periodDate = parseMonthYearLabel(rowLabel)
    if (periodDate === null) continue
    const footnote = resolveFootnotes(rowLabel, footnotes)
    columns.forEach((cl, i) => {
      if (cl === null || i >= row.length) return
      const num = toFloat(row[i])
      if (num === null) return
      const key = `${periodDate}\u0000${cl.basket}`
      let slot = grouped.get(key)
      if (!slot) {
        slot = { date: periodDate, label: cl.basket, level: 0, relative_importance: null, pricing_schedule: null, footnote, table_id: c.tableId, table_name: c.tableName, table_number: 5, release_period: c.releasePeriod }
        grouped.set(key, slot)
      }
      slot[cl.kind] = num
    })
  }
  const out = [...grouped.values()].sort((a, b) => (a.date === b.date ? ((a.label as string) < (b.label as string) ? -1 : (a.label as string) > (b.label as string) ? 1 : 0) : (a.date as string) < (b.date as string) ? 1 : -1))
  out.forEach((r, i) => (r.row_index = i + 1))
  return out
}

/** Tables 6 and 7, positionally: the change, its effect on all items, the standard error and the largest-since marker. */
function parseTable67(body: Sheet, tableNumber: 6 | 7, c: Ctx, footnotes: Map<string, string>): Row[] {
  const mainKind = tableNumber === 6 ? 'pct_change_1m_sa' : 'pct_change_12m'
  const effectKind = tableNumber === 6 ? 'effect_on_all_items_sa' : 'effect_on_all_items_nsa'
  const out: Row[] = []
  let sourceIdx = 0
  for (const row of body) {
    if (!row || row.length === 0 || row[0] === null || row[0] === undefined || row[0] === '') continue
    const level = toLevel(row[0])
    if (level === null) continue
    if (row.length < 2 || typeof row[1] !== 'string' || !row[1].trim()) continue
    const label = row[1].trim()
    sourceIdx++
    out.push({
      date: c.releaseDate,
      label,
      level,
      row_index: sourceIdx,
      footnote: resolveFootnotes(label, footnotes),
      table_id: c.tableId,
      table_name: c.tableName,
      table_number: tableNumber,
      release_period: c.releasePeriod,
      relative_importance: row.length > 2 ? toFloat(row[2]) : null,
      [mainKind]: row.length > 3 ? toFloat(row[3]) : null,
      [effectKind]: row.length > 4 ? toFloat(row[4]) : null,
      standard_error_median_price_change: row.length > 5 ? toFloat(row[5]) : null,
      largest_or_smallest_since_marker: row.length > 6 ? trimmedString(row[6]) : null,
      largest_or_smallest_since_pct: row.length > 7 ? toFloat(row[7]) : null,
    })
  }
  return out
}

/** One News Release Table workbook as rows (`_parse_nr_table`). */
function parseTable(bytes: Uint8Array, year: number, month: number, tableNumber: number): Row[] {
  const sheet: Sheet = (readXlsx(bytes)[0]?.rows ?? []).map((r) => r.map((cell) => (typeof cell === 'string' ? decodeCharRefs(cell) : cell)))
  const releasePeriod = `${MONTH_NAMES[month - 1]} ${year}`
  const c: Ctx = {
    year,
    month,
    releasePeriod,
    releaseDate: isoDate(year, month, 1),
    tableId: `cpi-nr-${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-t${tableNumber}`,
    tableName: `CPI News Release ${releasePeriod} — Table ${tableNumber}: ${TABLE_TITLES[tableNumber]}`,
  }
  let superRow: Cell[] = []
  let subRow: Cell[] = []
  let dataStart = 0
  for (let idx = 0; idx < sheet.length; idx++) {
    const row = sheet[idx]!
    if (row.length === 0 || row[0] === null || row[0] === undefined) continue
    if (cleanHeader(row[0]).toLowerCase() === 'indent level') {
      superRow = row
      subRow = sheet[idx + 1] ?? []
      dataStart = idx + 2
      break
    }
  }
  if (superRow.length === 0) return []
  const body = sheet.slice(dataStart)
  const footnotes = parseFootnotes(body)
  let rows: Row[]
  if (tableNumber === 5) rows = parseTable5(body, superRow, subRow, c, footnotes)
  else if (tableNumber === 6 || tableNumber === 7) rows = parseTable67(body, tableNumber, c, footnotes)
  else rows = parseItemTable(body, superRow, subRow, c, footnotes)
  // The Data models serialise a label with a footnote as {value, footnote}.
  const keep = MODEL_FIELDS[tableNumber]!
  return rows.map((r) => {
    const out: Row = {}
    for (const k of keep) if (r[k] !== undefined && r[k] !== null) out[k] = r[k]
    if (typeof out.label === 'string' && typeof out.footnote === 'string' && out.footnote) out.label = { value: out.label, footnote: out.footnote }
    return out
  })
}

// ---- download ----------------------------------------------------------------------------------------------

const nrUrl = (year: number, month: number, table: number): string => `https://www.bls.gov/cpi/tables/supplemental-files/news-release-table${table}-${String(year).padStart(4, '0')}${String(month).padStart(2, '0')}.xlsx`

/** One table file, or null when BLS has not published it (a redirect, a 404 or a page that is not a workbook). */
function fetchNrXlsx(ctx: NativeCtx, year: number, month: number, table: number): Promise<Uint8Array | null> {
  const url = nrUrl(year, month, table)
  return ctx.cache(`bls:nr:${url}`, 3600 * 1000, async () => {
    const res = await ctx.http.response(url, { headers: { 'User-Agent': BLS_USER_AGENT, Accept: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,*/*' }, timeoutMs: 60_000 })
    if (res.redirected || res.status === 404) return null
    if (res.status !== 200) throw new Error(`BLS returned HTTP ${res.status} fetching ${url}.`)
    const bytes = new Uint8Array(await res.arrayBuffer())
    return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4 ? bytes : null
  })
}

function tableHandler(table: number): NativeHandler {
  return async (params: NativeParams, ctx: NativeCtx): Promise<Row[]> => {
    const date = str(params.date)
    let year: number
    let month: number
    let content: Uint8Array | null = null
    if (date) {
      year = Number(date.slice(0, 4))
      month = Number(date.slice(5, 7))
      content = await fetchNrXlsx(ctx, year, month, table)
      if (content === null) throw new Error(`BLS CPI News Release Table ${table} for ${MONTH_NAMES[month - 1]} ${year} was not found.`)
    } else {
      // The latest published month: walk back from today until a file exists.
      const today = ctx.now()
      year = today.getUTCFullYear()
      month = today.getUTCMonth() + 1
      for (let i = 0; i < 6 && content === null; i++) {
        content = await fetchNrXlsx(ctx, year, month, table)
        if (content === null) {
          month--
          if (month === 0) {
            month = 12
            year--
          }
        }
      }
      if (content === null) throw new Error('Could not locate a recent CPI News Release Table XLSX within the last six months.')
    }
    const rows = parseTable(content, year, month, table)
    if (rows.length === 0) throw new Error(`No rows parsed from CPI News Release table ${table}.`)
    return rows
  }
}

export const cpiNewsReleaseRoutes: Record<string, NativeHandler> = {
  'bls/cpi/t1_expenditure_category': tableHandler(1),
  'bls/cpi/t2_detailed_expenditure': tableHandler(2),
  'bls/cpi/t3_special_aggregates': tableHandler(3),
  'bls/cpi/t4_selected_areas': tableHandler(4),
  'bls/cpi/t5_chained_vs_cpiu': tableHandler(5),
  'bls/cpi/t6_1m_analysis': tableHandler(6),
  'bls/cpi/t7_12m_analysis': tableHandler(7),
}
