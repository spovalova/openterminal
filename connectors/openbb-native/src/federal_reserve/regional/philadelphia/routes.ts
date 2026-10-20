// federal_reserve/philadelphia/*, provider federal_reserve. Ported from openbb_federal_reserve/utils/philadelphia.py and
// models/regional/philadelphia_*.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain arrays instead of pandas frames,
// ctx.cache instead of the on-disk cache, and legacy .xls read with src/lib/xls.ts instead of xlrd.
import { BROWSER_UA } from '../../../http.js'
import type { NativeCtx, NativeParams, Row } from '../../../types.js'
import { readCsvFrame } from '../csvframe.js'
import { isNa, pivotWide, readFrame, readGrid, toDate, toNumeric, parseLooseDate, type Cell, type Frame } from '../workbook.js'

const MEDIA_URL = 'https://www.philadelphiafed.org/-/media/frbp/assets'
const DAY_MS = 24 * 3600 * 1000

const dateParam = (params: NativeParams, name: 'start_date' | 'end_date'): string | undefined => (typeof params[name] === 'string' && params[name] ? (params[name] as string) : undefined)
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
const pad2 = (n: number): string => String(n).padStart(2, '0')

function emptyData(): never {
  throw new Error('The request was returned empty.')
}

/** A Philadelphia Fed file, kept for a day; an HTML error page served with status 200 is an error (`fetch_philadelphia`). */
function download(ctx: NativeCtx, url: string): Promise<Uint8Array> {
  return ctx.cache(`philadelphia:${url}`, DAY_MS, async () => {
    const bytes = await ctx.http.bytes(url, { headers: { 'user-agent': BROWSER_UA }, timeoutMs: 120_000 })
    let i = 0
    while (i < 15 && (bytes[i] === 0x20 || bytes[i] === 0x0a || bytes[i] === 0x0d || bytes[i] === 0x09)) i++
    if (bytes[i] === 0x3c) throw new Error(`No Philadelphia Fed file was found at '${url}'.`)
    if (bytes.length === 0) emptyData()
    return bytes
  })
}

/** `read_workbook(content, sheet, header)`. */
function sheetFrame(bytes: Uint8Array, sheet: string, header = 0): Frame {
  return readFrame(bytes, sheet, header)
}

function at(frame: Frame, name: string): number {
  const i = frame.columns.indexOf(name)
  if (i < 0) throw new Error(`'${name}'`)
  return i
}

/** Quarter-start date of integer year and quarter cells (`quarter_start`). */
function quarterStart(year: Cell | undefined, quarter: Cell | undefined): string {
  const y = Math.trunc(Number(year))
  const q = Math.trunc(Number(quarter))
  if (!Number.isFinite(y) || !Number.isFinite(q) || q < 1 || q > 4) throw new Error(`Invalid quarter: ${year} ${quarter}`)
  return `${String(y).padStart(4, '0')}-${pad2((q - 1) * 3 + 1)}-01`
}

/** Rows of `frame` with the renamed columns: missing cells left out. */
function record(frame: Frame, labels: string[], row: Cell[], keep: string[]): Row {
  const out: Row = {}
  labels.forEach((label, i) => {
    if (keep.includes(label) && !isNa(row[i])) out[label] = row[i]
  })
  return out
}

function window(rows: { date: string }[], params: NativeParams): void {
  const start = dateParam(params, 'start_date')
  const end = dateParam(params, 'end_date')
  for (let i = rows.length - 1; i >= 0; i--) {
    const d = rows[i]!.date
    if ((start && d < start) || (end && d > end)) rows.splice(i, 1)
  }
}

