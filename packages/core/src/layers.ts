import { z } from 'zod'

/**
 * The layer spec (PLAN.md section 17, "the widget model"): a chart is panes, a pane is layers, a layer is one
 * mark bound to one dataset's fields. The renderer knows marks and panes only; it never knows what the data
 * means. Presets (presets.ts) expand to this; users and advanced agents may write it directly.
 */

export const MARKS = ['line', 'area', 'candle', 'bar', 'histogram', 'marker', 'level', 'band', 'cell', 'profile'] as const
export const MarkSchema = z.enum(MARKS)
export type Mark = z.infer<typeof MarkSchema>

export const ScaleSideSchema = z.enum(['left', 'right'])
export type ScaleSide = z.infer<typeof ScaleSideSchema>

const field = z.string().min(1)
const dataset = z.string().min(1).describe('Dataset name in the widget’s data graph')

const seriesBase = {
  data: dataset,
  x: field,
  y: field,
  /** Split into one series per distinct value of this field (symbol, series). */
  group: field.optional(),
  scale: ScaleSideSchema.optional(),
  color: field.optional().describe('A CSS colour, or omitted for the palette'),
  /** Legend label; the field label when absent. */
  label: z.string().max(40).optional(),
}

export const LineLayerSchema = z.object({ mark: z.literal('line'), ...seriesBase, width: z.number().min(0.5).max(6).optional() })
export const AreaLayerSchema = z.object({ mark: z.literal('area'), ...seriesBase })
/** Signed bars: positive in the up colour, negative in the down colour, zero line drawn. */
export const BarLayerSchema = z.object({ mark: z.literal('bar'), ...seriesBase, signed: z.boolean().optional() })
export const HistogramLayerSchema = z.object({ mark: z.literal('histogram'), ...seriesBase, signed: z.boolean().optional(), colorBy: field.optional() })
export const CandleLayerSchema = z.object({
  mark: z.literal('candle'),
  data: dataset,
  x: field,
  open: field,
  high: field,
  low: field,
  close: field,
  group: field.optional(),
  scale: ScaleSideSchema.optional(),
})
/** Event markers over a dataset with a time field: a label and a kind per row (earnings, dividend, news, insider, macro, custom). */
export const MarkerLayerSchema = z.object({
  mark: z.literal('marker'),
  data: dataset,
  x: field,
  label: field.optional(),
  kind: field.optional(),
  /** A second line of text shown in the tooltip, e.g. the reaction. */
  detail: field.optional(),
  position: z.enum(['above', 'below', 'inline']).optional(),
  scale: ScaleSideSchema.optional(),
})
/** A horizontal line: a constant `value`, or one per row of a dataset's `y` field (strikes, targets, 52-week high). */
export const LevelLayerSchema = z
  .object({
    mark: z.literal('level'),
    value: z.number().optional(),
    data: dataset.optional(),
    y: field.optional(),
    label: z.string().max(40).optional(),
    color: z.string().optional(),
    style: z.enum(['solid', 'dashed', 'dotted']).optional(),
    scale: ScaleSideSchema.optional(),
  })
  .refine((l) => l.value !== undefined || (l.data && l.y), { message: 'level needs a value, or data and y' })
/** A shaded range: between two constants or two fields, or over x where a boolean/condition field is true. */
export const BandLayerSchema = z
  .object({
    mark: z.literal('band'),
    data: dataset.optional(),
    x: field.optional(),
    lo: z.union([z.number(), field]).optional(),
    hi: z.union([z.number(), field]).optional(),
    /** A boolean field: shade the x ranges where it is true (recession-style shading when a spread is negative). */
    when: field.optional(),
    /** Fixed x range as epoch ms or axis values. */
    from: z.number().optional(),
    to: z.number().optional(),
    color: z.string().optional(),
    label: z.string().max(40).optional(),
  })
  .refine((b) => (b.lo !== undefined && b.hi !== undefined) || b.when || (b.from !== undefined && b.to !== undefined), { message: 'band needs lo and hi, or when, or from and to' })
/** A coloured grid cell: x and y categories with a value. */
export const CellLayerSchema = z.object({
  mark: z.literal('cell'),
  data: dataset,
  x: field,
  y: field,
  value: field,
  palette: z.enum(['diverging', 'sequential']).optional(),
  domain: z.tuple([z.number(), z.number()]).optional(),
  /** Show the value in each cell. */
  text: z.boolean().optional(),
})
/** A horizontal volume profile beside the price: value per price level. */
export const ProfileLayerSchema = z.object({
  mark: z.literal('profile'),
  data: dataset,
  y: field,
  value: field,
  side: ScaleSideSchema.optional(),
  bins: z.number().int().min(5).max(200).optional(),
})

export const LayerSchema = z.discriminatedUnion('mark', [
  LineLayerSchema,
  AreaLayerSchema,
  BarLayerSchema,
  HistogramLayerSchema,
  CandleLayerSchema,
  MarkerLayerSchema,
  LevelLayerSchema as unknown as typeof LineLayerSchema,
  BandLayerSchema as unknown as typeof LineLayerSchema,
  CellLayerSchema,
  ProfileLayerSchema,
])
export type Layer =
  | z.infer<typeof LineLayerSchema>
  | z.infer<typeof AreaLayerSchema>
  | z.infer<typeof BarLayerSchema>
  | z.infer<typeof HistogramLayerSchema>
  | z.infer<typeof CandleLayerSchema>
  | z.infer<typeof MarkerLayerSchema>
  | z.infer<typeof LevelLayerSchema>
  | z.infer<typeof BandLayerSchema>
  | z.infer<typeof CellLayerSchema>
  | z.infer<typeof ProfileLayerSchema>

export const XTypeSchema = z.enum(['time', 'number', 'category'])
export type XType = z.infer<typeof XTypeSchema>

export const ScaleSchema = z.object({
  min: z.number().optional(),
  max: z.number().optional(),
  /** Index every series to 100 at its first value (the compare preset's normalize). */
  indexed: z.boolean().optional(),
  log: z.boolean().optional(),
  /** Axis label format: percent for rates, price for dollars, integer for counts. */
  format: z.enum(['price', 'percent', 'integer', 'compact', 'ratio']).optional(),
  visible: z.boolean().optional(),
})
export type Scale = z.infer<typeof ScaleSchema>

export const PaneSchema = z.object({
  /** Relative height; panes share the widget height in proportion (price 3, volume 1). */
  height: z.number().positive().default(1),
  x: XTypeSchema.default('time'),
  layers: z.array(LayerSchema as unknown as z.ZodType<Layer>).min(1),
  scales: z.object({ left: ScaleSchema.optional(), right: ScaleSchema.optional() }).optional(),
  title: z.string().max(40).optional(),
  /** Show the legend chips (series name, last value, change) in the pane's top-left. */
  legend: z.boolean().optional(),
  /** Show the last value of each series as a badge on its price axis. */
  lastValue: z.boolean().optional(),
})
export type Pane = z.output<typeof PaneSchema>
export type PaneInput = z.input<typeof PaneSchema>

export function parsePanes(input: unknown): Pane[] {
  return z.array(PaneSchema).parse(input)
}

/** Every dataset name a pane list reads from. */
export function paneDatasets(panes: readonly Pane[]): string[] {
  const out = new Set<string>()
  for (const p of panes) for (const l of p.layers) if ('data' in l && l.data) out.add(l.data)
  return [...out]
}
