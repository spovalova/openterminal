// economy/survey/{economic_conditions_chicago, manufacturing_outlook_ny, manufacturing_outlook_texas, sloos,
// university_of_michigan}, provider fred. Ported from openbb_fred/models/{survey_of_economic_conditions_chicago,
// manufacturing_outlook_ny, manufacturing_outlook_texas, senior_loan_officer_survey, university_of_michigan}.py
// (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of DataFrames and pydantic models. (The
// nonfarm payrolls survey is a release table: release-tables.ts.)
import type { NativeCtx, NativeParams, Row } from '../types.js'
import data from './data.json' with { type: 'json' }
import { apiKey, text, useCache } from './helpers.js'
import { fetchSeries, present, type SeriesRow } from './series.js'

type Json = Record<string, any>
const D = data as unknown as Json

/** `frequency[:1].lower()`: `annual` → `a`, `quarter` → `q`. */
const firstLetter = (frequency: string | undefined): string | null => (frequency ? frequency.slice(0, 1).toLowerCase() : null)

const byDate = (a: Row, b: Row) => (String(a.date) < String(b.date) ? -1 : String(a.date) > String(b.date) ? 1 : 0)

/** The options every survey takes on the series fetch. */
function options(params: NativeParams) {
  return {
    start_date: text(params, 'start_date') ?? null,
    end_date: text(params, 'end_date') ?? null,
    transform: text(params, 'transform') ?? null,
    frequency: firstLetter(text(params, 'frequency')),
    aggregation_method: text(params, 'aggregation_method') ?? null,
    use_cache: useCache(params),
  }
}

export async function economicConditionsChicago(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const key = apiKey(ctx)
  const idToField = D.chicago as Record<string, string>
  const result = await fetchSeries(ctx, key, { symbol: Object.keys(idToField).join(','), ...options(params) })
  if (result.rows.length === 0) throw new Error('There was an error with the request and was returned empty.')
  return result.rows.map((r) => {
    const row: Row = { date: r.date }
    for (const [id, v] of Object.entries(r)) if (id !== 'date') row[idToField[id] ?? id] = v
    return present(row)
  })
}

export async function universityOfMichigan(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const key = apiKey(ctx)
  const start = text(params, 'start_date')
  // The consumer sentiment index before 1978 is a separate series.
  const ids = ['UMCSENT', 'MICH', ...((start && start < '1978-01-01') || !start ? ['UMCSENT1'] : [])]
  const result = await fetchSeries(ctx, key, { symbol: ids.join(','), ...options(params) })
  if (result.rows.length === 0) throw new Error('There was an error with the request and was returned empty.')
  const rows: Row[] = result.rows.map((r) => {
    const { UMCSENT1: earlier, UMCSENT: sentiment, MICH: inflation, date } = r as Record<string, any>
    const row: Row = { date }
    if ('UMCSENT' in r) row.consumer_sentiment = sentiment ?? earlier
    else if ('UMCSENT1' in r) throw new Error("'UMCSENT'")
    if ('MICH' in r) row.inflation_expectation = inflation
    return present(row)
  })
  return rows.sort(byDate)
}

export async function sloos(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const key = apiKey(ctx)
  const category = text(params, 'category') ?? 'spreads'
  const ids = (D.sloos as Record<string, string>)[category]
  if (ids === undefined) throw new Error(`category: Input should be one of ${Object.keys(D.sloos).join(', ')} (got ${category})`)
  const result = await fetchSeries(ctx, key, {
    symbol: ids,
    start_date: text(params, 'start_date') ?? null,
    end_date: text(params, 'end_date') ?? null,
    transform: text(params, 'transform') ?? null,
    use_cache: useCache(params),
  })
  const long: Row[] = []
  for (const symbol of Object.keys(result.metadata)) {
    for (const r of result.rows) {
      const value = r[symbol]
      if (value === null || value === undefined) continue
      long.push({ date: r.date, symbol, value, title: (result.metadata[symbol]?.title as string | undefined) ?? '' })
    }
  }
  if (long.length === 0) throw new Error('There was an error with the request and it was returned empty.')
  return long.sort(byDate)
}

// ---- the regional Fed manufacturing surveys, which publish a diffusion index and the shares behind it per topic -----------

type Outlook = Record<string, Record<string, string>>
const FIELDS = ['diffusion_index', 'percent_reporting_increase', 'percent_reporting_decrease', 'percent_reporting_no_change']

