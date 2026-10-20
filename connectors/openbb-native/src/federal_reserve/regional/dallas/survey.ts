// Decoding of the Dallas Fed outlook-survey workbooks, provider federal_reserve. Ported from
// openbb_federal_reserve/utils/dallas_survey.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain arrays instead of pandas frames.
import type { Row } from '../../../types.js'
import { isDateCell, isNa, parseLooseDate, readFrame, toNumeric, pivotWide, type Cell, type Frame } from '../workbook.js'
import { cmp } from './helpers.js'

export const MANUFACTURING_INDICATORS: Record<string, string> = {
  prod: 'Production',
  capu: 'Capacity Utilization',
  vnwo: 'Volume of New Orders',
  gro: 'Growth Rate of Orders',
  ufil: 'Unfilled Orders',
  vshp: 'Volume of Shipments',
  dtm: 'Delivery Time',
  fgi: 'Finished Goods Inventories',
  prm: 'Prices Paid for Raw Materials',
  pfg: 'Prices Received for Finished Goods',
  wgs: 'Wages and Benefits',
  nemp: 'Number of Employees',
  avgwk: 'Hours Worked',
  cexp: 'Capital Expenditures',
  colk: 'Company Outlook',
  bact: 'General Business Activity',
  uncr: 'Outlook Uncertainty',
}

export const SERVICE_INDICATORS: Record<string, string> = {
  rev: 'Revenue',
  emp: 'Employment',
  pemp: 'Part-Time Employment',
  avgwk: 'Hours Worked',
  wgs: 'Wages and Benefits',
  inp: 'Input Prices',
  sell: 'Selling Prices',
  cexp: 'Capital Expenditures',
  inv: 'Inventories',
  colk: 'Company Outlook',
  bact: 'General Business Activity',
  uncr: 'Outlook Uncertainty',
}

const RETAIL_INDICATORS: Record<string, string> = {
  rev: 'Retail Sales',
  trev: 'Companywide Sales',
  intrev: 'Internet Sales',
  emp: 'Employment',
  pemp: 'Part-Time Employment',
  avgwk: 'Hours Worked',
  wgs: 'Wages and Benefits',
  inp: 'Input Prices',
  sell: 'Selling Prices',
  cexp: 'Capital Expenditures',
  inv: 'Inventories',
  colk: 'Company Outlook',
  bact: 'General Business Activity',
  uncr: 'Outlook Uncertainty',
}

export const ENERGY_INDICATORS: Record<string, string> = {
  qbac: 'Business Activity',
  qoprd: 'Oil Production',
  qgprd: 'Natural Gas Production',
  qcexp: 'Capital Expenditures',
  qfexp: 'Capital Expenditures (Next Year, Expected)',
  qdvcst: 'Finding and Development Costs',
  qlsexp: 'Lease Operating Expenses',
  qsdtm: 'Supplier Delivery Time',
  qeqput: 'Equipment Utilization',
  qlgtm: 'Lag Time in Turnaround of Activity',
  qinp: 'Input Costs',
  qsell: 'Prices Received for Services',
  qopmgn: 'Operating Margins',
  qemp: 'Employment',
  qemphr: 'Employee Hours',
  qwgs: 'Wages and Benefits',
  qolk: 'Company Outlook',
  quncr: 'Outlook Uncertainty',
}

export const BANKING_INDICATORS: Record<string, [label: string, horizon: string]> = {
  lvol: ['Total Loan Volume', 'current'],
  ldem: ['Loan Demand', 'current'],
  lnon: ['Nonperforming Loans', 'current'],
  lprice: ['Loan Pricing', 'current'],
  lstds: ['Credit Standards', 'current'],
  civol: ['Commercial & Industrial Loan Volume', 'current'],
  cinp: ['Commercial & Industrial Nonperforming Loans', 'current'],
  cistds: ['Commercial & Industrial Credit Standards', 'current'],
  crevol: ['Commercial Real Estate Loan Volume', 'current'],
  crenp: ['Commercial Real Estate Nonperforming Loans', 'current'],
  crestds: ['Commercial Real Estate Credit Standards', 'current'],
  rrevol: ['Residential Real Estate Loan Volume', 'current'],
  rrenp: ['Residential Real Estate Nonperforming Loans', 'current'],
  rrestds: ['Residential Real Estate Credit Standards', 'current'],
  cvol: ['Consumer Loan Volume', 'current'],
  cnp: ['Consumer Nonperforming Loans', 'current'],
  cstds: ['Consumer Credit Standards', 'current'],
  colkdem: ['Loan Demand', 'future'],
  colknp: ['Nonperforming Loans', 'future'],
  bact: ['General Business Activity', 'current'],
  fbact: ['General Business Activity', 'future'],
  ocorvol: ['Core Deposit Volume', 'current'],
  ocstfds: ['Cost of Funds', 'current'],
  onintmar: ['Net Interest Margin', 'current'],
  onintinc: ['Noninterest Income', 'current'],
}

