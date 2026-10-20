// The EIA dataset routes, provider eia: coal/*, petroleum/*, natural_gas/*, electricity/*, electricity_grid/*,
// densified_biomass/*, nuclear_outages/*, state_electricity_profiles/*, aeo, ieo, crude_oil_imports, international,
// seds and total_energy. Ported from openbb_us_eia/models/registry.py and the ~200 dataset models it lists, which all
// run the same generic query (openbb_us_eia/utils/api_query.py: transform_dataset_query, extract_dataset_data,
// transform_dataset_data) over a catalog entry (OpenBB Platform 5.0.0, Apache-2.0); modified: one handler per route
// built from catalog.json instead of one pydantic model per route.
import type { NativeCtx, NativeHandler, NativeParams, Row } from '../types.js'
import { apiKey, paginate, transformRows, type DataRequest, type PageLimits } from './api.js'
import { CATALOG, formatPeriod, getDataset, resolveDataColumns, resolveFacets, resolveFrequency } from './catalog.js'

/** Parameters every dataset takes; the others are facet filters (STANDARD_FIELDS in utils/catalog.py). */
const STANDARD_FIELDS = new Set(['dataset', 'release', 'frequency', 'data_type', 'start_date', 'end_date', 'sort', 'limit'])

/** A parameter as the text OpenBB's models receive: lists joined with commas, empty as absent. */
export function text(params: NativeParams, name: string): string | undefined {
  const v = params[name]
  if (v === undefined || v === null) return undefined
  const s = Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean).join(',') : String(v)
  return s === '' ? undefined : s
}

/** `limit: int | None = Field(gt=0)` and `sort: Literal["asc", "desc"] = "asc"`. */
export function limitAndSort(params: NativeParams): { limit: number | undefined; sort: 'asc' | 'desc' } {
  const rawLimit = text(params, 'limit')
  const limit = rawLimit === undefined ? undefined : Number(rawLimit)
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) throw new Error(`limit: Input should be greater than 0 (got ${rawLimit})`)
  const sort = text(params, 'sort') ?? 'asc'
  if (sort !== 'asc' && sort !== 'desc') throw new Error(`sort: Input should be 'asc' or 'desc' (got ${sort})`)
  return { limit, sort }
}

export function datasetHandler(route: string, limits: PageLimits = {}): NativeHandler {
  const target = CATALOG.routes[route]
  if (!target) throw new Error(`${route} is not an EIA dataset route`)
  const [group, fixedDataset, defaultRelease] = target
  return async (params: NativeParams, ctx: NativeCtx): Promise<Row[]> => {
    const key = apiKey(ctx)
    const { limit, sort } = limitAndSort(params)
    // `dataset_key`: the model's fixed dataset, else its `dataset` or `release` parameter, else the group's first.
    const datasetKey = fixedDataset ?? text(params, 'dataset') ?? text(params, 'release') ?? defaultRelease ?? Object.keys(CATALOG.groups[group]!.datasets)[0]!
    const spec = getDataset(group, datasetKey)
    const [frequency, [format, path]] = resolveFrequency(spec, text(params, 'frequency'))
    const dataColumns = resolveDataColumns(spec, text(params, 'data_type'))
    const filters: Record<string, string | undefined> = {}
    for (const name of Object.keys(params)) if (!STANDARD_FIELDS.has(name)) filters[name] = text(params, name)
    const facets = resolveFacets(group, spec, frequency, filters)

    const start = text(params, 'start_date')
    const end = text(params, 'end_date')
    const request: DataRequest = {
      path,
      apiKey: key,
      frequency,
      dataColumns,
      facets,
      facetParams: Object.fromEntries(Object.entries(spec.facets).map(([canonical, facet]) => [facet.id, canonical])),
      coverage: [spec.start, spec.end],
      start: start ? formatPeriod(start, format) : undefined,
      end: end ? formatPeriod(end, format) : undefined,
      sort,
    }
    const data = await paginate(ctx, request, limit, limits)

    const rows = transformRows(spec, data.rows, data.dateFormat || format)
    rows.sort((a, b) => (sort === 'desc' ? b.time - a.time : a.time - b.time))
    return (limit === undefined ? rows : rows.slice(0, limit)).map((r) => r.row)
  }
}

/** Every dataset route of the provider, keyed by OpenBB route. */
export const DATASET_ROUTES: Record<string, NativeHandler> = Object.fromEntries(Object.keys(CATALOG.routes).map((route) => [route, datasetHandler(route)]))
