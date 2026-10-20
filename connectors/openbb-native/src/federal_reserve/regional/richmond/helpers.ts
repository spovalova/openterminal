// Shared by the Richmond Fed routes, provider federal_reserve. Ported from openbb_federal_reserve/utils/richmond_surveys.py
// (OpenBB Platform 5.0.0, Apache-2.0); modified: ctx.cache instead of the on-disk cache, and plain arrays instead of pandas
// frames.
import { BROWSER_UA } from '../../../http.js'
import type { NativeCtx, NativeParams, Row } from '../../../types.js'
import { isNa, pivotWide, readFrame, toDate, type Cell } from '../workbook.js'

const MEDIA = 'https://www.richmondfed.org/-/media/RichmondFedOrg'
const SURVEY_ROOT = 'region_communities/regional_data_analysis/regional_economy/surveys_of_business_conditions'
const DAY_MS = 24 * 3600 * 1000

/** survey → workbook URL and the sheet the Python code reads. */
const SURVEYS: Record<string, { data: string; sheet: string }> = {
  manufacturing: { data: `${MEDIA}/${SURVEY_ROOT}/manufacturing/data/mfg_historicaldata.xlsx`, sheet: 'Mfg Historical Series' },
  non_manufacturing: { data: `${MEDIA}/${SURVEY_ROOT}/non-manufacturing/data/nmf_historicaldata.xlsx`, sheet: 'Non-Mfg Historical Series' },
  carolinas: { data: `${MEDIA}/${SURVEY_ROOT}/carolinas/data/car_historicaldata.xlsx`, sheet: 'CAR Historical Series' },
  maryland: { data: `${MEDIA}/${SURVEY_ROOT}/maryland/data/mar_historicaldata.xlsx`, sheet: 'MD Historical Series' },
  virginia: { data: `${MEDIA}/${SURVEY_ROOT}/virginia/data/va_historicaldata.xlsx`, sheet: 'VA Historical Series' },
}

export { MEDIA }

export const dateParam = (params: NativeParams, name: 'start_date' | 'end_date'): string | undefined => (typeof params[name] === 'string' && params[name] ? (params[name] as string) : undefined)

/** A workbook download from the Richmond Fed, kept for a day. */
export function downloadWorkbook(ctx: NativeCtx, key: string, url: string): Promise<Uint8Array> {
  return ctx.cache(`richmond:${key}`, DAY_MS, async () => {
    const bytes = await ctx.http.bytes(url, { headers: { 'user-agent': BROWSER_UA }, timeoutMs: 120_000 })
    if (bytes.length === 0) throw new Error('The request was returned empty.')
    return bytes
  })
}

const ADJUSTMENTS: Record<string, string> = { nsa: 'Not Seasonally Adjusted', sa: 'Seasonally Adjusted' }
const HORIZONS: Record<string, string> = { c: 'Current', e: 'Expectations (Six Months Ahead)' }
const INFIXES = new Set(['mfg', 'nmf', 'svc', 'car', 'mar', 'md', 'va'])
const INDICATORS: Record<string, string> = {
  ship: 'Shipments',
  new_orders: 'New Orders',
  bk_logs: 'Backlog of Orders',
  cap_util: 'Capacity Utilization',
  vend_lead: 'Vendor Lead Time',
  emp: 'Number of Employees',
  workwk: 'Average Workweek',
  wage: 'Wages',
  fd_gds_inv: 'Finished Goods Inventories',
  raw_mats_inv: 'Raw Materials Inventories',
  pct_chg_prcs_recd: 'Prices Received',
  pct_chg_prcs_pd: 'Prices Paid',
  capital_expnd: 'Capital Expenditures',
  local_bus_cond: 'Local Business Conditions',
  nec_skls_avail: 'Availability of Necessary Skills',
  equip_sftw_expnd: 'Equipment and Software Expenditures',
  bus_svcs_expnd: 'Business Services Expenditures',
  composite: 'Composite Index',
  revenues: 'Revenues',
  revs_sales: 'Revenues',
  demand: 'Demand',
  ave_wage: 'Wages',
  ave_workwk: 'Average Workweek',
  prcs_recd: 'Prices Received',
  new_orders_recd: 'New Orders Received',
  bus_act: 'Business Activity',
  gen_bus_cond: 'General Business Conditions',
  sales: 'Sales',
  bus_cond_nation: 'Business Conditions (Nation)',
  bus_cond_region: 'Business Conditions (Region)',
}

