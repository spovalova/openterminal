// App state: workspaces, the active tab, per-workspace run status, frames by widget id. Reducers for every ServerMsg.
import { createContext, useContext, type Dispatch } from 'react'
import type { Frame, Message, ServerMsg, Step, Workspace } from '@terminal/core'
import type { Health } from './api'
import type { SocketStatus } from './socket'

export type Status = 'empty' | 'active' | 'streaming' | 'error'

export type WorkspaceState = {
  status: Status
  /** The prompt in flight (or the one that failed, for retry). */
  prompt: string | null
  /** True between submit and the server's `started`. */
  sending: boolean
  startedAt: number | null
  steps: Step[]
  streamingText: string
  lastError: string | null
  /** Wall time of the last completed run, for the Steps header of the last reply. */
  lastRunMs: number | null
}

export type AppState = {
  loaded: boolean
  workspaces: Workspace[]
  activeId: string | null
  ws: Record<string, WorkspaceState>
  frames: Record<string, Frame>
  frameErrors: Record<string, string>
  socket: SocketStatus
  health: Health | null
  sidebarOpen: boolean
}

export type Action =
  | { type: 'server'; msg: ServerMsg; now?: number }
  | { type: 'workspaces'; workspaces: Workspace[] }
  | { type: 'workspace'; workspace: Workspace }
  | { type: 'removeWorkspace'; id: string }
  | { type: 'activate'; id: string | null }
  | { type: 'promptSent'; workspaceId: string; text: string }
  | { type: 'frameLoaded'; widgetId: string; frame: Frame }
  | { type: 'frameFailed'; widgetId: string; error: string }
  | { type: 'socket'; status: SocketStatus }
  | { type: 'health'; health: Health }
  | { type: 'sidebar'; open?: boolean }

export const initialState: AppState = {
  loaded: false,
  workspaces: [],
  activeId: null,
  ws: {},
  frames: {},
  frameErrors: {},
  socket: 'closed',
  health: null,
  sidebarOpen: true,
}

export function initialWorkspaceState(workspace?: Workspace): WorkspaceState {
  const hasContent = !!workspace && (workspace.widgets.length > 0 || workspace.messages.length > 0)
  return {
    status: hasContent ? 'active' : 'empty',
    prompt: null,
    sending: false,
    startedAt: null,
    steps: [],
    streamingText: '',
    lastError: null,
    lastRunMs: null,
  }
}

export function workspaceState(state: AppState, id: string | null | undefined): WorkspaceState {
  if (!id) return initialWorkspaceState()
  return state.ws[id] ?? initialWorkspaceState(state.workspaces.find((w) => w.id === id))
}

/** Empty shows the centered PromptBox; Active shows the grid plus sidebar. Error keeps whichever layout it happened in. */
export function layoutFor(workspace: Workspace | undefined, ws: WorkspaceState): 'empty' | 'active' {
  if (ws.status === 'streaming') return 'active'
  if (!workspace) return 'empty'
  return workspace.widgets.length > 0 || workspace.messages.length > 0 ? 'active' : 'empty'
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'workspaces': {
      const ws: AppState['ws'] = {}
      for (const w of action.workspaces) ws[w.id] = state.ws[w.id] ?? initialWorkspaceState(w)
      const activeId = action.workspaces.some((w) => w.id === state.activeId) ? state.activeId : (action.workspaces[0]?.id ?? null)
      return { ...state, loaded: true, workspaces: action.workspaces, ws, activeId }
    }
    case 'workspace': {
      const exists = state.workspaces.some((w) => w.id === action.workspace.id)
      const workspaces = exists ? state.workspaces.map((w) => (w.id === action.workspace.id ? action.workspace : w)) : [...state.workspaces, action.workspace]
      const prev = state.ws[action.workspace.id]
      const next: WorkspaceState = prev
        ? prev.status === 'streaming' || prev.status === 'error'
          ? prev
          : { ...prev, status: initialWorkspaceState(action.workspace).status }
        : initialWorkspaceState(action.workspace)
      return { ...state, workspaces, ws: { ...state.ws, [action.workspace.id]: next } }
    }
    case 'removeWorkspace': {
      const removed = state.workspaces.find((w) => w.id === action.id)
      const workspaces = state.workspaces.filter((w) => w.id !== action.id)
      const ws = { ...state.ws }
      delete ws[action.id]
      const frames = { ...state.frames }
      const frameErrors = { ...state.frameErrors }
      for (const widget of removed?.widgets ?? []) {
        delete frames[widget.id]
        delete frameErrors[widget.id]
      }
      const activeId = state.activeId === action.id ? (workspaces[0]?.id ?? null) : state.activeId
      return { ...state, workspaces, ws, frames, frameErrors, activeId }
    }
    case 'activate':
      return state.activeId === action.id ? state : { ...state, activeId: action.id }
    case 'promptSent': {
      const prev = workspaceState(state, action.workspaceId)
      return patchWs(state, action.workspaceId, {
        ...prev,
        prompt: action.text,
        sending: true,
        lastError: null,
        streamingText: '',
        steps: [],
        status: prev.status === 'error' ? layoutStatus(state, action.workspaceId) : prev.status,
      })
    }
    case 'frameLoaded':
      return setFrame(state, action.widgetId, action.frame)
    case 'frameFailed':
      return { ...state, frameErrors: { ...state.frameErrors, [action.widgetId]: action.error } }
    case 'socket':
      return { ...state, socket: action.status }
    case 'health':
      return { ...state, health: action.health }
    case 'sidebar':
      return { ...state, sidebarOpen: action.open ?? !state.sidebarOpen }
    case 'server':
      return onServer(state, action.msg, action.now ?? Date.now())
  }
}

