// The release-table routes, provider fred: economy/fred_release_table, economy/pce and economy/survey/nonfarm_payrolls.
// Ported from openbb_fred/models/{release_table, personal_consumption_expenditures, non_farm_payrolls}.py and
// utils/release_tables.py (get_units, release_series) (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows
// instead of DataFrames and pydantic models. Where pandas' dtypes decide the output (a parent id column with a
// missing value is floats, so its text is `5.0`, and no element then finds its children) the same is done here.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import data from './data.json' with { type: 'json' }
import { apiKey, fredGet, joinDates, parseDate, releaseTablesUrl, text, toFloat, useCache } from './helpers.js'
import { searchSeries } from './search.js'

type Json = Record<string, any>
const D = data as unknown as Json

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

// ---- units ---------------------------------------------------------------------------------------------------------------

const PAGE = 1000
const MAX_SERIES = 10_000
const TRIES = 4

/** Every series a release publishes, a page of 1000 at a time; a page that keeps failing ends the list (`release_series`). */
async function releaseSeries(ctx: NativeCtx, key: string, releaseId: string | number): Promise<Row[]> {
  const found: Row[] = []
  for (let offset = 0; offset < MAX_SERIES; offset += PAGE) {
    let page: Row[] = []
    for (let attempt = 0; attempt < TRIES; attempt++) {
      try {
        page = await searchSeries(ctx, key, { release_id: Number(releaseId), offset })
        break
      } catch {
        if (attempt === TRIES - 1) return found
        await sleep(2 ** attempt * 1000)
      }
    }
    found.push(...page)
    if (page.length < PAGE) break
  }
  return found
}

/** The unit of measure of each series in a release (`get_units`). */
async function getUnits(ctx: NativeCtx, key: string, releaseId: string | number): Promise<Map<string, string>> {
  const units = new Map<string, string>()
  for (const row of await releaseSeries(ctx, key, releaseId)) if (row.series_id && row.units) units.set(String(row.series_id), String(row.units))
  return units
}

// ---- pandas helpers -----------------------------------------------------------------------------------------------------

/** A numeric id column as `astype(str)` writes it: `5`, or `5.0` when a missing value made the column floats. */
function idText(v: unknown, hasMissing: boolean): string | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'number') return hasMissing ? (Number.isInteger(v) ? v.toFixed(1) : String(v)) : String(v)
  return String(v)
}

const isMissing = (v: unknown) => v === null || v === undefined

/** pydantic's `int`: a number or numeric text without a fraction; anything else fails the model. */
function intOf(v: unknown, field: string): number | null {
  if (isMissing(v)) return null
  const n = typeof v === 'number' ? v : Number(String(v).trim())
  if (String(v).trim() === '' || !Number.isInteger(n)) throw new Error(`${field}: Input should be a valid integer`)
  return n
}

/** `observation_value.str.replace(',', '').astype(float)`; a missing value stays missing. */
function numberOf(value: unknown): number | null {
  if (isMissing(value)) return null
  const n = toFloat(String(value).replaceAll(',', ''))
  if (n === null) throw new Error(`could not convert string to float: '${value}'`)
  return n
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/** `to_datetime(x, format='%b %Y').dt.date`: strictly an abbreviated month and a year. */
function monthYear(value: unknown): string {
  const m = /^([A-Za-z]{3}) (\d{4})$/.exec(String(value))
  const month = m ? MONTHS.indexOf(m[1]!.toLowerCase()) : -1
  if (!m || month < 0) throw new Error(`time data "${value}" doesn't match format "%b %Y"`)
  return `${m[2]}-${String(month + 1).padStart(2, '0')}-01`
}

/** `children`: for each parent id, its sorted, distinct element ids joined by commas (`groupby` leaves out missing parents). */
function childrenOf(rows: { element_id: string; parent_id: string | null }[]): Map<string, string> {
  const groups = new Map<string, Set<string>>()
  for (const r of rows) {
    if (r.parent_id === null) continue
    if (!groups.has(r.parent_id)) groups.set(r.parent_id, new Set())
    groups.get(r.parent_id)!.add(r.element_id)
  }
  return new Map([...groups].map(([parent, ids]) => [parent, [...ids].sort().join(',')]))
}

type Compare = (a: any, b: any) => number
const cmp = (a: string | number, b: string | number): number => (a < b ? -1 : a > b ? 1 : 0)
/** A stable sort by several keys; a missing text sorts last when `missingLast`, else it is the empty text. */
function sortBy<T>(rows: T[], ...keys: Compare[]): T[] {
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      for (const k of keys) {
        const c = k(a.r, b.r)
        if (c !== 0) return c
      }
      return a.i - b.i
    })
    .map((x) => x.r)
}

