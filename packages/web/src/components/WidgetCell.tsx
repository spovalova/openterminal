import { useState } from 'react'
import { Dialog, WidgetFrame } from '@terminal/ui'
import { KINDS, type Frame, type Widget } from '@terminal/core'
import { useActions } from '../actions'
import { widgetDomId } from '../chips'
import { useApp } from '../state'
import { subtitleFor } from '../subtitle'
import { viewFor } from '../views'
import { WidgetEditor } from './WidgetEditor'

/** A frame has the columns of the widget's kind (the registry guarantees it for the widget's own frame). */
export function frameMatches(widget: Widget, frame: Frame): boolean {
  const expected = KINDS[widget.query.kind].columns
  return frame.columns.length === expected.length && frame.columns.every((c, i) => c.name === expected[i]!.name)
}

/** One grid cell: a WidgetFrame around the view for the widget's frame; skeleton until the frame lands. */
export function WidgetCell({ widget, workspaceId }: { widget: Widget; workspaceId: string }) {
  const { state } = useApp()
  const { refreshWidget } = useActions()
  const [expanded, setExpanded] = useState(false)
  const [editing, setEditing] = useState(false)

  // Frames are keyed by widget id, and ids (w1, w2, …) repeat across workspaces: a frame left by another
  // workspace's widget with the same id is not this widget's until its own lands, so it is treated as loading.
  const stored = state.frames[widget.id]
  const frame = stored && frameMatches(widget, stored) ? stored : undefined
  const error = state.frameErrors[widget.id]
  const View = viewFor(widget.view)
  const subtitle = subtitleFor(widget, frame)

  return (
    <div id={widgetDomId(widget.id)} className="widget-cell h-full w-full rounded">
      <WidgetFrame
        title={widget.title}
        subtitle={subtitle}
        size={widget.size}
        loading={!frame && !error}
        error={error}
        empty={!!frame && frame.rows.length === 0}
        onEdit={() => setEditing(true)}
        onRefresh={() => refreshWidget(widget.id, workspaceId)}
        onExpand={() => setExpanded(true)}
      >
        {frame && <View widget={widget} frame={frame} />}
      </WidgetFrame>

      <Dialog open={expanded} onClose={() => setExpanded(false)} title={subtitle ? `${widget.title} · ${subtitle}` : widget.title} size="wide">
        <div className="h-[70vh] w-full min-h-0">{frame ? <View widget={widget} frame={frame} /> : <div className="text-fg-2">{error ?? 'Loading…'}</div>}</div>
      </Dialog>

      <WidgetEditor open={editing} onClose={() => setEditing(false)} workspaceId={workspaceId} widget={widget} />
    </div>
  )
}
