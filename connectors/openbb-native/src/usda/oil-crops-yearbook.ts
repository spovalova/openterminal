// usda/oil_crops_yearbook, provider usda. Ported from openbb_government_us/usda/models/oil_crops_yearbook.py and
// utils/ers_oil_crops_yearbook.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { cell, csvDictRows, fetchErsText, isNullToken, nullTokensToNone, optInt, optString, pyFloat } from './helpers.js'
import { classifyDimsSimple, dimValue, isDigits, sortedNested, type Rec } from './helpers-a.js'

const OILCROPS_CSV = '/media/5218/all-tables-oil-crops-yearbook.csv'
const DEFAULT_TABLE = 'soybeans_supply_disappearance_price'

/** Table → [Table_number, Attribute_Desc filter, series column, commodity column, geography column]. */
const OIL_CROPS_TABLES: Record<string, [string, string | null, string, string | null, string | null]> = {
  soybean_stocks_quarterly: ['1', null, 'Attribute_Desc', null, null],
  soybeans_acreage_production_yield_value: ['2', null, 'Attribute_Desc', null, null],
  soybeans_supply_disappearance_price: ['3', null, 'Attribute_Desc', null, null],
  soybean_meal_supply_disappearance_price: ['4', null, 'Attribute_Desc', null, null],
  soybean_oil_supply_disappearance_price: ['5', null, 'Attribute_Desc', null, null],
  soybeans_supply_disappearance_by_quarter: ['6', null, 'Attribute_Desc', null, null],
  soybean_meal_supply_disappearance_by_month: ['7', null, 'Attribute_Desc', null, null],
  soybean_oil_supply_disappearance_by_month: ['8', null, 'Attribute_Desc', null, null],
  soybean_crush_value_price_spread: ['9', null, 'Attribute_Desc2', null, null],
  peanuts_acreage_production_yield_value: ['10', null, 'Attribute_Desc', null, null],
  peanuts_supply_disappearance_price: ['11', null, 'Attribute_Desc', null, null],
  peanuts_food_use: ['12', null, 'Attribute_Desc', null, null],
  peanuts_planted_acreage_by_state: ['13', null, 'Geography_Desc2', null, null],
  peanuts_harvested_acreage_by_state: ['14', null, 'Geography_Desc2', null, null],
  peanuts_production_by_state: ['15', null, 'Geography_Desc2', null, null],
  peanuts_yield_by_state: ['16', null, 'Geography_Desc2', null, null],
  cottonseed_acreage_production_yield_value: ['17', null, 'Attribute_Desc', null, null],
  cottonseed_supply_disappearance_price: ['18', null, 'Attribute_Desc', null, null],
  cottonseed_meal_supply_disappearance_price: ['19', null, 'Attribute_Desc', null, null],
  cottonseed_oil_supply_disappearance_price: ['20', null, 'Attribute_Desc', null, null],
  sunflowerseed_acreage_production_yield_value: ['21', null, 'Attribute_Desc', 'Commodity_Desc2', null],
  sunflowerseed_supply_disappearance_price: ['22', null, 'Attribute_Desc', null, null],
  sunflowerseed_meal_supply_disappearance_price: ['23', null, 'Attribute_Desc', null, null],
  sunflowerseed_oil_supply_disappearance_price: ['24', null, 'Attribute_Desc', null, null],
  canola_seed_supply_disappearance_price: ['25', null, 'Attribute_Desc', null, null],
  canola_oil_supply_disappearance_price: ['26', null, 'Attribute_Desc', null, null],
  canola_meal_supply_disappearance_price: ['27', null, 'Attribute_Desc', null, null],
  flaxseed_acreage_production_yield_value: ['28', null, 'Attribute_Desc', null, null],
  flaxseed_supply_disappearance_price: ['29', null, 'Attribute_Desc', null, null],
  linseed_meal_supply_disappearance_price: ['30', null, 'Attribute_Desc', null, null],
  linseed_oil_supply_disappearance_price: ['31', null, 'Attribute_Desc', null, null],
  edible_fats_and_oils_supply_disappearance: ['32', null, 'Attribute_Desc', 'Commodity_Desc2', null],
  corn_oil_supply_disappearance_price: ['33', null, 'Attribute_Desc', null, null],
  prices_received_by_farmers: ['34', 'Received by U.S. farmers', 'Attribute_Desc2', null, null],
  prices_terminal_markets: ['34', 'Cash prices at terminal markets', 'Attribute_Desc2', null, null],
  prices_oilmeals: ['34', 'Meal prices', 'Attribute_Desc2', null, null],
  prices_fats_and_oils_wholesale: ['34', 'Wholesale prices', 'Attribute_Desc2', null, null],
  prices_producer_price_indexes: ['34', 'Bureau of Labor Statistics Producer Price Indexes', 'Attribute_Desc2', null, null],
  lard_supply_disappearance_price: ['35', null, 'Attribute_Desc', null, null],
  edible_tallow_supply_disappearance_price: ['36', null, 'Attribute_Desc', null, null],
  world_soybean_complex_supply_and_use: ['37', null, 'Attribute_Desc', 'Commodity_Desc2', 'Geography_Desc2'],
  soybean_exports_by_destination: ['38', null, 'Geography_Desc2', null, null],
  soybean_meal_exports_by_destination: ['39', null, 'Geography_Desc2', null, null],
  soybean_oil_exports_by_destination: ['40', null, 'Geography_Desc2', null, null],
  world_oilseed_supply_and_distribution: ['41', null, 'Attribute_Desc', 'Commodity_Desc2', null],
  world_vegetable_oils_supply_and_distribution: ['42', null, 'Attribute_Desc', 'Commodity_Desc2', null],
  world_protein_meal_supply_and_distribution: ['43', null, 'Attribute_Desc', 'Commodity_Desc2', null],
}