/** An index level that sorts missing values last. */
const lastMissing = <T>(get: (r: T) => string | number | null): Compare => (a: T, b: T) => {
  const x = get(a)
  const y = get(b)
  if (x === null || y === null) return x === null && y === null ? 0 : x === null ? 1 : -1
  return cmp(x, y)
}

// ---- the release tables API ---------------------------------------------------------------------------------------------

/** The elements of a release-tables answer; none when the answer has no `elements`. */
function elementsOf(response: unknown): Json[] | undefined {
  if (!response || typeof response !== 'object' || !('elements' in (response as object))) return undefined
  return Object.values(((response as Json).elements ?? {}) as Record<string, Json>)
}

const requireColumns = (rows: Json[], columns: string[]) => {
  const missing = columns.filter((c) => !rows.some((r) => !isMissing(r[c])))
  if (missing.length > 0) throw new Error(`"[${missing.map((c) => `'${c}'`).join(', ')}] not in index"`)
}

// ---- economy/fred_release_table ------------------------------------------------------------------------------------------

function quarterStart(value: string): string {
  const [y, m] = value.split('-') as [string, string]
  return `${y}-${String((Math.floor((Number(m) - 1) / 3)) * 3 + 1).padStart(2, '0')}-01`
}

/** `apply_date_format`: quarter labels become the quarter's last day, other labels dates, and what is neither stays text. */
function releaseDate(value: unknown): string {
  const x = String(value).replaceAll(' ', '-')
  if (x.startsWith('Q')) {
    const ends: Record<string, string> = { Q1: '-03-31', Q2: '-06-30', Q3: '-09-30', Q4: '-12-31' }
    const quarter = ends[x.split('-')[0]!]
    if (quarter === undefined) throw new Error(`'${x.split('-')[0]}'`)
    return x.split('-').at(-1)! + quarter
  }
  const iso = parseDate(x)
  if (iso) return iso
  const m = /^([A-Za-z]{3})-(\d{4})$/.exec(x)
  const month = m ? MONTHS.indexOf(m[1]!.toLowerCase()) : -1
  return m && month >= 0 ? `${m[2]}-${String(month + 1).padStart(2, '0')}-01` : x
}

type TableRow = Row

