// Typed fetch helpers for the HTTP routes in PLAN.md section 7.4 and the v2 data routes (section 17, phase 1 (e)).
import {
  FrameSchema,
  WorkspaceSchema,
  type AnyQuery,
  type AnyWidget,
  type CatalogHit,
  type Descriptor,
  type Frame,
  type Recipe,
  type RegisteredConnector,
  type Workspace,
} from '@openterminal/core'

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    /** `traceback` from a failed transform; `issues` from a validation error. */
    public readonly detail: { traceback?: string; issues?: string[] } = {},
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export type Health = { ok: boolean; connectors: string[]; recipes: number; llm: boolean }
export type WorkspacePatch = { name?: string; widgets?: AnyWidget[] }

export type CatalogStats = Record<string, { routes: number; alive: number; dead: number; unknown: number; probedAt?: number }>
export type CatalogSearch = { query: string; hits: CatalogHit[]; stats: CatalogStats; connectors: string[]; recipes: number }
export type ConnectorCatalog = { connector: string; status: RegisteredConnector['status']; descriptors: Descriptor[]; stats: CatalogStats[string] }
export type RecipesResponse = { builtin: Recipe[]; user: Recipe[] }
export type ProbeResult = { probed: number; alive: number; dead: number; ms: number }
export type StoreInfo = { location: string; frames: number; kind?: 'sqlite' | 'json' | 'injected'; migration?: { workspaces: number; widgets: number; v1Widgets: number; backup?: string; alreadyDone: boolean; at: number } }
export type WorkspaceExport = { format: 'openterminal-workspace'; version: number; exportedAt?: number; name: string; widgets: AnyWidget[]; recipes?: Recipe[] }

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
    const detail: { traceback?: string; issues?: string[] } = {}
    try {
      const body: unknown = await res.json()
      if (body && typeof body === 'object') {
        const b = body as { error?: unknown; message?: unknown; traceback?: unknown; issues?: unknown }
        const err = b.error ?? b.message
        if (typeof err === 'string') message = err
        if (typeof b.traceback === 'string') detail.traceback = b.traceback
        if (Array.isArray(b.issues)) detail.issues = b.issues.map(String)
      }
    } catch {
      /* body was not JSON */
    }
    throw new ApiError(res.status, message, detail)
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

  /** One dataset's frame; `workspaceId` scopes the lookup because widget ids repeat across workspaces. */
  widgetFrame: async (widgetId: string, opts: { workspaceId?: string; dataset?: string } = {}): Promise<Frame> => {
    const p = new URLSearchParams()
    if (opts.workspaceId) p.set('workspace', opts.workspaceId)
    if (opts.dataset) p.set('dataset', opts.dataset)
    const qs = p.toString()
    return FrameSchema.parse(await request(`/api/widgets/${encodeURIComponent(widgetId)}/frame${qs ? `?${qs}` : ''}`))
  },

  connectors: () => request<RegisteredConnector[]>('/api/connectors'),
  /** Save the LLM key (config.yml, mode 600); the answer never carries it. `restart` when the server cannot switch live. */
  setLlm: (llm: { provider: 'anthropic' | 'openai'; apiKey: string; model?: string }) =>
    request<{ configured: boolean; provider: string; model: string; restart?: boolean }>('/api/llm', { method: 'PUT', json: llm }),
  setConnectorConfig: (name: string, config: Record<string, unknown>) =>
    request<RegisteredConnector>(`/api/connectors/${encodeURIComponent(name)}/config`, { method: 'PUT', json: config }),

  // ---- v2 data routes ----
  catalog: (q = '', opts: { limit?: number; namespaces?: string[]; connectors?: string[]; includeDead?: boolean } = {}) => {
    const p = new URLSearchParams()
    if (q) p.set('q', q)
    if (opts.limit) p.set('limit', String(opts.limit))
    if (opts.namespaces?.length) p.set('namespaces', opts.namespaces.join(','))
    if (opts.connectors?.length) p.set('connectors', opts.connectors.join(','))
    if (opts.includeDead) p.set('includeDead', '1')
    const qs = p.toString()
    return request<CatalogSearch>(`/api/catalog${qs ? `?${qs}` : ''}`)
  },
  connectorCatalog: (connector: string) => request<ConnectorCatalog>(`/api/catalog/${encodeURIComponent(connector)}`),
  probe: (connector?: string) => request<ProbeResult>('/api/catalog/probe', { method: 'POST', json: connector ? { connector } : {} }),
  recipes: () => request<RecipesResponse>('/api/recipes'),
  setRecipes: (recipes: Recipe[]) => request<{ user: Recipe[] }>('/api/recipes', { method: 'PUT', json: { recipes } }),
  /** Run any query: a frame, or an ApiError with `detail.traceback` for a failed transform. */
  query: async (query: AnyQuery, opts: { refresh?: boolean } = {}): Promise<Frame> => {
    const res = await request<{ frame: unknown }>('/api/query', { method: 'POST', json: { query, ...(opts.refresh ? { refresh: true } : {}) } })
    return FrameSchema.parse(res.frame)
  },
  setting: <T = unknown>(key: string) => request<{ key: string; value: T }>(`/api/settings/${encodeURIComponent(key)}`).then((r) => r.value),
  setSetting: <T = unknown>(key: string, value: T) => request<{ key: string; value: T }>(`/api/settings/${encodeURIComponent(key)}`, { method: 'PUT', json: { value } }).then((r) => r.value),
  exportWorkspace: (id: string) => request<WorkspaceExport>(`/api/workspaces/${encodeURIComponent(id)}/export`),
  importWorkspace: (doc: unknown) => request<{ workspace: unknown; recipesAdded: string[] }>('/api/workspaces/import', { method: 'POST', json: doc }).then((r) => ({ workspace: parseWorkspace(r.workspace), recipesAdded: r.recipesAdded })),
  storeInfo: () => request<StoreInfo>('/api/store'),
}