/** Python's `str.title()` on "word word": the first letter of each run of letters upper-cased, the rest lower-cased. */
const title = (s: string): string => s.toLowerCase().replace(/(^|[^a-z])([a-z])/g, (_, a: string, b: string) => a + b.toUpperCase())

/** Decode a `{adj}_{survey}_{indicator}_{c|e}` column into labelled parts. */
function decodeColumn(code: string): { indicator: string; adjustment: string; horizon: string } | undefined {
  const parts = code.trim().toLowerCase().split('_')
  if (parts.length < 2 || !Object.hasOwn(ADJUSTMENTS, parts[0]!)) return undefined
  let rest = parts.slice(1)
  if (rest.length > 0 && INFIXES.has(rest[0]!)) rest = rest.slice(1)
  let horizon = HORIZONS.c!
  if (rest.length > 0 && Object.hasOwn(HORIZONS, rest[rest.length - 1]!)) {
    horizon = HORIZONS[rest[rest.length - 1]!]!
    rest = rest.slice(0, -1)
  }
  if (rest.length === 0) return undefined
  const key = rest.join('_')
  return { indicator: (Object.hasOwn(INDICATORS, key) ? INDICATORS[key] : undefined) ?? title(key.replace(/_/g, ' ')), adjustment: ADJUSTMENTS[parts[0]!]!, horizon }
}

/** A survey sheet as date-filtered records, one per month, all columns kept (`parse_survey_records`). */
function surveyRecords(bytes: Uint8Array, sheet: string, start?: string, end?: string): { date: string; cells: [string, Cell][] }[] {
  const frame = readFrame(bytes, sheet)
  const dateAt = frame.columns.indexOf('date')
  if (dateAt < 0) throw new Error("'date'")
  const rows = frame.rows.flatMap((row) => {
    const date = toDate(row[dateAt])
    return date === undefined ? [] : [{ date, row }]
  })
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  return rows
    .filter(({ date }) => (!start || date >= start) && (!end || date <= end))
    .map(({ date, row }) => ({ date, cells: frame.columns.map((c, i): [string, Cell] => [c, row[i] ?? null]).filter(([c]) => c !== 'date') }))
}

/** A survey sheet as wide rows: one indicator column per series, a row per (date, adjustment, horizon) (`parse_survey_wide`). */
export function parseSurveyWide(bytes: Uint8Array, sheet: string, start?: string, end?: string): Row[] {
  const long: Row[] = []
  for (const { date, cells } of surveyRecords(bytes, sheet, start, end)) {
    for (const [column, value] of cells) {
      const decoded = decodeColumn(column)
      const v = isNa(value) ? null : value
      long.push(decoded ? { date, ...decoded, value: v } : { date, indicator: column, adjustment: null, horizon: null, value: v })
    }
  }
  const str = (v: unknown): string => (v === null || v === undefined ? 'None' : String(v))
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
  long.sort((a, b) => cmp(a.date as string, b.date as string) || cmp(a.indicator as string, b.indicator as string) || cmp(str(a.adjustment), str(b.adjustment)) || cmp(str(a.horizon), str(b.horizon)))
  return pivotWide(long, ['date', 'adjustment', 'horizon'], 'indicator', 'value')
}

export async function survey(ctx: NativeCtx, name: string, sheet: string | undefined, params: NativeParams): Promise<Row[]> {
  const spec = SURVEYS[name]
  if (!spec) throw new Error(`No Richmond Fed survey '${name}'.`)
  const bytes = await downloadWorkbook(ctx, `survey:${name}`, spec.data)
  return parseSurveyWide(bytes, sheet ?? spec.sheet, dateParam(params, 'start_date'), dateParam(params, 'end_date'))
}