function layoutStatus(state: AppState, id: string): Status {
  const w = state.workspaces.find((x) => x.id === id)
  return w && (w.widgets.length > 0 || w.messages.length > 0) ? 'active' : 'empty'
}

function patchWs(state: AppState, id: string, ws: WorkspaceState): AppState {
  return { ...state, ws: { ...state.ws, [id]: ws } }
}

function setFrame(state: AppState, widgetId: string, frame: Frame): AppState {
  const frameErrors = { ...state.frameErrors }
  delete frameErrors[widgetId]
  return { ...state, frames: { ...state.frames, [widgetId]: frame }, frameErrors }
}

function onServer(state: AppState, msg: ServerMsg, now: number): AppState {
  switch (msg.t) {
    case 'started': {
      const prev = workspaceState(state, msg.workspaceId)
      return patchWs(state, msg.workspaceId, {
        ...prev,
        status: 'streaming',
        sending: false,
        startedAt: now,
        steps: [],
        streamingText: '',
        lastError: null,
      })
    }
    case 'step': {
      const prev = workspaceState(state, msg.workspaceId)
      return patchWs(state, msg.workspaceId, { ...prev, steps: [...prev.steps, msg.step] })
    }
    case 'widgets': {
      // A prompt overwrites the workspace: the new set replaces the old one.
      const existing = state.workspaces.find((w) => w.id === msg.workspaceId)
      const keep = new Set(msg.widgets.map((w) => w.id))
      const frames = { ...state.frames }
      const frameErrors = { ...state.frameErrors }
      for (const widget of existing?.widgets ?? []) {
        if (keep.has(widget.id)) continue
        delete frames[widget.id]
        delete frameErrors[widget.id]
      }
      const workspaces = existing
        ? state.workspaces.map((w) => (w.id === msg.workspaceId ? { ...w, widgets: msg.widgets, name: msg.name ?? w.name, updatedAt: now } : w))
        : state.workspaces
      return { ...state, workspaces, frames, frameErrors }
    }
    case 'frame':
      return setFrame(state, msg.widgetId, msg.frame)
    case 'frameError':
      return { ...state, frameErrors: { ...state.frameErrors, [msg.widgetId]: msg.error } }
    case 'delta': {
      const prev = workspaceState(state, msg.workspaceId)
      return patchWs(state, msg.workspaceId, { ...prev, streamingText: prev.streamingText + msg.text })
    }
    case 'done': {
      const prev = workspaceState(state, msg.workspaceId)
      const user: Message | null = prev.prompt ? { role: 'user', text: prev.prompt, at: prev.startedAt ?? now } : null
      const agent: Message = { ...msg.message, at: msg.message.at ?? now }
      const workspaces = state.workspaces.map((w) =>
        w.id === msg.workspaceId ? { ...w, messages: [...w.messages, ...(user ? [user] : []), agent], updatedAt: now } : w,
      )
      const next = patchWs({ ...state, workspaces }, msg.workspaceId, {
        ...prev,
        status: 'active',
        prompt: null,
        sending: false,
        startedAt: null,
        steps: [],
        streamingText: '',
        lastError: null,
        lastRunMs: prev.startedAt ? now - prev.startedAt : null,
      })
      return next
    }
    case 'failed': {
      const prev = workspaceState(state, msg.workspaceId)
      return patchWs(state, msg.workspaceId, {
        ...prev,
        status: 'error',
        sending: false,
        lastError: msg.error,
        lastRunMs: prev.startedAt ? now - prev.startedAt : prev.lastRunMs,
        startedAt: null,
      })
    }
  }
}

export type AppContextValue = { state: AppState; dispatch: Dispatch<Action> }
export const AppContext = createContext<AppContextValue | null>(null)

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp must be used inside AppContext')
  return ctx
}

export function useActiveWorkspace(): { workspace: Workspace | undefined; ws: WorkspaceState } {
  const { state } = useApp()
  const workspace = state.workspaces.find((w) => w.id === state.activeId)
  return { workspace, ws: workspaceState(state, state.activeId) }
}
