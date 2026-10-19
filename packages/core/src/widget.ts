import { z } from 'zod'
import { FieldOverridesSchema } from './fields.js'
import { ViewV2Schema, type ViewV2 } from './presets.js'
import { AnyQuerySchema, type AnyQuery, type AnyQueryInput } from './query.js'
import { LEGEND_LABEL_MAX, LegendLabelsSchema, SizeSchema, type Size } from './view-options.js'

export { LEGEND_LABEL_MAX, LegendLabelsSchema, SizeSchema }
export type { Size }

/** Grid spans per size: lg 2x2, md 1x2 (two columns wide, one row), sm 1x1. */
export const SIZE_SPANS: Record<Size, { cols: number; rows: number }> = {
  lg: { cols: 2, rows: 2 },
  md: { cols: 2, rows: 1 },
  sm: { cols: 1, rows: 1 },
}

/**
 * The widget (PLAN.md section 17, "the widget model"): a named data graph (a plain widget is a graph with one node,
 * `main`), a preset with options, per-field overrides, and the size as a hint the packer may demote.
 */
export const DATASET_NAME_RE = /^[a-z_][a-z0-9_]*$/
export const DEFAULT_DATASET = 'main'

export const WidgetV2Schema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1).max(80),
    size: SizeSchema,
    data: z.record(z.string().regex(DATASET_NAME_RE, 'dataset names are Python identifiers'), AnyQuerySchema).refine((d) => Object.keys(d).length > 0, { message: 'a widget needs at least one dataset' }),
    view: ViewV2Schema,
    fields: FieldOverridesSchema.optional(),
  })
  .superRefine((w, ctx) => {
    const names = Object.keys(w.data)
    const refs: [string, string | undefined][] = [
      ['data', w.view.data],
      ['events', w.view.preset === 'price' ? w.view.events : undefined],
      ['levels', w.view.preset === 'price' && typeof w.view.levels === 'string' ? w.view.levels : undefined],
      ['band', w.view.preset === 'price' && w.view.band && !Array.isArray(w.view.band) ? w.view.band.data : undefined],
    ]
    for (const [opt, ref] of refs) {
      if (ref && !names.includes(ref)) ctx.addIssue({ code: 'custom', path: ['view', opt], message: `view.${opt} names dataset "${ref}", which the widget does not have (datasets: ${names.join(', ')})` })
    }
  })
export type WidgetV2 = z.output<typeof WidgetV2Schema>
export type WidgetV2Input = z.input<typeof WidgetV2Schema>

/** The widget type; the name dates from the v1 coexistence. */
export type AnyWidget = WidgetV2

export function isWidgetV2(w: unknown): w is WidgetV2 {
  return !!w && typeof w === 'object' && 'data' in w && !!(w as WidgetV2).data && typeof (w as WidgetV2).view === 'object' && 'preset' in (w as WidgetV2).view
}

// ---------------------------------------------------------------------------------------------- the v1 JSON shape

/**
 * A widget as the v1 store wrote it (`~/.terminal/workspaces/<id>.json`, before 2026-10-19): one `{ kind, params }`
 * query rendered by one typed view. Read here only to migrate it; nothing executes a kind. The params are an open
 * object: the recipe of the same name validates them when the widget runs.
 */
const LegacyViewSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('series'), candle: z.boolean().optional(), normalize: z.boolean().optional(), labels: LegendLabelsSchema.optional() }),
  z.object({ type: z.literal('table') }),
  z.object({ type: z.literal('chain') }),
  z.object({ type: z.literal('stat'), column: z.string().min(1).optional() }),
])
export const LegacyWidgetSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(80),
  size: SizeSchema,
  query: z.object({ kind: z.string().min(1), params: z.record(z.string(), z.unknown()).default({}) }),
  view: LegacyViewSchema,
})
export type LegacyWidget = z.output<typeof LegacyWidgetSchema>

export function isLegacyWidget(w: unknown): w is LegacyWidget {
  return !!w && typeof w === 'object' && 'query' in w && !!(w as LegacyWidget).query && typeof (w as LegacyWidget).query.kind === 'string' && !('data' in w)
}

const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? v.split(',').map((s) => s.trim()).filter(Boolean) : [])

/** The v1 view of a widget as the v2 preset it maps to. */
export function migrateView(view: LegacyWidget['view'], query: LegacyWidget['query']): ViewV2 {
  switch (view.type) {
    case 'table':
      return { preset: 'table' }
    case 'chain':
      return { preset: 'chain' }
    case 'stat':
      return view.column ? { preset: 'stat', column: view.column } : { preset: 'stat' }
    case 'series': {
      const labels = view.labels
      if (view.candle) return { preset: 'price', candle: true, volume: true, ...(labels ? { labels } : {}) }
      if (view.normalize) return { preset: 'compare', normalize: true, ...(labels ? { labels } : {}) }
      const groups = query.kind === 'ohlcv' ? list(query.params.symbols).length : query.kind === 'macro' ? list(query.params.series).length : 1
      if (groups <= 1 && query.kind === 'ohlcv') return { preset: 'price', ...(labels ? { labels } : {}) }
      return { preset: 'compare', normalize: false, ...(labels ? { labels } : {}) }
    }
  }
}

/**
 * A v1 widget as a v2 one: the query becomes the recipe of the same name under `main` (a multi-series macro query
 * becomes one `macro` dataset per series, since the recipe takes one series), the view becomes a preset. Accepts the
 * raw JSON (validated with `LegacyWidgetSchema`) or an already parsed legacy widget. Throws ZodError on neither.
 */
export function migrateWidget(input: unknown): WidgetV2 {
  const w = LegacyWidgetSchema.parse(input)
  const data: Record<string, AnyQuery> = {}
  const series = list(w.query.params.series)
  if (w.query.kind === 'macro' && series.length > 1) {
    for (const s of series) data[s] = { recipe: 'macro', params: { series: s, ...(w.query.params.range !== undefined ? { range: w.query.params.range } : {}) } }
  } else if (w.query.kind === 'macro') {
    data[DEFAULT_DATASET] = { recipe: 'macro', params: { ...w.query.params, ...(series.length === 1 ? { series: series[0] } : {}) } }
  } else data[DEFAULT_DATASET] = { recipe: w.query.kind, params: { ...w.query.params } }
  return WidgetV2Schema.parse({ id: w.id, title: w.title, size: w.size, data, view: migrateView(w.view, w.query) })
}

/** Accept a widget in either JSON shape and return a v2 widget: a v1 shape is migrated. Throws ZodError on neither. */
export function parseAnyWidget(input: unknown): WidgetV2 {
  if (isLegacyWidget(input)) return migrateWidget(input)
  return WidgetV2Schema.parse(input)
}

/** The widget schema stores and the protocol use: a v2 widget, or a v1 one migrated on read. */
export const AnyWidgetSchema: z.ZodType<WidgetV2, WidgetV2Input | z.input<typeof LegacyWidgetSchema>> = z.union([WidgetV2Schema, LegacyWidgetSchema.transform((w) => migrateWidget(w))]) as unknown as z.ZodType<WidgetV2, WidgetV2Input | z.input<typeof LegacyWidgetSchema>>

/** Every query in a widget, keyed by dataset name. */
export function widgetQueries(w: AnyWidget): Record<string, AnyQuery> {
  return w.data
}

export type { AnyQueryInput as WidgetQueryInput }