const MONTH_NUMBERS: Record<string, number> = { January: 1, February: 2, March: 3, April: 4, May: 5, June: 6, July: 7, August: 8, September: 9, October: 10, November: 11, December: 12 }
const QUARTER_ORDER = ['Sep.–Nov.', 'Dec.–Feb.', 'Mar.–May', 'June–Aug.']
const POINT_IN_TIME_ORDER = ['September 1', 'December 1', 'March 1', 'June 1']
const FREQUENCY_ORDER = ['point_in_time', 'annual', 'quarterly', 'monthly']
const POINT_IN_TIME_TABLES = new Set(['soybean_stocks_quarterly'])
const QUARTERLY_MONTHLY_ANNUAL_TABLES = new Set(['soybeans_supply_disappearance_by_quarter'])
const MONTHLY_ANNUAL_TABLES = new Set(['soybean_meal_supply_disappearance_by_month', 'soybean_oil_supply_disappearance_by_month', 'soybean_crush_value_price_spread'])
const MONTHLY_ONLY_TABLES = new Set(['prices_received_by_farmers', 'prices_terminal_markets', 'prices_oilmeals', 'prices_fats_and_oils_wholesale', 'prices_producer_price_indexes'])

const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)

/** The frequencies a table publishes, in fixed order. */
function tableFrequencies(table: string): string[] {
  const present = POINT_IN_TIME_TABLES.has(table)
    ? ['point_in_time']
    : QUARTERLY_MONTHLY_ANNUAL_TABLES.has(table)
      ? ['annual', 'quarterly', 'monthly']
      : MONTHLY_ANNUAL_TABLES.has(table)
        ? ['annual', 'monthly']
        : MONTHLY_ONLY_TABLES.has(table)
          ? ['monthly']
          : ['annual']
  return FREQUENCY_ORDER.filter((f) => present.includes(f))
}

/** The finest frequency that stays dense. */
function defaultFrequency(table: string): string {
  const freqs = tableFrequencies(table)
  return ['point_in_time', 'quarterly', 'monthly'].find((c) => freqs.includes(c)) ?? 'annual'
}

/** `coerce_period`: 'MY Total' and blanks are whole-year totals (no period). */
function coercePeriod(raw: string): string | null {
  return raw === '' || raw === 'MY Total' ? null : raw
}

/** `frequency_of`: classify a Timeperiod_Desc token. */
function frequencyOf(raw: string): string {
  if (raw === '' || raw === 'MY Total') return 'annual'
  if (raw.includes('–') || raw.includes('-')) return 'quarterly'
  const parts = raw.split(/\s+/)
  if (parts.length === 2 && has(MONTH_NUMBERS, parts[0]!) && isDigits(parts[1]!)) return 'point_in_time'
  if (has(MONTH_NUMBERS, raw)) return 'monthly'
  return 'annual'
}

/** First calendar month of a marketing-year definition such as 'October–September'. */
function startMonth(definition: string | null): number {
  const text = (definition ?? '').trim()
  for (const sep of ['–', '-']) {
    if (text.includes(sep)) return MONTH_NUMBERS[text.split(sep)[0]!.trim()] ?? 1
  }
  return MONTH_NUMBERS[text] ?? 1
}

function formatPeriod(period: string, frequency: string): string {
  if (frequency !== 'quarterly') return period
  const cleaned = period.replace(/\./g, '').replace(/–/g, '-')
  const rank = Math.max(QUARTER_ORDER.indexOf(period), 0)
  return `${cleaned} (Q${rank + 1})`
}

