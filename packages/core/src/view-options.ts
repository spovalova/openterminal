import { z } from 'zod'

/** Shared view option schemas, in their own module so presets.ts and widget.ts can both import them without a cycle. */

export const SizeSchema = z.enum(['lg', 'md', 'sm'])
export type Size = z.infer<typeof SizeSchema>

/** A legend label override: short, one line. */
export const LEGEND_LABEL_MAX = 32
export const LegendLabelsSchema = z
  .record(z.string().min(1), z.string().trim().min(1).max(LEGEND_LABEL_MAX))
  .describe('Legend label per line, keyed by symbol (ohlcv) or series (macro), e.g. { "NVDA": "Nvidia" }. Omit to show the symbol.')
export type LegendLabels = z.infer<typeof LegendLabelsSchema>
