// usda/purchase_to_plate, provider usda. Ported from openbb_government_us/usda/models/purchase_to_plate.py and
// utils/ers_purchase_to_plate.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { csvDictRows, fetchErsFile, nullTokensToNone, optString, pyFloat, sortedBy, zipText } from './helpers.js'

const MEDIA = '/media/6557/purchase-to-plate-national-average-prices-for-nhanes-csv-format.zip'
const MEMBER = 'pp_national_average_prices_csv.csv'

/** Survey year → cycle field, oldest first. */
const CYCLE_BY_YEAR: Record<string, string> = {
  '2011/2012': 'cycle_2011_2012',
  '2013/2014': 'cycle_2013_2014',
  '2015/2016': 'cycle_2015_2016',
  '2017/2018': 'cycle_2017_2018',
}
const CYCLE_ORDER = Object.values(CYCLE_BY_YEAR)

/** Food group → leading digit of the FNDDS food code. */
const FOOD_GROUPS: Record<string, string> = { milk: '1', meat: '2', eggs: '3', legumes: '4', grains: '5', fruits: '6', vegetables: '7', fats: '8', sugars: '9' }
const DEFAULT_FOOD_GROUP = 'milk'
const DIGIT_TO_GROUP = Object.fromEntries(Object.entries(FOOD_GROUPS).map(([slug, digit]) => [digit, slug]))

const MOD_NULL_TOKENS = new Set(['0', 'na', 'n/a', ''])
const VALUE_NULL_TOKENS = new Set(['na', 'n/a', ''])

const normalizeMod = (mod: string | undefined): string => {
  const text = (mod ?? '').trim()
  return MOD_NULL_TOKENS.has(text.toLowerCase()) ? '0' : text
}
const cleanToken = (value: string | undefined): string | null => {
  const text = (value ?? '').trim()
  return VALUE_NULL_TOKENS.has(text.toLowerCase()) ? null : text
}
const parsePrice = (value: string | undefined): number | null => {
  const text = (value ?? '').trim()
  if (VALUE_NULL_TOKENS.has(text.toLowerCase())) return null
  const n = pyFloat(text)
  if (n === undefined) throw new Error(`could not convert string to float: '${text}'`)
  return n
}

type PriceRecord = {
  foodCode: string
  modCode: string
  foodGroup: string | undefined
  cycle: string
  cycleIndex: number
  foodDescription: string
  methodDescription: string | null
  nhanes: string | null
  price: number | null
}

export async function purchaseToPlate(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const requested = optString(params, 'food_group') ?? DEFAULT_FOOD_GROUP
  const foodGroup = Object.keys(FOOD_GROUPS).find((slug) => slug.toLowerCase() === requested.toLowerCase())
  if (!foodGroup) throw new Error(`Invalid food_group: ${requested}. Valid food groups are: ${Object.keys(FOOD_GROUPS).join(', ')}`)

  const records: PriceRecord[] = []
  for (const row of csvDictRows(zipText(await fetchErsFile(ctx, MEDIA), MEMBER))) {
    const cycle = CYCLE_BY_YEAR[(row.year ?? '').trim()]
    if (cycle === undefined) continue
    const foodCode = (row.food_code ?? '').trim()
    records.push({
      foodCode,
      modCode: normalizeMod(row.mod_code),
      foodGroup: DIGIT_TO_GROUP[foodCode.slice(0, 1)],
      cycle,
      cycleIndex: CYCLE_ORDER.indexOf(cycle),
      foodDescription: (row.food_description ?? '').trim(),
      methodDescription: cleanToken(row.method_description),
      nhanes: cleanToken(row.nhanes),
      price: parsePrice(row.price_100gm),
    })
  }

  // One row per (food code, modification code); the descriptions come from the most recent cycle the item appears in.
  type Group = { recent: number; row: Row }
  const groups = new Map<string, Group>()
  for (const r of records) {
    if (r.foodGroup !== foodGroup) continue
    const key = JSON.stringify([r.foodCode, r.modCode])
    let g = groups.get(key)
    if (!g) {
      g = { recent: -1, row: { food_code: r.foodCode, mod_code: r.modCode, food_description: null, method_description: null, nhanes: null } }
      groups.set(key, g)
    }
    g.row[r.cycle] = r.price
    if (r.cycleIndex >= g.recent) {
      g.recent = r.cycleIndex
      g.row.food_description = r.foodDescription
      g.row.method_description = r.methodDescription
      g.row.nhanes = r.nhanes
    }
  }
  const kept = [...groups.values()].map((g) => g.row).filter((row) => CYCLE_ORDER.some((c) => row[c] !== undefined && row[c] !== null))
  if (kept.length === 0) throw new Error('No records match the given filters.')
  return sortedBy(kept, (row) => [row.food_code as string, row.mod_code as string]).map((row) => {
    const out = nullTokensToNone(row)
    // food_description is a required string in the model.
    if (out.food_description === null) throw new Error('food_description: Input should be a valid string')
    return out
  })
}
