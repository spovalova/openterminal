// usda/adoption_of_genetically_engineered_crops, provider usda. Ported from openbb_government_us/usda/models/adoption_of_genetically_engineered_crops_in_the_united_states.py
// and the matching utils/ers_*.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models, the workbook is read with src/lib/xlsx.ts instead of openpyxl.
import { readXlsx, type Cell } from '../lib/xlsx.js'
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { CROPS, CROP_STATES, STATES_ALL, TRAIT_PREFIXES } from './adoption-of-genetically-engineered-crops-data.js'
import { fetchErsFile, nullTokensToNone, optInt, optString, pyFloat, sortedBy } from './helpers.js'
import { optList } from './helpers-c.js'

const MEDIA_PATH = '/media/5685/genetically-engineered-varieties-of-corn-upland-cotton-and-soybeans-by-state-and-for-the-united-states-2000-25.xlsx'
const DEFAULT_CROP = 'corn'
const DEFAULT_STATE = 'United States'
const STATE_CANON = new Map(Object.values(CROP_STATES).flatMap((states) => states.map((s) => [s.toLowerCase(), s] as const)))
const STATE_SUFFIX = /\s*\d+\/\s*$/
const FOOTNOTE_MARKER = /^\d+\//
const TOKEN_VALUES: Record<string, number | null> = { '.': null, '*': 0 }

const str = (cell: Cell | undefined): string => (cell === null || cell === undefined ? '' : String(cell)).trim()

function matchTrait(label: string): string | undefined {
  const low = label.toLowerCase()
  return TRAIT_PREFIXES.find(([prefix]) => low.startsWith(prefix))?.[1]
}

function isFootnote(label: string): boolean {
  const low = label.toLowerCase()
  return label.startsWith('*') || low.startsWith('note:') || low.startsWith('source:') || FOOTNOTE_MARKER.test(label)
}

/** A cell as a number, `null` for the "." token, and undefined where the cell is missing or not a number. */
function coerceValue(cell: Cell | undefined): number | null | undefined {
  if (cell === null || cell === undefined || typeof cell === 'boolean') return undefined
  if (typeof cell === 'number') return cell
  const text = cell.trim()
  if (!text) return undefined
  if (text in TOKEN_VALUES) return TOKEN_VALUES[text]
  return pyFloat(text)
}

type Observation = { state: string; trait: string; year: number; value: number | null }

/** `parse_sheet`: blocks introduced by a trait heading, each with a "State/Year" header row and one row per state. */
function parseSheet(rows: Cell[][], crop: string): Observation[] {
  const validTraits = new Set(CROPS[crop]!.traits)
  const records: Observation[] = []
  let trait: string | undefined
  let yearColumns: [number, number][] = []
  for (const cells of rows) {
    const label = str(cells[0])
    if (!label) continue
    const matched = matchTrait(label)
    if (matched !== undefined) {
      trait = validTraits.has(matched) ? matched : undefined
      yearColumns = []
      continue
    }
    if (label.toLowerCase().startsWith('state/year')) {
      yearColumns = []
      cells.forEach((cell, index) => {
        const text = str(cell)
        if (index > 0 && /^\d{4}$/.test(text)) yearColumns.push([index, Number(text)])
      })
      continue
    }
    if (isFootnote(label)) continue
    if (trait === undefined || yearColumns.length === 0) continue
    const state = label.replace(STATE_SUFFIX, '').trim()
    for (const [index, year] of yearColumns) {
      const value = coerceValue(cells[index])
      if (value === undefined) continue
      records.push({ state, trait, year, value })
    }
  }
  return records
}

export async function adoptionOfGeneticallyEngineeredCrops(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const crop = optString(params, 'crop') ?? DEFAULT_CROP
  const config = CROPS[crop]
  if (!config) throw new Error(`Invalid crop: ${crop}. Valid crops are: ${Object.keys(CROPS).join(', ')}`)
  // State names match case-insensitively; an unknown one is an error, none at all means the national total.
  const tokens = optList(params, 'state') ?? []
  const unknown = tokens.filter((t) => !STATE_CANON.has(t.toLowerCase()))
  if (unknown.length) throw new Error(`Invalid state(s): ${unknown.join(', ')}. Valid states are: ${STATES_ALL.join(', ')}`)
  const selected = new Set(tokens.length ? tokens.map((t) => STATE_CANON.get(t.toLowerCase())!) : [DEFAULT_STATE])
  const startYear = optInt(params, 'start_year')
  const endYear = optInt(params, 'end_year')

  const sheet = readXlsx(await fetchErsFile(ctx, MEDIA_PATH)).find((s) => s.name === config.sheet)
  if (!sheet) throw new Error(`Worksheet ${config.sheet} does not exist.`)
  const grouped = new Map<string, { state: string; year: number; traits: Map<string, number | null> }>()
  for (const r of parseSheet(sheet.rows, crop)) {
    if (!selected.has(r.state)) continue
    if ((startYear !== undefined && r.year < startYear) || (endYear !== undefined && r.year > endYear)) continue
    const key = JSON.stringify([r.state, r.year])
    let cell = grouped.get(key)
    if (!cell) grouped.set(key, (cell = { state: r.state, year: r.year, traits: new Map() }))
    cell.traits.set(r.trait, r.value)
  }
  return sortedBy([...grouped.values()], (g) => [g.state, g.year]).map((g) => {
    const row: Row = { state: g.state, year: g.year }
    for (const trait of config.traits) row[trait] = g.traits.get(trait) ?? null
    return nullTokensToNone(row)
  })
}
