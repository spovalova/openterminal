// economy/available_indicators, provider oecd. Ported from openbb_oecd/models/available_indicators.py and
// utils/metadata/_search_mixin.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic
// models, the indicator catalogue and the other dataflows that hold an indicator come from the metadata data file.
import { text } from '../lib/params.js'
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { matchesQuery, parseSearchQuery } from './helpers.js'
import { alsoIn, dataflowsInTopic, findByShortId, findDataflow, indicatorsOf, searchOrder, type IndicatorEntry } from './metadata.js'

/**
 * OpenBB's API hands a list param (`dataflows`, `keywords`) to the model as a list holding the one comma-joined text,
 * and the model uses a list as it is: two dataflows in one call find nothing, in OpenBB as here.
 */
const list = (v: string | undefined): string[] | undefined => (v === undefined ? undefined : [v])

/** The indicators matching a query and keywords in the given dataflows, or in every dataflow (`search_indicators`). */
function searchIndicators(query: string, dataflows: string[] | undefined, keywords: string[] | undefined): IndicatorEntry[] {
  let all: IndicatorEntry[]
  if (dataflows && dataflows.length > 0) {
    all = []
    for (const id of dataflows) {
      const df = findDataflow(id)
      if (df) all.push(...indicatorsOf(df))
    }
  } else {
    if (!query && !keywords) throw new Error("At least one of 'query', 'dataflows', or 'keywords' is required.")
    all = searchOrder().flatMap((df) => indicatorsOf(df))
  }
  if (query) {
    const phrases = parseSearchQuery(query)
    all = all.filter((ind) => matchesQuery(`${ind.label} ${ind.description} ${ind.dataflow_name} ${ind.dataflow_id} ${ind.indicator}`.toLowerCase(), phrases))
  }
  if (keywords) {
    for (const rawKeyword of keywords) {
      const kw = rawKeyword.trim()
      if (kw.toLowerCase().startsWith('not ')) {
        const exclude = kw.slice(4).trim().toLowerCase()
        all = all.filter((i) => !`${i.label} ${i.description} ${i.indicator}`.toLowerCase().includes(exclude))
      } else {
        const include = kw.toLowerCase()
        all = all.filter((i) => `${i.label} ${i.description} ${i.indicator}`.toLowerCase().includes(include))
      }
    }
  }
  return all
}

export async function availableIndicators(params: NativeParams, _ctx: NativeCtx): Promise<Row[]> {
  let dataflows = list(text(params, 'dataflows'))
  const topic = text(params, 'topic')
  // A topic stands for the dataflows filed under it, narrowed to the ones asked for.
  if (topic) {
    const topicDataflows = dataflowsInTopic(topic)
    if (dataflows && dataflows.length > 0) {
      const wanted = dataflows
      const intersected = topicDataflows.filter((d) => wanted.some((f) => d.endsWith(f) || d === f))
      dataflows = intersected.length > 0 ? intersected : dataflows
    } else dataflows = topicDataflows
  }
  const results = searchIndicators(text(params, 'query') ?? '', dataflows, list(text(params, 'keywords')))
  if (results.length === 0) return []

  return results.map((ind) => {
    const df = findByShortId(ind.dataflow_id)
    const row: Row = {
      symbol_root: ind.indicator,
      symbol: ind.dataflow_id && ind.indicator ? `${ind.dataflow_id}::${ind.indicator}` : ind.indicator || ind.dataflow_id,
      description: ind.description,
      label: ind.label,
      dataflow_id: ind.dataflow_id,
      dataflow_name: ind.dataflow_name,
      dimension_id: ind.dimension_id,
      frequencies: df?.freq ?? [],
      transformations: df?.tx ?? [],
      member_of: alsoIn(ind.indicator, ind.dataflow_id),
    }
    if (ind.parent) row.parent = ind.parent
    return row
  })
}
