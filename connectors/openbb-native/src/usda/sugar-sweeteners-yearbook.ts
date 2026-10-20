// usda/sugar_sweeteners_yearbook, provider usda. Ported from openbb_government_us/usda/models/sugar_sweeteners_yearbook.py
// and utils/ers_sugar_sweeteners_yearbook.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { cell, csvDictRows, fetchErsText, nullTokensToNone, optInt, optString, pyFloat, pyInt } from './helpers.js'
import { classifyDimsFull, dimValue, isDigits, sortedNested, type Rec } from './helpers-a.js'

const DEFAULT_TABLE = 'table_24a'

/** Source column → record field. */
const DIMENSION_FIELDS: [string, string][] = [
  ['Commodity_desc', 'commodity_desc'],
  ['Commodity_desc2', 'commodity_desc2'],
  ['Geographic_extent', 'geographic_extent'],
  ['Geographic_extent2', 'geographic_extent2'],
  ['Source_or_destination', 'source_or_destination'],
  ['Fiscal_year_entered', 'fiscal_year_entered'],
  ['Fiscal_year_quota', 'fiscal_year_quota'],
  ['Forecast_yearmonth', 'forecast_yearmonth'],
]
/** The dimensions that may be folded into columns or row labels (the forecast vintage is not one). */
const FOLD_DIM_FIELDS = ['commodity_desc', 'commodity_desc2', 'geographic_extent', 'geographic_extent2', 'source_or_destination', 'fiscal_year_entered', 'fiscal_year_quota']

const M0 = '/media/5170/world-us-and-mexican-sugar-and-corn-sweetener-prices.csv'
const M1 = '/media/7096/us-sugar-crop-production-and-sugar-production-deliveries-and-stocks.csv'
const M2 = '/media/5151/us-honey-production-and-trade.csv'
const M3 = '/media/7144/us-consumption-of-caloric-sweeteners.csv'
const M4 = '/media/7097/the-machine-readable-file-combines-the-data-from-the-3-excel-tables-us-and-mexico-fiscal-year-sugar-supply-and-use-table-25-us-monthly-estimates-of-sugar-supply-and-use-and-table-26-monthly-estimates-of-mexican-sugar-supply-and-use.csv'
const M5 = '/media/7095/the-machine-readable-file-combines-the-data-from-the-2-excel-tables-us-corn-sweetener-supply-and-use-and-corn-sweetener-trade.csv'
const M6 = '/media/7098/the-machine-readable-file-combines-the-data-from-the-5-excel-tables-table-57-to-table-61.csv'

/** Table → [media file, Table_number]. */
const SUGAR_SWEETENERS_FILES: Record<string, [string, string]> = {
  table_2: [M0, '2'],
  table_3a: [M0, '3a'],
  table_3b: [M0, '3b'],
  table_4: [M0, '4'],
  table_5: [M0, '5'],
  table_5a: [M0, '5a'],
  table_6: [M0, '6'],
  table_7: [M0, '7'],
  table_8: [M0, '8'],
  table_9: [M0, '9'],
  table_10: [M0, '10'],
  table_11: [M0, '11'],
  table_12: [M0, '12'],
  table_13: [M0, '13'],
  table_31a: [M0, '31a'],
  table_31b: [M0, '31b'],
  table_54: [M0, '54'],
  table_55: [M0, '55'],
  table_14: [M1, '14'],
  table_15: [M1, '15'],
  table_16: [M1, '16'],
  table_17: [M1, '17'],
  table_18: [M1, '18'],
  table_19: [M1, '19'],
  table_20a: [M1, '20a'],
  table_20b: [M1, '20b'],
  table_21: [M1, '21'],
  table_22: [M1, '22'],
  table_46: [M2, '46'],
  table_47: [M2, '47'],
  table_48a: [M2, '48a'],
  table_48b: [M2, '48b'],
  table_49: [M3, '49'],
  table_50: [M3, '50'],
  table_51: [M3, '51'],
  table_52: [M3, '52'],
  table_53: [M3, '53'],
  table_24a: [M4, '24a'],
  table_24b: [M4, '24b'],
  table_25: [M4, '25'],
  table_26: [M4, '26'],
  table_56a: [M4, '56a'],
  table_56b: [M4, '56b'],
  table_27: [M5, '27'],
  table_28: [M5, '28'],
  table_29: [M5, '29'],
  table_30: [M5, '30'],
  table_34a: [M5, '34a'],
  table_34b: [M5, '34b'],
  table_35a: [M5, '35a'],
  table_35b: [M5, '35b'],
  table_36: [M5, '36'],
  table_37: [M5, '37'],
  table_38: [M5, '38'],
  table_57: [M6, '57'],
  table_58a: [M6, '58a'],
  table_58b: [M6, '58b'],
  table_58c: [M6, '58c'],
  table_59a: [M6, '59a'],
  table_59b: [M6, '59b'],
  table_60a: [M6, '60a'],
  table_60b: [M6, '60b'],
  table_60c: [M6, '60c'],
  table_60d: [M6, '60d'],
  table_60e: [M6, '60e'],
  table_61a: [M6, '61a'],
  table_61b: [M6, '61b'],
}

