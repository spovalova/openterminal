// federal_reserve/minneapolis/*, provider federal_reserve. Ported from openbb_federal_reserve/models/regional/minneapolis_*.py
// (OpenBB Platform 5.0.0, Apache-2.0); modified: plain arrays instead of pandas frames, ctx.cache instead of the on-disk cache;
// business_conditions also accepts the `month` header the prices file now carries (OpenBB still reads `Date` and fails).
import { BROWSER_UA } from '../../../http.js'
import type { NativeCtx, NativeParams, Row } from '../../../types.js'
import { readCsvFrame } from '../csvframe.js'
import { isNa, toNumeric, type Cell, type Frame } from '../workbook.js'

const BASE_URL = 'https://www.minneapolisfed.org/~/media/Assets/Pages/regional-economic-indicators'
const DAY_MS = 24 * 3600 * 1000
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

const dateParam = (params: NativeParams, name: 'start_date' | 'end_date'): string | undefined => (typeof params[name] === 'string' && params[name] ? (params[name] as string) : undefined)
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** A CSV download, kept for a day. */
function download(ctx: NativeCtx, file: string): Promise<string> {
  return ctx.cache(`minneapolis:${file}`, DAY_MS, async () => {
    const text = await ctx.http.text(`${BASE_URL}/${file}`, { headers: { 'user-agent': BROWSER_UA } })
    if (!text) throw new Error('The request was returned empty.')
    return text
  })
}

/** `to_datetime(cell, format="%b %Y")`: "Jan 2019" → 2019-01-01; anything else is an error, as in pandas. */
function monthYear(cell: Cell): string {
  const m = /^([A-Za-z]{3}) (\d{4})$/.exec(String(cell ?? '').trim())
  const month = m ? MONTHS.indexOf(m[1]!.toLowerCase()) : -1
  if (!m || month < 0) throw new Error(`time data "${cell}" doesn't match format "%b %Y"`)
  return `${m[2]}-${String(month + 1).padStart(2, '0')}-01`
}

function column(frame: Frame, name: string): number {
  const at = frame.columns.indexOf(name)
  if (at < 0) throw new Error(`'${name}'`)
  return at
}

const emptyData = (): never => {
  throw new Error('The request was returned empty.')
}

/** The date-first CSVs with one numeric column per geography (employment, unemployment, labor force, quits rate). */
async function geographies(ctx: NativeCtx, params: NativeParams, file: string, wanted: string[]): Promise<Row[]> {
  const frame = readCsvFrame(await download(ctx, file))
  const dateAt = column(frame, 'Date')
  const valueColumns = wanted.filter((c) => frame.columns.includes(c))
  const start = dateParam(params, 'start_date')
  const end = dateParam(params, 'end_date')
  const rows = frame.rows.map((row) => ({ row, date: monthYear(row[dateAt]!) }))
  rows.sort((a, b) => cmp(a.date, b.date))
  const records: Row[] = []
  for (const { row, date } of rows) {
    if ((start && date < start) || (end && date > end)) continue
    const record: Row = { date }
    for (const c of valueColumns) {
      const v = toNumeric(row[frame.columns.indexOf(c)])
      if (v !== null) record[c] = v
    }
    if (valueColumns.some((c) => c in record)) records.push(record)
  }
  if (records.length === 0) emptyData()
  return records
}

const STATES = ['MN', 'MT', 'ND', 'SD', 'WI', 'US']
export const employment = (params: NativeParams, ctx: NativeCtx) => geographies(ctx, params, 'employment_data.csv', STATES)
export const unemployment = (params: NativeParams, ctx: NativeCtx) => geographies(ctx, params, 'unemployment_data.csv', STATES)
export const laborForce = (params: NativeParams, ctx: NativeCtx) => geographies(ctx, params, 'labor_force_data.csv', STATES)
export const quitsRate = (params: NativeParams, ctx: NativeCtx) => geographies(ctx, params, 'quits_rate_data.csv', STATES)

export async function regionalGdp(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const frame = readCsvFrame(await download(ctx, 'real_gdp.csv'))
  const periodAt = column(frame, 'Period')
  const valueColumns = ['US', 'MN', 'MT', 'ND', 'SD', 'WI'].filter((c) => frame.columns.includes(c))
  const start = dateParam(params, 'start_date')
  const end = dateParam(params, 'end_date')
  // "Q1 2019" → 2019Q1 → the first day of the quarter.
  const rows = frame.rows.map((row) => {
    const m = /^Q(\d)\s+(\d{4})$/.exec(String(row[periodAt] ?? '').trim())
    if (!m || Number(m[1]) < 1 || Number(m[1]) > 4) throw new Error(`Invalid quarter: ${row[periodAt]}`)
    return { row, date: `${m[2]}-${String((Number(m[1]) - 1) * 3 + 1).padStart(2, '0')}-01` }
  })
  rows.sort((a, b) => cmp(a.date, b.date))
  const records: Row[] = []
  for (const { row, date } of rows) {
    if ((start && date < start) || (end && date > end)) continue
    const record: Row = { date }
    for (const c of valueColumns) {
      const v = toNumeric(row[frame.columns.indexOf(c)])
      if (v !== null) record[c] = v
    }
    if (valueColumns.some((c) => c in record)) records.push(record)
  }
  if (records.length === 0) emptyData()
  return records
}

