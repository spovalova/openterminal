// federal_reserve/atlanta/taylor_rule, taylor_rule_measures and taylor_rule_heatmap, provider federal_reserve. Ported from
// openbb_federal_reserve/models/regional/atlanta_taylor_rule.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain
// arrays instead of pandas frames.
import type { NativeCtx, NativeParams, Row } from '../../../types.js'
import { dateOf, isDateCell, isNa, numberOrNull, readFrame, readGrid, toDate, toNumeric, type Cell } from '../workbook.js'
import { ATLANTA_DOCS, dateParam, downloadWorkbook, emptyData } from './helpers.js'

const URL = `${ATLANTA_DOCS}/datafiles/cqer/research/taylor-rule/taylor-rule-data.xlsx`
const NA_VALUES = ['#N/A', '#N/A N/A', 'na', '.']

const CHART_SHEETS: Record<string, string> = {
  taylor_93_unemployment: 'FOMCTaylor93UR',
  taylor_99_unemployment: 'FOMCTaylor99UR',
  taylor_93_gdp: 'Taylor93GDP',
}
const MEASURE_SHEETS: Record<string, string> = {
  natural_rate: 'NaturalRateMeasures',
  gap: 'GapMeasures',
  inflation: 'InflationMeasures',
  inflation_target: 'InflationTargetMeasures',
  fed_funds: 'FedFundsRates',
}
const HEATMAP_SHEETS: Record<string, string> = { latest: 'HeatMapLatestQuarter', previous: 'HeatMapPreviousQuarter' }

const workbook = (ctx: NativeCtx) => downloadWorkbook(ctx, 'taylor_rule', URL)

export async function taylorRule(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const start = dateParam(params, 'start_date')
  const end = dateParam(params, 'end_date')
  const bytes = await workbook(ctx)
  const merged = new Map<string, Row>()
  const actualByDate = new Map<string, number | null>()
  for (const [field, sheet] of Object.entries(CHART_SHEETS)) {
    const frame = readFrame(bytes, sheet, 1, NA_VALUES)
    const prescribed = frame.columns.findIndex((c) => c.startsWith(sheet))
    const actual = frame.columns.findIndex((c) => c.trim() === 'Actual Fed Funds Rate')
    for (const row of frame.rows) {
      const cell = row[0]
      if (!isDateCell(cell)) continue
      const observation = dateOf(cell as string)
      let record = merged.get(observation)
      if (!record) {
        record = { date: observation }
        merged.set(observation, record)
      }
      record[field] = prescribed >= 0 ? numberOrNull(row[prescribed]) : null
      if (actual >= 0 && !actualByDate.has(observation)) actualByDate.set(observation, numberOrNull(row[actual]))
    }
  }
  const records: Row[] = []
  for (const [observation, record] of merged) {
    if (start && observation < start) continue
    if (end && observation > end) continue
    record.actual_fed_funds_rate = actualByDate.get(observation) ?? null
    records.push(record)
  }
  return records.sort((a, b) => (a.date as string).localeCompare(b.date as string))
}

export async function taylorRuleMeasures(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const start = dateParam(params, 'start_date')
  const end = dateParam(params, 'end_date')
  const frame = readFrame(await workbook(ctx), MEASURE_SHEETS[String(params.measure ?? 'natural_rate')]!, 1, NA_VALUES)
  const measures = frame.columns.slice(1)
  const records: Row[] = []
  const dated = frame.rows.map((row) => ({ row, date: toDate(row[0]) })).filter((r): r is { row: Cell[]; date: string } => r.date !== undefined)
  dated.sort((a, b) => a.date.localeCompare(b.date))
  for (const { row, date } of dated) {
    if (start && date < start) continue
    if (end && date > end) continue
    const record: Row = { date }
    measures.forEach((m, i) => {
      record[m] = toNumeric(row[i + 1])
    })
    if (measures.some((m) => record[m] !== null)) records.push(record)
  }
  if (records.length === 0) emptyData()
  return records
}

export async function taylorRuleHeatmap(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const grid = readGrid(await workbook(ctx), HEATMAP_SHEETS[String(params.quarter ?? 'latest')]!)
  const text = (v: unknown): string => (isNa(v) ? '' : String(v).trim())
  const marker = grid.findIndex((row) => row.some((c) => text(c).includes('Measure of Gap')))
  if (marker < 0) emptyData()
  const headerRow = marker + 1
  const gapColumns = new Map<number, string>()
  for (let j = 2; j < (grid[headerRow]?.length ?? 0); j++) {
    const label = text(grid[headerRow]![j])
    if (!label) break
    gapColumns.set(j, label)
  }
  const records: Row[] = []
  for (const row of grid.slice(headerRow + 1)) {
    const label = text(row[1])
    if (!label || label.toLowerCase() === 'nan') continue
    if (!/\p{L}/u.test(label)) continue
    const record: Row = { r_star_measure: label }
    let hasValue = false
    for (const [column, gap] of gapColumns) {
      const cell = row[column]
      // pandas holds an empty cell as NaN, which Python's isinstance(…, float) accepts: the row still counts.
      if (typeof cell === 'number' || cell === null) {
        hasValue = true
        if (typeof cell === 'number') record[gap] = cell
      }
    }
    if (hasValue) records.push(record)
  }
  if (records.length === 0) emptyData()
  return records
}

