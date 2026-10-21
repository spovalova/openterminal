// The OECD catalogue the five metadata commands read: the topic tree, the table map, and the values, labels and
// descriptions of each dataflow's dimensions. Ported from openbb_oecd/utils/metadata/ (_public_api_mixin.py,
// _search_mixin.py, _indicator_mixin.py, _helpers.py; OpenBB Platform 5.0.0, Apache-2.0); modified: the answers the
// shipped cache would give are the pieces in data/commands.json (built by data/generate-commands.py, which checks
// that they rebuild what OpenBB returns), and the dataflows, their topic paths and short ids are metadata.ts's.
import { compareText } from '../lib/compare-text.js'
import { unpackJson, type Packed } from '../lib/packed.js'
import packed from './data/commands.json' with { type: 'json' }
import { allDataflows, resolveDataflow, type DataflowMeta } from './metadata.js'

type TreeNode = [id: string, name: string, children: TreeNode[]]
/** [dimension id, dimension name, list, allowed, descs, loose, parents]; -1 where a dimension has none of that piece. */
type Piece = [string, string, number, number, number, number, number]

type Data = {
  tree: TreeNode[]
  /** The values of a dimension as `get_dataflow_parameters` lists them: [codes, labels]. */
  lists: [string[], string[]][]
  /** The codes a dataflow's content constraint allows for a dimension. */
  allowed: string[][]
  /** Description of each code of a codelist; `descs` is exact, `loose` also falls back to another version of it. */
  descs: Record<string, string>[]
  /** {code: parent code} of an indicator dimension's codelist. */
  parents: Record<string, string>[]
  dataflows: Record<string, [description: string, indicatorDimension: string, dimensions: Piece[]]>
}

let data: Data | undefined
const load = (): Data => (data ??= unpackJson<Data>(packed as Packed))

// ---- the topic taxonomy ----

type Category = { id: string; name: string; path: string; children: Category[] }

let categories: { tree: Category[]; names: Map<string, string>; dataflows: Map<string, string[]> } | undefined

/** The taxonomy tree with its paths, the name of each path, and the dataflows in each (`_taxonomy_tree`, `_category_names`, `_category_to_dfs`). */
function taxonomy(): NonNullable<typeof categories> {
  if (categories) return categories
  const names = new Map<string, string>()
  const build = (nodes: TreeNode[], prefix: string): Category[] =>
    nodes.map(([id, name, children]) => {
      const path = prefix ? `${prefix}.${id}` : id
      names.set(path, name)
      return { id, name, path, children: build(children, path) }
    })
  const tree = build(load().tree, '')
  const dataflows = new Map<string, string[]>()
  for (const df of allDataflows()) for (const path of df.cats ?? []) dataflows.set(path, [...(dataflows.get(path) ?? []), df.id])
  categories = { tree, names, dataflows }
  return categories
}

export type DataflowListing = { label: string; value: string; topic: string; topic_name: string; subtopic: string; subtopic_name: string; all_subtopics: string[] }

/** The dataflows as `[{label, value, topic, subtopic, …}]`, by id, optionally of one topic (`list_dataflows`). */
export function listDataflows(topic?: string): DataflowListing[] {
  const { names } = taxonomy()
  const topicUpper = topic ? topic.toUpperCase() : ''
  const result: DataflowListing[] = []
  for (const df of allDataflows()) {
    const cats = df.cats ?? []
    let primaryTopic = ''
    let primarySubtopic = ''
    const subtopics: string[] = []
    for (const path of cats) {
      const parts = path.split('.')
      const t = parts[0] ?? ''
      const s = parts.length > 1 ? parts[1]! : ''
      if (!primaryTopic) primaryTopic = t
      if (topicUpper) {
        if (t === topicUpper && s) {
          subtopics.push(s)
          if (!primarySubtopic) primarySubtopic = s
        }
      } else if (s) {
        if (!primarySubtopic) primarySubtopic = s
        subtopics.push(s)
      }
    }
    if (topicUpper && !cats.some((c) => c.split('.')[0] === topicUpper)) continue
    const shownTopic = topicUpper || primaryTopic
    result.push({
      label: df.name,
      value: df.id,
      topic: shownTopic,
      topic_name: names.get(shownTopic) ?? '',
      subtopic: primarySubtopic,
      subtopic_name: primarySubtopic ? (names.get(`${shownTopic}.${primarySubtopic}`) ?? '') : '',
      all_subtopics: [...new Set(subtopics)].sort(compareText),
    })
  }
  return result.sort((a, b) => compareText(a.value, b.value))
}

type TopicNode = { id: string; name: string; dataflow_count: number; subtopics: TopicNode[] }

