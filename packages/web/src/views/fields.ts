/**
 * The field config pipeline for a widget (PLAN.md section 17, "the widget model"): for every dataset,
 * `mergeFieldConfig(detectShape(columns, rows), frame.meta.fields, widget.fields)`, where `meta.fields` is what the
 * runner stamped from the annotations (and a recipe's or transform's own `columns`), and the overrides are the
 * widget's `fields`. Every view reads its spec through `expandPreset` / `controlFor` over this.
 */
import { DEFAULT_DATASET, controlFor, detectShape, expandPreset, mergeFieldConfig, type AnyWidget, type Control, type DatasetFields, type DatasetsFieldConfig, type Frame, type Pane, type ViewV2 } from '@terminal/core'

/** The widget's view: a preset with options. */
export function viewOf(widget: AnyWidget): ViewV2 {
  return widget.view
}

/** The recipe behind a widget's primary dataset, when it is a recipe query (what the empty states and subtitles key on). */
export function recipeOf(widget: AnyWidget): string | undefined {
  const name = widget.view.data && widget.view.data in widget.data ? widget.view.data : DEFAULT_DATASET in widget.data ? DEFAULT_DATASET : Object.keys(widget.data)[0]
  const q = name ? widget.data[name] : undefined
  return q && 'recipe' in q && typeof q.recipe === 'string' ? q.recipe : undefined
}

/** What an empty frame means for each built-in recipe; the generic line for routes and transforms. */
export const EMPTY_HINT: Record<string, string> = {
  search: 'No symbols matched the query.',
  quote: 'No quotes came back for these symbols.',
  ohlcv: 'No price bars came back for this range.',
  index: 'No price bars came back for this range.',
  news: 'No headlines in this window.',
  earnings: 'No earnings dates in this window.',
  profile: 'No profile came back for these symbols.',
  metrics: 'No metrics came back for these symbols.',
  financials: 'No statements came back for these symbols.',
  estimates: 'No analyst estimates for these symbols.',
  eps_history: 'No reported earnings for these symbols.',
  dividends: 'No dividends on record for these symbols.',
  insiders: 'No insider transactions on record.',
  institutions: 'No institutional holders on record.',
  short_interest: 'No short interest reports for these symbols.',
  options: 'No contracts matched this expiration and strike window.',
  volatility: 'No volatility data for these symbols.',
  calendar: 'No scheduled releases in this window.',
  ipos: 'No IPOs in this window.',
  movers: 'No movers right now.',
  screener: 'No names passed the screen.',
  holdings: 'No holdings reported for this fund.',
  macro: 'No observations in this range.',
  yield_curve: 'No curve for this date.',
}

export function emptyHintFor(widget: AnyWidget): string {
  const recipe = recipeOf(widget)
  return (recipe && EMPTY_HINT[recipe]) || 'The query returned no rows.'
}

/** Field config for one frame of a widget: shape roles under the frame's stamped config under the widget's overrides. */
export function datasetFields(widget: AnyWidget, frame: Frame): DatasetFields {
  const shape = detectShape(frame.columns, frame.rows.slice(0, 500))
  const fields = mergeFieldConfig(shape, frame.meta.fields ?? {}, widget.fields ?? {})
  // A numeric column with no unit and no format: whole numbers (counts, row ids, contract sizes) read as integers,
  // anything else as a number with two decimals (core's default); the values decide, since nobody annotated them.
  for (const c of frame.columns) {
    const f = fields[c.name]
    if (c.type !== 'number' || !f) continue
    const sample = frame.rows.slice(0, 200).map((r) => r[frame.columns.indexOf(c)]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
    if (sample.length === 0) continue
    const big = Math.max(...sample.map(Math.abs)) >= 1e6
    // Dollar amounts and unannotated numbers in the millions and billions (a transform's revenue or market cap, an
    // institution's share count) read compact ("41.5B"), never as a 14-digit cell; percents, changes and integers keep theirs.
    if (big && (f.format === undefined || f.format === 'price' || f.format === 'ratio')) fields[c.name] = { ...f, format: 'compact' }
    else if (!f.unit && !f.format && sample.every((v) => Number.isInteger(v))) fields[c.name] = { ...f, format: 'integer' }
  }
  return { shape, fields }
}

/** Field config for every dataset that has landed. */
export function datasetsFor(widget: AnyWidget, frames: Record<string, Frame>): DatasetsFieldConfig {
  const out: DatasetsFieldConfig = {}
  for (const [name, frame] of Object.entries(frames)) out[name] = datasetFields(widget, frame)
  return out
}

/** The renderer's spec for a widget over its frames, or undefined before the primary frame has landed. */
export function controlOf(widget: AnyWidget, frames: Record<string, Frame>): Control | undefined {
  return controlFor(viewOf(widget), datasetsFor(widget, frames))
}

/** The panes a widget's view expands to over the frames that have landed. */
export function expandView(widget: AnyWidget, frames: Record<string, Frame>): Pane[] {
  return expandPreset(viewOf(widget), datasetsFor(widget, frames))
}

/** The frame a view draws first: the one the view names, else `main`, else the first. */
export function primaryFrame(widget: AnyWidget, frames: Record<string, Frame>): Frame | undefined {
  const view = viewOf(widget)
  if (view.data && frames[view.data]) return frames[view.data]
  return frames[DEFAULT_DATASET] ?? Object.values(frames)[0]
}
