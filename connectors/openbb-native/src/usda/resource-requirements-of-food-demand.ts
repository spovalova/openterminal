// usda/resource_requirements_of_food_demand, provider usda. Ported from openbb_government_us/usda/models/resource_requirements_of_food_demand.py
// and utils/ers_resource_requirements_of_food_demand.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows
// instead of pydantic models.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { csvDictRows, fetchErsFile, nullTokensToNone, optInt, optString, pyFloat, pyInt, sortedBy, zipText } from './helpers.js'

const MEDIA_PATH = '/media/7066/resource-requirements-of-food-demand.zip'
const CSV_MEMBER = 'resource-requirements-food-demand-data.csv'
const DEFAULT_TABLE = 'Xf0000'

/** Table number → what it covers; only the keys are validated. */
const TABLES = [
  'Xf0000', 'Xf1000', 'Xf1100', 'Xf1101', 'Xf1102', 'Xf1103', 'Xf1104', 'Xf1105', 'Xf1106', 'Xf1107', 'Xf1108', 'Xf1109', 'Xf1110', 'Xf1111', 'Xf1112', 'Xf1113', 'Xf1114', 'Xf1115',
  'Xf1116', 'Xf1117', 'Xf1118', 'Xf1119', 'Xf1120', 'Xf1121', 'Xf1122', 'Xf1123', 'Xf1124', 'Xf1125', 'Xf1126', 'Xf1127', 'Xf1128', 'Xf1200', 'Xf1201', 'Xf1202', 'Xf1203', 'Xf1204',
  'Xf1205', 'Xf1206', 'Xf1207', 'Xf2000', 'Xf2100', 'Xf2101', 'Xf2102', 'Xf2103', 'Xf2200', 'Xf2201', 'Xf2202', 'Xf2203', 'Xf3000',
]

const ENERGY_SOURCE_COLUMNS: Record<string, string> = {
  TOTAL: 'energy_total',
  PA: 'energy_pa',
  NG: 'energy_ng',
  ES: 'energy_es',
  CL: 'energy_cl',
  LO: 'energy_lo',
  BF: 'energy_bf',
  WW: 'energy_ww',
  WD: 'energy_wd',
  HY: 'energy_hy',
  GE: 'energy_ge',
  SO: 'energy_so',
  WY: 'energy_wy',
  CC: 'energy_cc',
  SF: 'energy_sf',
}

/** `measure_column`: the value column a resource row feeds, or undefined for rows that are not measures. */
function measureColumn(resource: string, sourceCode: string): string | undefined {
  const name = resource.trim()
  const code = sourceCode.trim().toUpperCase()
  if (name === 'Employment') return 'employment'
  if (name === 'Water') return 'water'
  if (name === 'Energy') return Object.hasOwn(ENERGY_SOURCE_COLUMNS, code) ? ENERGY_SOURCE_COLUMNS[code] : undefined
  return undefined
}

export async function resourceRequirementsOfFoodDemand(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const table = optString(params, 'table') ?? DEFAULT_TABLE
  if (!TABLES.includes(table)) throw new Error(`Invalid table: ${table}. Valid tables are: ${TABLES.join(', ')}`)
  const startYear = optInt(params, 'start_year')
  const endYear = optInt(params, 'end_year')

  type Record_ = { year: number; stage: string | null; stageOrd: number; column: string; value: number }
  const records: Record_[] = []
  for (const row of csvDictRows(zipText(await fetchErsFile(ctx, MEDIA_PATH), CSV_MEMBER))) {
    if ((row.TableNumber ?? '').trim() !== table) continue
    const column = measureColumn(row.Resource ?? '', row.SourceCode ?? '')
    if (column === undefined) continue
    const value = pyFloat((row.Data ?? '').trim())
    if (value === undefined) continue
    const yearRaw = (row.Year ?? '').trim()
    if (!/^\d{4}$/.test(yearRaw)) continue
    records.push({ year: Number(yearRaw), stage: (row.SupplyChainStageDescription ?? '').trim() || null, stageOrd: pyInt((row.SupplyChainStageNumber ?? '').trim()) ?? 0, column, value })
  }

  // One wide row per (year, stage), in order of first appearance before sorting.
  type Wide = { order: number; year: number; stageOrd: number; row: Row }
  const pivoted = new Map<string, Wide>()
  records.forEach((r, order) => {
    if (startYear !== undefined && r.year < startYear) return
    if (endYear !== undefined && r.year > endYear) return
    const key = JSON.stringify([r.year, r.stageOrd, r.stage])
    let wide = pivoted.get(key)
    if (!wide) {
      wide = { order, year: r.year, stageOrd: r.stageOrd, row: { year: r.year, stage: r.stage } }
      pivoted.set(key, wide)
    }
    wide.row[r.column] = r.value
  })
  return sortedBy([...pivoted.values()], (w) => [w.year, w.stageOrd, w.order]).map((w) => nullTokensToNone(w.row))
}