/** The topic tree with the number of dataflows under each node, empty branches left out (`list_topics`). */
function listTopicTree(): TopicNode[] {
  const { tree, dataflows } = taxonomy()
  const annotate = (node: Category): TopicNode => {
    const direct = dataflows.get(node.path)?.length ?? 0
    const children = node.children.map(annotate).filter((c) => c.dataflow_count > 0)
    return { id: node.id, name: node.name, dataflow_count: direct + children.reduce((sum, c) => sum + c.dataflow_count, 0), subtopics: children }
  }
  return tree.map(annotate)
}

export type TopicRow = { topic_id: string; topic: string; subtopic_id: string; subtopic: string; dataflows: number }

/** The topic tree as one row per topic and subtopic (`_build_topic_rows`). */
export function topicRows(): TopicRow[] {
  const rows: TopicRow[] = []
  for (const t of listTopicTree()) {
    if (!t.dataflow_count) continue
    if (t.subtopics.length > 0) {
      for (const s of t.subtopics) if (s.dataflow_count) rows.push({ topic_id: t.id, topic: t.name, subtopic_id: s.id, subtopic: s.name, dataflows: s.dataflow_count })
    } else rows.push({ topic_id: t.id, topic: t.name, subtopic_id: '', subtopic: '', dataflows: t.dataflow_count })
  }
  return rows
}

// ---- the table map ----

export type TableRow = {
  topic: string
  topic_id: string
  subtopic: string
  subtopic_id: string
  sub_subtopic: string
  path: string
  table: string
  dataflow_id: string
  short_id: string
  countries: number
}

type Family = { representative: string; shortId: string; name: string; members: number }

const COUNTRY_SUFFIX = /^_?([A-Z]{2,3})$/

/** Dataflows of one data structure, in the catalogue's order (the part of the id before `@`). */
function byStructure(): Map<string, DataflowMeta[]> {
  const groups = new Map<string, DataflowMeta[]>()
  for (const df of allDataflows()) {
    const dsd = df.id.includes('@') ? df.id.split('@')[0]! : df.id
    groups.set(dsd, [...(groups.get(dsd) ?? []), df])
  }
  return groups
}

/** Dataflow families that are per-country splits of the same table (`_detect_country_families`). */
function countryFamilies(): Map<string, Family> {
  const familyMap = new Map<string, Family>()
  for (const dfs of byStructure().values()) {
    if (dfs.length < 5) continue
    const shorts = dfs.map((df) => df.short)
    let prefix = shorts[0]!
    for (const s of shorts.slice(1)) if (s.length < prefix.length) prefix = s
    for (const sid of shorts) while (prefix && !sid.startsWith(prefix)) prefix = prefix.slice(0, -1)
    if (prefix.length < 4) continue
    const suffixes = dfs.map((df) => df.short.slice(prefix.length))
    const countryMembers = suffixes.filter((sfx) => COUNTRY_SUFFIX.test(sfx)).length
    if (countryMembers / dfs.length < 0.7) continue
    let representative = dfs.find((_, i) => ['ALL', '_ALL'].includes(suffixes[i]!.toUpperCase()))
    representative ??= dfs.find((_, i) => suffixes[i] === '')
    if (!representative) {
      const nonCountry = dfs.filter((_, i) => !COUNTRY_SUFFIX.test(suffixes[i]!))
      representative = nonCountry[0] ?? dfs.reduce((best, df) => (compareText(df.short, best.short) < 0 ? df : best))
    }
    const family: Family = { representative: representative.id, shortId: representative.short, name: representative.name, members: dfs.length }
    for (const df of dfs) familyMap.set(df.id, family)
  }
  return familyMap
}

/** Section dataflows mapped to the root of their family inside one data structure (`_detect_section_families`). */
function sectionFamilies(): Map<string, string> {
  const sectionMap = new Map<string, string>()
  for (const dfs of byStructure().values()) {
    if (dfs.length < 2) continue
    const sorted = [...dfs].sort((a, b) => a.short.length - b.short.length || compareText(a.short, b.short))
    const roots: DataflowMeta[] = []
    for (const df of sorted) {
      const parent = roots.find((r) => df.short.startsWith(`${r.short}_`))
      if (parent) sectionMap.set(df.id, parent.id)
      else roots.push(df)
    }
  }
  return sectionMap
}

let tableMapCache: TableRow[] | undefined

