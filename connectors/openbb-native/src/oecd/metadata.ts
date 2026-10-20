// The OECD metadata the routes read, from data/oecd.json (built by data/generate.py out of OpenBB's oecd_cache:
// dataflows with their dimensions, dimension values, countries, searchable indicators, topics). Ported from
// openbb_oecd/utils/metadata/ (OpenBB Platform 5.0.0, Apache-2.0); modified: the answers of the metadata singleton are
// looked up in the data file instead of being derived from the 200 MB shipped cache at run time.
import { unpackJson, type Packed } from '../lib/packed.js'
import packed from './data/oecd.json' with { type: 'json' }

export type DataflowMeta = {
  /** The full id, such as `DSD_PRICES@DF_PRICES_ALL`. */
  id: string
  short: string
  agency: string
  version: string
  name: string
  /** Dimension ids in key order. */
  dims: string[]
  /** False for a dataflow without a time dimension. */
  time?: boolean
  /** Per dimension, the index of its values in `lists`; -1 for none. */
  cl: number[]
  country: number
  /** Index into `search`; -1 for none. */
  ind: number
  freq: string[]
  tx: string[]
  cats?: string[]
  /** Ids of the dataflow's presentation tables. */
  tables?: string[]
}

type Data = {
  dataflows: DataflowMeta[]
  /** Dimension values: codes, or `[code, label]` pairs where labels are read. */
  lists: (string | [string, string])[][]
  /** Searchable indicators: dimension, code, label, description or null, parent or null. */
  search: [string, string, string, string | null, string | null][][]
  /** Per indicator code held by several dataflows: the first eleven (indices into `dataflows`) and how many in all. */
  also: Record<string, [number[], number]>
  /** The order OpenBB searches the dataflows in. */
  order?: number[]
}

let data: Data | undefined
let byFullId: Map<string, DataflowMeta> | undefined
let byShortId: Map<string, DataflowMeta> | undefined
let nameByShort: Map<string, string> | undefined

function load(): Data {
  if (!data) {
    data = unpackJson<Data>(packed as Packed)
    byFullId = new Map(data.dataflows.map((d) => [d.id, d] as const))
    // A short id answers to the last dataflow that has it, as `_short_id_map` does.
    byShortId = new Map(data.dataflows.map((d) => [d.short, d] as const))
    nameByShort = new Map(data.dataflows.map((d) => [d.short, d.name] as const))
  }
  return data
}

export function allDataflows(): DataflowMeta[] {
  return load().dataflows
}

/** The dataflows in the order OpenBB's indicator search walks them. */
export function searchOrder(): DataflowMeta[] {
  const d = load()
  return d.order ? d.order.map((i) => d.dataflows[i]!) : d.dataflows
}

/** A short or full dataflow id as the dataflow (`_resolve_dataflow_id`). */
export function resolveDataflow(id: string): DataflowMeta {
  load()
  const hit = byFullId!.get(id) ?? byShortId!.get(id)
  if (!hit) throw new Error(`Unknown OECD dataflow: '${id}'. Use list_dataflows() to see available dataflows.`)
  return hit
}

/** A dataflow if the id names one, by full id or by short id. */
export function findDataflow(id: string): DataflowMeta | undefined {
  load()
  return byFullId!.get(id) ?? byShortId!.get(id)
}

/** The dataflow a short id stands for (`_short_id_map`), else the one with that full id. */
export function findByShortId(id: string): DataflowMeta | undefined {
  load()
  return byShortId!.get(id) ?? byFullId!.get(id)
}

/** The dimension ids of a dataflow in key order (`get_dimension_order`). */
export const dimensionOrder = (id: string): string[] => resolveDataflow(id).dims

export type Param = { label: string; value: string }

/** The values of each dimension (`get_dataflow_parameters`): every code of its codelist, sorted; labels only where the file keeps them. */
export function dataflowParameters(id: string): Record<string, Param[]> {
  const df = resolveDataflow(id)
  const d = load()
  const out: Record<string, Param[]> = {}
  df.dims.forEach((dim, i) => {
    const at = df.cl[i]!
    out[dim] = at < 0 ? [] : d.lists[at]!.map((e) => (typeof e === 'string' ? { label: e, value: e } : { label: e[1], value: e[0] }))
  })
  return out
}

