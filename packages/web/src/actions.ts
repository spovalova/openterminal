// The handful of user actions that touch the API, the socket, and the store together.
import type { Widget } from '@terminal/core'
import { api } from './api'
import { tickerPrompt } from './platform'
import { useSocket } from './socketContext'
import { useApp, workspaceState } from './state'

export function useActions() {
  const { state, dispatch } = useApp()
  const socket = useSocket()

  const newWorkspace = async (name?: string): Promise<string> => {
    const workspace = await api.createWorkspace(name ? { name } : {})
    dispatch({ type: 'workspace', workspace })
    dispatch({ type: 'activate', id: workspace.id })
    return workspace.id
  }

  const deleteWorkspace = async (id: string): Promise<void> => {
    const workspace = state.workspaces.find((w) => w.id === id)
    if (!window.confirm(`Delete workspace "${workspace?.name ?? id}"? This cannot be undone.`)) return
    await api.deleteWorkspace(id)
    dispatch({ type: 'removeWorkspace', id })
  }

  const renameWorkspace = async (id: string, name: string): Promise<void> => {
    const trimmed = name.trim().slice(0, 60)
    if (!trimmed) return
    const workspace = await api.patchWorkspace(id, { name: trimmed })
    dispatch({ type: 'workspace', workspace })
  }

  /** Conversation-first: a prompt in an Empty workspace starts it; in an Active one it appends and the next `widgets` overwrites. */
  const submitPrompt = (workspaceId: string, text: string): void => {
    let prompt = text.trim()
    if (!prompt) return
    const workspace = state.workspaces.find((w) => w.id === workspaceId)
    const ticker = tickerPrompt(prompt)
    if (ticker && workspace && workspace.widgets.length === 0 && workspace.messages.length === 0) {
      prompt = ticker.prompt
      if (workspace.name === 'Untitled') void renameWorkspace(workspaceId, ticker.ticker).catch(() => {})
    }
    dispatch({ type: 'promptSent', workspaceId, text: prompt })
    socket.prompt(workspaceId, prompt)
  }

  const retry = (workspaceId: string): void => {
    const ws = workspaceState(state, workspaceId)
    if (ws.prompt) submitPrompt(workspaceId, ws.prompt)
  }

  const cancel = (workspaceId: string): void => socket.cancel(workspaceId)

  const refreshWidget = (widgetId: string): void => socket.refresh(widgetId)

  /** Ticker shortcut from the palette: a new workspace named after the ticker, then "Overview of <ticker>". */
  const openTicker = async (ticker: string): Promise<void> => {
    const workspace = await api.createWorkspace({ name: ticker })
    dispatch({ type: 'workspace', workspace })
    dispatch({ type: 'activate', id: workspace.id })
    const prompt = `Overview of ${ticker}`
    dispatch({ type: 'promptSent', workspaceId: workspace.id, text: prompt })
    socket.prompt(workspace.id, prompt)
  }

  /** Replace (or append) one widget, persist via PATCH, then refresh it. */
  const saveWidget = async (workspaceId: string, widget: Widget): Promise<void> => {
    const workspace = state.workspaces.find((w) => w.id === workspaceId)
    if (!workspace) return
    const exists = workspace.widgets.some((w) => w.id === widget.id)
    const widgets = exists ? workspace.widgets.map((w) => (w.id === widget.id ? widget : w)) : [...workspace.widgets, widget]
    const saved = await api.patchWorkspace(workspaceId, { widgets })
    dispatch({ type: 'workspace', workspace: saved })
    socket.refresh(widget.id)
  }

  const removeWidget = async (workspaceId: string, widgetId: string): Promise<void> => {
    const workspace = state.workspaces.find((w) => w.id === workspaceId)
    if (!workspace) return
    const saved = await api.patchWorkspace(workspaceId, { widgets: workspace.widgets.filter((w) => w.id !== widgetId) })
    dispatch({ type: 'workspace', workspace: saved })
  }

  return { newWorkspace, deleteWorkspace, renameWorkspace, submitPrompt, retry, cancel, refreshWidget, openTicker, saveWidget, removeWidget }
}
