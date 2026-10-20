// The IMF metadata the routes read, from data/imf.json (built by data/generate.py out of OpenBB's imf_cache: dataflows,
// data structures, dimension values with their labels, indicators and presentation tables, UNIT and SCALE codelists).
// Ported from openbb_imf/utils/metadata/ (OpenBB Platform 5.0.0, Apache-2.0); modified: the answers of the metadata
// singleton are looked up in the data file instead of being derived from the shipped cache at run time.
import { unpackJson, type Packed } from '../lib/packed.js'
import packed from './data/imf.json' with { type: 'json' }

export type Param = { label: string; value: string }

export type DataflowMeta = {
  agency: string
  name: string
  dsd: string
  structure: string
  /** Dimension ids in the order the data structure lists them. */
  dims: string[]
  /** Dimension ids by position, when that differs. */
  urlDims?: string[]
  /** Codelists behind the UNIT and SCALE attributes. */
  unit?: string
  scale?: string
  /** Queryable values of each dimension, as `get_dataflow_parameters` returns them. */
  params: Record<string, [string, string][]>
  /** Presentation tables: id, name, description. */
  tables: [string, string, string][]
  extra?: string[]
  /** Indicators: dimension, code, label, description, indices into `tables`. Absent where the dataflow has none. */
  ind?: [string, string, string, string, number[]][]
}

type Data = { dataflows: Record<string, DataflowMeta>; codelists: Record<string, Record<string, string>> }

let data: Data | undefined
function load(): Data {
  data ??= unpackJson<Data>(packed as Packed)
  return data
}

export const dataflowIds = (): string[] => Object.keys(load().dataflows)

export function getDataflow(id: string): DataflowMeta | undefined {
  return Object.hasOwn(load().dataflows, id) ? load().dataflows[id] : undefined
}

export function requireDataflow(id: string): DataflowMeta {
  const df = getDataflow(id)
  if (!df) throw new Error(`Dataflow '${id}' not found.`)
  return df
}

/** The queryable values of every dimension of a dataflow (`get_dataflow_parameters`). */
export function dataflowParameters(id: string): Record<string, Param[]> {
  const df = requireDataflow(id)
  return Object.fromEntries(Object.entries(df.params).map(([dim, options]) => [dim, options.map(([value, label]) => ({ label, value }))]))
}

/** `{dimension: {code: label}}` for a dataflow (`_get_cached_translations`). */
export function translationMaps(id: string): Record<string, Map<string, string>> {
  return Object.assign(Object.create(null) as Record<string, Map<string, string>>, Object.fromEntries(Object.entries(requireDataflow(id).params).map(([dim, options]) => [dim, new Map(options.map(([value, label]) => [value, label]))])))
}

/** A codelist the data file carries (`CL_UNIT`, `CL_UNIT_MULT`, `CL_DERIVATION_TYPE`, `CL_COUNTRY`, …). */
export function codelist(id: string): Record<string, string> | undefined {
  return Object.hasOwn(load().codelists, id) ? load().codelists[id] : undefined
}

export type IndicatorEntry = {
  dataflow_id: string
  dataflow_name: string
  structure_id: string
  agency_id: string
  dimension_id: string
  indicator: string
  label: string
  description: string
  series_id: string
  extra_dimensions: string[]
  /** Presentation tables the indicator is in: id and name. */
  tables: { table_id: string; table_name: string }[]
  /** The tables' names and descriptions, as the search matches them. */
  table_search_text: string
}

const indicatorCache = new Map<string, IndicatorEntry[]>()

/** Every indicator of a dataflow, with its presentation tables (`get_indicators_in` and `_build_indicator_table_maps`). */
export function indicatorsIn(id: string): IndicatorEntry[] {
  const hit = indicatorCache.get(id)
  if (hit) return hit
  const df = requireDataflow(id)
  if (!df.ind) throw new Error(`Could not find an indicator-like dimension for dataflow '${id}'.`)
  const name = df.name.trim()
  const out = df.ind.map(([dim, code, label, description, tableIndexes]): IndicatorEntry => {
    const tables = tableIndexes.map((i) => df.tables[i]!)
    return {
      dataflow_id: id,
      dataflow_name: name,
      structure_id: df.structure,
      agency_id: df.agency,
      dimension_id: dim,
      indicator: code,
      label,
      description,
      series_id: `${id}::${code}`,
      extra_dimensions: df.extra ?? [],
      tables: tables.map(([table_id, table_name]) => ({ table_id, table_name })),
      table_search_text: tables.map(([, tableName, tableDescription]) => ` ${tableName.toLowerCase()} ${tableDescription.toLowerCase()}`).join(''),
    }
  })
  indicatorCache.set(id, out)
  return out
}