/** A flat, navigable map of every OECD presentation table (`table_map`). */
export function tableMap(): TableRow[] {
  if (tableMapCache) return tableMapCache
  const { tree, dataflows } = taxonomy()
  const byId = new Map(allDataflows().map((df) => [df.id, df] as const))
  const families = countryFamilies()
  const sections = sectionFamilies()
  const emitted = new Set<string>()
  const rows: TableRow[] = []

  const makeRow = (crumb: string[], ids: string[], table: string, dataflowId: string, shortId: string, countries: number): TableRow => ({
    topic: crumb[0] ?? '',
    topic_id: ids[0] ?? '',
    subtopic: crumb[1] ?? '',
    subtopic_id: ids[1] ?? '',
    sub_subtopic: crumb.length > 2 ? crumb.slice(2).join(' > ') : '',
    path: crumb.join(' > '),
    table,
    dataflow_id: dataflowId,
    short_id: shortId,
    countries,
  })

  const walk = (nodes: Category[], breadcrumb: string[], idBreadcrumb: string[]): void => {
    for (const node of nodes) {
      const crumb = [...breadcrumb, node.name]
      const ids = [...idBreadcrumb, node.id]
      for (const fid of [...(dataflows.get(node.path) ?? [])].sort(compareText)) {
        const entry = byId.get(fid)
        if (!entry || sections.has(fid)) continue
        const family = families.get(fid)
        if (family) {
          const key = `${node.path}\u0000${family.representative}`
          if (emitted.has(key)) continue
          emitted.add(key)
          rows.push(makeRow(crumb, ids, family.name, family.representative, family.shortId, family.members))
        } else rows.push(makeRow(crumb, ids, entry.name, fid, entry.short, 0))
      }
      walk(node.children, crumb, ids)
    }
  }
  walk(tree, [], [])
  tableMapCache = rows.sort((a, b) => compareText(a.path, b.path) || compareText(a.table, b.table))
  return tableMapCache
}

/** Search the table map by keyword: space-separated terms are AND-ed, `|` is OR within a term (`find_tables`). */
export function findTables(query: string): TableRow[] {
  const full = tableMap()
  const tokens = query.trim().split(/\s+/).filter(Boolean).map((t) => t.toLowerCase())
  if (tokens.length === 0) return full
  const matched = new Map<string, TableRow>()
  for (const row of full) {
    const haystack = [row.topic, row.subtopic, row.sub_subtopic, row.path, row.table, row.dataflow_id, row.short_id].join(' ').toLowerCase()
    if (!tokens.every((token) => token.split('|').some((alt) => haystack.includes(alt)))) continue
    const prev = matched.get(row.dataflow_id)
    if (!prev || row.path.length > prev.path.length) matched.set(row.dataflow_id, row)
  }
  return [...matched.values()].sort((a, b) => compareText(a.path, b.path) || compareText(a.table, b.table))
}

export type TableListing = { table_id: string; name: string; topic: string; topic_id: string; subtopic: string; subtopic_id: string; dataflow_id: string }

/** The tables with names and topics, by keyword, topic and subtopic (`list_tables`). */
export function listTables(query?: string, topic?: string, subtopic?: string): TableListing[] {
  let rows = query ? findTables(query) : tableMap()
  if (topic) rows = rows.filter((r) => r.topic_id.toUpperCase() === topic.toUpperCase())
  if (subtopic) rows = rows.filter((r) => r.subtopic_id.toUpperCase() === subtopic.toUpperCase())
  return rows.map((r) => ({ table_id: r.short_id, name: r.table, topic: r.topic, topic_id: r.topic_id, subtopic: r.subtopic, subtopic_id: r.subtopic_id, dataflow_id: r.dataflow_id }))
}

// ---- the dimensions of a dataflow ----

export type Value = { value: string; label: string; description: string }

const mapCache = new Map<string, Map<string, string>>()

/** An interned code → text map as a Map, so codes like `constructor` are looked up as codes. */
function mapOf(kind: 'descs' | 'parents', index: number): Map<string, string> {
  if (index < 0) return new Map()
  const key = `${kind}:${index}`
  let hit = mapCache.get(key)
  if (!hit) {
    hit = new Map(Object.entries(load()[kind][index]!))
    mapCache.set(key, hit)
  }
  return hit
}

/** The values of a dimension as `get_dataflow_parameters` lists them (sorted by code). */
function baseEntries(piece: Piece): { value: string; label: string }[] {
  if (piece[2] < 0) return []
  const [codes, labels] = load().lists[piece[2]]!
  return codes.map((value, i) => ({ value, label: labels[i]! }))
}

/** The dimension's values the content constraint allows, in the codelist's order (`get_constrained_values`). */
function constrainedEntries(piece: Piece): { value: string; label: string }[] {
  const entries = baseEntries(piece)
  if (piece[3] < 0) return entries
  const allowed = new Set(load().allowed[piece[3]]!)
  return entries.filter((e) => allowed.has(e.value))
}

