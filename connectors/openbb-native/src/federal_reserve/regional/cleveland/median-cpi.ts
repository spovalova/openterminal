// federal_reserve/cleveland/median_cpi, median_cpi_components and systemic_risk, provider federal_reserve. Ported from
// openbb_federal_reserve/models/regional/cleveland_median_cpi.py, cleveland_median_cpi_components.py and
// cleveland_systemic_risk.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain arrays instead of pandas frames.
import type { NativeCtx, NativeParams, Row } from '../../../types.js'
import { readCsvFrame } from '../csvframe.js'
import { parseLooseDate, toNumeric } from '../workbook.js'
import { CLEVELAND_WEBCHARTS, dateParam, downloadText, meltAndPivot } from './helpers.js'

const MEDIAN_CPI_URL = `${CLEVELAND_WEBCHARTS}/mediancpi`

/** table → file, and the columns kept with their labels. */
const TABLES: Record<string, [file: string, labels: Record<string, string>]> = {
  summary: ['mediancpi_chartdata.csv', { mediancpi: 'Median CPI', trimmedmeancpi: '16% Trimmed-Mean CPI', cpi: 'CPI', corecpi: 'Core CPI' }],
  median_cpi: ['mcpi_revised.csv', { mcpi_monthly_chg: 'Median CPI, 1-Month Change', mcpi_ann_monthly_chg: 'Median CPI, 1-Month Annualized' }],
  trimmed_mean: ['trim_revised.csv', { trim_monthly_chg: '16% Trimmed-Mean CPI, 1-Month Change', trim_ann_monthly_chg: '16% Trimmed-Mean CPI, 1-Month Annualized' }],
  cpi: ['cpi.csv', { cpi_index: 'CPI Index', ann_monthly_chg: 'CPI, 1-Month Annualized' }],
  core_cpi: ['core.csv', { core_index: 'Core CPI Index', ann_monthly_chg: 'Core CPI, 1-Month Annualized' }],
}

const COMPONENT_COLUMNS: Record<string, string> = {
  Component: 'component',
  '1-Month Annualized Percent Change': 'change',
  'Relative Importance (Normalized)': 'relative_importance',
  'Cumulative Relative Importance': 'cumulative_relative_importance',
}

const SYSTEMIC_LABELS: Record<string, string> = {
  sri: 'Systemic Risk Indicator (ADD minus PDD)',
  add: 'Average Distance-to-Default (ADD)',
  pdd: 'Portfolio Distance-to-Default (PDD)',
}

/** Rows of a CSV whose first column is the date: dated rows with the numeric columns asked for. */
function datedRows(text: string, wanted: string[], lowercase: boolean): { date: string; values: Record<string, number | null> }[] {
  const frame = readCsvFrame(text)
  const columns = frame.columns.map((c) => (lowercase ? c.trim().toLowerCase() : c.trim()))
  const out: { date: string; values: Record<string, number | null> }[] = []
  for (const row of frame.rows) {
    const cell = row[0]
    const date = typeof cell === 'string' ? parseLooseDate(cell) : undefined
    if (date === undefined) continue
    const values: Record<string, number | null> = {}
    for (const column of wanted) {
      const at = columns.indexOf(column, 1)
      if (at >= 0) values[column] = toNumeric(row[at])
    }
    out.push({ date, values })
  }
  return out
}

export async function medianCpi(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const table = String(params.table ?? 'summary')
  const [file, labels] = TABLES[table]!
  const text = await downloadText(ctx, `median_cpi:${table}`, `${MEDIAN_CPI_URL}/${file}`)
  return meltAndPivot(datedRows(text, Object.keys(labels), false), labels, dateParam(params, 'start_date'), dateParam(params, 'end_date'))
}

export async function medianCpiComponents(_params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const text = await downloadText(ctx, 'median_cpi_components', `${MEDIAN_CPI_URL}/mediancpi_component_table.csv`)
  const frame = readCsvFrame(text)
  const columns = frame.columns.map((c) => COMPONENT_COLUMNS[c.trim()] ?? c.trim())
  return frame.rows.map((row) => {
    const out: Row = {}
    columns.forEach((name, i) => {
      if (Object.values(COMPONENT_COLUMNS).includes(name) && row[i] !== null && row[i] !== undefined) out[name] = row[i]
    })
    return out
  })
}

export async function systemicRisk(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const text = await downloadText(ctx, 'systemic_risk', `${CLEVELAND_WEBCHARTS}/systemicrisk/landing_systemicrisk.csv`)
  // The date is the column named "date" here, not the first one.
  const frame = readCsvFrame(text)
  const columns = frame.columns.map((c) => c.trim().toLowerCase())
  const dateAt = columns.indexOf('date')
  if (dateAt < 0) throw new Error("'date'")
  const rows = frame.rows.flatMap((row) => {
    const cell = row[dateAt]
    const date = typeof cell === 'string' ? parseLooseDate(cell) : undefined
    if (date === undefined) return []
    const values: Record<string, number | null> = {}
    for (const column of Object.keys(SYSTEMIC_LABELS)) {
      const at = columns.indexOf(column)
      if (at >= 0) values[column] = toNumeric(row[at])
    }
    return [{ date, values }]
  })
  return meltAndPivot(rows, SYSTEMIC_LABELS, dateParam(params, 'start_date'), dateParam(params, 'end_date'))
}
