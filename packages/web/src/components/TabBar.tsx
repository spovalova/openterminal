import { useState } from 'react'
import { Button, Dialog, Tabs } from '@terminal/ui'
import { useActions } from '../actions'
import { useApp } from '../state'

/** One tab per workspace. Close deletes (confirm), "+" creates, double-click renames (PATCH). */
export function TabBar() {
  const { state, dispatch } = useApp()
  const { newWorkspace, deleteWorkspace, renameWorkspace } = useActions()
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)

  const active = state.workspaces.find((w) => w.id === state.activeId)
  const items = state.workspaces.map((w) => {
    const ws = state.ws[w.id]
    return { id: w.id, label: ws?.status === 'streaming' ? `${w.name} ·` : w.name }
  })

  // The ui Tabs component has no rename hook; the first click of a double-click selects the tab, so the active one is the target.
  const onDoubleClick = () => {
    if (active) setRenaming({ id: active.id, name: active.name })
  }

  return (
    <div className="border-b border-border bg-surface" onDoubleClick={onDoubleClick}>
      <Tabs
        items={items}
        activeId={state.activeId ?? undefined}
        onSelect={(id) => dispatch({ type: 'activate', id })}
        onClose={(id) => void deleteWorkspace(id)}
        onNew={() => void newWorkspace()}
      />
      <Dialog open={renaming !== null} onClose={() => setRenaming(null)} title="Rename workspace">
        <form
          className="flex w-[min(90vw,360px)] gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (renaming) void renameWorkspace(renaming.id, renaming.name).then(() => setRenaming(null))
          }}
        >
          <input
            autoFocus
            className="flex-1 rounded border border-border bg-bg px-2 py-1 text-fg outline-none focus:border-accent"
            value={renaming?.name ?? ''}
            maxLength={60}
            onChange={(e) => setRenaming((r) => (r ? { ...r, name: e.target.value } : r))}
          />
          <Button type="submit" size="sm" variant="primary">
            Rename
          </Button>
        </form>
      </Dialog>
    </div>
  )
}
