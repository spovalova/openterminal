import { z } from 'zod'
import { FrameSchema } from './frame.js'
import { MessageSchema, StepSchema, type Workspace, type Message } from './workspace.js'
import { AnyWidgetSchema, DEFAULT_DATASET } from './widget.js'

/** One WebSocket per client. */
export const ClientMsgSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('prompt'), workspaceId: z.string(), text: z.string().min(1) }),
  z.object({ t: z.literal('cancel'), workspaceId: z.string() }),
  /** `dataset` (v2) refreshes one dataset of the widget; absent means every dataset. */
  z.object({ t: z.literal('refresh'), widgetId: z.string(), workspaceId: z.string().optional(), dataset: z.string().optional() }),
  z.object({ t: z.literal('focus'), workspaceId: z.string() }),
])
export type ClientMsg = z.infer<typeof ClientMsgSchema>

/**
 * Frame messages (v2) carry `{ workspaceId, widgetId, dataset }` so the web keys frames by workspace, widget and
 * dataset (PLAN.md section 17, feature 8); widget ids repeat across workspaces. A v1 message has neither
 * `workspaceId` nor `dataset`; read it with `frameKey`, which defaults the dataset to `main`.
 */
export const ServerMsgSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('started'), workspaceId: z.string() }),
  z.object({ t: z.literal('step'), workspaceId: z.string(), step: StepSchema }),
  /** v2 (phase 2 integration): the agent's set is `WidgetV2[]`; v1 widgets still pass during the coexistence. */
  z.object({ t: z.literal('widgets'), workspaceId: z.string(), widgets: z.array(AnyWidgetSchema), name: z.string().optional() }),
  z.object({ t: z.literal('frame'), widgetId: z.string(), frame: FrameSchema, workspaceId: z.string().optional(), dataset: z.string().optional() }),
  z.object({ t: z.literal('frameError'), widgetId: z.string(), error: z.string(), workspaceId: z.string().optional(), dataset: z.string().optional() }),
  z.object({ t: z.literal('delta'), workspaceId: z.string(), text: z.string() }),
  z.object({ t: z.literal('done'), workspaceId: z.string(), message: MessageSchema }),
  z.object({ t: z.literal('failed'), workspaceId: z.string(), error: z.string() }),
])
export type ServerMsg = z.infer<typeof ServerMsgSchema>

export type FrameRef = { workspaceId?: string | undefined; widgetId: string; dataset?: string | undefined }

/** The web state's key for a frame: `workspace/widget/dataset`, with the v1 defaults (no workspace, dataset `main`). */
export function frameKey(ref: FrameRef): string {
  return `${ref.workspaceId ?? ''}/${ref.widgetId}/${ref.dataset ?? DEFAULT_DATASET}`
}

/** The dataset a frame or frameError message is about. */
export function frameDataset(m: Extract<ServerMsg, { t: 'frame' | 'frameError' }>): string {
  return m.dataset ?? DEFAULT_DATASET
}

/**
 * The seam between the HTTP/WebSocket layer and the agent loop.
 * The runner emits step/widgets/delta as it goes and resolves with the final agent message.
 * The server emits started before calling run, and done/failed after it settles.
 */
export interface AgentRunner {
  run(input: { workspace: Workspace; prompt: string; signal: AbortSignal; emit(m: ServerMsg): void }): Promise<Message>
}