/** The codes of the country codelist of a dataflow, with their labels, in the codelist's order (`_get_country_codelist`). */
export function countryCodelist(id: string): [string, string][] {
  const df = resolveDataflow(id)
  return df.country < 0 ? [] : (load().lists[df.country] as [string, string][])
}

/** Python's `_normalize_label`: a country label as lower snake case. */
export function normalizeLabel(label: string): string {
  let s = label.replace(/\s*\(.*?\)\s*/g, '')
  s = s.split(',')[0]!
  s = s.trim().toLowerCase().replace(/-/g, '_').replace(/ /g, '_')
  s = s.replace(/_+/g, '_')
  return s.replace(/^_+|_+$/g, '')
}

/** Country names or codes as the dataflow's codes (`resolve_country_codes`); `all` is none. */
export function resolveCountryCodes(dataflow: string, input: string): string[] {
  if (!input || ['all', '*'].includes(input.trim().toLowerCase())) return []
  const countries = countryCodelist(dataflow)
  if (countries.length === 0) return input.split(',').map((c) => c.trim().toUpperCase()).filter(Boolean)
  const lookup = new Map<string, string>()
  for (const [code, label] of countries) {
    lookup.set(code.toUpperCase(), code)
    lookup.set(code.toLowerCase(), code)
    lookup.set(normalizeLabel(label), code)
  }
  const resolved: string[] = []
  for (const part of input.split(',').map((p) => p.trim()).filter(Boolean)) {
    const match = lookup.get(part) || lookup.get(part.toUpperCase()) || lookup.get(part.toLowerCase()) || lookup.get(normalizeLabel(part))
    if (match) resolved.push(match)
    else {
      const available = countries.map(([code]) => code).sort()
      throw new Error(`Invalid country '${part}' for dataflow '${dataflow}'. Available codes (${available.length} total): ${available.slice(0, 20).join(', ')}${available.length > 20 ? ' ...' : ''}`)
    }
  }
  return resolved
}

export type IndicatorEntry = {
  dataflow_id: string
  dataflow_name: string
  dimension_id: string
  indicator: string
  label: string
  description: string
  parent?: string
  /** The dataflow's full id, to find its frequencies and transformations. */
  full_id: string
}

const searchCache = new Map<string, IndicatorEntry[]>()

/** What a search of one dataflow returns before the query is applied (`search_indicators` with `dataflows`). */
export function indicatorsOf(df: DataflowMeta): IndicatorEntry[] {
  const hit = searchCache.get(df.id)
  if (hit) return hit
  const d = load()
  const out =
    df.ind < 0
      ? []
      : d.search[df.ind]!.map(([dimension_id, indicator, label, description, parent]): IndicatorEntry => {
          const entry: IndicatorEntry = { dataflow_id: df.short, dataflow_name: df.name, dimension_id, indicator, label, description: description ?? label, full_id: df.id }
          if (parent) entry.parent = parent
          return entry
        })
  searchCache.set(df.id, out)
  return out
}

/** The dataflows whose topic taxonomy starts with a topic, by full id (`list_dataflows(topic)`). */
export function dataflowsInTopic(topic: string): string[] {
  const upper = topic.toUpperCase()
  return allDataflows().filter((df) => (df.cats ?? []).some((c) => c.split('.')[0] === upper)).map((df) => df.id).sort()
}

/** Other dataflows holding an indicator, as OpenBB lists them in `member_of` (`_build_also_in`). */
export function alsoIn(indicator: string, dataflowShortId: string): string[] {
  const d = load()
  const hit = Object.hasOwn(d.also, indicator) ? d.also[indicator] : undefined
  if (!indicator || !hit) return []
  const [first, total] = hit
  const unique = first.map((i) => d.dataflows[i]!.short).filter((short) => short !== dataflowShortId)
  // The code is in the asking dataflow's own list, so it is one of the `total`; leaving that one out leaves total - 1.
  const others = total - 1
  const labeled = unique.slice(0, 10).map((short) => {
    const name = nameByShort!.get(short) ?? ''
    return name ? `${short} (${name})` : short
  })
  if (others > 10) labeled.push(`... and ${others - 10} more`)
  return labeled
}
