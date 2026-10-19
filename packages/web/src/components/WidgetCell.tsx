import { useState } from 'react'
import { Dialog, WidgetFrame } from '@terminal/ui'
import type { AnyWidget, Widget } from '@terminal/core'
import { useActions } from '../actions'
import { widgetDomId } from '../chips'
import { useApp } from '../state'
import { errorFor, framesComplete, framesFor } from '../state/frames'
import { subtitleForWidget } from '../subtitle'
import { viewFor } from '../views'
import { WidgetEditor } from './WidgetEditor'

export { frameMatches } from '../state/frames'

/**
 * One grid cell: a WidgetFrame around the view for the widget's frames; skeleton until the primary frame lands.
 * Frames are read by workspace, widget and dataset (state/frames.ts), so a frame left by another workspace's
 * widget with the same id is never this widget's.
 */
export function WidgetCell({ widget, workspaceId }: { widget: AnyWidget; workspaceId: string }) {
  const { state } = useApp()
  const { refreshWidget } = useActions()
  const [expanded, setExpanded] = useState(false)
  const [editing, setEditing] = useState(false)

  const frames = framesFor(state.frames, workspaceId, widget)
  const landed = Object.keys(frames).length > 0
  const error = errorFor(state.frameErrors, workspaceId, widget)
  const View = viewFor(widget)
  const subtitle = subtitleForWidget(widget, frames)
  const primary = frames.main ?? Object.values(frames)[0]
  // Render once the primary frame is here; a secondary dataset (events, levels) draws when it lands.
  const ready = landed && (framesComplete(widget, frames) || !!primary)

  return (
    <div id={widgetDomId(widget.id)} className="widget-cell h-full w-full rounded">
      <WidgetFrame
        title={widget.title}
        subtitle={subtitle}
        size={widget.size}
        loading={!ready && !error}
        error={ready ? undefined : error}
        empty={ready && !!primary && primary.rows.length === 0}
        onEdit={() => setEditing(true)}
        onRefresh={() => refreshWidget(widget.id, workspaceId)}
        onExpand={() => setExpanded(true)}
      >
        {ready && <View widget={widget} frames={frames} />}
      </WidgetFrame>

      <Dialog open={expanded} onClose={() => setExpanded(false)} title={subtitle ? `${widget.title} · ${subtitle}` : widget.title} size="wide">
        <div className="h-[70vh] w-full min-h-0">{ready ? <View widget={widget} frames={frames} /> : <div className="text-fg-2">{error ?? 'Loading…'}</div>}</div>
      </Dialog>

      {/* The editor is v1's form over kinds until (e)'s three-tab editor lands; a v2 widget has no kind form yet. */}
      {'query' in widget && widget.query && <WidgetEditor open={editing} onClose={() => setEditing(false)} workspaceId={workspaceId} widget={widget as Widget} />}
    </div>
  )
}
