import { useState } from 'react'
import { Dialog, WidgetFrame } from '@terminal/ui'
import type { Widget } from '@terminal/core'
import { useActions } from '../actions'
import { widgetDomId } from '../chips'
import { useApp } from '../state'
import { viewFor } from '../views'
import { WidgetEditor } from './WidgetEditor'

/** One grid cell: a WidgetFrame around the view for the widget's frame; skeleton until the frame lands. */
export function WidgetCell({ widget, workspaceId }: { widget: Widget; workspaceId: string }) {
  const { state } = useApp()
  const { refreshWidget } = useActions()
  const [expanded, setExpanded] = useState(false)
  const [editing, setEditing] = useState(false)

  const frame = state.frames[widget.id]
  const error = state.frameErrors[widget.id]
  const View = viewFor(widget.view)

  return (
    <div id={widgetDomId(widget.id)} className="widget-cell h-full w-full rounded">
      <WidgetFrame
        title={widget.title}
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

      <Dialog open={expanded} onClose={() => setExpanded(false)} title={widget.title} size="wide">
        <div className="h-[70vh] w-full min-h-0">{frame ? <View widget={widget} frame={frame} /> : <div className="text-fg-2">{error ?? 'Loading…'}</div>}</div>
      </Dialog>

      <WidgetEditor open={editing} onClose={() => setEditing(false)} workspaceId={workspaceId} widget={widget} />
    </div>
  )
}