/** The rows of one date of a release table. */
function tableRows(elements: Json[]): TableRow[] {
  const sections: TableRow[] = []
  const observed: Json[] = []
  for (const v of elements) {
    if (v && (v.type === 'section' || v.type === 'table')) {
      const { children: _c, release_id: _r, ...rest } = v
      sections.push({ ...rest, element_id: String(v.element_id), parent_id: v.parent_id ? String(v.parent_id) : null })
    } else if ('observation_value' in v && v.observation_value !== '.' && v.type !== 'header') {
      observed.push({ ...v, element_id: String(v.element_id) })
    }
  }
  if (observed.length === 0) return sections

  // DataFrame(data).dropna(how='all', axis=1): a column nobody has a value for goes.
  const present = (c: string) => observed.some((r) => !isMissing(r[c]))
  const indexColumns = ['line', 'element_id', 'parent_id'].filter(present)
  requireColumns(observed, ['level', 'series_id', 'name', 'observation_date', 'observation_value'])
  if (!indexColumns.includes('parent_id')) throw new Error("'DataFrame' object has no attribute 'parent_id'")
  const parentMissing = observed.some((r) => isMissing(r.parent_id))
  const lineMissing = indexColumns.includes('line') && observed.some((r) => isMissing(r.line))
  void lineMissing

  const table = observed.map((r) => ({
    line: indexColumns.includes('line') ? (isMissing(r.line) || Number.isNaN(Number(r.line)) ? null : Math.trunc(Number(r.line))) : undefined,
    element_id: String(r.element_id),
    parent_id: idText(r.parent_id, parentMissing),
    level: r.level,
    series_id: r.series_id,
    name: r.name,
    observation_date: releaseDate(r.observation_date),
    observation_value: numberOf(r.observation_value),
  }))
  const children = childrenOf(table)
  const withChildren = table.map((r) => ({ ...r, children: children.get(r.element_id) ?? null }))
  // Sorted on line, element id, children, parent id and level, a missing one standing for -1 or the empty text.
  const numeric = (v: unknown) => (typeof v === 'number' ? v : -1)
  const sorted = sortBy(
    withChildren,
    ...(indexColumns.includes('line') ? [(a: any, b: any) => cmp(a.line ?? -1, b.line ?? -1)] : []),
    (a: any, b: any) => cmp(a.element_id, b.element_id),
    (a: any, b: any) => cmp(a.children ?? '', b.children ?? ''),
    (a: any, b: any) => cmp(a.parent_id ?? '', b.parent_id ?? ''),
    (a: any, b: any) => cmp(typeof a.level === 'number' ? numeric(a.level) : String(a.level ?? ''), typeof b.level === 'number' ? numeric(b.level) : String(b.level ?? '')),
  )
  return sorted.map((r) => {
    const row: TableRow = {}
    for (const [k, v] of Object.entries(r)) if (v !== undefined) row[k] = v
    return row
  })
}

/** FredReleaseTableData: OpenBB's names for the API's keys, and a null left out. */
function releaseRow(raw: Row): Row {
  const names: Record<string, string> = { observation_date: 'date', observation_value: 'value', series_id: 'symbol', type: 'element_type' }
  const out: Row = {}
  for (const [k, v] of Object.entries(raw)) if (v !== null && v !== undefined) out[names[k] ?? k] = k === 'level' || k === 'line' ? intOf(v, k) : v
  // `date` is a date: a label that is none (`Fall 2025`) fails the model.
  if (typeof out.date === 'string' && !/^\d{4}-\d{2}-\d{2}/.test(out.date)) throw new Error(`date: Input should be a valid date or datetime, input is too short`)
  return out
}

export async function fredReleaseTable(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const key = apiKey(ctx)
  const releaseId = text(params, 'release_id')
  if (!releaseId) throw new Error('release_id: Field required')
  const cache = useCache(params)
  const info = await searchSeries(ctx, key, { release_id: releaseId, use_cache: cache })
  if (info.length === 0) throw new Error(`No release information found for, ${releaseId}.`)
  // `next(iter({...}))` over the frequencies of the release's series: the first one met (a set has no order in Python).
  const frequency = info[0]!.frequency_short

  let dates: (string | undefined)[] = [undefined]
  const joined = joinDates(text(params, 'date'))
  if (joined) {
    let requested = joined.split(',')
    if (frequency === 'M') requested = requested.map((d) => `${d.slice(0, -2)}01`)
    else if (frequency === 'Q') requested = requested.map(quarterStart)
    dates = [...new Set(requested)].sort()
  }
  const elementId = text(params, 'element_id')
  const urls = dates.map((date) => releaseTablesUrl(releaseId, elementId, key, date))
  const results: TableRow[] = []
  const answers = await Promise.all(urls.map((url) => fredGet(ctx, url, { useCache: cache })))
  for (const answer of answers) {
    const elements = elementsOf(answer)
    if (!elements) continue
    const rows = tableRows(elements)
    // A table of headings only adds each heading once.
    if (rows.length > 0 && rows.every((r) => !('observation_value' in r))) {
      for (const item of rows) if (!results.some((r) => r.element_id === item.element_id)) results.push(item)
    } else results.push(...rows)
  }
  const units = await getUnits(ctx, key, releaseId)
  for (const row of results) row.units = units.get(String(row.series_id)) ?? null
  if (results.length === 0) {
    throw new Error(`No tables were found for the release, ${releaseId}. Use \`fred_search()\` to list all release IDs.\n\nReleases without tables will not return data, nor will this endpoint return individual line items.\n\nTry a different 'element_id' and/or 'date'.\n\nExclude 'date' for the most recent observations.\n\nExclude 'element_id' to reveal the top-level element IDs.\n\nUse \`fred_series\` for single series data.`)
  }
  const ordered = sortBy(
    results,
    (a: Row, b: Row) => cmp(String(a.observation_date ?? ''), String(b.observation_date ?? '')),
    (a: Row, b: Row) => cmp(Number(a.line ?? Infinity), Number(b.line ?? Infinity)),
  )
  return ordered.map(releaseRow)
}