export async function anxiousIndex(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const bytes = await download(ctx, `${MEDIA_URL}/surveys-and-data/survey-of-professional-forecasters/anxious-index/anxious_index_chart.xlsx`)
  const frame = sheetFrame(bytes, 'Data', 3)
  const [yearAt, quarterAt, aiAt, recAt] = [at(frame, 'Obs Year'), at(frame, 'Obs Quarter'), at(frame, 'Anxious Index'), at(frame, 'RECESS')]
  const rows = frame.rows.filter((r) => !isNa(r[yearAt]) && !isNa(r[quarterAt])).map((r) => ({ date: quarterStart(r[yearAt], r[quarterAt]), row: r }))
  window(rows, params)
  rows.sort((a, b) => cmp(a.date, b.date))
  const records = rows.flatMap(({ date, row }) => {
    const out: Row = { date }
    if (!isNa(row[aiAt])) out.anxious_index = row[aiAt]
    if (!isNa(row[recAt])) out.recession = row[recAt]
    return 'anxious_index' in out || 'recession' in out ? [out] : []
  })
  if (records.length === 0) emptyData()
  return records
}

export async function businessConditions(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const bytes = await download(ctx, `${MEDIA_URL}/surveys-and-data/ads/ads_index_most_current_vintage.xlsx`)
  const grid = readGrid(bytes, 0)
  const names = grid[0]!.length > 2 ? ['date', 'ads_index', 'recession'] : ['date', 'ads_index']
  const rows = grid.slice(1).map((row) => {
    const m = /^(\d{4})[:-](\d{2})[:-](\d{2})/.exec(String(row[0] ?? '').trim())
    if (!m) throw new Error(`time data "${row[0]}" doesn't match format "%Y:%m:%d"`)
    return { date: `${m[1]}-${m[2]}-${m[3]}`, row }
  })
  window(rows, params)
  rows.sort((a, b) => cmp(a.date, b.date))
  return rows.map(({ date, row }) => {
    const out: Row = { date }
    names.forEach((n, i) => {
      if (n !== 'date' && !isNa(row[i])) out[n] = row[i]
    })
    return out
  })
}

export async function gdpplus(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const bytes = await download(ctx, `${MEDIA_URL}/data-visualizations/gdpplus.xlsx`)
  const frame = sheetFrame(bytes, 'Sheet1')
  const rename: Record<string, string> = { OBS_YEAR: 'year', OBS_QUARTER: 'quarter', GDPPLUS_DATA: 'gdpplus', GRGDP_DATA: 'gdp_growth', GRGDI_DATA: 'gdi_growth', RECBARS: 'recession' }
  const labels = frame.columns.map((c) => rename[c] ?? c)
  const [yearAt, quarterAt] = [labels.indexOf('year'), labels.indexOf('quarter')]
  if (yearAt < 0) throw new Error("'year'")
  if (quarterAt < 0) throw new Error("'quarter'")
  const keep = ['gdpplus', 'gdp_growth', 'gdi_growth', ...(labels.includes('recession') ? ['recession'] : [])]
  for (const k of keep.slice(0, 3)) if (!labels.includes(k)) throw new Error(`"['${k}'] not in index"`)
  const rows = frame.rows.filter((r) => !isNa(r[yearAt]) && !isNa(r[quarterAt])).map((r) => ({ date: quarterStart(r[yearAt], r[quarterAt]), row: r }))
  window(rows, params)
  rows.sort((a, b) => cmp(a.date, b.date))
  return rows.map(({ date, row }) => ({ date, ...record(frame, labels, row, keep) }))
}

export async function partisanConflict(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const bytes = await download(ctx, `${MEDIA_URL}/data-visualizations/partisan-conflict.xlsx`)
  const frame = sheetFrame(bytes, 'Sheet1')
  const [yearAt, monthAt, valueAt] = [at(frame, 'Year'), at(frame, 'Month'), at(frame, 'Partisan Conflict')]
  const names = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
  const rows = frame.rows
    .filter((r) => !isNa(r[yearAt]) && !isNa(r[monthAt]))
    .map((row) => {
      const month = names.indexOf(String(row[monthAt]).trim().toLowerCase())
      if (month < 0) throw new Error(`time data "${Math.trunc(Number(row[yearAt]))} ${row[monthAt]}" doesn't match format "%Y %B"`)
      return { date: `${String(Math.trunc(Number(row[yearAt]))).padStart(4, '0')}-${pad2(month + 1)}-01`, row }
    })
  window(rows, params)
  rows.sort((a, b) => cmp(a.date, b.date))
  return rows.map(({ date, row }) => ({ date, ...(isNa(row[valueAt]) ? {} : { partisan_conflict: row[valueAt] }) }))
}

