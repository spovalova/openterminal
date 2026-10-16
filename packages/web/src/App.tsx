import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { Button, Kbd } from '@terminal/ui'
import { api } from './api'
import { ConnectorsPage } from './components/ConnectorsPage'
import { EmptyView } from './components/EmptyView'
import { Grid } from './components/Grid'
import { Palette } from './components/Palette'
import { Sidebar } from './components/Sidebar'
import { TabBar } from './components/TabBar'
import { isModKey, isTyping, MOD } from './platform'
import { TerminalSocket } from './socket'
import { SocketContext } from './socketContext'
import { AppContext, initialState, layoutFor, reducer, workspaceState, type AppState } from './state'
import { withViewTransition } from './transition'

const ACTIVE_KEY = 'terminal.activeWorkspace'

export function App() {
  const [state, dispatch] = useReducer(reducer, initialState)
  const stateRef = useRef<AppState>(state)
  stateRef.current = state
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [connectorsOpen, setConnectorsOpen] = useState(() => typeof location !== 'undefined' && location.hash === '#connectors')

  // One socket for the app's lifetime. `started` on the active Empty workspace runs inside a view transition
  // so the PromptBox slides from the center to the sidebar.
  const socket = useMemo(
    () =>
      new TerminalSocket({
        onStatus: (status) => dispatch({ type: 'socket', status }),
        onMessage: (msg) => {
          const s = stateRef.current
          if (msg.t === 'started' && msg.workspaceId === s.activeId) {
            const workspace = s.workspaces.find((w) => w.id === msg.workspaceId)
            if (layoutFor(workspace, workspaceState(s, msg.workspaceId)) === 'empty') {
              withViewTransition(() => dispatch({ type: 'server', msg }))
              return
            }
          }
          dispatch({ type: 'server', msg })
        },
      }),
    [],
  )

  // Boot: health, workspaces, socket.
  useEffect(() => {
    socket.connect()
    void api
      .health()
      .then((health) => dispatch({ type: 'health', health }))
      .catch(() => {})
    void api
      .listWorkspaces()
      .then((workspaces) => {
        dispatch({ type: 'workspaces', workspaces })
        let remembered: string | null = null
        try {
          remembered = localStorage.getItem(ACTIVE_KEY)
        } catch {
          /* storage unavailable */
        }
        if (remembered && workspaces.some((w) => w.id === remembered)) dispatch({ type: 'activate', id: remembered })
        if (workspaces.length === 0) {
          void api.createWorkspace().then((workspace) => {
            dispatch({ type: 'workspace', workspace })
            dispatch({ type: 'activate', id: workspace.id })
          })
        }
      })
      .catch((e: unknown) => {
        console.error('failed to load workspaces', e)
        dispatch({ type: 'workspaces', workspaces: [] })
      })
    return () => socket.close()
  }, [socket])

  // Re-check health whenever the socket comes back (the server may have restarted with new keys).
  useEffect(() => {
    if (state.socket !== 'open') return
    void api
      .health()
      .then((health) => dispatch({ type: 'health', health }))
      .catch(() => {})
  }, [state.socket])

  // Focus follows the active tab; only the focused workspace polls. Frames missing after a reload are fetched over HTTP.
  const activeWorkspace = state.workspaces.find((w) => w.id === state.activeId)
  const activeWs = workspaceState(state, state.activeId)
  const widgetKey = activeWorkspace?.widgets.map((w) => w.id).join(',') ?? ''
  useEffect(() => {
    if (!state.activeId) return
    socket.focus(state.activeId)
    try {
      localStorage.setItem(ACTIVE_KEY, state.activeId)
    } catch {
      /* storage unavailable */
    }
    if (activeWs.status === 'streaming') return
    const s = stateRef.current
    for (const widget of activeWorkspace?.widgets ?? []) {
      if (s.frames[widget.id] || s.frameErrors[widget.id]) continue
      void api
        .widgetFrame(widget.id)
        .then((frame) => dispatch({ type: 'frameLoaded', widgetId: widget.id, frame }))
        .catch(() => socket.refresh(widget.id, activeWorkspace?.id))
    }
  }, [state.activeId, widgetKey, socket])

  // Keyboard: ⌘K or `/` opens the palette, ⌘\ toggles the sidebar, Escape closes overlays.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isModKey(e) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((o) => !o)
        return
      }
      if (isModKey(e) && e.key === '\\') {
        e.preventDefault()
        dispatch({ type: 'sidebar' })
        return
      }
      if (e.key === '/' && !isTyping(e) && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        setPaletteOpen(true)
        return
      }
      if (e.key === 'Escape') {
        setPaletteOpen(false)
        setConnectorsOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    const onHash = () => setConnectorsOpen(location.hash === '#connectors')
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const layout = layoutFor(activeWorkspace, activeWs)

  return (
    <AppContext.Provider value={{ state, dispatch }}>
      <SocketContext.Provider value={socket}>
        <div className="flex h-full flex-col bg-bg text-fg">
          <TabBar />
          <main className="relative flex min-h-0 flex-1">
            {!state.loaded ? (
              <div className="flex flex-1 items-center justify-center text-fg-2">Loading…</div>
            ) : !activeWorkspace ? (
              <div className="flex flex-1 items-center justify-center text-fg-2">Creating a workspace…</div>
            ) : layout === 'empty' ? (
              <div className="flex-1">
                <EmptyView workspace={activeWorkspace} ws={activeWs} />
              </div>
            ) : (
              <>
                <div className="min-w-0 flex-1">
                  <Grid workspace={activeWorkspace} ws={activeWs} />
                </div>
                {state.sidebarOpen ? (
                  <Sidebar workspace={activeWorkspace} ws={activeWs} />
                ) : (
                  <button
                    type="button"
                    className="absolute top-2 right-2 z-10 rounded border border-border bg-surface px-2 py-1 text-fg-2 hover:text-fg"
                    onClick={() => dispatch({ type: 'sidebar', open: true })}
                    title={`Show sidebar (${MOD}+\\)`}
                  >
                    Conversation
                  </button>
                )}
              </>
            )}
          </main>
          <footer className="flex items-center justify-between border-t border-border bg-surface px-3 py-1 text-fg-2">
            <div className="flex items-center gap-2">
              <span className={state.socket === 'open' ? 'text-up' : state.socket === 'connecting' ? 'text-fg-2' : 'text-down'} aria-hidden>
                ●
              </span>
              <span>{state.socket === 'open' ? 'connected' : state.socket === 'connecting' ? 'connecting…' : 'disconnected, retrying'}</span>
              {state.health && (
                <span>
                  · {state.health.kinds.length} kinds{state.health.llm ? '' : ' · no LLM key'}
                </span>
              )}
            </div>
            <div className="flex items-center gap-3">
              <span>
                <Kbd>{MOD}</Kbd> <Kbd>K</Kbd> palette · <Kbd>{MOD}</Kbd> <Kbd>\</Kbd> sidebar
              </span>
              <Button size="sm" variant="ghost" onClick={() => setConnectorsOpen(true)}>
                Connectors
              </Button>
            </div>
          </footer>
        </div>
        <Palette open={paletteOpen} onClose={() => setPaletteOpen(false)} onConnectors={() => setConnectorsOpen(true)} />
        <ConnectorsPage
          open={connectorsOpen}
          onClose={() => {
            setConnectorsOpen(false)
            if (location.hash === '#connectors') history.replaceState(null, '', location.pathname + location.search)
          }}
        />
      </SocketContext.Provider>
    </AppContext.Provider>
  )
}
