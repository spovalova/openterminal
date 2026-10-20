// usda/wheat_data, provider usda. Ported from openbb_government_us/usda/models/wheat_data.py and
// utils/ers_wheat_data.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { cell, csvDictRows, fetchErsFile, isNullToken, optInt, optString, pyFloat, sortedBy, zipText } from './helpers.js'

const DEFAULT_TABLE = 'us_supply_and_disappearance'
const ALL_YEARS_ZIP = '/media/5709/wheat-data-all-years.zip'
const QUARTERLY_ZIP = '/media/5708/wheat-by-class-quarterly.zip'

const CLASS_CANON: Record<string, string> = {
  'all wheat': 'All wheat',
  durum: 'Durum',
  'hard red spring': 'Hard red spring',
  'hard red winter': 'Hard red winter',
  'hard white': 'Hard white',
  'soft red winter': 'Soft red winter',
  'soft white': 'Soft white',
  white: 'White',
  rye: 'Rye',
}

type Dim = 'wheat_class' | 'commodity_group' | 'product' | 'geography' | 'unit'
const ROW_DIM_FIELDS: Dim[] = ['wheat_class', 'commodity_group', 'product', 'geography', 'unit']
/** The order varying dimensions are written into the period label. */
const LABEL_DIM_ORDER: Dim[] = ['commodity_group', 'wheat_class', 'product', 'geography', 'unit']

type TableConfig = {
  media: string
  member: string
  valueCol: string
  yearCol: string
  periodCol: string | null
  seriesCol: string | null
  valueName: string | null
  /** Source column → row dimension. */
  rowDims: [string, Dim][]
}

const all = (member: string, c: Omit<TableConfig, 'media' | 'member' | 'valueCol'>): TableConfig => ({ media: ALL_YEARS_ZIP, member, valueCol: 'Amount', ...c })
const std = { yearCol: 'Marketing_Year', periodCol: 'Timeperiod_Desc', valueName: null }

const WHEAT_DATA_FILES: Record<string, TableConfig> = {
  wheat_acreage_production_yield_price: all('01_Wheat_US_Acreage_Production_Yield_and_Farm_Price.csv', { ...std, seriesCol: 'Attribute_Desc2', rowDims: [['Commodity_Desc2', 'wheat_class']] }),
  rye_acreage_production_yield_price: all('02_Rye_US_Acreage_Production_Yield_and_Farm_Price.csv', { ...std, seriesCol: 'Attribute_Desc2', rowDims: [['Commodity_Desc2', 'wheat_class']] }),
  world_supply_and_disappearance: all('03_04_World_wheat_supply_and_disappearance.csv', { ...std, periodCol: null, seriesCol: 'Attribute_Desc', rowDims: [] }),
  us_supply_and_disappearance: all('05_11_US_Supply_And_Disappearance.csv', { ...std, seriesCol: 'Attribute_Desc', rowDims: [['Commodity_Desc2', 'wheat_class']] }),
  rye_supply_and_disappearance: all('12_Rye_US_Supply_And_Disappearance.csv', { ...std, seriesCol: 'Attribute_Desc', rowDims: [] }),
  food_use: all('13_16_Food_Use.csv', { ...std, seriesCol: 'Commodity_Desc2', rowDims: [['Commodity_Desc', 'commodity_group']] }),
  government_and_private_stocks: all('17_Government_and_private_stocks.csv', { ...std, seriesCol: 'Attribute_Desc', rowDims: [] }),
  domestic_and_international_prices: all('18_20_Domestic_and_international_prices.csv', {
    ...std,
    seriesCol: 'Commodity_Desc',
    rowDims: [
      ['Geography_Desc', 'geography'],
      ['Unit_Desc', 'unit'],
    ],
  }),
  export_import_trade_by_component: all('21_24_Export_and_import_trade_data_by_component.csv', {
    ...std,
    seriesCol: 'Attribute_Desc',
    rowDims: [
      ['Commodity_Desc', 'product'],
      ['Commodity_Desc2', 'commodity_group'],
    ],
  }),
  all_wheat_destination_exports: all('25_All_wheat_destination_export_trade_data.csv', { ...std, seriesCol: null, valueName: 'Exports', rowDims: [['Geography_Desc', 'geography']] }),
  by_class_inspections: all('26_By_class_inspections _data.csv', { ...std, seriesCol: 'Commodity_Desc', rowDims: [['Geography_Desc', 'geography']] }),
  exports_by_government_program: all('27_Exports_by_government_program.csv', { ...std, yearCol: 'Fiscal_Year', seriesCol: 'Attribute_Desc', rowDims: [] }),
  flour_production_and_disappearance: all('28_31_Flour_production_and_disappearance.csv', {
    ...std,
    yearCol: 'Calendar_Year',
    seriesCol: 'Attribute_Desc',
    rowDims: [
      ['Commodity_Desc2', 'product'],
      ['Commodity_Desc', 'commodity_group'],
    ],
  }),
  wheat_flour_price_relationships: all('32_33_Wheat_and_flour_price_relationships.csv', { ...std, seriesCol: 'Commodity_Desc2', rowDims: [['Geography_Desc', 'geography']] }),
  by_class_trade_data: all('34_35_By-class_trade_data.csv', { ...std, seriesCol: 'Attribute_Desc', rowDims: [['Commodity_Desc', 'wheat_class']] }),
  by_class_quarterly: {
    media: QUARTERLY_ZIP,
    member: 'wheat-by-class-quarterly.csv',
    valueCol: 'Value',
    yearCol: 'MarketingYear',
    periodCol: 'TimePeriod',
    seriesCol: 'Attribute',
    valueName: null,
    rowDims: [
      ['Class', 'wheat_class'],
      ['Unit', 'unit'],
    ],
  },
}

