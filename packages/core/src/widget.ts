import { z } from 'zod'
import { FieldOverridesSchema } from './fields.js'
import { KINDS, QuerySchema, SERIES_KINDS, type Kind } from './kinds.js'
import { ViewV2Schema, type ViewV2 } from './presets.js'
import { AnyQuerySchema, legacyToRecipe, type AnyQuery, type AnyQueryInput } from './query.js'
import { LEGEND_LABEL_MAX, LegendLabelsSchema, SizeSchema, type Size } from './view-options.js'

export { LEGEND_LABEL_MAX, LegendLabelsSchema, SizeSchema }
export type { Size }

/**
 * Kinds whose frame has one row per symbol (the latest row per symbol for short_interest) and the
 * numeric column a trader asks about first: what the `stat` view shows as its one big number.
 */
export const STAT_KEY_COLUMN = {
  quote: 'price',
  metrics: 'pe',
  volatility: 'iv30',
  estimates: 'target_consensus',
  profile: 'market_cap',
  short_interest: 'days_to_cover',
} as const satisfies Partial<Record<Kind, string>>
export type StatKind = keyof typeof STAT_KEY_COLUMN
export const STAT_KINDS: ReadonlySet<Kind> = new Set<Kind>(Object.keys(STAT_KEY_COLUMN) as StatKind[])
export function isStatKind(kind: Kind): kind is StatKind {
  return STAT_KINDS.has(kind)
}

/** Numeric columns of a kind: what a stat view's `column` may name. */
export function numericColumns(kind: Kind): string[] {
  return KINDS[kind].columns.filter((c) => c.type === 'number').map((c) => c.name)
}

/**
 * series: lightweight-charts over a frame with a time column (`ohlcv`, `macro`). `candle` and `normalize`
 * are mutually exclusive and only for `ohlcv`; candle requires exactly one symbol; normalize rebases every
 * line to 100 at the first bar. `labels` renames legend entries; every key must be one of the query's
 * symbols (or macro series).
 * table: any kind.
 * chain: the option chain layout (calls, strike, puts), only for `options`.
 * stat: one big number per symbol (the kind's key column, or `column` to pick another numeric one) with
 * the symbol as its label and a change line under it; only for the kinds in STAT_KEY_COLUMN.
 */
export const ViewSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('series'), candle: z.boolean().optional(), normalize: z.boolean().optional(), labels: LegendLabelsSchema.optional() }),
  z.object({ type: z.literal('table') }),
  z.object({ type: z.literal('chain') }),
  z.object({ type: z.literal('stat'), column: z.string().min(1).optional().describe('A numeric column of the kind to show instead of its key column') }),
])
export type View = z.infer<typeof ViewSchema>
export const VIEW_TYPES = ['series', 'table', 'chain', 'stat'] as const

/** The column a stat widget shows: the view's `column` when set, else the kind's key column. */
export function statColumn(kind: Kind, view: View): string | undefined {
  if (view.type === 'stat' && view.column) return view.column
  return isStatKind(kind) ? STAT_KEY_COLUMN[kind] : undefined
}

/** The v1 widget: one kind query rendered by one view. Production's path; unchanged until phase 3. */
export const WidgetSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1).max(80),
    size: SizeSchema,
    query: QuerySchema,
    view: ViewSchema,
  })
  .superRefine((w, ctx) => {
    if (w.view.type === 'chain') {
      if (w.query.kind !== 'options') ctx.addIssue({ code: 'custom', path: ['view'], message: 'chain view requires an options query' })
      return
    }
    if (w.view.type === 'stat') {
      if (!isStatKind(w.query.kind)) {
        ctx.addIssue({ code: 'custom', path: ['view'], message: `stat view requires a ${[...STAT_KINDS].join(', ')} query` })
        return
      }
      if (w.view.column && !numericColumns(w.query.kind).includes(w.view.column)) {
        ctx.addIssue({ code: 'custom', path: ['view', 'column'], message: `${w.query.kind} has no numeric column "${w.view.column}" (one of ${numericColumns(w.query.kind).join(', ')})` })
      }
      return
    }
    if (w.view.type !== 'series') return
    if (!SERIES_KINDS.has(w.query.kind)) {
      ctx.addIssue({ code: 'custom', path: ['view'], message: `series view requires an ohlcv or macro query` })
      return
    }
    if (w.view.labels) {
      const groups: readonly string[] = w.query.kind === 'ohlcv' ? w.query.params.symbols : w.query.kind === 'macro' ? w.query.params.series : []
      for (const key of Object.keys(w.view.labels)) {
        if (!groups.includes(key)) {
          ctx.addIssue({ code: 'custom', path: ['view', 'labels', key], message: `labels: "${key}" is not one of the query's ${w.query.kind === 'macro' ? 'series' : 'symbols'}` })
        }
      }
    }
    if (w.query.kind !== 'ohlcv') {
      if (w.view.candle || w.view.normalize) ctx.addIssue({ code: 'custom', path: ['view'], message: 'candle and normalize are only for ohlcv' })
      return
    }
    if (w.view.candle && w.view.normalize) {
      ctx.addIssue({ code: 'custom', path: ['view'], message: 'candle and normalize are mutually exclusive' })
    }
    if (w.view.candle && w.query.params.symbols.length !== 1) {
      ctx.addIssue({ code: 'custom', path: ['view', 'candle'], message: 'candle requires exactly one symbol' })
    }
  })