const LIVINGSTON_SUFFIXES: [string, string][] = [
  ['BP', 'base_prior'],
  ['ZM', 'base_current'],
  ['6M', 'six_month'],
  ['12M', 'twelve_month'],
  ['BY', 'base_year'],
  ['ZY', 'current_year'],
  ['1Y', 'one_year'],
  ['2Y', 'two_year'],
  ['10Y', 'ten_year'],
]

export async function livingstonSurvey(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const variable = String(params.variable ?? 'RGDPX')
  const file = String(params.statistic ?? 'mean') === 'mean' ? 'means.xlsx' : 'medians.xlsx'
  const bytes = await download(ctx, `${MEDIA_URL}/surveys-and-data/livingston-survey/historical-data/${file}`)
  const frame = sheetFrame(bytes, variable)
  const rename: Record<string, string> = { Date: 'date' }
  for (const [suffix, name] of LIVINGSTON_SUFFIXES) rename[`${variable}_${suffix}`] = name
  const labels = frame.columns.map((c) => rename[c] ?? c)
  const dateAt = labels.indexOf('date')
  if (dateAt < 0) throw new Error("['date']")
  const valueNames = Object.values(rename).filter((v) => v !== 'date' && labels.includes(v))
  const rows = frame.rows
    .filter((r) => !isNa(r[dateAt]))
    .map((row) => {
      const date = toDate(row[dateAt])
      if (date === undefined) throw new Error(`Unknown datetime string format, unable to parse: ${row[dateAt]}`)
      return { date, row }
    })
  window(rows, params)
  rows.sort((a, b) => cmp(a.date, b.date))
  const records = rows.flatMap(({ date, row }) => {
    const out: Row = { date, ...record(frame, labels, row, valueNames) }
    return valueNames.some((n) => n in out) ? [out] : []
  })
  if (records.length === 0) emptyData()
  return records
}

export async function manufacturingOutlook(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const bytes = await download(ctx, `${MEDIA_URL}/surveys-and-data/mbos/historical-data/diffusion-indexes/bos_dif.csv`)
  const frame = readCsvFrame(new TextDecoder('utf-8').decode(bytes).replace(/�/g, ''))
  const labels = frame.columns.map((c) => (c === 'DATE' ? 'date' : c))
  const dateAt = labels.indexOf('date')
  if (dateAt < 0) throw new Error("'date'")
  // parse_two_digit_month: "%b-%y", a date after today is shifted back a century.
  const today = ctx.now().toISOString().slice(0, 10)
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
  const parse = (cell: Cell | undefined): string | undefined => {
    const m = /^([A-Za-z]{3})-(\d{2})$/.exec(String(cell ?? '').trim())
    const month = m ? months.indexOf(m[1]!.toLowerCase()) : -1
    if (!m || month < 0) return undefined
    const yy = Number(m[2])
    let year = yy < 69 ? 2000 + yy : 1900 + yy
    let date = `${year}-${pad2(month + 1)}-01`
    if (date > today) {
      year -= 100
      date = `${year}-${pad2(month + 1)}-01`
    }
    return date
  }
  const rows = frame.rows.flatMap((row) => {
    const date = parse(row[dateAt])
    return date === undefined ? [] : [{ date, row }]
  })
  window(rows, params)
  rows.sort((a, b) => cmp(a.date, b.date))
  return rows.flatMap(({ date, row }) => {
    const out: Row = { date }
    labels.forEach((c, i) => {
      if (c !== 'date' && !isNa(row[i])) out[c] = Number(row[i])
    })
    return Object.keys(out).length > 1 ? [out] : []
  })
}