type Observation = {
  marketingYear: string
  year: number
  period: string | null
  dims: Record<Dim, string | null>
  series: string
  amount: number
  order: number
}

/** `parse_table`: one table's CSV as long observations; rows with a blank or non-numeric value or year are skipped. */
function parseTable(text: string, config: TableConfig): Omit<Observation, 'order'>[] {
  const out: Omit<Observation, 'order'>[] = []
  for (const row of csvDictRows(text)) {
    const amount = pyFloat(cell(row, config.valueCol))
    if (amount === undefined) continue
    const yearLabel = cell(row, config.yearCol)
    if (!/^\d{4}/.test(yearLabel)) continue
    const dims: Record<Dim, string | null> = { wheat_class: null, commodity_group: null, product: null, geography: null, unit: null }
    for (const [source, field] of config.rowDims) {
      let value = cell(row, source)
      if (field === 'wheat_class') value = CLASS_CANON[value.toLowerCase()] ?? value
      dims[field] = value || null
    }
    out.push({
      marketingYear: yearLabel,
      year: Number(yearLabel.slice(0, 4)),
      period: config.periodCol ? cell(row, config.periodCol) || null : null,
      dims,
      series: config.seriesCol ? cell(row, config.seriesCol) : (config.valueName ?? ''),
      amount,
    })
  }
  return out
}

export async function wheatData(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const table = optString(params, 'table') ?? DEFAULT_TABLE
  const config = WHEAT_DATA_FILES[table]
  if (!config) throw new Error(`Invalid table: ${table}. Valid tables are: ${Object.keys(WHEAT_DATA_FILES).join(', ')}`)
  const startYear = optInt(params, 'start_year')
  const endYear = optInt(params, 'end_year')

  const text = zipText(await fetchErsFile(ctx, config.media), config.member)
  const records = parseTable(text, config)
    .map((r, order) => ({ ...r, order }))
    .filter((r) => (startYear === undefined || r.year >= startYear) && (endYear === undefined || r.year <= endYear))
    .map((r) => ({ ...r, dims: Object.fromEntries(ROW_DIM_FIELDS.map((f) => [f, isNullToken(r.dims[f]) ? null : r.dims[f]])) as Record<Dim, string | null> }))
  if (records.length === 0) return []

  // Dimensions with more than one value are written into the period label; a single unit becomes the columns' suffix.
  const distinct = Object.fromEntries(ROW_DIM_FIELDS.map((f) => [f, new Set(records.map((r) => r.dims[f]).filter((v): v is string => v !== null))])) as Record<Dim, Set<string>>
  const varying = new Set(ROW_DIM_FIELDS.filter((f) => distinct[f].size > 1))
  const tableUnit = !varying.has('unit') && distinct.unit.size === 1 ? [...distinct.unit][0]! : null

  type Wide = { sort: string[]; year: number; order: number; period: string; values: Map<string, number> }
  const pivoted = new Map<string, Wide>()
  const colOrder: string[] = []
  const seenCols = new Set<string>()
  for (const r of records) {
    const key = JSON.stringify([r.marketingYear, r.period, ...ROW_DIM_FIELDS.map((f) => r.dims[f])])
    let row = pivoted.get(key)
    if (!row) {
      const dimParts = LABEL_DIM_ORDER.filter((f) => varying.has(f) && r.dims[f] !== null).map((f) => r.dims[f]!)
      const timeLabel = r.period ? `${r.marketingYear} ${r.period}` : r.marketingYear
      row = { sort: LABEL_DIM_ORDER.map((f) => r.dims[f] ?? ''), year: r.year, order: r.order, period: [...dimParts, timeLabel].join(' — '), values: new Map() }
      pivoted.set(key, row)
    }
    const column = tableUnit && !r.series.includes(`(${tableUnit})`) ? `${r.series} (${tableUnit})` : r.series
    if (!seenCols.has(column)) {
      seenCols.add(column)
      colOrder.push(column)
    }
    row.values.set(column, (row.values.get(column) ?? 0) + r.amount)
  }
  return sortedBy([...pivoted.values()], (r) => [...r.sort, r.year, r.order]).map((r) => {
    const out: Row = { period: r.period }
    for (const column of colOrder) out[column] = r.values.get(column) ?? null
    return out
  })
}
