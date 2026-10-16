import { z } from 'zod'
import { WidgetSchema } from './widget.js'

export const StepSchema = z.object({
  tool: z.enum(['query', 'set_workspace']),
  args: z.unknown(),
  /** One line for the Steps list, e.g. "ohlcv MU, SNDK, WDC, STX 1d 3mo · 252 rows". */
  summary: z.string(),
  ms: z.number().nonnegative(),
  error: z.string().optional(),
})
export type Step = z.infer<typeof StepSchema>

export const MessageSchema = z.object({
  role: z.enum(['user', 'agent']),
  text: z.string(),
  steps: z.array(StepSchema).optional(),
  at: z.number().optional(),
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
