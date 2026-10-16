import { useEffect, useState } from 'react'
import { Command } from 'cmdk'
import { Dialog } from '@terminal/ui'
import { useActions } from '../actions'
import { TICKER_RE } from '../platform'
import { useApp } from '../state'

/** The command palette (⌘K or `/`): new workspace, jump to a workspace, connectors, and the ticker shortcut. */
export function Palette({ open, onClose, onConnectors }: { open: boolean; onClose: () => void; onConnectors: () => void }) {
  const { state, dispatch } = useApp()
  const { newWorkspace, openTicker } = useActions()
  const [query, setQuery] = useState('')

  useEffect(() => {
    if (open) setQuery('')
  }, [open])

  const ticker = TICKER_RE.test(query.trim()) ? query.trim() : null
  const run = (fn: () => unknown) => {
    onClose()
    void fn()
  }

  return (
    <Dialog open={open} onClose={onClose} title="Palette">
      <Command label="Command palette" loop className="w-[min(90vw,560px)]">
        <Command.Input
          autoFocus
          value={query}
          onValueChange={setQuery}
          placeholder="Type a command, a workspace, or a ticker like MU…"
          className="w-full border-b border-border bg-transparent px-2 py-2 text-fg outline-none placeholder:text-muted"
        />
        <Command.List className="max-h-[50vh] overflow-y-auto py-1 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-muted [&_[cmdk-item]]:cursor-pointer [&_[cmdk-item]]:rounded [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-1.5 [&_[cmdk-item][data-selected=true]]:bg-raised">
          <Command.Empty className="px-2 py-3 text-muted">Nothing matches.</Command.Empty>
          {ticker && (
            <Command.Group heading="Ticker">
              <Command.Item value={`ticker ${ticker}`} onSelect={() => run(() => openTicker(ticker))}>
                Overview of {ticker} <span className="text-muted">— new workspace</span>
              </Command.Item>
            </Command.Group>
          )}
          <Command.Group heading="Workspaces">
            <Command.Item value="new workspace" onSelect={() => run(() => newWorkspace())}>
              New workspace
            </Command.Item>
            {state.workspaces.map((w) => (
              <Command.Item key={w.id} value={`jump ${w.name} ${w.id}`} onSelect={() => run(() => dispatch({ type: 'activate', id: w.id }))}>
                {w.name}
                {w.id === state.activeId && <span className="ml-2 text-muted">current</span>}
              </Command.Item>
            ))}
          </Command.Group>
          <Command.Group heading="Settings">
            <Command.Item value="connectors keys" onSelect={() => run(onConnectors)}>
              Connectors
            </Command.Item>
          </Command.Group>
        </Command.List>
      </Command>
    </Dialog>
  )
}
