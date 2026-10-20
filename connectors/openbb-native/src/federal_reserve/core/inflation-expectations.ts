// economy/survey/inflation_expectations, provider federal_reserve. Ported from
// openbb_federal_reserve/models/inflation_expectations.py (OpenBB Platform 5.0.0, Apache-2.0); modified: the shared
// xlsx reader instead of openpyxl and pandas, ctx.cache instead of the on-disk cache.
import { readXlsx } from '../../lib/xlsx.js'
import type { NativeCtx, NativeParams, Row } from '../../types.js'
import { DAY_MS, inRange, request, str } from './helpers.js'

const URL = 'https://www.philadelphiafed.org/-/media/FRBP/Assets/Surveys-And-Data/survey-of-professional-forecasters/historical-data/Inflation.xlsx'
const QUARTER_TO_MONTH: Record<number, string> = { 1: '01', 2: '04', 3: '07', 4: '10' }
const COLUMNS = ['infpgdp1yr', 'infcpi1yr', 'infcpi10yr']

export async function inflationExpectations(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const start = str(params, 'start_date')
  const end = str(params, 'end_date')
  const file = await ctx.cache('fed:inflation_expectations', DAY_MS, () => ctx.http.bytes(URL, request()))
  const sheet = readXlsx(file).find((s) => s.name === 'INFLATION')
  if (!sheet) throw new Error('Worksheet INFLATION does not exist.')
  const [header = [], ...body] = sheet.rows
  const names = header.map((h) => String(h ?? '').toLowerCase())
  const at = (name: string): number => names.indexOf(name)

  const rows: Row[] = []
  for (const r of body) {
    const year = Number(r[at('year')])
    const quarter = Number(r[at('quarter')])
    if (!Number.isFinite(year) || QUARTER_TO_MONTH[quarter] === undefined) continue
    const date = `${String(Math.trunc(year)).padStart(4, '0')}-${QUARTER_TO_MONTH[quarter]}-01`
    if (!inRange(date, start, end)) continue
    const row: Row = { date }
    for (const c of COLUMNS) {
      const v = r[at(c)]
      if (typeof v === 'number' && Number.isFinite(v)) row[c] = v
    }
    if (COLUMNS.some((c) => row[c] !== undefined)) rows.push(row)
  }
  if (rows.length === 0) throw new Error('The query filters resulted in no data. Try again with different date parameters.')
  return rows.sort((a, b) => String(a.date).localeCompare(String(b.date)))
}
