import { nyDate } from './clock.js'
import type { Frame } from './frame.js'
import { canonicalKey, type AnyQuery } from './query.js'
import { widgetQueries, type AnyWidget } from './widget.js'

/**
 * One snapshot for the reply and the widgets (taste round 2, change 5). The frames each widget showed when a reply
 * was verified, kept so the widgets the reply describes keep showing those numbers until the user asks for live
 * data: a "verified" footer never sits under figures the widgets beside it contradict.
 *
 * `asOf` is the reply's time; `widgets` holds, per widget, the key of its queries (a held frame belongs to the widget
 * only while its data graph is the same) and its frames by dataset.
 */
export type ReplySnapshot = {
  asOf: number
  widgets: Record<string, { key: string; frames: Record<string, Frame> }>
}

/** The key of a widget's data graph: its datasets' canonical queries, in name order. */
export function widgetDataKey(widget: AnyWidget): string {
  return JSON.stringify(
    Object.entries(widgetQueries(widget))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, q]) => [name, canonicalKey(q)]),
  )
}

/**
 * The snapshot a run leaves: for every widget, the frames it showed during the run (`shown`, keyed
 * `widgetId/dataset`), else the frames the run itself fetched for the same queries (`seen`), which are the previews
 * the reply was verified against. A widget missing a dataset in both is left live.
 */
export function buildSnapshot(widgets: readonly AnyWidget[], shown: ReadonlyMap<string, Frame>, seen: (q: AnyQuery) => Frame | undefined, asOf: number): ReplySnapshot {
  const out: ReplySnapshot = { asOf, widgets: {} }
  for (const widget of widgets) {
    const frames: Record<string, Frame> = {}
    let complete = true
    for (const [dataset, q] of Object.entries(widgetQueries(widget))) {
      const frame = shown.get(`${widget.id}/${dataset}`) ?? seen(q)
      if (!frame) {
        complete = false
        break
      }
      frames[dataset] = frame
    }
    if (complete && Object.keys(frames).length > 0) out.widgets[widget.id] = { key: widgetDataKey(widget), frames }
  }
  return out
}

/** A snapshot holds on the trading date it was taken (New York): a returning user the next day sees live data. */
export function snapshotCurrent(snapshot: ReplySnapshot | undefined, now: number): boolean {
  return !!snapshot && nyDate(snapshot.asOf) === nyDate(now)
}

/** The frames held for a widget, marked `heldAt`, when the snapshot is current and the widget's queries unchanged. */
export function heldFrames(snapshot: ReplySnapshot | undefined, widget: AnyWidget, now: number): Record<string, Frame> | undefined {
  if (!snapshot || !snapshotCurrent(snapshot, now)) return undefined
  const entry = snapshot.widgets[widget.id]
  if (!entry || entry.key !== widgetDataKey(widget)) return undefined
  const out: Record<string, Frame> = {}
  for (const [dataset, frame] of Object.entries(entry.frames)) out[dataset] = { ...frame, meta: { ...frame.meta, heldAt: snapshot.asOf } }
  return out
}

/** The snapshot without some widgets (released to live data); every widget when `widgetIds` is omitted. */
export function releaseSnapshot(snapshot: ReplySnapshot, widgetIds?: readonly string[]): ReplySnapshot {
  if (!widgetIds) return { asOf: snapshot.asOf, widgets: {} }
  const widgets = { ...snapshot.widgets }
  for (const id of widgetIds) delete widgets[id]
  return { asOf: snapshot.asOf, widgets }
}
