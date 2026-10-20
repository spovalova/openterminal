// usda/vegetables_and_pulses, provider usda. Ported from openbb_government_us/usda/models/vegetables_and_pulses.py and
// utils/ers_vegetables_and_pulses.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models,
// and the CSV is found in the archive by its extension, because ERS renamed it from Vegetables_Pulses.csv to
// vegetables-pulses-data.csv, which makes OpenBB's lookup of the old name fail with a KeyError.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { cell, csvDictRows, decodeText, fetchErsFile, nullTokensToNone, optInt, optString, pyFloat, readZip, sortedBy } from './helpers.js'
import { isDigits } from './helpers-a.js'

const DATA_ZIP = '/media/5018/vegetables-and-pulses-machine-readable-data.zip'
const CSV_MEMBER = 'Vegetables_Pulses.csv'
const DEFAULT_TABLE = 'Table33_Potatoes'

const TABLES = new Set([
  'Table09_WorldVegProduction', 'Table10_CashReceipts', 'Table11_TotalFresh', 'Table12_Artichokes', 'Table13_Asparagus', 'Table14_Broccoli', 'Table15_BrusselsSprouts', 'Table16_Cabbage', 'Table17_Carrots', 'Table18_Cauliflower',
  'Table19_Celery', 'Table20_CollardGreens', 'Table21_Cucumbers', 'Table22_Eggplant', 'Table23_EscaroleandEndive', 'Table24_Garlic', 'Table25_HeadLettuce', 'Table26_LeafandRomaine', 'Table27_Kale', 'Table28_Mushrooms',
  'Table29_MustardGreens', 'Table30_Okra', 'Table31_Onions', 'Table32_PeppersBell', 'Table33_Potatoes', 'Table34_Pumpkins', 'Table35_Radishes', 'Table36_SnapBeans', 'Table37_Spinach', 'Table38_Squash',
  'Table39_SweetCorn', 'Table40_SweetPotatoes', 'Table41_Tomatoes', 'Table42_TurnipGreens', 'Table43_TotalVeg_Pr', 'Table44a_Asparagus_Pr', 'Table44b_Asparagus_Cn', 'Table44c_Asparagus_Fz', 'Table45_Broccoli_Pr', 'Table46_Cabbage_Pr',
  'Table47a_Carrots_Pr', 'Table47b_Carrots_Fz', 'Table47c_Carrots_Cn', 'Table48_Cauliflower_Pr', 'Table49_Cucumbers_Pr', 'Table50a_GreenLimaBeans_Pr', 'Table50b_GreenLimaBeans_Cn', 'Table50c_GreenLimaBeans_Fz', 'Table51_Mushrooms_Pr', 'Table52_Onions_Dehy',
  'Table53a_GreenPeas_Pr', 'Table53b_GreenPeas_Cn', 'Table53c_GreenPeas_Fz', 'Table54_ChiliPeppers_Pr', 'Table55a_Potatoes_Cn', 'Table55b_Potatoes_Chip', 'Table55c_Potatoes_Dehy', 'Table55d_Potatoes_Fz', 'Table56a_SnapBeans_Pr', 'Table56b_SnapBeans_Cn',
  'Table56c_SnapBeans_Fz', 'Table57a_Spinach_Pr', 'Table57b_Spinach_Cn', 'Table57c_Spinach_Fz', 'Table58a_SweetCorn_Pr', 'Table58b_SweetCorn_Cn', 'Table58c_SweetCorn_Fz', 'Table59_Tomatoes_Pr', 'Table60_AllDryBeans', 'Table61_Pinto',
  'Table62_Navy', 'Table63_GreatNorthern', 'Table64_Black', 'Table65_Lima', 'Table66_RedKidney', 'Table67_Blackeye', 'Table68_Garbanzo', 'Table69_SmallWhite', 'Table70_SmallRed', 'Table71_Pink', 'Table72_Other',
])

export async function vegetablesAndPulses(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const table = optString(params, 'table') ?? DEFAULT_TABLE
  if (!TABLES.has(table)) throw new Error(`Invalid table: ${table}. Valid tables are: ${[...TABLES].join(', ')}`)
  const startYear = optInt(params, 'start_year')
  const endYear = optInt(params, 'end_year')

  type Wide = { commodity: string | null; location: string | null; end_use: string | null; geographical_level: string | null; year: number; values: Map<string, number> }
  const pivoted = new Map<string, Wide>()
  const itemOrder: string[] = []
  const seenItems = new Set<string>()
  const members = readZip(await fetchErsFile(ctx, DATA_ZIP))
  const member = members[CSV_MEMBER] ?? Object.entries(members).find(([name]) => name.toLowerCase().endsWith('.csv'))?.[1]
  if (!member) throw new Error(`There is no item named '${CSV_MEMBER}' in the archive`)
  for (const row of csvDictRows(decodeText(member))) {
    // parse_rows
    if (cell(row, 'Table') !== table) continue
    const value = pyFloat(cell(row, 'PublishValue'))
    if (value === undefined) continue
    const yearLabel = cell(row, 'Year')
    if (!isDigits(yearLabel.slice(0, 4))) continue
    const year = Number(yearLabel.slice(0, 4))
    // transform_data: the year window, then one wide row per (commodity, end use, location, year).
    if ((startYear !== undefined && year < startYear) || (endYear !== undefined && year > endYear)) continue
    const item = cell(row, 'Item')
    if (!seenItems.has(item)) {
      seenItems.add(item)
      itemOrder.push(item)
    }
    const commodity = cell(row, 'Commodity') || null
    const endUse = cell(row, 'EndUse') || null
    const location = cell(row, 'Location') || null
    const key = JSON.stringify([commodity, endUse, location, year])
    let wide = pivoted.get(key)
    if (!wide) {
      wide = { commodity, location, end_use: endUse, geographical_level: cell(row, 'GeographicalLevel') || null, year, values: new Map() }
      pivoted.set(key, wide)
    }
    wide.values.set(item, value)
  }
  if (pivoted.size === 0) throw new Error('No records match the given filters.')

  return sortedBy([...pivoted.values()], (w) => [w.commodity ?? '', w.location ?? '', w.end_use ?? '', w.year]).map((w) => {
    const out: Row = { year: w.year, commodity: w.commodity, location: w.location, end_use: w.end_use, geographical_level: w.geographical_level }
    for (const item of itemOrder) if (w.values.has(item)) out[item] = w.values.get(item)
    return nullTokensToNone(out)
  })
}