// ---- economy/pce and economy/survey/nonfarm_payrolls --------------------------------------------------------------------

/** A required string/number/int the model refuses to have missing. */
function required(row: Row, fields: string[]): void {
  for (const f of fields) if (isMissing(row[f])) throw new Error(`${f}: Input should be a valid ${f === 'value' ? 'number' : f === 'level' || f === 'line' ? 'integer' : 'string'}`)
}

type Element = { line?: number | null; element_id: string; parent_id: string | null; level: any; series_id: string; name: string; observation_date: string; observation_value: number | null; children?: string | null; units?: string | null }

/** The observations of one release-tables answer, sorted as the two models sort them. */
function observationsOf(elements: Json[], keep: (v: Json) => boolean, withLine: boolean): Element[] {
  const kept = elements.filter(keep)
  if (kept.length === 0) return []
  const present = (c: string) => kept.some((r) => !isMissing(r[c]))
  requireColumns(kept, ['level', 'series_id', 'name', 'observation_date', 'observation_value'])
  for (const c of withLine ? ['line', 'element_id', 'parent_id'] : ['element_id', 'parent_id']) if (!(c in Object.assign({}, ...kept)) && !present(c)) throw new Error(`"None of [${c}] are in the columns"`)
  const parentMissing = kept.some((r) => isMissing(r.parent_id))
  // set_index([...]).sort_index(): numeric ids, a missing parent last.
  const first = sortBy(
    kept,
    ...(withLine ? [lastMissing<Json>((r) => (isMissing(r.line) ? null : Number(r.line)))] : []),
    lastMissing<Json>((r) => (isMissing(r.element_id) ? null : Number(r.element_id))),
    lastMissing<Json>((r) => (isMissing(r.parent_id) ? null : Number(r.parent_id))),
  )
  return first.map((r) => ({
    ...(withLine ? { line: Math.trunc(Number(r.line)) } : {}),
    element_id: String(r.element_id),
    parent_id: idText(r.parent_id, parentMissing),
    level: r.level,
    series_id: r.series_id,
    name: r.name,
    observation_date: monthYear(r.observation_date),
    observation_value: numberOf(r.observation_value),
  }))
}

/** The second `set_index(...).sort_index()` of both routes: text levels sort as text, a missing level last. */
function resort(rows: Element[], withLine: boolean): Element[] {
  const children = childrenOf(rows)
  const withChildren = rows.map((r) => ({ ...r, children: children.get(r.element_id) ?? null }))
  return sortBy(
    withChildren,
    ...(withLine ? [(a: Element, b: Element) => cmp(a.line!, b.line!)] : []),
    (a: Element, b: Element) => cmp(a.element_id, b.element_id),
    lastMissing<Element>((r) => r.children ?? null),
    lastMissing<Element>((r) => r.parent_id),
    lastMissing<Element>((r) => (typeof r.level === 'number' ? r.level : r.level === null || r.level === undefined ? null : String(r.level))),
  )
}