/** Several CSVs merged on the month: for each file, the geography columns as `<prefix> <geography>` fields. */
function mergeMonthly(files: { frame: Frame; fields: [source: string, field: string][] }[], params: NativeParams): Row[] {
  const rows = new Map<string, Row>()
  const fields: string[] = []
  for (const { frame, fields: pairs } of files) {
    const dateAt = column(frame, 'Date')
    for (const [source, field] of pairs) {
      const at = frame.columns.indexOf(source)
      if (at < 0) continue
      fields.push(field)
      for (const row of frame.rows) {
        const date = monthYear(row[dateAt]!)
        const v = toNumeric(row[at])
        const record = rows.get(date) ?? { date }
        rows.set(date, record)
        record[field] = v
      }
    }
  }
  const start = dateParam(params, 'start_date')
  const end = dateParam(params, 'end_date')
  const records: Row[] = []
  for (const date of [...rows.keys()].sort(cmp)) {
    if ((start && date < start) || (end && date > end)) continue
    const row = rows.get(date)!
    if (fields.some((f) => row[f] !== null && row[f] !== undefined)) records.push(row)
  }
  if (records.length === 0) emptyData()
  return records
}

export async function regionalCpi(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const [cpiU, core] = await Promise.all([download(ctx, 'CPI_U.csv'), download(ctx, 'CPI_U_less_food_energy.csv')])
  const geos = ['US', 'West North Central', 'Mountain']
  return mergeMonthly(
    [
      { frame: readCsvFrame(cpiU), fields: geos.map((g): [string, string] => [g, `CPI-U ${g}`]) },
      { frame: readCsvFrame(core), fields: geos.map((g): [string, string] => [g, `Core ${g}`]) },
    ],
    params,
  )
}

export async function jobOpeningsHiring(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const states = ['MN', 'MT', 'ND', 'SD', 'WI']
  const texts = await Promise.all(states.map((s) => download(ctx, `hiring_job_${s.toLowerCase()}.csv`)))
  return mergeMonthly(
    texts.map((text, i) => ({ frame: readCsvFrame(text), fields: [`${states[i]} Job Opening Rate`, `${states[i]} Hiring Rate`].map((c): [string, string] => [c, c]) })),
    params,
  )
}

export async function unemploymentClaims(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const [initialText, continuedText] = await Promise.all([download(ctx, 'mn_initial.csv'), download(ctx, 'mn_continued.csv')])
  const side = (text: string, name: string) => {
    const frame = readCsvFrame(text)
    const dateAt = column(frame, 'Date')
    const mn = column(frame, 'MN')
    return new Map(frame.rows.map((row) => [monthDay(row[dateAt]!), row[mn] ?? null] as const).map(([d, v]) => [d, { [name]: v }] as const))
  }
  const initial = side(initialText, 'initial_claims')
  const continued = side(continuedText, 'continued_claims')
  const start = dateParam(params, 'start_date')
  const end = dateParam(params, 'end_date')
  const out: Row[] = []
  for (const date of [...new Set([...initial.keys(), ...continued.keys()])].sort(cmp)) {
    if ((start && date < start) || (end && date > end)) continue
    const row: Row = { date }
    for (const part of [initial.get(date), continued.get(date)]) {
      for (const [k, v] of Object.entries(part ?? {})) if (!isNa(v)) row[k] = Math.trunc(Number(v))
    }
    out.push(row)
  }
  return out
}

/** `to_datetime(cell)` of an ISO date. */
function monthDay(cell: Cell): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(cell ?? '').trim())
  if (!m) throw new Error(`Unknown datetime string format, unable to parse: ${cell}`)
  return `${m[1]}-${m[2]}-${m[3]}`
}

const PRICES_COLUMNS: Record<string, string> = { Benefits: 'benefits', 'Input prices': 'input_prices', 'Sales prices': 'sales_prices', Wages: 'wages' }
const PERFORMANCE_COLUMNS: Record<string, string> = { Investment: 'investment', Headcount: 'headcount', Hiring: 'hiring', Inventories: 'inventories', Profits: 'profits', Sales: 'sales' }

/** One business-conditions CSV: month (flash months end in "(F)") plus the renamed value columns. */
function businessConditionsFile(text: string, dateNames: string[], rename: Record<string, string>): Map<string, { flash: boolean; values: Row }> {
  const frame = readCsvFrame(text)
  const name = dateNames.find((n) => frame.columns.includes(n))
  if (name === undefined) throw new Error(`'${dateNames[0]}'`)
  const dateAt = frame.columns.indexOf(name)
  const out = new Map<string, { flash: boolean; values: Row }>()
  for (const row of frame.rows) {
    const raw = String(row[dateAt] ?? '')
    const flash = /\(F\)/.test(raw)
    const date = monthYear(raw.replace(/\s*\(F\)\s*$/, ''))
    const values: Row = {}
    frame.columns.forEach((c, i) => {
      if (i !== dateAt && !isNa(row[i])) values[rename[c] ?? c] = row[i]
    })
    out.set(date, { flash, values })
  }
  return out
}

export async function businessConditions(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const [pricesText, performanceText] = await Promise.all([download(ctx, 'business_conditions_prices.csv'), download(ctx, 'business_conditions_performance.csv')])
  // OpenBB reads the prices file's `Date` column; the file now names it `month`, like the performance file.
  const prices = businessConditionsFile(pricesText, ['Date', 'month'], PRICES_COLUMNS)
  const performance = businessConditionsFile(performanceText, ['month'], PERFORMANCE_COLUMNS)
  const start = dateParam(params, 'start_date')
  const end = dateParam(params, 'end_date')
  const out: Row[] = []
  for (const date of [...new Set([...prices.keys(), ...performance.keys()])].sort(cmp)) {
    if ((start && date < start) || (end && date > end)) continue
    const p = prices.get(date)
    const q = performance.get(date)
    out.push({ date, ...p?.values, ...q?.values, is_flash: Boolean(p?.flash || q?.flash) })
  }
  return out
}