const RESPONSES: Record<string, string> = { i: 'increase', n: 'no change', d: 'decrease' }
const ENERGY_STEMS: Record<string, string> = Object.fromEntries(Object.entries(ENERGY_INDICATORS).map(([code, label]) => [code.slice(1), label]))
const PRICE_PRODUCTS: Record<string, string> = { oprc: 'WTI Oil Price', ngprc: 'Henry Hub Natural Gas Price' }
const PRICE_STATS: Record<string, string> = { ref: 'Reference', avg: 'Average', med: 'Median', max: 'Maximum', min: 'Minimum', sd: 'Standard Deviation', nof: 'Number of Responses' }
const PRICE_SHARES: Record<string, string> = { d: '% Expecting Decrease', i: '% Expecting Increase', n: '% Expecting No Change', dk: "% Responding Don't Know" }

const has = (o: Record<string, unknown>, k: string): boolean => Object.hasOwn(o, k)
/** Python's `str.title()` for the response words. */
const title = (s: string): string => s.replace(/(^|[^A-Za-z])([a-z])/g, (_, a: string, b: string) => a + b.toUpperCase())

/** A Dallas Fed Energy Survey column code as a readable label (`decode_energy_code`). */
export function decodeEnergyCode(code: string): string {
  const text = code.trim()
  const lower = text.toLowerCase()
  if (!lower || lower === 'date') return text
  if (lower[0] === 'q' || lower[0] === 'y') {
    const stem = lower.slice(1)
    if (has(ENERGY_STEMS, stem)) return ENERGY_STEMS[stem]!
    const last = stem.slice(-1)
    if (has(RESPONSES, last) && has(ENERGY_STEMS, stem.slice(0, -1))) return `${ENERGY_STEMS[stem.slice(0, -1)]} (% Reporting ${title(RESPONSES[last]!)})`
  }
  for (const [product, name] of Object.entries(PRICE_PRODUCTS)) {
    const position = lower.indexOf(product)
    if (position < 0) continue
    const head = lower.slice(0, position)
    const tail = lower.slice(position + product.length)
    if (has(PRICE_STATS, head) && !tail) return `${name} (${PRICE_STATS[head]})`
    if (head === 'f' && (!tail || has(PRICE_SHARES, tail))) return `${name} (${tail ? PRICE_SHARES[tail] : 'Expected'})`
  }
  return text
}

/** A sheet's first column as the date (`to_datetime(str(cell).strip(), format=…, errors="coerce")`), rows outside the window dropped. */
function readDated(frame: Frame, dateFormat: string | undefined, start?: string, end?: string): { date: string; row: Cell[] }[] {
  const out: { date: string; row: Cell[] }[] = []
  for (const row of frame.rows) {
    const cell = row[0]
    let date: string | undefined
    if (dateFormat === '%b-%y') {
      // A text cell like "Jun-04"; a real date cell reads as "2004-06-01 00:00:00" and does not match the format.
      const m = isDateCell(cell) ? null : /^([A-Za-z]{3})-(\d{2})$/.exec(isNa(cell) ? '' : String(cell).trim())
      const month = m ? ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(m[1]!.toLowerCase()) : -1
      if (m && month >= 0) {
        const yy = Number(m[2])
        date = `${yy < 69 ? 2000 + yy : 1900 + yy}-${String(month + 1).padStart(2, '0')}-01`
      }
    } else if (typeof cell === 'string') date = parseLooseDate(cell)
    if (date === undefined) continue
    if ((start && date < start) || (end && date > end)) continue
    out.push({ date, row })
  }
  return out
}

export function surveyFrame(bytes: Uint8Array, sheet: string): Frame {
  return readFrame(bytes, sheet, 0)
}

type Decoded = { indicator: string; horizon: string; response?: string }

