// usda/fruit_and_tree_nuts_data, provider usda. Ported from openbb_government_us/usda/models/fruit_and_tree_nuts_data.py and
// utils/ers_fruit_and_tree_nuts_data.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { cell, csvDictRows, fetchErsText, nullTokensToNone, optInt, pyFloat } from './helpers.js'
import { isDigits, sortedNested } from './helpers-a.js'

const YEARBOOK_MEDIA = '/media/7009/all-fruit-and-tree-nuts-yearbook-data.csv'
const DEFAULT_TABLE = 'A-1'
const CODE_PATTERN = /^Table\s+([A-H])\s*-\s*(\d+)/
const SERIES_DIMS = ['variable', 'market_segment', 'geography'] as const

const MONTH_NUMBERS: Record<string, number> = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 }

/** Tables per category letter (A-1 .. A-15, B-1 .. B-29, ...). */
const TABLES_PER_CATEGORY: Record<string, number> = { A: 15, B: 29, C: 20, D: 10, E: 10, F: 18, G: 45, H: 5 }
const TABLE_TITLES = new Set(Object.entries(TABLES_PER_CATEGORY).flatMap(([letter, n]) => Array.from({ length: n }, (_, i) => `${letter}-${i + 1}`)))

type Observation = { yearLabel: string; year: number; month: string | null; variable: string; commodity: string; market_segment: string; geography: string; unit: string; value: number }

/** Upper-cased single value, as the category and table validators read it. */
function upperParam(params: NativeParams, name: string): string | undefined {
  const v = params[name]
  const first = Array.isArray(v) ? v[0] : v
  if (first === undefined || first === null || first === '') return undefined
  return String(first).trim().toUpperCase()
}

export async function fruitAndTreeNutsData(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  // The category is only validated; the table decides what is read.
  const category = upperParam(params, 'category')
  if (category !== undefined && !Object.prototype.hasOwnProperty.call(TABLES_PER_CATEGORY, category)) throw new Error(`Invalid category: ${category}. Valid categories are: ${Object.keys(TABLES_PER_CATEGORY).join(', ')}`)
  const table = upperParam(params, 'table') ?? DEFAULT_TABLE
  if (!TABLE_TITLES.has(table)) throw new Error(`Invalid table: ${table}. Valid tables are: ${[...TABLE_TITLES].join(', ')}`)
  const startYear = optInt(params, 'start_year')
  const endYear = optInt(params, 'end_year')

  // parse_records
  const data: Observation[] = []
  for (const row of csvDictRows(await fetchErsText(ctx, YEARBOOK_MEDIA))) {
    const match = CODE_PATTERN.exec(row.table_name ?? '')
    if (!match || `${match[1]}-${match[2]}` !== table) continue
    const value = pyFloat(cell(row, 'value'))
    if (value === undefined) continue
    const yearLabel = cell(row, 'year_value')
    if (!isDigits(yearLabel.slice(0, 4))) continue
    const month = cell(row, 'month')
    data.push({
      yearLabel,
      year: Number(yearLabel.slice(0, 4)),
      month: Object.prototype.hasOwnProperty.call(MONTH_NUMBERS, month.toLowerCase()) ? month : null,
      variable: cell(row, 'variable'),
      commodity: cell(row, 'commodity_element'),
      market_segment: cell(row, 'market_segment'),
      geography: cell(row, 'geographic_extent'),
      unit: cell(row, 'unit'),
      value,
    })
  }

  // Which dimensions split the series, judged over the whole table (before the year window).
  const distinct = (dim: keyof Observation): number => new Set(data.map((r) => r[dim])).size
  const seriesDims = SERIES_DIMS.filter((dim) => distinct(dim) > 1)
  const commodityVaries = distinct('commodity') > 1
  const commodityIsColumn = commodityVaries && seriesDims.length === 0
  const commodityIsRow = commodityVaries && seriesDims.length > 0
  const monthly = data.some((r) => r.month)
  const columnLabel = (r: Observation): string => {
    const parts = SERIES_DIMS.filter((dim) => seriesDims.includes(dim)).map((dim) => r[dim])
    const head = commodityIsColumn ? r.commodity : parts.length ? parts.join(', ') : r.variable
    return `${head} (${r.unit})`
  }
  const columnOrder: string[] = []
  const seenColumns = new Set<string>()
  const commodityIndex = new Map<string, number>()
  for (const r of data) {
    if (!commodityIndex.has(r.commodity)) commodityIndex.set(r.commodity, commodityIndex.size)
    const label = columnLabel(r)
    if (!seenColumns.has(label)) {
      seenColumns.add(label)
      columnOrder.push(label)
    }
  }

  type Wide = { commodityIndex: number; year: number; month: number; order: number; label: string; commodity: string | null; monthName: string | null; values: Map<string, number> }
  const pivoted = new Map<string, Wide>()
  data.forEach((r, order) => {
    if ((startYear !== undefined && r.year < startYear) || (endYear !== undefined && r.year > endYear)) return
    const key = JSON.stringify([r.yearLabel, monthly ? r.month : null, commodityIsRow ? r.commodity : null])
    let row = pivoted.get(key)
    if (!row) {
      row = {
        commodityIndex: commodityIsRow ? commodityIndex.get(r.commodity)! : 0,
        year: r.year,
        month: MONTH_NUMBERS[(r.month ?? '').toLowerCase()] ?? 0,
        order,
        label: commodityIsRow ? `${r.commodity} — ${r.yearLabel}` : r.yearLabel,
        commodity: commodityIsRow ? r.commodity : null,
        monthName: monthly ? r.month : null,
        values: new Map(),
      }
      pivoted.set(key, row)
    }
    row.values.set(columnLabel(r), r.value)
  })
  return sortedNested([...pivoted.values()], (w) => [w.commodityIndex, w.year, w.month, w.order]).map((w) => {
    const out: Row = { year: w.label, commodity: w.commodity, month: w.monthName }
    for (const label of columnOrder) out[label] = w.values.get(label) ?? null
    return nullTokensToNone(out)
  })
}
