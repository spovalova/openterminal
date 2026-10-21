// The EIA catalog commands: the datasets OpenBB serves, and the values a dataset's filters take. The names, categories,
// descriptions and labelled choices come from datasets.json (built by generate-datasets.py out of OpenBB's
// eia_catalog.json.xz); the rest of a dataset is catalog.json's.
import { compareText } from '../lib/compare-text.js'
import { unpackJson, type Packed } from '../lib/packed.js'
import { text } from '../lib/params.js'
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { API_BASE, apiKey, getJson } from './api.js'
import { CATALOG } from './catalog.js'
import packed from './datasets.json' with { type: 'json' }

type Data = {
  /** [group, dataset, name, category, description], in the catalog's order. */
  datasets: [string, string, string, string, string | null][]
  /** Distinct choice lists: [value, param, label]. */
  pool: [string, string, string][][]
  /** "group/dataset/facet" → index into pool, for the facets whose choices are embedded. */
  choices: Record<string, number>
}

let data: Data | undefined
const load = (): Data => (data ??= unpackJson<Data>(packed as Packed))

/** The dataset slugs of a group, in the catalog's order (`dataset_choices`); an unknown group is an error (`get_group`). */
function datasetChoices(group: string): string[] {
  const slugs = load().datasets.filter(([g]) => g === group).map(([, slug]) => slug)
  if (slugs.length === 0) throw new Error(`Unknown EIA group '${group}'. Choices: ${Object.keys(CATALOG.groups).join(', ')}`)
  return slugs
}

// eia/datasets (command, no provider). Ported from openbb_us_eia/eia_router.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows; the catalog is catalog.json plus datasets.json, and a missing value is left out of the row instead of being None.
export async function datasets(params: NativeParams): Promise<Row[]> {
  const group = text(params, 'group')
  const rows: Row[] = []
  for (const [groupName, slug, name, category, description] of load().datasets) {
    if (group !== undefined && groupName !== group) continue
    const spec = CATALOG.groups[groupName]!.datasets[slug]!
    const row: Row = {
      group: groupName,
      dataset: slug,
      name,
      category,
      route: spec.path,
      frequencies: Object.keys(spec.frequencies).join(','),
      default_frequency: spec.frequency,
      data_columns: Object.keys(spec.columns).join(','),
      filters: Object.entries(spec.facets).filter(([, facet]) => facet.filterable !== false).map(([facet]) => facet).join(','),
      start_period: spec.start,
      end_period: spec.end,
      description: description || null,
    }
    rows.push(Object.fromEntries(Object.entries(row).filter(([, v]) => v !== null && v !== undefined)))
  }
  return rows
}

/** Python's `str()` of a JSON scalar. */
const pyStr = (v: unknown): string => (v === null || v === undefined ? 'None' : String(v))

// eia/facet_options (command, no provider). Ported from openbb_us_eia/eia_router.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows; a facet without embedded choices asks the API with eia_api_key and throws MissingCredential when there is none, where Python sends an empty key and relays the API's refusal.
export async function facetOptions(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const group = text(params, 'group') ?? ''
  const facet = text(params, 'facet') ?? ''
  const dataset = text(params, 'dataset') ?? datasetChoices(group)[0]!
  const slugs = datasetChoices(group)
  if (!slugs.includes(dataset)) throw new Error(`Unknown dataset '${dataset}' for EIA group '${group}'. Choices: ${slugs.join(', ')}`)
  const spec = CATALOG.groups[group]!.datasets[dataset]!
  const facets = Object.keys(spec.facets)
  if (!facets.includes(facet)) throw new Error(`'${facet}' is not a filter of dataset '${dataset}'. Choices: ${facets.join(', ')}`)

  const d = load()
  const embedded = d.choices[`${group}/${dataset}/${facet}`]
  if (embedded !== undefined) {
    // Choices that share a readable value are one record, with all their codes.
    const grouped = new Map<string, { value: string; label: string; code: string[] }>()
    for (const [value, param, label] of d.pool[embedded]!) {
      const slug = param || value
      const record = grouped.get(slug) ?? { value: slug, label, code: [] }
      grouped.set(slug, record)
      record.code.push(value)
    }
    return [...grouped.values()].map((record) => ({ ...record, code: record.code.join(',') })).sort((a, b) => compareText(a.label, b.label))
  }

  const key = apiKey(ctx)
  const response = await getJson(ctx, `${API_BASE}/${spec.path}/facet/${spec.facets[facet]!.id}?api_key=${key}`)
  const values = ((response.response ?? {}) as { facets?: Record<string, unknown>[] }).facets ?? []
  return values
    .map((item) => ({ value: pyStr(item.id), label: pyStr(item.name || item.id), code: pyStr(item.id) }))
    .sort((a, b) => compareText(a.label, b.label))
}