function longRecords(frame: Frame, dated: { date: string; row: Cell[] }[], decode: (column: string) => Decoded | undefined, sortByResponse: boolean): Row[] {
  const records: Row[] = []
  frame.columns.forEach((column, c) => {
    if (c === 0) return
    const d = decode(column)
    if (!d) return
    for (const { date, row } of dated) records.push({ date, indicator: d.indicator, horizon: d.horizon, ...(d.response !== undefined ? { response: d.response } : {}), value: toNumeric(row[c]) })
  })
  const key = (r: Row) => (sortByResponse ? [r.date, r.indicator, r.horizon, r.response] : [r.date, r.indicator, r.horizon]) as string[]
  return records.sort((a, b) => {
    const [ka, kb] = [key(a), key(b)]
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return cmp(ka[i]!, kb[i]!)
    return 0
  })
}

/** A survey sheet as long `(date, indicator, horizon, value)` records (`parse_survey`). */
export function parseSurvey(bytes: Uint8Array, sheet: string, indicators: Record<string, string>, dateFormat: string | undefined, start?: string, end?: string): Row[] {
  const frame = surveyFrame(bytes, sheet)
  const dated = readDated(frame, dateFormat, start, end)
  return longRecords(
    frame,
    dated,
    (column) => {
      const lowered = column.trim().toLowerCase()
      if (has(indicators, lowered)) return { indicator: indicators[lowered]!, horizon: 'current' }
      if (lowered.startsWith('f') && has(indicators, lowered.slice(1))) return { indicator: indicators[lowered.slice(1)]!, horizon: 'future' }
      return undefined
    },
    false,
  )
}

/** A retail sheet as long `(date, indicator, horizon, response, value)` records (`parse_retail_survey`). */
export function parseRetailSurvey(bytes: Uint8Array, sheet: string, dateFormat: string | undefined, start?: string, end?: string): Row[] {
  const frame = surveyFrame(bytes, sheet)
  const dated = readDated(frame, dateFormat, start, end)
  const bases = Object.keys(RETAIL_INDICATORS).sort((a, b) => b.length - a.length)
  return longRecords(
    frame,
    dated,
    (column) => {
      const lowered = column.trim().toLowerCase()
      for (const [prefix, horizon] of [['f', 'future'], ['', 'current']] as const) {
        if (prefix && !lowered.startsWith(prefix)) continue
        const rest = lowered.slice(prefix.length)
        for (const base of bases) {
          if (rest === base) return { indicator: RETAIL_INDICATORS[base]!, horizon, response: 'net' }
          for (const [suffix, response] of Object.entries(RESPONSES)) if (rest === base + suffix) return { indicator: RETAIL_INDICATORS[base]!, horizon, response }
        }
      }
      return undefined
    },
    true,
  )
}

/** A sheet whose columns map straight to `(label, horizon)` pairs (`parse_keyed_survey`). */
export function parseKeyedSurvey(bytes: Uint8Array, sheet: string, mapping: Record<string, [string, string]>, dateFormat: string | undefined, start?: string, end?: string): Row[] {
  const frame = surveyFrame(bytes, sheet)
  const dated = readDated(frame, dateFormat, start, end)
  return longRecords(
    frame,
    dated,
    (column) => {
      const entry = mapping[column.trim().toLowerCase()]
      return entry && Object.hasOwn(mapping, column.trim().toLowerCase()) ? { indicator: entry[0], horizon: entry[1] } : undefined
    },
    false,
  )
}

/** Every value column of an Energy Survey sheet as long records (`parse_energy_long`). */
export function parseEnergyLong(bytes: Uint8Array, sheet: string, start?: string, end?: string): Row[] {
  const frame = surveyFrame(bytes, sheet)
  const rows = frame.rows.flatMap((row) => {
    const cell = row[0]
    const date = isDateCell(cell) ? (cell as string).slice(0, 10) : typeof cell === 'string' ? parseLooseDate(cell) : undefined
    return date === undefined ? [] : [{ date, row }]
  })
  const records: Row[] = []
  frame.columns.forEach((code, c) => {
    if (c === 0) return
    const indicator = decodeEnergyCode(code)
    for (const { date, row } of rows) {
      if ((start && date < start) || (end && date > end)) continue
      records.push({ date, indicator, value: toNumeric(row[c]) })
    }
  })
  return records.sort((a, b) => cmp(a.date as string, b.date as string) || cmp(a.indicator as string, b.indicator as string))
}

/** The wide rows of a decoded survey: one column per `column` label (`pivot_wide`). */
export function pivotSurvey(records: Row[], columnOf: (r: Row) => string): Row[] {
  return pivotWide(
    records.map((r) => ({ date: r.date, column: columnOf(r), value: r.value })),
    'date',
    'column',
    'value',
  )
}
