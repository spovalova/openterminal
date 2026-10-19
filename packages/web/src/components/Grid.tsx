import { GRID_GAP, columnsFor, isShortContent, minHeight, naturalHeight, packLayout, placementHeight, trackHeights, type ContentHint, type Workspace } from '@openterminal/core'
import { Button, EmptyState } from '@openterminal/ui'
import { useCallback, useLayoutEffect, useMemo, useState } from 'react'
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
    const update = () => setSize((prev) => (prev.width === el.clientWidth - 16 && prev.height === el.clientHeight ? prev : { width: el.clientWidth - 16, height: el.clientHeight }))
    update()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [el])
  return [ref, size]
}

/**
 * CSS grid laid out by `packLayout`: the column count follows the grid's width, every widget gets an explicit
 * position and span in columns and tracks, and no cell stays empty (product rule 3). Each widget goes to the packer
 * with a content hint (its view kind, the primary frame's row count, a table's content width, a stat's card count).
 *
 * Taste round 2: the tracks are sized, not uniform. A track that only short widgets (stats, facts cards, short
 * tables) occupy on their own is as tall as their content, measured in the browser; the other tracks share the rest
 * of the pane, so the page fills to the bottom and a card's spare height goes to the chart or table beside it.
 */
export function Grid({ workspace, ws }: { workspace: Workspace; ws: WorkspaceState }) {
  const [adding, setAdding] = useState(false)
  const [ref, pane] = usePaneSize()
  const { state } = useApp()
  const [naturals, setNaturals] = useState<Record<string, number>>({})
  const onNatural = useCallback((id: string, px: number) => setNaturals((prev) => (Math.abs((prev[id] ?? 0) - px) <= 1 ? prev : { ...prev, [id]: px })), [])
  const columns = columnsFor(pane.width)
  const columnWidth = (pane.width - GRID_GAP * (columns - 1)) / columns
  const available = Math.max(0, pane.height - CHROME_HEIGHT)

  const hints: ContentHint[] = workspace.widgets.map((widget) => contentHintFor(widget, framesFor(state.frames, workspace.id, widget)))
  const hintKey = JSON.stringify([workspace.widgets.map((w) => w.size), hints, columns, Math.round(columnWidth), Math.round(available)])
  const layout = useMemo(
    () => packLayout(workspace.widgets.map((widget, i) => ({ size: widget.size, contentHint: hints[i] })), columns, { columnWidth, height: available, gap: GRID_GAP }),
    // The hints, sizes and pane decide the layout; recomputing on every frame tick would cost the packer's search.
    [hintKey],
  )

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

  const short = workspace.widgets.map((widget, i) => isShortContent({ size: widget.size, contentHint: hints[i]! }))
  const items = layout.map((p, i) => {
    const width = p.cols * columnWidth + (p.cols - 1) * GRID_GAP
    const measured = short[i] ? naturals[workspace.widgets[i]!.id] : undefined
    const estimate = naturalHeight(hints[i], width)
    return { short: short[i]!, natural: measured ?? estimate, min: measured ?? minHeight(hints[i], width) }
  })
  const tracks = trackHeights(layout, items, available, GRID_GAP)
  // A card or short table whose track is taller than its content (a taller neighbour shares the track) fills its cell:
  // a table's rows breathe up to 36px and a card's lines up to 8px more, the rest stays under the content. Its natural
  // height is no longer measured there (it would grow with the spacing), the last measurement stands.
  const slackOf = (i: number) => {
    const measured = short[i] ? naturals[workspace.widgets[i]!.id] : undefined
    return measured !== undefined ? placementHeight(layout[i]!, tracks, GRID_GAP) - measured : 0
  }
  const rows = tracks.length

  return (
    <div ref={ref} className="flex h-full flex-col overflow-y-auto p-2">
      <div
        className="widget-grid"
        style={{ '--grid-cols': columns, gridTemplateRows: tracks.map((t) => `${t}px`).join(' ') } as React.CSSProperties}
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
              data-hint={JSON.stringify(hints[i])}
              data-natural={items[i]!.natural}
            >
              <WidgetCell widget={widget} workspaceId={workspace.id} fit={short[i] && slackOf(i) <= 24 ? 'content' : 'fill'} slack={short[i] ? Math.max(0, slackOf(i)) : 0} onNatural={onNatural} />
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
