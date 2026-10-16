import { z } from 'zod'
import { FrameSchema } from './frame.js'
import { MessageSchema, StepSchema, type Workspace, type Message } from './workspace.js'
import { WidgetSchema } from './widget.js'

/** One WebSocket per client. */
export const ClientMsgSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('prompt'), workspaceId: z.string(), text: z.string().min(1) }),
  z.object({ t: z.literal('cancel'), workspaceId: z.string() }),
  z.object({ t: z.literal('refresh'), widgetId: z.string() }),
  z.object({ t: z.literal('focus'), workspaceId: z.string() }),
])
export type ClientMsg = z.infer<typeof ClientMsgSchema>

export const ServerMsgSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('started'), workspaceId: z.string() }),
  z.object({ t: z.literal('step'), workspaceId: z.string(), step: StepSchema }),
  z.object({ t: z.literal('widgets'), workspaceId: z.string(), widgets: z.array(WidgetSchema), name: z.string().optional() }),
  z.object({ t: z.literal('frame'), widgetId: z.string(), frame: FrameSchema }),
  z.object({ t: z.literal('frameError'), widgetId: z.string(), error: z.string() }),
  z.object({ t: z.literal('delta'), workspaceId: z.string(), text: z.string() }),
  z.object({ t: z.literal('done'), workspaceId: z.string(), message: MessageSchema }),
  z.object({ t: z.literal('failed'), workspaceId: z.string(), error: z.string() }),
])
export type ServerMsg = z.infer<typeof ServerMsgSchema>

/**
 * The seam between the HTTP/WebSocket layer and the agent loop.
 * The runner emits step/widgets/delta as it goes and resolves with the final agent message.
 * The server emits started before calling run, and done/failed after it settles.
 */
export interface AgentRunner {
  run(input: { workspace: Workspace; prompt: string; signal: AbortSignal; emit(m: ServerMsg): void }): Promise<Message>
}
