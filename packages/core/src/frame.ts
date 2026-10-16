import { z } from 'zod'

/**
 * A Frame is the only data shape that crosses from a connector to a view.
 *
 * Conventions:
 * - `time` columns hold epoch milliseconds (number). Connectors convert.
 * - Any cell may be `null` when the source has no value; the column type is the nominal type.
 * - Multi-symbol results are long format: one row per (symbol, …) with a `symbol` column.
 * - Rows for `ohlcv` are sorted by symbol then time ascending.
 */
export const ColumnTypeSchema = z.enum(['string', 'number', 'time', 'boolean'])
export type ColumnType = z.infer<typeof ColumnTypeSchema>

export const ColumnSchema = z.object({ name: z.string().min(1), type: ColumnTypeSchema })
export type Column = z.infer<typeof ColumnSchema>

export const FrameMetaSchema = z.object({
  /** Name of the connector that produced the frame. */
  connector: z.string(),
  /** Epoch ms when the connector fetched it. */
  fetchedAt: z.number(),
  /** Milliseconds the frame may be served from cache. */
  ttl: z.number().nonnegative(),
})
export type FrameMeta = z.infer<typeof FrameMetaSchema>

export const FrameSchema = z.object({
  columns: z.array(ColumnSchema),
  rows: z.array(z.array(z.unknown())),
  meta: FrameMetaSchema,
})
export type Frame = z.infer<typeof FrameSchema>

/** Index of a column by name, or -1. */
export function columnIndex(frame: Pick<Frame, 'columns'>, name: string): number {
  return frame.columns.findIndex((c) => c.name === name)
}

/** Rows as objects keyed by column name. Convenience for views and tests, not for transport. */
export function frameToObjects(frame: Frame): Record<string, unknown>[] {
  const names = frame.columns.map((c) => c.name)
  return frame.rows.map((row) => {
    const o: Record<string, unknown> = {}
    names.forEach((n, i) => {
      o[n] = row[i] ?? null
    })
    return o
  })
}
