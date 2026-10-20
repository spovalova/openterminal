// usda/food_at_home_monthly_area_prices, provider usda. Ported from openbb_government_us/usda/models/food_at_home_monthly_area_prices.py
// and utils/ers_food_at_home_monthly_area_prices.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of
// pydantic models, and the 53 MB long file is scanned line by line instead of being parsed whole (the file has no
// multi-line fields).
import { parseCsv } from '../lib/csv.js'
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { decodeText, fetchErsFile, nullTokensToNone, optInt, optString, pyFloat, pyInt, zipMember } from './helpers.js'

const DEFAULT_TABLE = 'monthly_area_prices'
const DEFAULT_GROUP = 'Dairy'
const DEFAULT_ITEM = '40000'
const DEFAULT_MEASURE = 'unit_value_mean_wtd'

const FMAP_TABLES: Record<string, { media: string; member: string }> = {
  monthly_area_prices: { media: '/media/5400/food-at-home-monthly-area-prices-2012-to-2018.zip', member: 'FMAP-Data.csv' },
  supplemental_price_indexes: { media: '/media/5402/food-at-home-monthly-area-prices-supplemental-price-indexes-2016-to-2018.zip', member: 'FMAP-SupIndex-Data.csv' },
}
const DEFAULT_MEASURE_BY_TABLE: Record<string, string> = { monthly_area_prices: 'unit_value_mean_wtd', supplemental_price_indexes: 'price_index_geks' }

/** Metro or region code → OpenBB field. */
const AREAS: Record<string, string> = {
  '0': 'national',
  '1': 'northeast',
  '2': 'midwest',
  '3': 'south',
  '4': 'west',
  '12060': 'atlanta',
  '14460': 'boston',
  '16980': 'chicago',
  '19100': 'dallas',
  '19820': 'detroit',
  '26420': 'houston',
  '31080': 'los_angeles',
  '33100': 'miami',
  '35620': 'new_york',
  '37980': 'philadelphia',
}
const AREA_FIELDS = Object.values(AREAS)

const BOTH = ['monthly_area_prices', 'supplemental_price_indexes']
const MEASURES: Record<string, { source: string; tables: string[] }> = {
  unit_value_mean_wtd: { source: 'Unit_value_mean_wtd', tables: ['monthly_area_prices'] },
  unit_value_mean_unwtd: { source: 'Unit_value_mean_unwtd', tables: ['monthly_area_prices'] },
  unit_value_se_wtd: { source: 'Unit_value_se_wtd', tables: ['monthly_area_prices'] },
  price_index_geks: { source: 'Price_index_GEKS', tables: BOTH },
  purchase_dollars_wtd: { source: 'Purchase_dollars_wtd', tables: BOTH },
  purchase_dollars_unwtd: { source: 'Purchase_dollars_unwtd', tables: BOTH },
  purchase_grams_wtd: { source: 'Purchase_grams_wtd', tables: BOTH },
  purchase_grams_unwtd: { source: 'Purchase_grams_unwtd', tables: BOTH },
  number_stores: { source: 'Number_stores', tables: BOTH },
  price_index_laspeyres: { source: 'Price_index_Laspeyres', tables: ['supplemental_price_indexes'] },
  price_index_paasche: { source: 'Price_index_Paasche', tables: ['supplemental_price_indexes'] },
  price_index_tornqvist: { source: 'Price_index_Tornqvist', tables: ['supplemental_price_indexes'] },
  price_index_fisher_ideal: { source: 'Price_index_Fisher_Ideal', tables: ['supplemental_price_indexes'] },
  price_index_ccd: { source: 'Price_index_CCD', tables: ['supplemental_price_indexes'] },
}

const GROUPS = ['Grains', 'Vegetables', 'Fruit', 'Dairy', 'Meat and Protein Foods', 'Prepared meals, sides, and salads', 'Other foods']

/** The EFPG food-group codes (only the codes are validated; the group parameter is accepted but selects nothing). */
const EFPG = [
  '10000', '10025', '10050', '10075', '15000', '15025', '15050', '15075', '20000', '20075', '21500', '21525', '21550', '21575', '23000', '23075', '24500', '24525', '24550', '24575',
  '26000', '26525', '26550', '26575', '27500', '27550', '27575', '29000', '29025', '29050', '29075', '30000', '30025', '30050', '30075', '30090', '35000', '35050', '35075',
  '40000', '40030', '40060', '43000', '43030', '43060', '46000', '46050', '50000', '50050', '50075', '51500', '51550', '51575', '53000', '53050', '53075', '54500', '54550', '56000', '57500', '59000',
  '60000', '62500', '65000', '67500', '70000', '70050', '71000', '71050', '72000', '72010', '72020', '72030', '72040', '72050', '72060', '73000', '73010', '73020', '73030', '73040', '73050', '73060',
  '74000', '74050', '75000', '75050', '76000', '77000', '78000',
]