/** 0 for annual-like categories, 1 for quarters, 2 for months. */
function frequencyRank(periodCat: string | null): number {
  const label = (periodCat ?? '').toLowerCase()
  return label.includes('quarter') ? 1 : label.includes('month') ? 2 : 0
}

/** The within-year part of a row label: the quarter's first word, the month, or nothing for annual rows. */
function withinYearLabel(periodCat: string | null, periodDesc: string | null): string {
  if (frequencyRank(periodCat) === 0) return ''
  const desc = periodDesc ?? ''
  return (periodCat ?? '').toLowerCase().includes('quarter') ? desc.split(' ')[0]! : desc
}

export async function sugarSweetenersYearbook(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const table = optString(params, 'table') ?? DEFAULT_TABLE
  const config = Object.prototype.hasOwnProperty.call(SUGAR_SWEETENERS_FILES, table) ? SUGAR_SWEETENERS_FILES[table] : undefined
  if (!config) throw new Error(`Invalid table: ${table}. Valid tables are: ${Object.keys(SUGAR_SWEETENERS_FILES).join(', ')}`)
  const requested = optString(params, 'frequency')
  const startYear = optInt(params, 'start_year')
  const endYear = optInt(params, 'end_year')

  // parse_table
  const data: Rec[] = []
  for (const row of csvDictRows(await fetchErsText(ctx, config[0]))) {
    if (cell(row, 'Table_number') !== config[1]) continue
    const value = pyFloat(cell(row, 'Value'))
    if (value === undefined) continue
    const yearLabel = cell(row, 'Year')
    if (!isDigits(yearLabel.slice(0, 4))) continue
    const record: Rec = {
      year: Number(yearLabel.slice(0, 4)),
      period: cell(row, 'Period') || null,
      period_cat: cell(row, 'Period_cat') || null,
      period_desc: cell(row, 'Period_desc') || null,
      attribute: cell(row, 'Attribute_desc'),
      unit: cell(row, 'Unit'),
      value,
    }
    for (const [source, field] of DIMENSION_FIELDS) record[field] = cell(row, source) || null
    data.push(record)
  }
  if (data.length === 0) return []

  // _resolve_frequency: the table's period categories, quarters before months.
  const available = [...new Set(data.map((r) => r.period_cat as string | null).filter((c): c is string => !!c))].sort((a, b) => frequencyRank(a) - frequencyRank(b) || (a < b ? -1 : a > b ? 1 : 0))
  const frequency = requested !== undefined && available.includes(requested) ? requested : (available[0] ?? null)
  let rows = data.filter((r) => r.period_cat === frequency && (startYear === undefined || (r.year as number) >= startYear) && (endYear === undefined || (r.year as number) <= endYear))
  const vintages = new Set(rows.map((r) => r.forecast_yearmonth as string | null).filter((v): v is string => !!v))
  if (vintages.size > 1) {
    const latest = [...vintages].reduce((a, b) => (b > a ? b : a))
    rows = rows.filter((r) => r.forecast_yearmonth === latest)
  }
  if (rows.length === 0) throw new Error('No records match the given filters.')

  // _pivot
  const foldDims = FOLD_DIM_FIELDS.filter((f) => new Set(rows.map((r) => dimValue(r, f))).size > 1)
  const { columnDims, rowDims } = classifyDimsFull(rows, foldDims, 'attribute')
  const multiUnit = new Set(rows.map((r) => r.unit)).size > 1
  type Wide = { dims: string[]; year: number; period: number; order: number; label: string; values: Map<string, number> }
  const pivoted = new Map<string, Wide>()
  const columnOrder: string[] = []
  const seenColumns = new Set<string>()
  rows.forEach((r, order) => {
    const year = r.year as number
    const within = withinYearLabel(r.period_cat as string | null, r.period_desc as string | null)
    const timeLabel = within ? `${year} ${within}` : String(year)
    const rowValues = rowDims.map((f) => dimValue(r, f)).filter((v): v is string => v !== null)
    const key = JSON.stringify([rowDims.map((f) => dimValue(r, f)), year, r.period])
    let row = pivoted.get(key)
    if (!row) {
      row = { dims: rowValues, year, period: pyInt((r.period as string | null) ?? '') ?? 0, order, label: [...rowValues, timeLabel].join(' — '), values: new Map() }
      pivoted.set(key, row)
    }
    const columnValues = columnDims.map((f) => dimValue(r, f)).filter((v): v is string => v !== null)
    const base = [...columnValues, r.attribute as string].join(' — ')
    const column = multiUnit && r.unit ? `${base} (${r.unit})` : base
    if (!seenColumns.has(column)) {
      seenColumns.add(column)
      columnOrder.push(column)
    }
    row.values.set(column, r.value as number)
  })
  return sortedNested([...pivoted.values()], (w) => [w.dims, -w.year, -w.period, w.order]).map((w) => {
    const out: Row = { period: w.label }
    for (const column of columnOrder) out[column] = w.values.get(column) ?? null
    return nullTokensToNone(out)
  })
}
