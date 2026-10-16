import { SIZE_SPANS, type Workspace } from '@terminal/core'
import { Button, EmptyState } from '@terminal/ui'
import { useState } from 'react'
import type { WorkspaceState } from '../state'
import { WidgetCell } from './WidgetCell'
import { WidgetEditor } from './WidgetEditor'

/** CSS grid, three columns, dense auto-flow; spans from SIZE_SPANS; first widget placed first. */
export function Grid({ workspace, ws }: { workspace: Workspace; ws: WorkspaceState }) {
  const [adding, setAdding] = useState(false)

  if (workspace.widgets.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        {ws.status === 'streaming' ? (
          <EmptyState title="Planning the workspace…" hint="Widgets appear as the agent sets them." />
        ) : (
          <EmptyState
            title="No widgets yet"
            hint={
              <span>
                Ask in the sidebar, or{' '}
                <Button size="sm" variant="ghost" onClick={() => setAdding(true)}>
                  add a widget by hand
                </Button>
                .
              </span>
            }
          />
        )}
        <WidgetEditor open={adding} onClose={() => setAdding(false)} workspaceId={workspace.id} />
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto p-2">
      <div className="widget-grid">
        {workspace.widgets.map((widget) => {
          const span = SIZE_SPANS[widget.size]
          return (
            <div key={widget.id} style={{ gridColumn: `span ${span.cols}`, gridRow: `span ${span.rows}` }} className="min-w-0 min-h-0">
              <WidgetCell widget={widget} workspaceId={workspace.id} />
            </div>
          )
        })}
      </div>
      <div className="flex justify-end px-1 py-2">
        <Button size="sm" variant="ghost" onClick={() => setAdding(true)}>
          + Widget
        </Button>
      </div>
      <WidgetEditor open={adding} onClose={() => setAdding(false)} workspaceId={workspace.id} />
    </div>
  )
}
