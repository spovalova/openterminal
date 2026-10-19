import { z } from 'zod'
import { FieldConfigSchema } from './fields.js'

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

/**
 * Where a frame came from (v2). A route frame names its connector, route and params; a recipe frame also the recipe;
 * a transform frame carries its code and one lineage per input dataset. Previews show it so a reply can say
 * "derived from closes and reported EPS".
 */
export const LineageSchema = z.object({
  connector: z.string().optional(),
  route: z.string().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  provider: z.string().optional(),
  recipe: z.string().optional(),
  /** A hash of the recipe definition that produced the frame; a cached frame from an older definition is a miss. */
  recipeVersion: z.string().optional(),
  /** Transform inputs: dataset name → that input's lineage. */
  inputs: z.record(z.string(), z.unknown()).optional(),
  code: z.string().optional(),
})
export type Lineage = z.infer<typeof LineageSchema>

export const FrameMetaSchema = z.object({
  /** Name of the connector that produced the frame. */
  connector: z.string(),
  /** Epoch ms when the connector fetched it. */
  fetchedAt: z.number(),
  /** Milliseconds the frame may be served from cache. */
  ttl: z.number().nonnegative(),
  /** v2: field config per column (unit, label, format, role) as stamped by annotations and overrides. Absent on v1 frames. */
  fields: z.record(z.string(), FieldConfigSchema).optional(),
  /** v2: the query graph that produced the frame. Absent on v1 frames. */
  lineage: LineageSchema.optional(),
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
