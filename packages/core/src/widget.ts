import { z } from 'zod'
import { QuerySchema } from './kinds.js'

export const SizeSchema = z.enum(['lg', 'md', 'sm'])
export type Size = z.infer<typeof SizeSchema>

/**
 * series: lightweight-charts. `candle` and `normalize` are mutually exclusive.
 * candle requires exactly one symbol; normalize rebases every symbol to 100 at the first bar.
 * series only renders `ohlcv` frames.
 */
export const ViewSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('series'), candle: z.boolean().optional(), normalize: z.boolean().optional() }),
  z.object({ type: z.literal('table') }),
])
export type View = z.infer<typeof ViewSchema>

export const WidgetSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1).max(80),
    size: SizeSchema,
    query: QuerySchema,
    view: ViewSchema,
  })
  .superRefine((w, ctx) => {
    if (w.view.type !== 'series') return
    if (w.query.kind !== 'ohlcv') {
      ctx.addIssue({ code: 'custom', path: ['view'], message: 'series view requires an ohlcv query' })
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
