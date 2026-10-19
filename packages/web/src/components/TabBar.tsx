import { useEffect, useRef, useState } from 'react'
import { Button, Dialog, Tabs } from '@openterminal/ui'
import { useActions } from '../actions'
import { useApp } from '../state'

/**
 * One tab per workspace. Close deletes (confirm), "+" creates, double-click renames (PATCH). The "⋯" menu at the
 * right holds the workspace actions: rename, export as JSON, import a JSON export (PLAN.md section 17, "Workspace
 * export and import").
 */
export function TabBar() {
  const { state, dispatch } = useApp()
  const { newWorkspace, deleteWorkspace, renameWorkspace, exportWorkspace, importWorkspace } = useActions()
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const active = state.workspaces.find((w) => w.id === state.activeId)
  const items = state.workspaces.map((w) => {
    const ws = state.ws[w.id]
    const label = tabLabel(w.name)
    return { id: w.id, label: ws?.status === 'streaming' ? `${label} ·` : label }
  })

  // The ui Tabs component has no rename hook; the first click of a double-click selects the tab, so the active one is the target.
  const onDoubleClick = () => {
    if (active) setRenaming({ id: active.id, name: active.name })
  }

  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), 4_000)
    return () => clearTimeout(t)
  }, [notice])

  const onImportFile = async (file: File) => {
    try {
      const doc: unknown = JSON.parse(await file.text())
      const id = await importWorkspace(doc)
      const ws = state.workspaces.find((w) => w.id === id)
      setNotice(`Imported ${ws?.name ?? file.name}`)
    } catch (err) {
      setNotice(`Import failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return (
    <div className="flex items-stretch border-b border-border bg-surface" onDoubleClick={onDoubleClick}>
      <div className="min-w-0 flex-1">
        <Tabs
          items={items}
          activeId={state.activeId ?? undefined}
          onSelect={(id) => dispatch({ type: 'activate', id })}
          onClose={(id) => void deleteWorkspace(id)}
          onNew={() => void newWorkspace()}
        />
      </div>
      <div ref={menuRef} className="relative flex shrink-0 items-center border-b border-l border-border px-1" onDoubleClick={(e) => e.stopPropagation()}>
        {notice && <span className="px-2 text-xs text-fg-2">{notice}</span>}
        <button
          type="button"
          aria-label="Workspace menu"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          title="Workspace: rename, export, import"
          onClick={() => setMenuOpen((o) => !o)}
          className="flex size-7 items-center justify-center rounded text-fg-3 hover:bg-surface-2 hover:text-fg"
        >
          ⋯
        </button>
        {menuOpen && (
          <div role="menu" aria-label="Workspace actions" className="absolute top-full right-1 z-30 mt-1 flex w-56 flex-col rounded border border-border-strong bg-surface py-1 shadow-dialog">
            <MenuItem
              disabled={!active}
              onClick={() => {
                setMenuOpen(false)
                if (active) setRenaming({ id: active.id, name: active.name })
              }}
            >
              Rename workspace…
            </MenuItem>
            <MenuItem
              disabled={!active}
              onClick={() => {
                setMenuOpen(false)
                if (active) void exportWorkspace(active.id).then(() => setNotice(`Exported ${active.name}`)).catch((e: unknown) => setNotice(`Export failed: ${e instanceof Error ? e.message : String(e)}`))
              }}
            >
              Export workspace as JSON
            </MenuItem>
            <MenuItem
              onClick={() => {
                setMenuOpen(false)
                fileInput.current?.click()
              }}
            >
              Import workspace from JSON…
            </MenuItem>
          </div>
        )}
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          aria-label="Import workspace file"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            e.target.value = ''
            if (f) void onImportFile(f)
          }}
        />
      </div>
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

function MenuItem({ children, onClick, disabled }: { children: React.ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" role="menuitem" disabled={disabled} onClick={onClick} className="px-3 py-1.5 text-left text-sm text-fg hover:bg-surface-2 disabled:text-fg-3 disabled:hover:bg-transparent">
      {children}
    </button>
  )
}

/** Upper-case words that are not tickers. */
const NOT_TICKERS = new Set(['AI', 'ETF', 'ETFS', 'IV', 'RSI', 'MACD', 'SMA', 'EMA', 'PE', 'EPS', 'CPI', 'PPI', 'GDP', 'FOMC', 'US', 'USA', 'IPO', 'YTD', 'TTM', 'OI', 'ATM', 'DTE', 'VS'])

/**
 * A tab's label with its subject first (taste round, change 15): a name that mentions a ticker after its first word
 * ("Why is CRWV down?") reads "CRWV · Why is CRWV down?", so the ticker survives truncation; others are unchanged.
 */
export function tabLabel(name: string): string {
  const words = name.split(/\s+/)
  const first = words[0]?.replace(/[^A-Z^.]/g, '') ?? ''
  if (/^\^?[A-Z]{1,5}(\.[A-Z])?$/.test(first) && words[0] === first && !NOT_TICKERS.has(first)) return name
  const m = name.match(/(?:^|[\s(,])(\^?[A-Z]{2,5}(?:\.[A-Z])?)(?=$|[\s),.?!:'’])/g)
  const ticker = m?.map((t) => t.trim().replace(/^[(,]/, '')).find((t) => !NOT_TICKERS.has(t.replace('^', '')))
  return ticker ? `${ticker} · ${name}` : name
}
