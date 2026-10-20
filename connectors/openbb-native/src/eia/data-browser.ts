// eia/data_browser, provider eia. Ported from openbb_us_eia/models/data_browser.py (OpenBB Platform 5.0.0,
// Apache-2.0); modified: plain rows instead of pydantic models.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { API_BASE, apiKey, getJson, paginate, toFloat, type DataRequest } from './api.js'
import { formatPeriod, parsePeriod, snakeCase } from './catalog.js'
import { limitAndSort, text } from './dataset.js'

type Json = Record<string, any>

/** The `facets` string, `facetId:value1,value2;otherId:value`, as facet id → values. */
function parseFacets(facets: string | undefined): Map<string, string[]> {
  const query = new Map<string, string[]>()
  for (const rawPair of (facets ?? '').split(';')) {
    const pair = rawPair.trim()
    if (!pair) continue
    if (!pair.includes(':')) throw new Error(`Invalid facet filter '${pair}'. Use 'facetId:value1,value2' pairs separated by semicolons.`)
    const at = pair.indexOf(':')
    query.set(pair.slice(0, at).trim(), pair.slice(at + 1).split(',').map((item) => item.trim()).filter(Boolean))
  }
  return query
}

export async function dataBrowser(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const key = apiKey(ctx)
  const { limit, sort } = limitAndSort(params)
  const route = (text(params, 'route') ?? '').trim().replace(/^\/+|\/+$/g, '').replace(/\/data$/, '')
  if (!text(params, 'route')) throw new Error('route: Field required')
  const facets = parseFacets(text(params, 'facets'))

  // The route's metadata says which frequencies, columns and facets exist.
  const metadata = await getJson(ctx, `${API_BASE}/${route}?api_key=${key}`)
  const node = (metadata.response ?? {}) as Json
  if (node.routes && node.routes.length > 0) throw new Error(`'${route}' is not a data route. Child routes: ${(node.routes as Json[]).map((child) => child.id).join(', ')}`)
  const frequencies = new Map<string, Json>(((node.frequency ?? []) as Json[]).map((f) => [f.id as string, f]))
  if (frequencies.size === 0) throw new Error(`'${route}' is not a valid EIA data route.`)
  const requestedFrequency = text(params, 'frequency')
  const frequency: string | undefined = requestedFrequency ?? node.defaultFrequency
  if (frequency === undefined || !frequencies.has(frequency)) throw new Error(`Frequency '${requestedFrequency}' is not available for '${route}'. Choices: ${[...frequencies.keys()].join(', ')}`)
  const periodFormat: string = frequencies.get(frequency)!.format ?? 'YYYY-MM-DD'

  let dataColumns = Object.keys((node.data ?? {}) as Json)
  const dataType = text(params, 'data_type')
  if (dataType) {
    const requested = dataType.split(',').map((item) => item.trim()).filter(Boolean)
    const invalid = requested.filter((item) => !dataColumns.includes(item))
    if (invalid.length > 0) throw new Error(`Invalid data_type value(s) ${invalid.join(', ')} for '${route}'. Choices: ${dataColumns.join(', ')}`)
    dataColumns = requested
  }

  const facetIds = new Set<string>(((node.facets ?? []) as Json[]).map((f) => f.id as string))
  const unknown = [...facets.keys()].filter((id) => !facetIds.has(id)).sort()
  if (unknown.length > 0) throw new Error(`Invalid facet id(s) ${unknown.join(', ')} for '${route}'. Choices: ${[...facetIds].sort().join(', ')}`)

  const start = text(params, 'start_date')
  const end = text(params, 'end_date')
  const request: DataRequest = {
    path: route,
    apiKey: key,
    frequency,
    dataColumns,
    facets,
    facetParams: Object.fromEntries([...facetIds].map((id) => [id, id])),
    coverage: [node.startPeriod, node.endPeriod],
    start: start ? formatPeriod(start, periodFormat) : undefined,
    end: end ? formatPeriod(end, periodFormat) : undefined,
    sort,
  }
  const data = await paginate(ctx, request, limit)

  // transform_data: names in snake_case, the requested columns as numbers where they parse.
  const dateFormat = data.dateFormat || periodFormat
  const numeric = new Set(dataColumns.map(snakeCase))
  const rows = data.rows.map((raw) => {
    const period = parsePeriod(String(raw.period), dateFormat)
    const row: Row = { date: period.iso }
    for (const [k, value] of Object.entries(raw)) {
      if (k === 'period') continue
      const name = snakeCase(k)
      row[name] = numeric.has(name) && typeof value === 'string' ? (toFloat(value) ?? value) : value
    }
    return { row, time: period.time }
  })
  rows.sort((a, b) => (sort === 'desc' ? b.time - a.time : a.time - b.time))
  return (limit === undefined ? rows : rows.slice(0, limit)).map((r) => r.row)
}
