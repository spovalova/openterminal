// Typed fetch helpers for the HTTP routes in PLAN.md section 7.4.
import { FrameSchema, WorkspaceSchema, type Frame, type Kind, type RegisteredConnector, type Widget, type Workspace } from '@terminal/core'

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export type Health = { ok: boolean; kinds: Kind[]; llm: boolean }
export type WorkspacePatch = { name?: string; widgets?: Widget[] }

type Init = Omit<RequestInit, 'body'> & { json?: unknown }

async function request<T = unknown>(path: string, init: Init = {}): Promise<T> {
  const { json, headers, ...rest } = init
  const res = await fetch(path, {
    ...rest,
    headers: { ...(json !== undefined ? { 'content-type': 'application/json' } : {}), ...(headers as Record<string, string> | undefined) },
    body: json !== undefined ? JSON.stringify(json) : undefined,
  })
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`.trim()
    try {
      const body: unknown = await res.json()
      if (body && typeof body === 'object') {
        const err = (body as { error?: unknown; message?: unknown }).error ?? (body as { message?: unknown }).message
        if (typeof err === 'string') message = err
      }
    } catch {
      /* body was not JSON */
    }
    throw new ApiError(res.status, message)
  }
  if (res.status === 204) return undefined as T
  const text = await res.text()
  return (text ? JSON.parse(text) : undefined) as T
}

const parseWorkspace = (body: unknown): Workspace => WorkspaceSchema.parse(body)

export const api = {
  health: () => request<Health>('/api/health'),

  async listWorkspaces(): Promise<Workspace[]> {
    const body = await request<unknown>('/api/workspaces')
    const list = Array.isArray(body) ? body : ((body as { workspaces?: unknown[] } | null)?.workspaces ?? [])
    return WorkspaceSchema.array().parse(list)
  },
  createWorkspace: (init: { name?: string } = {}) => request('/api/workspaces', { method: 'POST', json: init }).then(parseWorkspace),
  getWorkspace: (id: string) => request(`/api/workspaces/${encodeURIComponent(id)}`).then(parseWorkspace),
  patchWorkspace: (id: string, patch: WorkspacePatch) =>
    request(`/api/workspaces/${encodeURIComponent(id)}`, { method: 'PATCH', json: patch }).then(parseWorkspace),
  deleteWorkspace: (id: string) => request<void>(`/api/workspaces/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  widgetFrame: async (widgetId: string): Promise<Frame> => FrameSchema.parse(await request(`/api/widgets/${encodeURIComponent(widgetId)}/frame`)),

  connectors: () => request<RegisteredConnector[]>('/api/connectors'),
  setConnectorConfig: (name: string, config: Record<string, unknown>) =>
    request<RegisteredConnector>(`/api/connectors/${encodeURIComponent(name)}/config`, { method: 'PUT', json: config }),
}
