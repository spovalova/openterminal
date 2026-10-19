import { useState } from 'react'
import { Dialog, WidgetFrame } from '@terminal/ui'
import { DEFAULT_DATASET, KINDS, describeQuery, isWidgetV2, widgetQueries, type AnyWidget, type Frame, type Widget } from '@terminal/core'
import { useActions } from '../actions'
import { widgetDomId } from '../chips'
import { frameErrorsFor, framesFor, useApp } from '../state'
import { subtitleFor } from '../subtitle'
import { viewFor } from '../views'
import { Editor } from './Editor'
import { asV1Widget } from './editor-model'
import { VirtualTable } from './VirtualTable'

/** A frame has the columns of the widget's kind (the registry guarantees it for the widget's own frame). */
export function frameMatches(widget: Widget, frame: Frame): boolean {
  const expected = KINDS[widget.query.kind].columns
  return frame.columns.length === expected.length && frame.columns.every((c, i) => c.name === expected[i]!.name)
}

/** The dataset a widget shows first: the view's, else `main`, else the first. */
export function primaryOf(widget: AnyWidget): string {
  const names = Object.keys(widgetQueries(widget))
  if (isWidgetV2(widget) && widget.view.data && names.includes(widget.view.data)) return widget.view.data
  return names.includes(DEFAULT_DATASET) ? DEFAULT_DATASET : (names[0] ?? DEFAULT_DATASET)
}

/**
 * One grid cell: a WidgetFrame around the view for the widget's frame; skeleton until the frame lands.
 * A v2 widget renders through the v1 views when its main data is a kind query the renderers know (`asV1Widget`),
 * else as a table of its primary dataset (the floor) until (d)'s preset renderers land.
 */
export function WidgetCell({ widget, workspaceId }: { widget: AnyWidget; workspaceId: string }) {
  const { state } = useApp()
  const { refreshWidget } = useActions()
  const [expanded, setExpanded] = useState(false)
  const [editing, setEditing] = useState(false)

  const frames = framesFor(state, widget)
  const errors = frameErrorsFor(state, widget)
  const primary = primaryOf(widget)
  const v1 = asV1Widget(widget)
  // Frames are keyed by widget id, and ids (w1, w2, …) repeat across workspaces: a frame left by another
  // workspace's widget with the same id is not this widget's until its own lands, so it is treated as loading.
  const main = frames[DEFAULT_DATASET] ?? frames[primary]
  const v1Frame = v1 && main && frameMatches(v1, main) ? main : undefined
  const frame = v1Frame ?? frames[primary]
  const error = errors[primary] ?? Object.values(errors)[0]
  const View = v1 ? viewFor(v1.view) : undefined
  const subtitle = v1 ? subtitleFor(v1, v1Frame) : describeQuery(widgetQueries(widget)[primary]!)
  const datasetCount = Object.keys(widgetQueries(widget)).length

  const body = frame ? (
    v1 && v1Frame && View ? (
      <View widget={v1} frame={v1Frame} />
    ) : (
      <div data-view="table-fallback" className="h-full w-full overflow-hidden">
        <VirtualTable columns={frame.columns} rows={frame.rows} />
      </div>
    )
  ) : null

  return (
    <div id={widgetDomId(widget.id)} className="widget-cell h-full w-full rounded">
      <WidgetFrame
        title={widget.title}
        subtitle={subtitle}
        size={widget.size}
        loading={!frame && !error}
        error={frame ? undefined : error}
        empty={!!frame && frame.rows.length === 0}
        meta={datasetCount > 1 ? <span className="num">{datasetCount} datasets</span> : undefined}
        onEdit={() => setEditing(true)}
        onRefresh={() => refreshWidget(widget.id, workspaceId)}
        onExpand={() => setExpanded(true)}
      >
        {body}
      </WidgetFrame>

      <Dialog open={expanded} onClose={() => setExpanded(false)} title={subtitle ? `${widget.title} · ${subtitle}` : widget.title} size="wide">
        <div className="flex h-[70vh] w-full min-h-0 flex-col gap-2">
          <div className="min-h-0 flex-1">{body ?? <div className="text-fg-2">{error ?? 'Loading…'}</div>}</div>
          {frame && v1Frame && (
            <details className="shrink-0">
              <summary className="cursor-pointer text-xs text-fg-2">
                The whole frame · {frame.rows.length} rows × {frame.columns.length} columns
              </summary>
              <div className="@container/widget mt-1 h-64 rounded border border-border">
                <VirtualTable columns={frame.columns} rows={frame.rows} />
              </div>
            </details>
          )}
        </div>
      </Dialog>

      <Editor open={editing} onClose={() => setEditing(false)} workspaceId={workspaceId} widget={widget} />
    </div>
  )
}