/** Within-year rank of a period token. */
function periodOrdinal(period: string | null, frequency: string, definition: string | null): number {
  if (period === null) return 0
  if (frequency === 'point_in_time') return Math.max(POINT_IN_TIME_ORDER.indexOf(period), 0)
  if (frequency === 'quarterly') return Math.max(QUARTER_ORDER.indexOf(period), 0)
  if (frequency === 'monthly' && has(MONTH_NUMBERS, period)) return (((MONTH_NUMBERS[period]! - startMonth(definition)) % 12) + 12) % 12
  return 0
}

export async function oilCropsYearbook(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const table = optString(params, 'table') ?? DEFAULT_TABLE
  if (!has(OIL_CROPS_TABLES, table)) throw new Error(`Invalid table: ${table}. Valid tables are: ${Object.keys(OIL_CROPS_TABLES).join(', ')}`)
  const requested = optString(params, 'frequency')?.toLowerCase()
  if (requested !== undefined && !FREQUENCY_ORDER.includes(requested)) throw new Error(`Invalid frequency: ${requested}. Valid frequencies are: ${FREQUENCY_ORDER.join(', ')}`)
  const startYear = optInt(params, 'start_year')
  const endYear = optInt(params, 'end_year')
  const frequency = requested !== undefined && tableFrequencies(table).includes(requested) ? requested : defaultFrequency(table)

  // parse_rows: the all-tables CSV filtered to this table, one record per numeric Amount.
  const [tableNumber, attributeFilter, seriesCol, commodityCol, geographyCol] = OIL_CROPS_TABLES[table]!
  const records: Rec[] = []
  for (const row of csvDictRows(await fetchErsText(ctx, OILCROPS_CSV))) {
    if (row.Table_number !== tableNumber) continue
    if (attributeFilter !== null && row.Attribute_Desc !== attributeFilter) continue
    const amountText = cell(row, 'Amount')
    if (amountText === '' || isNullToken(amountText)) continue
    const amount = pyFloat(amountText.replace(/,/g, ''))
    if (amount === undefined) continue
    const marketingYear = cell(row, 'Marketing_Year')
    if (!isDigits(marketingYear.slice(0, 4))) continue
    const timeperiod = (row.Timeperiod_Desc ?? '').trim()
    records.push({
      marketing_year: marketingYear,
      year: Number(marketingYear.slice(0, 4)),
      period: coercePeriod(timeperiod),
      frequency: frequencyOf(timeperiod),
      my_definition: cell(row, 'MY_Definition') || null,
      commodity: commodityCol ? cell(row, commodityCol) || null : null,
      geography: geographyCol ? cell(row, geographyCol) || null : null,
      unit_desc: cell(row, 'Unit_Desc') || null,
      series: cell(row, seriesCol),
      amount,
    })
  }

  // transform_data: one frequency, one year window, then pivot.
  const rows = records.filter((r) => r.frequency === frequency && (startYear === undefined || (r.year as number) >= startYear) && (endYear === undefined || (r.year as number) <= endYear))
  if (records.length === 0) return []
  if (rows.length === 0) throw new Error('No records match the given filters.')

  const foldDims = ['commodity', 'geography'].filter((f) => new Set(rows.map((r) => dimValue(r, f))).size > 1)
  const { columnDims, rowDims } = classifyDimsSimple(rows, foldDims, 'series')
  const multiUnit = new Set(rows.map((r) => r.unit_desc)).size > 1
  type Wide = { dims: string[]; year: number; ord: number; order: number; period: string; values: Map<string, number> }
  const pivoted = new Map<string, Wide>()
  const columnOrder: string[] = []
  const seenColumns = new Set<string>()
  rows.forEach((r, order) => {
    const marketingYear = r.marketing_year as string
    const period = r.period as string | null
    const timeLabel = period ? `${marketingYear} ${formatPeriod(period, frequency)}` : marketingYear
    const dimValues = rowDims.map((f) => dimValue(r, f)).filter((v): v is string => v !== null)
    const key = JSON.stringify([rowDims.map((f) => dimValue(r, f)), marketingYear, period])
    let row = pivoted.get(key)
    if (!row) {
      row = { dims: dimValues, year: r.year as number, ord: periodOrdinal(period, frequency, r.my_definition as string | null), order, period: [...dimValues, timeLabel].join(' — '), values: new Map() }
      pivoted.set(key, row)
    }
    const columnValues = columnDims.map((f) => dimValue(r, f)).filter((v): v is string => v !== null)
    const base = [...columnValues, r.series as string].join(' — ')
    const column = multiUnit && r.unit_desc ? `${base} (${r.unit_desc})` : base
    if (!seenColumns.has(column)) {
      seenColumns.add(column)
      columnOrder.push(column)
    }
    row.values.set(column, r.amount as number)
  })
  return sortedNested([...pivoted.values()], (w) => [w.dims, -w.year, -w.ord, w.order]).map((w) => {
    const out: Row = { period: w.period }
    for (const column of columnOrder) out[column] = w.values.get(column) ?? null
    return nullTokensToNone(out)
  })
}
