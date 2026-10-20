// federal_reserve/atlanta/gdpnow, provider federal_reserve. Ported from openbb_federal_reserve/models/regional/atlanta_gdpnow.py
// (OpenBB Platform 5.0.0, Apache-2.0); modified: the workbook URL (the Atlanta Fed moved it to research-and-data/data/gdpnow;
// the Python URL answers with a 404 page), plain arrays instead of pandas frames.
import type { NativeCtx, NativeParams, Row } from '../../../types.js'
import { cellText, dateOf, isDateCell, numberOrNull, pivotWide, readGrid, type Grid } from '../workbook.js'
import { ATLANTA_DOCS, dateParam, downloadWorkbook, emptyData } from './helpers.js'

const URL = `${ATLANTA_DOCS}/research-and-data/data/gdpnow/GDPTrackingModelDataAndForecasts.xlsx`

const SHEETS: Record<string, string> = {
  evolution: 'CurrentQtrEvolution',
  contributions: 'Contributions',
  change_in_contributions: 'ChangeInContributions',
  table: 'Table',
  table_contributions: 'TableCont',
  track_record: 'TrackRecord',
}

/** A trimmed, whitespace-collapsed label, or null when blank. */
const label = (v: unknown): string | null => cellText(v) || null

/** A dated table melted to long rows, carrying an optional release label column (`_melt_table`). */
function meltTable(grid: Grid, headerRow: number, valueStart: number, labelColumn: number | null): Row[] {
  const header = grid[headerRow] ?? []
  const records: Row[] = []
  for (const row of grid.slice(headerRow + 1)) {
    if (!isDateCell(row[0])) continue
    const observation = dateOf(row[0] as string)
    const release = labelColumn !== null ? label(row[labelColumn]) : null
    for (let column = valueStart; column < header.length; column++) {
      const name = label(header[column])
      const value = column < row.length ? numberOrNull(row[column]) : null
      if (name && value !== null && column !== labelColumn) records.push({ date: observation, series: name, value, major_release: release })
    }
  }
  return records
}

/** Already-wide rows from a fixed-column sheet, keeping date cells as dates (`_flat_table`). */
function flatTable(grid: Grid, headerRow: number): Row[] {
  const header = grid[headerRow] ?? []
  const records: Row[] = []
  for (const row of grid.slice(headerRow + 1)) {
    if (!isDateCell(row[0])) continue
    const record: Row = { date: dateOf(row[0] as string) }
    for (let column = 1; column < header.length; column++) {
      const name = label(header[column])
      if (!name) continue
      const cell = column < row.length ? row[column] : null
      record[name] = isDateCell(cell) ? dateOf(cell as string) : numberOrNull(cell)
    }
    records.push(record)
  }
  return records
}

/** The three side-by-side quarter blocks of the evolution sheet, melted (`_melt_evolution`). */
function meltEvolution(grid: Grid): Row[] {
  const width = Math.max(0, ...grid.map((r) => r.length))
  const records: Row[] = []
  for (let block = 0; block < width; block += 3) {
    for (const row of grid.slice(1)) {
      if (row.length <= block || !isDateCell(row[block])) continue
      const value = block + 2 < row.length ? numberOrNull(row[block + 2]) : null
      if (value !== null) records.push({ date: dateOf(row[block] as string), series: 'GDP nowcast', value, major_release: block + 1 < row.length ? label(row[block + 1]) : null })
    }
  }
  return records
}

export async function gdpnow(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const bytes = await downloadWorkbook(ctx, 'gdpnow', URL)
  const table = String(params.table ?? 'evolution')
  const grid = readGrid(bytes, SHEETS[table]!)

  let records: Row[]
  if (table === 'track_record') records = flatTable(grid, 0)
  else if (table === 'evolution') records = meltEvolution(grid)
  else if (table === 'contributions' || table === 'change_in_contributions') records = meltTable(grid, 1, 2, 11)
  else records = meltTable(grid, 0, 2, 1)

  const start = dateParam(params, 'start_date')
  const end = dateParam(params, 'end_date')
  if (start) records = records.filter((r) => (r.date as string) >= start)
  if (end) records = records.filter((r) => (r.date as string) <= end)
  if (records.length === 0) emptyData()

  const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
  if (table === 'track_record') return records.sort((a, b) => byString(a.date as string, b.date as string))
  const ordered = records.sort((a, b) => byString(a.date as string, b.date as string) || byString(a.series as string, b.series as string))
  return pivotWide(ordered, ['date', 'major_release'], 'series', 'value')
}