/** A topic's rows from the long table of its series: one row per date and topic, one column per statistic. */
function pivotTopics(rows: SeriesRow[], idToTopic: Map<string, string>, idToField: Map<string, string>, topicOrder: string[]): Row[] {
  const cells = new Map<string, Row>()
  const ids = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((id) => id !== 'date')
  for (const id of ids) {
    for (const r of rows) {
      const value = r[id]
      if (value === null || value === undefined) continue
      const topic = idToTopic.get(id)
      const field = idToField.get(id)
      if (topic === undefined || field === undefined) continue
      const k = `${r.date}\u0000${topic}`
      const cell = cells.get(k) ?? { date: r.date, topic }
      if (field in cell) throw new Error('Index contains duplicate entries, cannot reshape')
      cell[field] = value
      cells.set(k, cell)
    }
  }
  const topics = new Set([...cells.values()].map((c) => c.topic as string))
  const categories = topicOrder.filter((t) => topics.has(t))
  const ordered = [...cells.values()].sort((a, b) => (a.date! < b.date! ? -1 : a.date! > b.date! ? 1 : categories.indexOf(a.topic as string) - categories.indexOf(b.topic as string)))
  return ordered.map((c) => {
    const row: Row = { date: c.date, topic: c.topic }
    for (const f of FIELDS) if (f in c) row[f] = c[f]
    return row
  })
}

/** `validate_topic`: the names that are choices, `fallback` when none is. */
function topicsOf(value: string | undefined, choices: string[], fallback: string): string[] {
  const kept = (value ?? fallback).split(',').filter((t) => choices.includes(t))
  return kept.length > 0 ? kept : [fallback]
}

export async function manufacturingOutlookNy(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const key = apiKey(ctx)
  const outlook = D.nyOutlook as Record<string, Record<string, Record<string, string>>>
  const topics = topicsOf(text(params, 'topic'), D.nyOutlookChoices, 'new_orders')
  const seasonality = params.seasonally_adjusted === true || params.seasonally_adjusted === 'true' ? 'sa' : 'not_sa'
  const ids: string[] = []
  for (const t of topics) ids.push(...Object.values(outlook[`future_${t}`]?.[seasonality] ?? {}), ...Object.values(outlook[`current_${t}`]?.[seasonality] ?? {}))
  if (ids.length === 0) throw new Error('No valid topic selected. Please select a valid topic.')
  let result
  try {
    result = await fetchSeries(ctx, key, { symbol: ids.join(','), ...options(params) })
  } catch (err) {
    throw new Error((err instanceof Error && err.message) || 'FRED request failed (Error).', { cause: err })
  }
  if (result.rows.length === 0) throw new Error('The request was returned empty. You may be experiencing rate limiting from the FRED API. Please try again later and reduce the number of topics selected.')
  const idToTopic = new Map<string, string>()
  const idToField = new Map<string, string>()
  for (const [topic, bySeasonality] of Object.entries(outlook)) {
    for (const series of Object.values(bySeasonality)) {
      for (const [field, id] of Object.entries(series)) {
        idToTopic.set(id, topic)
        idToField.set(id, field)
      }
    }
  }
  return pivotTopics(result.rows, idToTopic, idToField, Object.keys(outlook))
}

export async function manufacturingOutlookTexas(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const key = apiKey(ctx)
  const outlook = D.texasOutlook as Outlook
  const topics = topicsOf(text(params, 'topic'), D.texasOutlookChoices, 'new_orders_growth')
  const ids: string[] = []
  for (const topic of topics) {
    for (const part of [`future_${topic}`, `current_${topic}`]) {
      if (!outlook[part]) throw new Error(`'${part}'`)
      ids.push(...Object.values(outlook[part]!))
    }
  }
  const result = await fetchSeries(ctx, key, { symbol: ids.join(','), ...options(params) })
  if (result.rows.length === 0) throw new Error('The request was returned empty. You may be experiencing rate limiting from the FRED API. Please try again later and reduce the number of topics selected.')
  const idToTopic = new Map<string, string>()
  const idToField = new Map<string, string>()
  for (const [topic, series] of Object.entries(outlook)) {
    for (const [field, id] of Object.entries(series)) {
      idToTopic.set(id, topic)
      idToField.set(id, field)
    }
  }
  return pivotTopics(result.rows, idToTopic, idToField, Object.keys(outlook))
}

