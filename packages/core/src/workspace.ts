import { z } from 'zod'
import { WidgetSchema } from './widget.js'

/** Agent tools: `query` and `set_workspace` (v1), plus `find_route` and `transform` (v2, PLAN.md section 17). */
export const TOOL_NAMES = ['query', 'set_workspace', 'find_route', 'transform'] as const
export const StepSchema = z.object({
  tool: z.enum(TOOL_NAMES),
  args: z.unknown(),
  /** One line for the Steps list, e.g. "ohlcv MU, SNDK, WDC, STX 1d 3mo · 252 rows". */
  summary: z.string(),
  ms: z.number().nonnegative(),
  error: z.string().optional(),
})
export type Step = z.infer<typeof StepSchema>

/**
 * Reply verification (PLAN.md section 17, "Also in v2"): every number the agent wrote, matched against that run's
 * previews with unit-aware tolerance. `unmatched` lists the figures no preview holds; `ok` is `unmatched` empty.
 * Produced by the server (packages/server/src/verify.ts), carried on the agent message and in the run log.
 */
export const VerificationSchema = z.object({
  ok: z.boolean(),
  /** Numbers found in the reply after dates, times, years, chip ids and small bare counts were skipped. */
  checked: z.number().int().nonnegative(),
  matched: z.number().int().nonnegative(),
  unmatched: z.array(z.object({ text: z.string(), value: z.number(), unit: z.string().optional() })),
})
export type Verification = z.infer<typeof VerificationSchema>

export const MessageSchema = z.object({
  role: z.enum(['user', 'agent']),
  text: z.string(),
  steps: z.array(StepSchema).optional(),
  at: z.number().optional(),
  /** v2: the reply's number check (agent messages only). */
  verification: VerificationSchema.optional(),
})
export type Message = z.infer<typeof MessageSchema>

export const WorkspaceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(60),
  widgets: z.array(WidgetSchema),
  messages: z.array(MessageSchema),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type Workspace = z.infer<typeof WorkspaceSchema>

export function createWorkspace(init: { id: string; name?: string; now?: number }): Workspace {
  const now = init.now ?? Date.now()
  return { id: init.id, name: init.name ?? 'Untitled', widgets: [], messages: [], createdAt: now, updatedAt: now }
}

/** Token the agent writes in a reply to link a widget; the web app renders it as a chip. */
export const WIDGET_CHIP_RE = /\[\[widget:([^\]\s]+)\]\]/g