export async function pce(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const key = apiKey(ctx)
  const category = text(params, 'category') ?? 'personal_income'
  const elementId = (D.pce.categoryToElement as Record<string, string>)[category]
  if (!elementId) throw new Error(`category: Input should be one of ${Object.keys(D.pce.categoryToElement).join(', ')} (got ${category})`)
  const dates = joinDates(text(params, 'date'))
  const periods = dates ? [...new Set(dates.split(',').map((d) => `${d.slice(0, -2)}01`))].sort() : [undefined]
  const cache = useCache(params)
  const answers = await Promise.all(periods.map((date) => fredGet(ctx, releaseTablesUrl('54', elementId, key, date), { useCache: cache })))
  const results: Element[] = []
  for (const answer of answers) {
    const elements = ((answer?.elements ?? {}) as Record<string, Json>) && Object.values((answer?.elements ?? {}) as Record<string, Json>)
    const kept = observationsOf(elements, (v) => v.observation_value !== '.' && v.type !== 'header', true)
    if (kept.length === 0) continue
    const rows = resort(kept, true)
    for (const r of rows) {
      r.units = category === 'personal_income' ? ((D.pce.personalIncomeLineToUnits as Record<string, string>)[String(r.line)] ?? D.pce.personalIncomeUnits) : (D.pce.categoryToUnits as Record<string, string>)[category]
    }
    results.push(...rows)
  }
  const units = await getUnits(ctx, key, 54)
  for (const row of results) row.units = units.get(row.series_id) || row.units
  if (results.length === 0) throw new Error('The request was returned empty.')
  const out = sortBy(results, (a: Element, b: Element) => cmp(a.observation_date, b.observation_date), (a: Element, b: Element) => cmp(a.line!, b.line!))
  return out.map((r) => {
    const row: Row = { date: r.observation_date, symbol: r.series_id, value: r.observation_value, name: r.name, units: r.units, element_id: r.element_id, parent_id: r.parent_id, children: r.children, level: intOf(r.level, 'level'), line: r.line }
    required(row, ['symbol', 'value', 'name', 'element_id', 'parent_id', 'level', 'line'])
    return Object.fromEntries(Object.entries(row).filter(([, v]) => v !== null && v !== undefined))
  })
}

export async function nonfarmPayrolls(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const key = apiKey(ctx)
  const category = text(params, 'category') ?? 'employees_nsa'
  const elementId = (D.nfp.elements as Record<string, string>)[category]
  if (!elementId) throw new Error(`category: Input should be one of ${Object.keys(D.nfp.elements).join(', ')} (got ${category})`)
  const dates = joinDates(text(params, 'date'))
  const periods = dates ? [...new Set(dates.split(',').map((d) => `${d.slice(0, -2)}01`))].sort() : [undefined]
  const cache = useCache(params)
  const answers = await Promise.all(periods.map((date) => fredGet(ctx, releaseTablesUrl('50', elementId, key, date), { useCache: cache })))
  const results: Element[] = []
  for (const answer of answers) {
    const elements = Object.values((answer?.elements ?? {}) as Record<string, Json>)
    const kept = observationsOf(elements, (v) => v.observation_value !== '.', false)
    if (kept.length === 0) continue
    if (category.startsWith('employees') && !category.endsWith('percent')) for (const r of kept) if (r.observation_value !== null) r.observation_value *= 1000
    results.push(...resort(kept, false))
  }
  const units = await getUnits(ctx, key, 50)
  for (const row of results) row.units = units.get(row.series_id) ?? null
  if (results.length === 0) throw new Error('The request was returned empty.')
  const order = new Map((D.nfp.sectorOrder as string[]).map((name, i) => [name, i]))
  const out = sortBy(results, (a: Element, b: Element) => cmp(a.observation_date, b.observation_date), (a: Element, b: Element) => cmp(order.get(a.name) ?? order.size, order.get(b.name) ?? order.size))
  return out.map((r) => {
    const row: Row = { date: r.observation_date, symbol: r.series_id, value: r.observation_value, name: r.name, units: r.units, element_id: r.element_id, parent_id: r.parent_id, children: r.children, level: intOf(r.level, 'level') }
    required(row, ['symbol', 'value', 'name', 'element_id', 'parent_id', 'level'])
    return Object.fromEntries(Object.entries(row).filter(([, v]) => v !== null && v !== undefined))
  })
}