/** One CSV line into fields (quoted fields with doubled quotes; no multi-line fields in this file). */
function splitLine(line: string): string[] {
  const out: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += ch
    } else if (ch === '"' && field === '') quoted = true
    else if (ch === ',') {
      out.push(field)
      field = ''
    } else field += ch
  }
  out.push(field)
  return out
}

type Observation = { year: number; month: number; areaCode: string; value: number }

/** `parse_series`: the rows of one food group and one attribute. */
function parseSeries(text: string, item: string, measureSource: string): Observation[] {
  const lines = text.split('\n')
  const [header] = parseCsv(lines[0] ?? '')
  if (!header) throw new Error('StopIteration')
  const idx = new Map(header.map((name, position) => [name, position]))
  const col = (name: string): number => {
    const at = idx.get(name)
    if (at === undefined) throw new Error(`KeyError: '${name}'`)
    return at
  }
  const yearI = col('Year')
  const monthI = col('Month')
  const efpgI = col('EFPG_code')
  const areaI = col('Metroregion_code')
  const attributeI = col('Attribute')
  const valueI = col('Value')
  const records: Observation[] = []
  for (let n = 1; n < lines.length; n++) {
    let line = lines[n]!
    if (!line.includes(item)) continue
    if (line.endsWith('\r')) line = line.slice(0, -1)
    const row = splitLine(line)
    if (row[efpgI] !== item || row[attributeI] !== measureSource) continue
    const year = pyInt(row[yearI] ?? '')
    const month = pyInt(row[monthI] ?? '')
    const value = pyFloat(row[valueI] ?? '')
    if (year === undefined || month === undefined || value === undefined) throw new Error(`invalid number in row ${n}: ${line}`)
    records.push({ year, month, areaCode: row[areaI]!, value })
  }
  return records
}

export async function foodAtHomeMonthlyAreaPrices(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const table = optString(params, 'table') ?? DEFAULT_TABLE
  const config = FMAP_TABLES[table]
  if (!config) throw new Error(`Invalid table: ${table}. Valid tables are: ${Object.keys(FMAP_TABLES).join(', ')}`)
  const group = optString(params, 'group') ?? DEFAULT_GROUP
  if (!GROUPS.includes(group)) throw new Error(`Invalid group: ${group}. Valid groups are: ${GROUPS.join(', ')}`)
  const item = optString(params, 'item') ?? DEFAULT_ITEM
  if (!EFPG.includes(item)) throw new Error(`Invalid item: ${item}. Valid items are EFPG codes: ${EFPG.join(', ')}`)
  const requested = optString(params, 'measure') ?? DEFAULT_MEASURE
  if (!(requested in MEASURES)) throw new Error(`Invalid measure: ${requested}. Valid measures are: ${Object.keys(MEASURES).join(', ')}`)
  const startYear = optInt(params, 'start_year')
  const endYear = optInt(params, 'end_year')

  // A measure the table does not carry falls back to the table's default.
  const measure = MEASURES[requested]!.tables.includes(table) ? requested : DEFAULT_MEASURE_BY_TABLE[table]!
  const text = decodeText(zipMember(await fetchErsFile(ctx, config.media), config.member))
  const data = parseSeries(text, item, MEASURES[measure]!.source)

  const pivoted = new Map<number, { year: number; month: number; row: Row }>()
  for (const r of data) {
    if (startYear !== undefined && r.year < startYear) continue
    if (endYear !== undefined && r.year > endYear) continue
    const key = r.year * 100 + r.month
    let wide = pivoted.get(key)
    if (!wide) {
      if (r.month < 1 || r.month > 12) throw new Error('month must be in 1..12')
      const row: Row = { date: `${String(r.year).padStart(4, '0')}-${String(r.month).padStart(2, '0')}-01` }
      for (const field of AREA_FIELDS) row[field] = null
      wide = { year: r.year, month: r.month, row }
      pivoted.set(key, wide)
    }
    const area = AREAS[r.areaCode]
    if (area !== undefined) wide.row[area] = r.value
  }
  return [...pivoted.values()].sort((a, b) => a.year - b.year || a.month - b.month).map((w) => nullTokensToNone(w.row))
}
