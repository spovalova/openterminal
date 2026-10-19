/**
 * The field config pipeline for a widget (PLAN.md section 17, "the widget model"): for every dataset,
 * `mergeFieldConfig(detectShape(columns, rows), annotations, overrides)`, where the annotations are the frame's
 * stamped `meta.fields` (v2) or the v1 kind tables (`legacyFieldConfig`), and the overrides the widget's `fields`.
 * Every view reads its spec through `expandPreset` / `controlFor` over this; nothing reads a kind past this file.
 */
import {
  DEFAULT_DATASET,
  controlFor,
  detectShape,
  expandPreset,
  isWidgetV2,
  mergeFieldConfig,
  migrateView,
  type AnyWidget,
  type Control,
  type DatasetFields,
  type DatasetsFieldConfig,
  type Frame,
  type Kind,
  type Pane,
  type ViewV2,
} from '@terminal/core'
import { MACRO_AMOUNTS, legacyFieldConfig } from './legacy'

/**
 * The v2 view of a widget: its own preset, or the v1 view migrated. A v1 candle chart drew a volume histogram
 * under the candles, so its `price` preset keeps `volume: true` (the migration in core maps the schema; the look
 * is the renderer's to preserve).
 */
export function viewOf(widget: AnyWidget): ViewV2 {
  if (isWidgetV2(widget)) return widget.view
  const view = migrateView(widget.view, widget.query)
  if (view.preset === 'price' && view.candle && widget.query.kind === 'ohlcv') return { ...view, volume: true }
  return view
}

/** The v1 kind behind a widget, when it has one (a v1 widget, or a v2 widget migrated from one). */
export function kindOf(widget: AnyWidget): Kind | undefined {
  return widget.query?.kind
}

/** Field config for one frame of a widget: shape roles under the annotations under the widget's overrides. */
export function datasetFields(widget: AnyWidget, frame: Frame): DatasetFields {
  const shape = detectShape(frame.columns, frame.rows.slice(0, 500))
  const kind = kindOf(widget)
  const annotations = frame.meta.fields ?? (kind ? legacyFieldConfig(kind, frame.columns) : {})
  // A v1 macro frame's `value` is a rate for every series but the dollar amounts (M2): the unit the kind never carried.
  if (!frame.meta.fields && kind === 'macro') {
    const amounts = shape.groups.length > 0 && shape.groups.every((g) => MACRO_AMOUNTS.has(g))
    annotations.value = amounts ? { unit: 'usd', format: 'compact', label: 'Value' } : { unit: 'percent', format: 'percent', label: 'Rate' }
  }
  const overrides = isWidgetV2(widget) ? (widget.fields ?? {}) : {}
  const fields = mergeFieldConfig(shape, annotations, overrides)
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
