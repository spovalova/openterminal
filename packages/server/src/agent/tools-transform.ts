// The `transform` agent tool (PLAN.md section 17; docs/notes/v2-contracts.md, workstream b). Workstream (c) adds
// it to `createTools`: `transform: createTransformTool({ registry, signal, onStep, charge })`.
//
// `transform(inputs, code, columns?)` → `registry.run({ inputs, code, columns })` → the preview with the frame's
// lineage and field config, or `{ ok: false, error, traceback }` so the agent can fix the script and call again.
import { tool } from 'ai'
import { z } from 'zod'
import {
  OT_HELPERS,
  TRANSFORM_ALLOWED_IMPORTS,
  TRANSFORM_LIMITS,
  TransformFailed,
  TransformQuerySchema,
  preview,
  type FieldConfig,
  type Lineage,
  type Preview,
  type Registry,
  type Step,
  type TransformQuery,
} from '@openterminal/core'

export type TransformToolDeps = {
  registry: Pick<Registry, 'run'>
  signal?: AbortSignal
  /** Called once per call with the finished step (also when it failed). */
  onStep?(step: Step): void
  /** The per-prompt budget hook: returns an error string when no call is left, and the tool returns it without running. */
  charge?(args: unknown, summary: string): string | undefined
  now?: () => number
}

/**
 * Input values are loose records here (the Anthropic API wants a plain object at the top and a 22-way union per
 * input would be unwieldy); `TransformQuerySchema` validates the real shapes in execute, as the v1 `query` tool does.
 */
export const TransformToolInput = z.object({
  inputs: z
    .record(z.string().regex(/^[a-z_][a-z0-9_]*$/i, 'input names are Python identifiers'), z.record(z.string(), z.unknown()))
    .describe('Dataset name → query. Each value is a route { connector, route, params }, a recipe { recipe, params }, a v1 { kind, params }, or a nested transform. Names are Python identifiers and become the DataFrame names in the script.'),
  code: z.string().min(1).max(TRANSFORM_LIMITS.codeChars).describe('Python (pandas) that assigns `result`, a DataFrame. `pd`, `np`, `scipy`, `math`, `datetime` and `ot` are in scope.'),
  columns: z
    .record(z.string(), z.object({ unit: z.enum(['fraction', 'percent', 'ratio', 'usd', 'shares', 'count', 'days', 'years', 'bps']).optional(), label: z.string().optional(), format: z.string().optional() }))
    .optional()
    .describe('Unit and label for columns the script created, e.g. { pe: { unit: "ratio", label: "P/E (TTM)" } }. Columns that keep an input\'s name keep its unit.'),
})
export type TransformToolInputT = z.input<typeof TransformToolInput>

export type TransformToolResult =
  | {
      ok: true
      connector: 'transform'
      note: string
      preview: Preview
      /** Code and the input queries' lineage, for "derived from closes and reported EPS". */
      lineage: Lineage
      /** Field config per result column: the unit each number carries. */
      fields: Record<string, FieldConfig>
    }
  | { ok: false; error: string; traceback?: string }

export const TRANSFORM_TOOL_DESCRIPTION = [
  'Derive a frame from one or more frames with pandas: joins, windows, ratios, rebasing, indicators, solvers, pivots.',
  'Each input is bound as a DataFrame of that name (time columns are tz-aware America/New_York datetimes); assign `result`, a DataFrame.',
  `Imports allowed: ${TRANSFORM_ALLOWED_IMPORTS.join(', ')}; \`ot\` has ${OT_HELPERS.map((h) => h.name).join(', ')}.`,
  `Limits: ${TRANSFORM_LIMITS.inputRows.toLocaleString()} input rows, ${TRANSFORM_LIMITS.outputRows.toLocaleString()} result rows, ${TRANSFORM_LIMITS.cpuMs / 1000} s.`,
  'Inputs you already queried are cache hits; new ones run first. Returns the preview of the result like `query` does, or { error, traceback }: fix the script and call again.',
  'Declare the unit of columns you create in `columns`; a number without a unit carries none in your reply.',
].join(' ')

/** One-line step summary, e.g. `transform(price, eps) · 502 rows`. */
export function transformSummary(input: unknown, rowCount?: number, failed = false): string {
  const names = Object.keys(((input ?? {}) as { inputs?: Record<string, unknown> }).inputs ?? {})
  const head = `transform(${names.join(', ')})`
  if (failed) return `${head} · failed`
  return rowCount === undefined ? head : `${head} · ${rowCount} ${rowCount === 1 ? 'row' : 'rows'}`
}

/** The tool body: validate, run through the registry, preview. Exported so it can be called without the `ai` wrapper. */
export async function runTransformTool(deps: TransformToolDeps, input: TransformToolInputT): Promise<TransformToolResult> {
  const now = deps.now ?? Date.now
  const t0 = now()
  const over = deps.charge?.(input, transformSummary(input))
  if (over) return { ok: false, error: over }
  const parsed = TransformQuerySchema.safeParse(input)
  if (!parsed.success) {
    const error = `invalid transform: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`
    deps.onStep?.({ tool: 'transform', args: input, summary: transformSummary(input, undefined, true), ms: now() - t0, error })
    return { ok: false, error }
  }
  const q: TransformQuery = parsed.data
  try {
    const frame = await deps.registry.run(q, { signal: deps.signal })
    const pv = preview(frame)
    deps.onStep?.({ tool: 'transform', args: q, summary: transformSummary(q, frame.rows.length), ms: now() - t0 })
    const shown = pv.rows.length
    const note =
      `transform over ${Object.keys(q.inputs).join(', ')}: ${pv.rowCount} rows` +
      (shown < pv.rowCount ? `, first ${shown} shown; use stats for the rest` : '') +
      '. Widgets on this transform render the full frame and re-run it when the inputs refresh.'
    return { ok: true, connector: 'transform', note, preview: pv, lineage: frame.meta.lineage ?? { code: q.code }, fields: frame.meta.fields ?? {} }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    const traceback = err instanceof TransformFailed ? err.traceback : undefined
    deps.onStep?.({ tool: 'transform', args: q, summary: transformSummary(q, undefined, true), ms: now() - t0, error })
    return { ok: false, error: `transform failed: ${error}`, ...(traceback ? { traceback } : {}) }
  }
}

export function createTransformTool(deps: TransformToolDeps) {
  return tool({
    description: TRANSFORM_TOOL_DESCRIPTION,
    inputSchema: TransformToolInput,
    execute: (input): Promise<TransformToolResult> => runTransformTool(deps, input),
  })
}

export type TransformTool = ReturnType<typeof createTransformTool>
