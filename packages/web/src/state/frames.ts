/**
 * Frames in the web state, keyed by workspace, widget and dataset through core's `frameKey` (PLAN.md section 17,
 * feature 8): widget ids (w1, w2, …) repeat across workspaces, so a frame left by another workspace's widget
 * with the same id must never render under this one. A frame message without a `workspaceId` lands under the
 * bare key and is read as a fallback.
 */
import { DEFAULT_DATASET, frameKey, widgetQueries, type AnyWidget, type Frame, type FrameRef } from '@terminal/core'

export type FrameStore = Record<string, Frame>
export type FrameErrors = Record<string, string>

/** A frame or error ref as the reducer sees it: the server's message, or the HTTP fetch with the workspace known. */
export type FrameEvent = { workspaceId?: string | undefined; widgetId: string; dataset?: string | undefined }

/** The frame store with one frame stored under its key, and any error for that key cleared. */
export function putFrame(frames: FrameStore, errors: FrameErrors, ref: FrameEvent, frame: Frame): { frames: FrameStore; frameErrors: FrameErrors } {
  const key = frameKey(ref)
  const frameErrors = { ...errors }
  delete frameErrors[key]
  return { frames: { ...frames, [key]: frame }, frameErrors }
}

export function putFrameError(errors: FrameErrors, ref: FrameEvent, error: string): FrameErrors {
  return { ...errors, [frameKey(ref)]: error }
}

/** Parse a key back into its parts (`workspace/widget/dataset`; ids never contain a slash). */
export function parseFrameKey(key: string): FrameRef {
  const [workspaceId = '', widgetId = '', dataset = DEFAULT_DATASET] = key.split('/')
  return { workspaceId: workspaceId || undefined, widgetId, dataset }
}

/**
 * Drop every frame and error of a widget: the keys under this workspace and the bare keys, every dataset.
 * Used when a `widgets` message replaces the set and when a workspace is deleted.
 */
export function dropWidgetFrames<T>(store: Record<string, T>, workspaceId: string | undefined, widgetId: string): Record<string, T> {
  let changed = false
  const out: Record<string, T> = {}
  for (const [key, value] of Object.entries(store)) {
    const ref = parseFrameKey(key)
    if (ref.widgetId === widgetId && (ref.workspaceId === undefined || ref.workspaceId === workspaceId)) {
      changed = true
      continue
    }
    out[key] = value
  }
  return changed ? out : store
}

/** True when any frame is stored for the widget under this workspace or the bare key. */
export function hasAnyFrame<T>(store: Record<string, T>, workspaceId: string | undefined, widgetId: string): boolean {
  return Object.keys(store).some((key) => {
    const ref = parseFrameKey(key)
    return ref.widgetId === widgetId && (ref.workspaceId === undefined || ref.workspaceId === workspaceId)
  })
}

/**
 * The frames a widget renders with, one per dataset that has landed: the workspace-keyed frame first, then the
 * bare key. Empty when nothing has landed yet.
 */
export function framesFor(store: FrameStore, workspaceId: string | undefined, widget: AnyWidget): Record<string, Frame> {
  const out: Record<string, Frame> = {}
  for (const dataset of Object.keys(widgetQueries(widget))) {
    const keyed = workspaceId ? store[frameKey({ workspaceId, widgetId: widget.id, dataset })] : undefined
    const frame = keyed ?? store[frameKey({ widgetId: widget.id, dataset })]
    if (frame) out[dataset] = frame
  }
  return out
}

/** The first error stored for the widget's datasets (the workspace-keyed one first, then the bare key). */
export function errorFor(errors: FrameErrors, workspaceId: string | undefined, widget: AnyWidget): string | undefined {
  for (const dataset of Object.keys(widgetQueries(widget))) {
    const keyed = workspaceId ? errors[frameKey({ workspaceId, widgetId: widget.id, dataset })] : undefined
    const error = keyed ?? errors[frameKey({ widgetId: widget.id, dataset })]
    if (error) return error
  }
  return undefined
}

/** True when every dataset of the widget has a frame. */
export function framesComplete(widget: AnyWidget, frames: Record<string, Frame>): boolean {
  return Object.keys(widgetQueries(widget)).every((d) => !!frames[d])
}
