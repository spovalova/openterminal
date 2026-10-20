// The EIA API v2 request layer. Ported from openbb_us_eia/utils/helpers.py (build_data_url, response_callback) and
// openbb_us_eia/utils/api_query.py (paginate, empty_result_message, transform_rows) (OpenBB Platform 5.0.0,
// Apache-2.0); modified: plain rows instead of pydantic models, page requests capped at 6 in flight, and error
// messages never carry the request URL (it holds the API key).
import { urlencode } from '../lib/urlencode.js'
import type { NativeCtx, Row } from '../types.js'
import { MissingCredential } from '../types.js'
import { parsePeriod, snakeCase, type Dataset } from './catalog.js'

export const API_BASE = 'https://api.eia.gov/v2'
export const PAGE_SIZE = 5000
export const MAX_AUTO_ROWS = 500_000
const MAX_IN_FLIGHT = 6

/** The key every route of the provider needs, checked before anything else as OpenBB's query executor does. */
export function apiKey(ctx: NativeCtx): string {
  const key = ctx.credential('eia_api_key')
  if (!key) throw new MissingCredential('eia', 'eia_api_key')
  return key
}

export type DataRequest = {
  path: string
  apiKey: string
  frequency: string
  dataColumns: string[]
  /** API facet id → values. */
  facets: Map<string, string[]>
  /** API facet id → the parameter name it is filtered with, for the explanation of an empty answer. */
  facetParams: Record<string, string>
  /** The dataset's first and last period. */
  coverage: [string | null | undefined, string | null | undefined]
  start?: string | undefined
  end?: string | undefined
  sort: string
}

/** One page of a data request as a URL (`build_data_url`). */
export function buildDataUrl(request: DataRequest, offset: number, length: number): string {
  const pairs: [string, string][] = [['api_key', request.apiKey]]
  if (request.frequency) pairs.push(['frequency', request.frequency])
  request.dataColumns.forEach((column, position) => pairs.push([`data[${position}]`, column]))
  for (const [facetId, values] of request.facets) for (const value of values) pairs.push([`facets[${facetId}][]`, value])
  if (request.start) pairs.push(['start', request.start])
  if (request.end) pairs.push(['end', request.end])
  pairs.push(['sort[0][column]', 'period'], ['sort[0][direction]', request.sort || 'desc'], ['offset', String(offset)], ['length', String(length)])
  return `${API_BASE}/${request.path}/data/?${urlencode(pairs)}`
}

type Json = Record<string, any>

/** Read an EIA response, surfacing authentication errors (`response_callback`). */
export async function getJson(ctx: NativeCtx, url: string): Promise<Json> {
  const res = await ctx.http.response(url)
  const text = await res.text()
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error(`EIA returned a response that is not JSON (HTTP ${res.status}): ${text.slice(0, 120)}`)
  }
  if (res.status === 403) {
    const error = ((body as Json | null)?.error ?? {}) as Json
    throw new Error(`${error.code ?? ''} -> ${error.message ?? 'An invalid api_key was supplied.'}`)
  }
  const result = body as Json
  if (result && typeof result === 'object' && !Array.isArray(result) && 'error' in result && !('response' in result)) {
    const error = result.error
    const detail = error && typeof error === 'object' ? (error.message ?? error) : error
    throw new Error(`EIA API error -> ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
  }
  return result
}

/** `amake_requests`: every URL at once; failures are dropped unless nothing succeeded, then the first is raised. */
async function getPages(ctx: NativeCtx, urls: string[]): Promise<Json[]> {
  const settled: PromiseSettledResult<Json>[] = new Array(urls.length)
  let next = 0
  const worker = async () => {
    for (let i = next++; i < urls.length; i = next++) {
      try {
        settled[i] = { status: 'fulfilled', value: await getJson(ctx, urls[i]!) }
      } catch (reason) {
        settled[i] = { status: 'rejected', reason }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(MAX_IN_FLIGHT, urls.length) }, worker))
  const pages = settled.flatMap((s) => (s.status === 'fulfilled' && s.value && Object.keys(s.value).length > 0 ? [s.value] : []))
  const failed = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected')
  if (failed && pages.length === 0) throw failed.reason
  return pages
}

export type Extracted = { rows: Json[]; total: number; dateFormat: string | undefined }

/** The page size and ceiling the API's limits fix; tests shrink them to page through a few rows. */
export type PageLimits = { pageSize?: number; maxAutoRows?: number }

/** Every page of a data request (`paginate`). */
export async function paginate(ctx: NativeCtx, request: DataRequest, limit: number | undefined, limits: PageLimits = {}): Promise<Extracted> {
  const pageSize = limits.pageSize ?? PAGE_SIZE
  const maxAutoRows = limits.maxAutoRows ?? MAX_AUTO_ROWS
  const firstLength = limit === undefined ? pageSize : Math.min(limit, pageSize)
  const response = await getJson(ctx, buildDataUrl(request, 0, firstLength))
  const payload = (response.response ?? {}) as Json
  const rows: Json[] = [...(payload.data ?? [])]
  const total = Math.trunc(Number(payload.total || 0))
  const dateFormat = payload.dateFormat as string | undefined

  if (total === 0 || rows.length === 0) throw new Error(await emptyResultMessage(ctx, request))

  const target = limit === undefined ? total : Math.min(limit, total)
  if (limit === undefined && total > maxAutoRows) {
    throw new Error(`The unfiltered request matches ${total} rows, above the automatic pagination ceiling of ${maxAutoRows}. Narrow the request with facet filters or dates, or set an explicit limit.`)
  }
  if (rows.length < target) {
    const urls: string[] = []
    for (let offset = rows.length; offset < target; offset += pageSize) urls.push(buildDataUrl(request, offset, Math.min(pageSize, target - offset)))
    for (const page of await getPages(ctx, urls)) rows.push(...(((page.response ?? {}) as Json).data ?? []))
  }
  return { rows: rows.slice(0, target), total, dateFormat }
}

/** Explain an empty answer by checking each filter value against the API's live vocabulary (`empty_result_message`). */
export async function emptyResultMessage(ctx: NativeCtx, request: DataRequest): Promise<string> {
  let dateHint = ''
  if (request.start || request.end) {
    dateHint = `\nRequested period: ${request.start || '...'} to ${request.end || '...'}.`
    const [from, to] = request.coverage
    if (from || to) dateHint += ` The dataset covers ${from} to ${to}.`
  }
  if (request.facets.size === 0) return `The request returned no data.${dateHint}`

  const invalidLines: string[] = []
  const validLines: string[] = []
  for (const [facetId, values] of request.facets) {
    const name = request.facetParams[facetId] ?? facetId
    let entries: Json[]
    try {
      const response = await getJson(ctx, `${API_BASE}/${request.path}/facet/${facetId}?api_key=${request.apiKey}`)
      entries = (response.response?.facets ?? []) as Json[]
    } catch {
      validLines.push(`  ${name}: ${values.join(', ')}`)
      continue
    }
    const vocabulary = new Map<string, string>(entries.map((e) => [String(e.id), String(e.name || e.id)]))
    const invalid = values.filter((v) => !vocabulary.has(v))
    if (invalid.length > 0) {
      invalidLines.push(`  ${name}: ${invalid.join(', ')} is not valid for this dataset. Valid ${name} choices:\n${formatChoiceList(vocabulary, name)}`)
    } else {
      validLines.push(`  ${name}: ${values.map((v) => `${v} (${vocabulary.get(v)})`).join(', ')}`)
    }
  }
  if (invalidLines.length > 0) return ['The request returned no data because of invalid filter value(s):', ...invalidLines].join('\n')
  return ['The request returned no data. Each filter value is valid for this dataset, but the combination does not match any series:', ...validLines, `Remove or change one of the filters.${dateHint}`].join('\n')
}

function formatChoiceList(vocabulary: Map<string, string>, name: string, limit = 50): string {
  const shown = [...vocabulary.entries()].sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)).slice(0, limit)
  const lines = shown.map(([value, label]) => `    ${value} = ${label}`)
  if (vocabulary.size > limit) lines.push(`    ... ${vocabulary.size - limit} more - use the \`facet_options\` endpoint for the full '${name}' list.`)
  return lines.join('\n')
}

