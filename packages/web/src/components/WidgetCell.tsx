import { useState } from 'react'
import { Dialog, WidgetFrame } from '@terminal/ui'
import { widgetQueries, type AnyWidget } from '@terminal/core'
import { useActions } from '../actions'
import { widgetDomId } from '../chips'
import { useApp } from '../state'
import { errorFor, framesFor } from '../state/frames'
import { subtitleForWidget } from '../subtitle'
import { primaryFrame, viewFor } from '../views'
import { Editor } from './Editor'
import { VirtualTable } from './VirtualTable'


/**
 * One grid cell: a WidgetFrame around the view for the widget's frames (one per dataset, PLAN.md section 17);
 * skeleton until the primary frame lands, a secondary dataset (events, levels) draws when it lands. Frames are
 * read by workspace, widget and dataset (state/frames.ts), so a frame left by another workspace's widget with
 * the same id is never this widget's. The expand dialog adds the whole primary frame as a virtualised table.
 */
export function WidgetCell({ widget, workspaceId }: { widget: AnyWidget; workspaceId: string }) {
  const { state } = useApp()
  const { refreshWidget } = useActions()
  const [expanded, setExpanded] = useState(false)
  const [editing, setEditing] = useState(false)

  const frames = framesFor(state.frames, workspaceId, widget)
  const error = errorFor(state.frameErrors, workspaceId, widget)
  const View = viewFor(widget)
  const subtitle = subtitleForWidget(widget, frames)
  const primary = primaryFrame(widget, frames)
  const ready = !!primary
  const datasetCount = Object.keys(widgetQueries(widget)).length

  return (
    <div id={widgetDomId(widget.id)} className="widget-cell h-full w-full rounded">
      <WidgetFrame
        title={widget.title}
        subtitle={subtitle}
        size={widget.size}
        loading={!ready && !error}
        error={ready ? undefined : error}
        empty={!!primary && primary.rows.length === 0}
        meta={datasetCount > 1 ? <span className="num">{datasetCount} datasets</span> : undefined}
        onEdit={() => setEditing(true)}
        onRefresh={() => refreshWidget(widget.id, workspaceId)}
        onExpand={() => setExpanded(true)}
      >
        {ready && <View widget={widget} frames={frames} />}
      </WidgetFrame>

      <Dialog open={expanded} onClose={() => setExpanded(false)} title={subtitle ? `${widget.title} · ${subtitle}` : widget.title} size="wide">
        <div className="flex h-[70vh] w-full min-h-0 flex-col gap-2">
          <div className="min-h-0 flex-1">{ready ? <View widget={widget} frames={frames} /> : <div className="text-fg-2">{error ?? 'Loading…'}</div>}</div>
          {primary && (
            <details className="shrink-0">
              <summary className="cursor-pointer text-xs text-fg-2">
                The whole frame · {primary.rows.length} rows × {primary.columns.length} columns
              </summary>
              <div className="@container/widget mt-1 h-64 rounded border border-border">
                <VirtualTable columns={primary.columns} rows={primary.rows} />
              </div>
            </details>
          )}
        </div>
      </Dialog>

      <Editor open={editing} onClose={() => setEditing(false)} workspaceId={workspaceId} widget={widget} />
    </div>
  )
}
