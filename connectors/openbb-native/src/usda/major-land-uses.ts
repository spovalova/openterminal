// usda/major_land_uses, provider usda. Ported from openbb_government_us/usda/models/major_land_uses.py
// and utils/ers_major_land_uses.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models,
// the cropland workbook is read with src/lib/xlsx.ts instead of pandas.
import { readXlsx, type Cell } from '../lib/xlsx.js'
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { cell, csvDictRows, decodeText, fetchErsFile, nullTokensToNone, optInt, optString, pyFloat, pyInt } from './helpers.js'
import { optList } from './helpers-c.js'
import { CROPLAND_VARIABLES, GEOGRAPHIES, LAND_USE_CATEGORIES, MAJOR_LAND_USES_FILES } from './major-land-uses-data.js'

const LABEL_TO_SLUG = new Map(Object.entries(LAND_USE_CATEGORIES).map(([slug, label]) => [label, slug]))
const GEOGRAPHY_LOOKUP = new Map(GEOGRAPHIES.map((name) => [name.toLowerCase(), name]))
const AGGREGATE_GEOGRAPHIES = new Set(['48 States', 'U.S. total'])
const YEAR_PATTERN = /^(\d{4})(?:\s|$)/

type Observation = { year: number; geography: string; region: string | null; landUse: string; value: number | null }

/** The Census of Agriculture benchmark CSV; values are in thousands of acres and become acres. */
function parseLandUseCsv(text: string): Observation[] {
  return csvDictRows(text).map((r) => {
    const geography = cell(r, 'Region or State')
    const region = cell(r, 'Region')
    const label = (r['Land use'] ?? '').trim().replace(/\s+/g, ' ')
    const rawValue = cell(r, 'Value')
    const isAggregate = region.endsWith(' total') || AGGREGATE_GEOGRAPHIES.has(geography)
    const year = pyInt(r.Year ?? '')
    if (year === undefined) throw new Error(`invalid literal for int() with base 10: '${r.Year}'`)
    let value: number | null = null
    if (rawValue !== '' && rawValue !== 'N.A.') {
      const n = pyFloat(rawValue)
      if (n === undefined) throw new Error(`could not convert string to float: '${rawValue}'`)
      value = n * 1000
    }
    return { year, geography, region: isAggregate ? null : region, landUse: LABEL_TO_SLUG.get(label) ?? label, value }
  })
}

/** The annual national workbook: blank rows and columns dropped, then one row per year (a footnote marker after the year is allowed). */
function parseCroplandXlsx(content: Uint8Array): Observation[] {
  const first = readXlsx(content)[0]
  const width = Math.max(0, ...(first?.rows ?? []).map((r) => r.length))
  const isBlank = (c: Cell | undefined) => c === null || c === undefined
  const rows = (first?.rows ?? []).map((r) => Array.from({ length: width }, (_, i) => r[i] ?? null)).filter((r) => !r.every(isBlank))
  const keep = Array.from({ length: width }, (_, i) => i).filter((i) => rows.some((r) => !isBlank(r[i])))
  const frame = rows.map((r) => keep.map((i) => r[i]!))
  if (keep.length !== CROPLAND_VARIABLES.length + 1) {
    throw new Error(`Unexpected column layout in the cropland-used-for-crops workbook: found ${keep.length} columns, expected ${CROPLAND_VARIABLES.length + 1}.`)
  }
  const out: Observation[] = []
  for (const row of frame.slice(2)) {
    const label = (isBlank(row[0]) ? 'nan' : String(row[0])).trim()
    const match = YEAR_PATTERN.exec(label)
    if (!match) break
    const year = Number(match[1])
    CROPLAND_VARIABLES.forEach((variable, i) => {
      const v = row[i + 1]
      let value: number | null = null
      if (!isBlank(v)) {
        value = typeof v === 'number' ? v * 1_000_000 : (pyFloat(String(v)) ?? Number.NaN) * 1_000_000
      }
      out.push({ year, geography: 'United States', region: null, landUse: variable, value })
    })
  }
  return out
}

export async function majorLandUses(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const table = optString(params, 'table') ?? 'land_use'
  if (table !== 'land_use' && table !== 'cropland_used_for_crops') throw new Error(`Invalid table: ${table}. Valid tables are: land_use, cropland_used_for_crops`)
  const landUses = optList(params, 'land_use')
  const unknownUses = (landUses ?? []).filter((v) => !(v in LAND_USE_CATEGORIES))
  if (unknownUses.length) throw new Error(`Invalid land_use value(s): ${unknownUses.join(', ')}. Valid categories are: ${Object.keys(LAND_USE_CATEGORIES).sort().join(', ')}`)
  const geographies = optList(params, 'geography')
  const unknownGeos = (geographies ?? []).filter((v) => !GEOGRAPHY_LOOKUP.has(v.toLowerCase()))
  if (unknownGeos.length) throw new Error(`Invalid geography value(s): ${unknownGeos.join(', ')}. Valid geographies are: ${GEOGRAPHIES.join(', ')}`)
  const selectedUses = landUses && table === 'land_use' ? new Set(landUses) : undefined
  const selectedGeographies = geographies && table === 'land_use' ? new Set(geographies.map((g) => GEOGRAPHY_LOOKUP.get(g.toLowerCase())!)) : undefined
  const startYear = optInt(params, 'start_year')
  const endYear = optInt(params, 'end_year')

  const data =
    table === 'cropland_used_for_crops'
      ? parseCroplandXlsx(await fetchErsFile(ctx, MAJOR_LAND_USES_FILES.cropland_used_for_crops!.media_path))
      : parseLandUseCsv(decodeText(await fetchErsFile(ctx, MAJOR_LAND_USES_FILES.land_use!.media_path)))

  // One wide row per (geography, land use), in order of first appearance.
  const pivoted = new Map<string, Row>()
  for (const r of data) {
    if ((startYear !== undefined && r.year < startYear) || (endYear !== undefined && r.year > endYear)) continue
    if (selectedUses && !selectedUses.has(r.landUse)) continue
    if (selectedGeographies && !selectedGeographies.has(r.geography)) continue
    const key = JSON.stringify([r.geography, r.landUse])
    let row = pivoted.get(key)
    if (!row) pivoted.set(key, (row = { geography: r.geography, land_use: r.landUse, region: r.region }))
    row[String(r.year)] = r.value
  }
  return [...pivoted.values()].map(nullTokensToNone)
}
