import { z } from 'zod'
import { KINDS, QuerySchema, SERIES_KINDS, type Kind } from './kinds.js'

export const SizeSchema = z.enum(['lg', 'md', 'sm'])
export type Size = z.infer<typeof SizeSchema>

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
 * line to 100 at the first bar.
 * table: any kind.
 * chain: the option chain layout (calls, strike, puts), only for `options`.
 * stat: one big number per symbol (the kind's key column, or `column` to pick another numeric one) with
 * the symbol as its label and a change line under it; only for the kinds in STAT_KEY_COLUMN.
 */
export const ViewSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('series'), candle: z.boolean().optional(), normalize: z.boolean().optional() }),
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
