// economy/available_indicators, provider imf. Ported from openbb_imf/models/available_indicators.py and
// utils/metadata/_search_mixin.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models,
// the indicator catalogue and the presentation tables each indicator is in come from the metadata data file.
import { text } from '../lib/params.js'
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { parseSearchQuery } from './helpers.js'
import { dataflowIds, indicatorsIn, type IndicatorEntry } from './metadata.js'

/** The catalogue entries that match a semicolon-separated list of phrases (`_filter_indicators_by_query`). */
function filterByQuery(indicators: IndicatorEntry[], query: string): IndicatorEntry[] {
  if (!query) return indicators
  const phrases = query.split(';').map((p) => p.trim()).filter(Boolean)
  if (phrases.length === 0) return indicators
  return indicators.filter((indicator) => {
    const haystack = `${indicator.label.toLowerCase()} ${indicator.description.toLowerCase()} ${indicator.dataflow_name.toLowerCase()} ${indicator.dataflow_id.toLowerCase()} ${indicator.indicator.toLowerCase()} ${indicator.table_search_text}`
    return phrases.some((phrase) => {
      const parsed = parseSearchQuery(phrase)
      return parsed.length === 0 ? haystack.includes(phrase.toLowerCase()) : parsed.some((orGroup) => orGroup.every((term) => haystack.includes(term)))
    })
  })
}

/** Keywords that must appear in an indicator's code, label, description or tables, or, after `not `, must not (`_filter_indicators_by_keywords`). */
function filterByKeywords(indicators: IndicatorEntry[], keywords: string[] | undefined): IndicatorEntry[] {
  if (!keywords || keywords.length === 0) return indicators
  return indicators.filter((indicator) => {
    const haystack = `${indicator.indicator} ${indicator.label} ${indicator.description} ${indicator.table_search_text}`.toLowerCase()
    for (const keyword of keywords) {
      const kw = keyword.trim()
      if (kw.toLowerCase().startsWith('not ')) {
        const exclude = kw.slice(4).toLowerCase()
        if (exclude && haystack.includes(exclude)) return false
      } else if (!haystack.includes(kw.toLowerCase())) return false
    }
    return true
  })
}

/**
 * OpenBB's API hands a list param (`dataflows`, `keywords`) to the model as a list holding the one comma-joined text,
 * and the model uses a list as it is: two dataflows in one call find nothing, in OpenBB as here.
 */
const list = (v: string | undefined): string[] | undefined => (v === undefined ? undefined : [v])

export async function availableIndicators(params: NativeParams, _ctx: NativeCtx): Promise<Row[]> {
  const queryParam = text(params, 'query')
  const dataflows = list(text(params, 'dataflows'))
  const keywords = list(text(params, 'keywords'))
  // OpenBB turns every comma of the query into ", ": commas separate phrases only through semicolons.
  const query = queryParam ? queryParam.replace(/,/g, ', ') : ''

  let targets: string[]
  if (dataflows && dataflows.length > 0) targets = dataflows
  else {
    if (!query && !keywords) throw new Error('A query must be provided when no dataflows and keywords are specified.')
    targets = dataflowIds()
  }

  const all: IndicatorEntry[] = []
  for (const id of new Set(targets)) {
    try {
      all.push(...indicatorsIn(id))
    } catch {
      // a dataflow without indicators (or an unknown id) is skipped with a warning
    }
  }
  const results = filterByKeywords(filterByQuery(all, query), keywords)
  if (results.length === 0) throw new Error('No indicators found for the given query.')

  return results.map((entry) => ({
    symbol_root: entry.indicator,
    symbol: `${entry.dataflow_id}::${entry.indicator}`,
    description: entry.label,
    agency_id: entry.agency_id,
    dataflow_id: entry.dataflow_id,
    dataflow_name: entry.dataflow_name,
    structure_id: entry.structure_id,
    dimension_id: entry.dimension_id,
    long_description: entry.description,
    member_of: entry.tables.map((t) => `${entry.dataflow_id}::${t.table_id}`),
    extra_dimensions: entry.extra_dimensions,
  }))
}