function pieces(fullId: string): [string, string, Piece[]] {
  const entry = load().dataflows[fullId]
  if (!entry) throw new Error(`Unknown OECD dataflow: '${fullId}'. Use list_dataflows() to see available dataflows.`)
  return entry
}

/** Dimension values filtered by the content constraints, with descriptions (`get_constrained_values`). */
export function constrainedValues(dataflowId: string): Record<string, Value[]> {
  const [, , dims] = pieces(resolveDataflow(dataflowId).id)
  const out: Record<string, Value[]> = {}
  for (const piece of dims) {
    const descriptions = mapOf('descs', piece[4])
    out[piece[0]] = constrainedEntries(piece).map((e) => ({ value: e.value, label: e.label, description: descriptions.get(e.value) ?? e.label }))
  }
  return out
}

export type IndicatorNode = { code: string; label: string; children: IndicatorNode[] }

/** A tree of codes by their parents, siblings by label (`_build_code_tree`). */
function buildCodeTree(codes: { value: string; label: string }[], parents: Map<string, string>): IndicatorNode[] {
  const nodes = new Map(codes.map((c) => [c.value, { code: c.value, label: c.label, children: [] as IndicatorNode[] }] as const))
  const roots: IndicatorNode[] = []
  for (const [code, node] of nodes) {
    const parent = parents.get(code)
    if (parent && nodes.has(parent)) nodes.get(parent)!.children.push(node)
    else roots.push(node)
  }
  const sort = (items: IndicatorNode[]): void => {
    items.sort((a, b) => compareText(a.label, b.label))
    for (const item of items) if (item.children.length > 0) sort(item.children)
  }
  sort(roots)
  return roots
}

export type DimensionInfo = { id: string; name: string; constrained_codes: number; values: Value[] }

export type Description = {
  short_id: string
  name: string
  description: string
  dataflow_id: string
  dimensions: DimensionInfo[]
  table_groups: Value[]
  indicator_dimension: string
  indicator_count: number
  indicator_tree: IndicatorNode[]
}

const countLeaves = (nodes: IndicatorNode[]): number => nodes.reduce((total, n) => total + (n.children.length > 0 ? countLeaves(n.children) : 1), 0)

const TABLE_GROUP_CANDIDATES = ['TABLE_IDENTIFIER', 'CHAPTER']

/** A comprehensive description of a dataflow and its dimensions (`describe_dataflow`). */
export function describeDataflow(dataflowId: string): Description {
  const df = resolveDataflow(dataflowId)
  const [description, indicatorDimension, dims] = pieces(df.id)

  const dimensions: DimensionInfo[] = dims.map((piece) => {
    const base = baseEntries(piece)
    const labels = new Map(base.map((e) => [e.value, e.label] as const))
    let shown = constrainedEntries(piece)
    if (piece[3] >= 0 && shown.length === 0) {
      const allowed = load().allowed[piece[3]]!
      // A constraint none of the codelist's values meets still lists its codes.
      if (allowed.length > 0) shown = [...allowed].sort(compareText).map((value) => ({ value, label: labels.get(value) ?? value }))
    }
    const descriptions = mapOf('descs', piece[5])
    return {
      id: piece[0],
      name: piece[1],
      constrained_codes: shown.length,
      values: shown.map((e) => ({ value: e.value, label: e.label, description: descriptions.get(e.value) ?? e.label })),
    }
  })

  // get_table_groups: the values of the first table-group dimension, constrained, with the codelist's own descriptions.
  const groupDimension = TABLE_GROUP_CANDIDATES.map((id) => dims.find((p) => p[0] === id)).find((p) => p !== undefined)
  const tableGroups: Value[] = groupDimension
    ? (() => {
        const descriptions = mapOf('descs', groupDimension[4])
        return constrainedEntries(groupDimension).map((e) => ({ value: e.value, label: e.label, description: descriptions.get(e.value) ?? e.label }))
      })()
    : []

  // get_indicator_tree: the indicator dimension's constrained codes, arranged by the codelist's parents.
  const indicator = indicatorDimension ? dims.find((p) => p[0] === indicatorDimension) : undefined
  const indicatorTree = indicator ? buildCodeTree(constrainedEntries(indicator), mapOf('parents', indicator[6])) : []

  return {
    short_id: df.short,
    name: df.name,
    description,
    dataflow_id: df.id,
    dimensions,
    table_groups: tableGroups,
    indicator_dimension: indicatorDimension,
    indicator_count: countLeaves(indicatorTree),
    indicator_tree: indicatorTree,
  }
}