const NBOS_INDICATORS: Record<string, string> = {
  gar: 'General Activity (Region)',
  ga: 'General Activity (Firm)',
  no: 'New Orders',
  sr: 'Sales or Revenues',
  uo: 'Unfilled Orders',
  iv: 'Inventories',
  pp: 'Prices Paid',
  pr: 'Prices Received',
  nf: 'Number of Full-Time Employees',
  np: 'Number of Part-Time Employees',
  aw: 'Average Workweek',
  wb: 'Wages and Benefits',
  cp: 'Capital Expenditures - Physical Plant',
  ce: 'Capital Expenditures - Equipment and Software',
}
const NBOS_FUTURE: Record<string, string> = { garf: 'General Activity (Region)', gaf: 'General Activity (Firm)' }
const NBOS_RESPONSES: Record<string, string> = { inc: 'increase', nc: 'no change', dec: 'decrease', dif: 'diffusion index' }

/** `{indicator}bn{inc|nc|dec|dif}[_…]` column codes. */
function decodeNbos(code: string): { indicator: string; horizon: string; response: string } | undefined {
  const m = /^([a-z]+?)bn(inc|nc|dec|dif)$/.exec(code.toLowerCase().split('_')[0]!)
  if (!m) return undefined
  const [prefix, response] = [m[1]!, NBOS_RESPONSES[m[2]!]!]
  if (Object.hasOwn(NBOS_INDICATORS, prefix)) return { indicator: NBOS_INDICATORS[prefix]!, horizon: 'Current', response }
  if (Object.hasOwn(NBOS_FUTURE, prefix)) return { indicator: NBOS_FUTURE[prefix]!, horizon: 'Expectations (Six Months Ahead)', response }
  return undefined
}

export async function nonmanufacturingOutlook(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const bytes = await download(ctx, `${MEDIA_URL}/surveys-and-data/nbos/nboshistory.xlsx`)
  const sheet = String(params.adjustment ?? 'sa') === 'nsa' ? 'NSA' : 'Responses_and_diffusion'
  const frame = sheetFrame(bytes, sheet)
  const rows = frame.rows.flatMap((row) => {
    const date = toDate(row[0])
    return date === undefined ? [] : [{ date, row }]
  })
  const decoded = frame.columns.flatMap((c, i) => {
    const d = i === 0 ? undefined : decodeNbos(c)
    return d ? [{ i, label: `${d.indicator} - ${d.horizon} - ${d.response}` }] : []
  })
  const start = dateParam(params, 'start_date')
  const end = dateParam(params, 'end_date')
  const long: Row[] = []
  for (const { i, label } of decoded) {
    for (const { date, row } of rows) {
      if ((start && date < start) || (end && date > end)) continue
      long.push({ date, series: label, value: toNumeric(row[i]) })
    }
  }
  long.sort((a, b) => cmp(a.date as string, b.date as string) || cmp(a.series as string, b.series as string))
  return pivotWide(long, 'date', 'series', 'value')
}

export async function stateCoincidentIndex(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const bytes = await download(ctx, `${MEDIA_URL}/surveys-and-data/coincident/coincident-revised.xls`)
  const frame = sheetFrame(bytes, String(params.dataset ?? 'indexes') === 'diffusion' ? 'Diffusion_Indexes' : 'Indexes')
  const state = typeof params.state === 'string' && params.state ? params.state.toUpperCase() : undefined
  const start = dateParam(params, 'start_date')
  const end = dateParam(params, 'end_date')
  const rows = frame.rows.flatMap((row) => {
    const date = toDate(row[0])
    return date === undefined ? [] : [{ date, row }]
  })
  const long: { date: string; state: string; value: number }[] = []
  for (let c = 1; c < frame.columns.length; c++) {
    const name = frame.columns[c]!
    if (state && name.toUpperCase() !== state) continue
    for (const { date, row } of rows) {
      if ((start && date < start) || (end && date > end)) continue
      const v = row[c]
      if (isNa(v)) continue
      long.push({ date, state: name, value: Number(v) })
    }
  }
  long.sort((a, b) => cmp(a.date, b.date) || cmp(a.state, b.state))
  if (long.length === 0) emptyData()
  return long
}

