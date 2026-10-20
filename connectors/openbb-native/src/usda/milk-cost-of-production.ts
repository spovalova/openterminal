// usda/milk_cost_of_production, provider usda. Ported from openbb_government_us/usda/models/milk_cost_of_production.py
// and utils/ers_milk_cost_of_production.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { cell, csvDictRows, fetchErsFile, nullTokensToNone, optInt, optString, pyFloat, pyInt, sortedBy } from './helpers.js'
import { decodeUtf8SigOrCp1252, optList } from './helpers-c.js'
import { CATEGORY_CHOICES, ITEM_CHOICES, MILK_COST_FILES, SIZE_CHOICES, STATE_CHOICES } from './milk-cost-of-production-data.js'

/** One filter param: every value must be a known choice key; returns the published labels. */
function selection(params: NativeParams, name: string, choices: Record<string, string>): Set<string> | undefined {
  const values = optList(params, name)
  if (!values) return undefined
  const unknown = values.filter((v) => !(v in choices))
  if (unknown.length) throw new Error(`Invalid ${name}(s): ${unknown.join(', ')}. Valid choices are: ${Object.keys(choices).sort().join(', ')}`)
  return new Set(values.map((v) => choices[v]!))
}

export async function milkCostOfProduction(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const report = optString(params, 'report') ?? 'by_state'
  const file = MILK_COST_FILES[report]
  if (!file) throw new Error(`Invalid report: ${report}. Valid reports are: ${Object.keys(MILK_COST_FILES).join(', ')}`)
  const states = selection(params, 'state', STATE_CHOICES)
  const sizes = selection(params, 'size', SIZE_CHOICES)
  const categories = selection(params, 'category', CATEGORY_CHOICES)
  const items = selection(params, 'item', ITEM_CHOICES)
  if (report === 'by_state' && sizes) throw new Error("The 'size' filter applies only to report='by_size_of_operation'.")
  if (report === 'by_size_of_operation' && states) throw new Error("The 'state' filter applies only to report='by_state'.")
  const startYear = optInt(params, 'start_year')
  const endYear = optInt(params, 'end_year')

  const byState = file.dimension === 'state'
  const text = decodeUtf8SigOrCp1252(await fetchErsFile(ctx, `/media/${file.media_id}/${file.slug}.csv`))
  const groupOrder = Object.values(byState ? STATE_CHOICES : SIZE_CHOICES)
  const categoryOrder = Object.values(CATEGORY_CHOICES)

  type Wide = { groupIndex: number; categoryIndex: number; totalLast: number; item: string; dims: Row; years: Map<number, number> }
  const pivoted = new Map<string, Wide>()
  const years = new Set<number>()
  for (const r of csvDictRows(text)) {
    const value = cell(r, 'Value')
    if (!value) continue
    const year = pyInt(cell(r, 'Year'))
    if (year === undefined) throw new Error(`invalid literal for int() with base 10: '${cell(r, 'Year')}'`)
    const amount = pyFloat(value)
    if (amount === undefined) throw new Error(`could not convert string to float: '${value}'`)
    const category = cell(r, 'Category')
    const item = (r.Item ?? '').replace(/[¹²³]/g, '').replace(/\s+/g, ' ').trim()
    const unit = cell(r, 'Units')
    const state = byState ? cell(r, 'Region') : null
    const size = byState ? null : cell(r, 'Size')
    if ((startYear !== undefined && year < startYear) || (endYear !== undefined && year > endYear)) continue
    if (states && !states.has(state ?? '')) continue
    if (sizes && !sizes.has(size ?? '')) continue
    if (categories && !categories.has(category)) continue
    if (items && !items.has(item)) continue
    const group = state || size || ''
    const key = JSON.stringify([group, category, item, unit])
    let row = pivoted.get(key)
    if (!row) {
      const g = groupOrder.indexOf(group)
      const c = categoryOrder.indexOf(category)
      row = {
        groupIndex: g >= 0 ? g : groupOrder.length,
        categoryIndex: c >= 0 ? c : categoryOrder.length,
        totalLast: item.startsWith('Total,') ? 1 : 0,
        item,
        dims: { group, category, item, unit },
        years: new Map(),
      }
      pivoted.set(key, row)
    }
    years.add(year)
    row.years.set(year, amount)
  }
  if (pivoted.size === 0) throw new Error('No records match the given filters.')
  const columns = [...years].sort((a, b) => a - b)
  return sortedBy([...pivoted.values()], (w) => [w.groupIndex, w.categoryIndex, w.totalLast, w.item]).map((w) => {
    const row: Row = { ...w.dims }
    for (const year of columns) row[String(year)] = w.years.get(year) ?? null
    return nullTokensToNone(row)
  })
}
