import { GRID_GAP, columnsFor, packLayout, rowHeightFor, type Workspace } from '@terminal/core'
import { Button, EmptyState } from '@terminal/ui'
import { useCallback, useLayoutEffect, useState } from 'react'
import { useApp, type WorkspaceState } from '../state'
import { framesFor } from '../state/frames'
import { contentHintFor } from '../views'
import { WidgetCell } from './WidgetCell'
import { Editor } from './Editor'

/** Vertical padding of the pane plus the "+ Widget" strip under the grid. */
const CHROME_HEIGHT = 16 + 36

/**
 * Pane size, measured on the scroll container itself (not the viewport: the sidebar takes a third of a
 * laptop). A callback ref, so a pane that first showed the empty state is measured once widgets arrive.
 */
function usePaneSize(): [(el: HTMLDivElement | null) => void, { width: number; height: number }] {
  const [el, setEl] = useState<HTMLDivElement | null>(null)
  const [size, setSize] = useState({ width: 1200, height: 0 })
  const ref = useCallback((node: HTMLDivElement | null) => setEl(node), [])
  useLayoutEffect(() => {
    if (!el) return
    const update = () => setSize({ width: el.clientWidth - 16, height: el.clientHeight })
    update()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [el])
  return [ref, size]
}

/**
 * CSS grid laid out by `packLayout`: the column count follows the grid's width, every widget gets an
 * explicit position and span, and no cell stays empty (product rule 3). Rows share the pane's height
 * down to MIN_ROW_HEIGHT (core), so one or two rows fill it and more scroll. Each widget goes to the
 * packer with a content hint (its view kind and the primary frame's row count), so a short table, a
 * stat or a facts card is one row tall and a chart two (PLAN.md section 17, "size by content").
 */
export function Grid({ workspace, ws }: { workspace: Workspace; ws: WorkspaceState }) {
  const [adding, setAdding] = useState(false)
  const [ref, pane] = usePaneSize()
  const { state } = useApp()
  const columns = columnsFor(pane.width)

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
        <Editor open={adding} onClose={() => setAdding(false)} workspaceId={workspace.id} />
      </div>
    )
  }

  const layout = packLayout(
    workspace.widgets.map((widget) => ({ size: widget.size, contentHint: contentHintFor(widget, framesFor(state.frames, workspace.id, widget)) })),
    columns,
  )
  const rows = layout.reduce((n, p) => Math.max(n, p.row + p.rows), 0)
  const columnWidth = (pane.width - GRID_GAP * (columns - 1)) / columns
  const rowHeight = rowHeightFor(rows, pane.height, CHROME_HEIGHT, columnWidth)

  return (
    <div ref={ref} className="flex h-full flex-col overflow-y-auto p-2">
      <div
        className="widget-grid"
        style={{ '--grid-cols': columns, '--grid-row': `${rowHeight}px` } as React.CSSProperties}
        data-columns={columns}
        data-rows={rows}
      >
        {workspace.widgets.map((widget, i) => {
          const p = layout[i]!
          return (
            <div
              key={widget.id}
              style={{ gridColumn: `${p.col + 1} / span ${p.cols}`, gridRow: `${p.row + 1} / span ${p.rows}` }}
              className="min-w-0 min-h-0"
              data-stretched={p.stretched ? '' : undefined}
              data-demoted={p.demoted ? '' : undefined}
            >
              <WidgetCell widget={widget} workspaceId={workspace.id} />
            </div>
          )
        })}
      </div>
      <div className="flex shrink-0 justify-end px-1 py-2">
        <Button size="sm" variant="ghost" onClick={() => setAdding(true)}>
          + Widget
        </Button>
      </div>
      <Editor open={adding} onClose={() => setAdding(false)} workspaceId={workspace.id} />
    </div>
  )
}