/** Python's `float(str)`: a number, or null for text that is not one (withheld values, flags). */
export function toFloat(value: unknown): number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return value
  if (typeof value !== 'string') return null
  const text = value.trim()
  // Digits may be grouped with single underscores, as Python allows; inf and nan are no number to the API's users.
  return /^[+-]?(\d+(_\d+)*(\.(\d+(_\d+)*)?)?|\.\d+(_\d+)*)([eE][+-]?\d+(_\d+)*)?$/.test(text) ? Number(text.replaceAll('_', '')) : null
}

/** Normalise raw API rows: dates, facet and column names, numeric columns (`transform_rows`). */
export function transformRows(spec: Dataset, rows: Json[], dateFormat: string): { row: Row; time: number }[] {
  const facetRenames = new Map<string, string>()
  for (const [canonical, facet] of Object.entries(spec.facets)) {
    const facetId = facet.id
    facetRenames.set(facetId, canonical)
    const base = facetId.replace(/id$/i, '')
    const companions = [...(FACET_NAME_COLUMNS[facetId] ?? []), `${facetId}Description`, `${facetId}-name`, `${facetId}-description`, `${base}Description`, `${base}Name`, `${base}-name`]
    for (const companion of companions) facetRenames.set(companion, `${canonical}_name`)
  }
  const columnRenames = new Map<string, string>()
  const numeric = new Set<string>()
  const dropped = new Set<string>()
  for (const [name, [id, isNumeric]] of Object.entries(spec.columns)) {
    columnRenames.set(id, name)
    dropped.add(`${id}-units`)
    if (isNumeric) numeric.add(name)
  }
  return rows.map((raw) => {
    const period = parsePeriod(String(raw.period), dateFormat)
    const row: Row = { date: period.iso }
    for (const [key, value] of Object.entries(raw)) {
      if (key === 'period' || dropped.has(key)) continue
      const name = facetRenames.get(key) || columnRenames.get(key) || snakeCase(key)
      const cell = numeric.has(name) ? toFloat(value) : value
      if (cell !== null && cell !== undefined) row[name] = cell
    }
    return { row, time: period.time }
  })
}

/** The name columns that accompany a facet in the API's rows, besides `<id>-name`, `<id>Description` and the like. */
const FACET_NAME_COLUMNS: Record<string, string[]> = {
  duoarea: ['area-name'],
  series: ['series-description'],
  msn: ['seriesDescription'],
  seriesId: ['seriesDescription', 'seriesName'],
  tableId: ['tableName'],
}
