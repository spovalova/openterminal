// usda/farm_income_and_wealth_statistics, provider usda. Ported from openbb_government_us/usda/models/farm_income_and_wealth_statistics.py
// and utils/ers_farm_income_and_wealth_statistics.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { ERS_BASE, cell, csvDictRows, decodeText, fetchErsFile, nullTokensToNone, optInt, optString, pyFloat, pyInt, readZip, sortedBy } from './helpers.js'
import { STATE_LABELS, TABLE_PREFIXES, US_ONLY_TABLES } from './farm-income-and-wealth-statistics-data.js'

const PRODUCT_PAGE = 'data-products/farm-income-and-wealth-statistics/data-files-us-and-state-level-farm-income-and-wealth-statistics'
/** The release the package shipped with; used when the product page names none. */
const RELEASE_ZIP = '/media/20808/february-5-2026-release.zip'
const DOWNLOAD_HEADING = 'Download All Data in CSV File Format'
const NULL_UNIT_TOKENS = ['�', ' ']
const DEFAULT_TABLE = 'income_statement'
const DEFAULT_STATE = 'US'

/** The first .zip link in the "Download All Data in CSV File Format" list of the product page (`extract_release_zip`). */
function extractReleaseZip(html: string): string | undefined {
  const start = html.indexOf(DOWNLOAD_HEADING)
  if (start === -1) return undefined
  const tail = html.slice(start)
  const end = tail.indexOf('</ul>')
  const match = /href="([^"?]+\.zip)"/.exec(end !== -1 ? tail.slice(0, end) : tail)
  if (!match) return undefined
  return match[1]!.startsWith('/') ? match[1] : `/${match[1]}`
}

function cleanUnit(unit: string): string {
  let cleaned = unit
  for (const token of NULL_UNIT_TOKENS) cleaned = cleaned.split(token).join('')
  return cleaned.trim()
}

export async function farmIncomeAndWealthStatistics(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const table = optString(params, 'table') ?? DEFAULT_TABLE
  const prefixes = TABLE_PREFIXES[table]
  if (!prefixes) throw new Error(`Invalid table: ${table}. Valid tables are: ${Object.keys(TABLE_PREFIXES).join(', ')}`)
  const state = (optString(params, 'state') ?? DEFAULT_STATE).toUpperCase()
  if (!(state in STATE_LABELS)) throw new Error(`Invalid state: ${state}. Valid states are: ${Object.keys(STATE_LABELS).join(', ')}`)
  const codes = US_ONLY_TABLES.includes(table) ? ['US'] : Object.keys(STATE_LABELS)
  if (!codes.includes(state)) throw new Error(`Invalid state '${state}' for table '${table}'. This table is published for: ${codes.join(', ')}`)
  const startYear = optInt(params, 'start_year')
  const endYear = optInt(params, 'end_year')

  // The release's file name changes with every release: read it off the product page, as OpenBB does.
  const html = new TextDecoder('utf-8').decode(await ctx.cache(`usda:ers:page:${PRODUCT_PAGE}`, 24 * 3600 * 1000, () => ctx.http.bytes(`${ERS_BASE}/${PRODUCT_PAGE}`)))
  const zip = readZip(await fetchErsFile(ctx, extractReleaseZip(html) ?? RELEASE_ZIP))
  const csvName = Object.keys(zip).find((n) => n.toLowerCase().endsWith('.csv'))
  if (csvName === undefined) throw new Error('the release archive has no CSV file')
  const text = decodeText(zip[csvName]!)

  const rank = new Map(prefixes.map((p, i) => [p, i]))
  type Wide = { rank: number; order: number; dims: Row; years: Map<number, number | null> }
  const pivoted = new Map<string, Wide>()
  let order = 0
  for (const r of csvDictRows(text)) {
    const prefix = (r.artificialKey ?? '').slice(0, 2)
    if (!prefixes.includes(prefix)) continue
    const rowState = cell(r, 'State').toUpperCase()
    if (rowState !== state) continue
    const year = pyInt(cell(r, 'Year'))
    if (year === undefined) throw new Error(`invalid literal for int() with base 10: '${cell(r, 'Year')}'`)
    const lineItem = cell(r, 'VariableDescriptionTotal')
    const unit = cleanUnit(r.unit_desc ?? '')
    const amountText = cell(r, 'Amount')
    const amount = amountText ? (pyFloat(amountText) ?? null) : null
    const thisOrder = order++
    if ((startYear !== undefined && year < startYear) || (endYear !== undefined && year > endYear)) continue
    const key = JSON.stringify([lineItem, unit])
    let row = pivoted.get(key)
    if (!row) {
      row = {
        rank: rank.get(prefix) ?? rank.size,
        order: thisOrder,
        dims: { line_item: lineItem, unit, state: STATE_LABELS[rowState] ?? rowState, part_1: cell(r, 'VariableDescriptionPart1') || null, part_2: cell(r, 'VariableDescriptionPart2') || null },
        years: new Map(),
      }
      pivoted.set(key, row)
    } else if (thisOrder < row.order) row.order = thisOrder
    row.years.set(year, amount)
  }
  if (pivoted.size === 0) throw new Error('No records match the given filters.')
  return sortedBy([...pivoted.values()], (w) => [w.rank, w.order]).map((w) => {
    const row: Row = { ...w.dims }
    for (const year of [...w.years.keys()].sort((a, b) => a - b)) row[String(year)] = w.years.get(year)
    return nullTokensToNone(row)
  })
}