const SPF_LONG_RUN = ['CPI10', 'PCE10', 'RGDP10', 'PROD10', 'BOND10']
const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()

export async function surveyProfessionalForecasters(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const variable = String(params.variable ?? 'RGDP')
  const statistic = capitalize(String(params.statistic ?? 'median'))
  const transform = SPF_LONG_RUN.includes(variable) ? 'Level' : capitalize(String(params.transform ?? 'level'))
  const bytes = await download(ctx, `${MEDIA_URL}/surveys-and-data/survey-of-professional-forecasters/data-files/files/${statistic}_${variable}_${transform}.xlsx`)
  const frame = sheetFrame(bytes, `${statistic}_${transform}`)
  const prefix = (transform === 'Growth' ? 'D' : '') + variable
  const rename: Record<string, string> = { [prefix]: 'long_run' }
  for (let i = 1; i <= 6; i++) rename[`${prefix}${i}`] = `horizon_${i}`
  for (const letter of ['A', 'B', 'C', 'D']) rename[`${prefix}${letter}`] = `annual_${letter.toLowerCase()}`
  const labels = frame.columns.map((c) => rename[c] ?? c)
  const [yearAt, quarterAt] = [at(frame, 'YEAR'), at(frame, 'QUARTER')]
  const valueNames = Object.values(rename).filter((v) => labels.includes(v))
  const rows = frame.rows.map((row) => ({ date: quarterStart(row[yearAt], row[quarterAt]), row }))
  window(rows, params)
  rows.sort((a, b) => cmp(a.date, b.date))
  const records = rows.flatMap(({ date, row }) => {
    const out: Row = { date, ...record(frame, labels, row, valueNames) }
    return valueNames.some((n) => n in out) ? [out] : []
  })
  if (records.length === 0) emptyData()
  return records
}

const ATSIX: Record<string, [sheet: string, prefix: string]> = { inflation: ['InfExp', 'infexp'], real: ['Real', 'real'], factors: ['Factors', ''] }

export async function termStructureInflation(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const dataset = String(params.dataset ?? 'inflation')
  const [sheet, prefix] = ATSIX[dataset]!
  const bytes = await download(ctx, `${MEDIA_URL}/surveys-and-data/atsix/ATSIX_Vintages.xlsx`)
  const frame = sheetFrame(bytes, sheet)
  const labels = frame.columns.map((c) => (c === '_date_' ? 'date' : c))
  const dateAt = labels.indexOf('date')
  if (dateAt < 0) throw new Error("'date'")
  const dated = frame.rows.flatMap((row) => {
    const date = parseDateCell(row[dateAt])
    return date === undefined ? [] : [{ date, row }]
  })
  const start = dateParam(params, 'start_date')
  const end = dateParam(params, 'end_date')
  type Long = { date: string; column: string; value: number | null; horizon: number }
  let long: Long[] = []
  labels.forEach((c, i) => {
    if (i === dateAt) return
    let horizon = 0
    let column = c
    if (dataset !== 'factors') {
      const stripped = c.split(prefix).join('')
      if (!/^\s*[+-]?\d+\s*$/.test(stripped)) throw new Error(`invalid literal for int() with base 10: '${stripped}'`)
      horizon = Number(stripped)
      column = `${horizon} Months`
    }
    for (const { date, row } of dated) long.push({ date, column, value: isNa(row[i]) ? null : Number(row[i]), horizon })
  })
  if (dataset !== 'factors') long.sort((a, b) => cmp(a.date, b.date) || a.horizon - b.horizon)
  long = long.filter((r) => (!start || r.date >= start) && (!end || r.date <= end))
  return pivotWide(long, 'date', 'column', 'value')
}

/** `to_datetime(cell, errors="coerce")`: a date cell, or a parseable string. */
function parseDateCell(cell: Cell | undefined): string | undefined {
  if (typeof cell === 'string') return toDate(cell) ?? parseLooseDate(cell)
  return toDate(cell)
}
