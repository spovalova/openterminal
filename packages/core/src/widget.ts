import { z } from 'zod'
import { QuerySchema, SERIES_KINDS } from './kinds.js'

export const SizeSchema = z.enum(['lg', 'md', 'sm'])
export type Size = z.infer<typeof SizeSchema>

/**
 * series: lightweight-charts over a frame with a time column (`ohlcv`, `macro`). `candle` and `normalize`
 * are mutually exclusive and only for `ohlcv`; candle requires exactly one symbol; normalize rebases every
 * line to 100 at the first bar.
 * table: any kind.
 * chain: the option chain layout (calls, strike, puts), only for `options`.
 */
export const ViewSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('series'), candle: z.boolean().optional(), normalize: z.boolean().optional() }),
  z.object({ type: z.literal('table') }),
  z.object({ type: z.literal('chain') }),
])
export type View = z.infer<typeof ViewSchema>
export const VIEW_TYPES = ['series', 'table', 'chain'] as const

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
    if (w.view.type !== 'series') return
    if (!SERIES_KINDS.has(w.query.kind)) {
      ctx.addIssue({ code: 'custom', path: ['view'], message: `series view requires an ohlcv or macro query` })
      return
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