export type Widget = z.output<typeof WidgetSchema>
export type WidgetInput = z.input<typeof WidgetSchema>

export function parseWidget(input: unknown): Widget {
  return WidgetSchema.parse(input)
}

/** Grid spans per size: lg 2x2, md 1x2 (two columns wide, one row), sm 1x1. */
export const SIZE_SPANS: Record<Size, { cols: number; rows: number }> = {
  lg: { cols: 2, rows: 2 },
  md: { cols: 2, rows: 1 },
  sm: { cols: 1, rows: 1 },
}

// ---------------------------------------------------------------------------------------------- v2

/**
 * The v2 widget (PLAN.md section 17, "the widget model"): a named data graph instead of one query (a plain
 * widget is a graph with one node, `main`), a preset with options instead of a view type, per-field overrides,
 * and the size as a hint the packer may demote. The v1 `query` stays readable on migrated widgets.
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
    /** The v1 query this widget was migrated from, kept for the Data tab and for v1 clients. */
    query: QuerySchema.optional(),
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

export function isWidgetV2(w: unknown): w is WidgetV2 {
  return !!w && typeof w === 'object' && 'data' in w && !!(w as WidgetV2).data && typeof (w as WidgetV2).view === 'object' && 'preset' in (w as WidgetV2).view
}

/** The v1 view of a widget as the v2 preset it maps to. */
export function migrateView(view: View, query: Widget['query']): ViewV2 {
  switch (view.type) {
    case 'table':
      return { preset: 'table' }
    case 'chain':
      return { preset: 'chain' }
    case 'stat':
      return view.column ? { preset: 'stat', column: view.column } : { preset: 'stat' }
    case 'series': {
      const labels = view.labels
      if (view.candle) return { preset: 'price', candle: true, ...(labels ? { labels } : {}) }
      if (view.normalize) return { preset: 'compare', normalize: true, ...(labels ? { labels } : {}) }
      const groups = query.kind === 'ohlcv' ? query.params.symbols.length : query.kind === 'macro' ? query.params.series.length : 1
      if (groups <= 1 && query.kind === 'ohlcv') return { preset: 'price', ...(labels ? { labels } : {}) }
      return { preset: 'compare', normalize: false, ...(labels ? { labels } : {}) }
    }
  }
}

/**
 * A v1 widget as a v2 one: the query becomes the recipe of the same name under `main` (a multi-series macro
 * query becomes one `macro` dataset per series, since the v2 recipe takes one series), the view becomes a preset.
 */
export function migrateWidget(w: Widget): WidgetV2 {
  const data: Record<string, AnyQuery> = {}
  if (w.query.kind === 'macro' && w.query.params.series.length > 1) {
    for (const s of w.query.params.series) data[s] = { recipe: 'macro', params: { series: s, range: w.query.params.range } }
  } else if (w.query.kind === 'macro') {
    data[DEFAULT_DATASET] = { recipe: 'macro', params: { series: w.query.params.series[0], range: w.query.params.range } }
  } else data[DEFAULT_DATASET] = legacyToRecipe(w.query)
  return { id: w.id, title: w.title, size: w.size, data, view: migrateView(w.view, w.query), query: w.query }
}

/** Accept a v1 or a v2 widget and return v2. Throws ZodError on neither. */
export function parseAnyWidget(input: unknown): WidgetV2 {
  if (isWidgetV2(input)) return WidgetV2Schema.parse(input)
  return migrateWidget(WidgetSchema.parse(input))
}

export const AnyWidgetSchema = z.union([WidgetV2Schema, WidgetSchema])
export type AnyWidget = WidgetV2 | Widget

/** Every query in a widget, v1 or v2, keyed by dataset name (`main` for v1). */
export function widgetQueries(w: AnyWidget): Record<string, AnyQuery> {
  return isWidgetV2(w) ? w.data : { [DEFAULT_DATASET]: w.query }
}

export type { AnyQueryInput as WidgetQueryInput }
