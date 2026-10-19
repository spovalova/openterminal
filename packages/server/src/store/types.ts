// The store interface (PLAN.md section 17, phase 1 (e)). SQLite implements it (`sqlite.ts`); the JSON store
// (`json.ts`) keeps the same interface with in-memory extras until the one-time migration has run.
import type { AnyWidget, Descriptor, Frame, Liveness, Message, Recipe, Step, Workspace } from '@terminal/core'

export type WorkspaceInit = { name?: string; widgets?: AnyWidget[]; messages?: Message[] }
export type WorkspacePatch = { name?: string; widgets?: AnyWidget[]; messages?: Message[] }

/** A connector's generated descriptors, cached with the provider version that produced them. */
export type CatalogCacheRow = { connector: string; version: string; descriptors: Descriptor[]; generatedAt: number }

/** A probe result: `Liveness` plus the route it is about (the row shape agreed with (a)). */
export type LivenessRow = { connector: string; route: string } & Liveness

/** One prompt's run (the row shape agreed with (c)); `verification` is whatever reply verification records. */
export type RunLogRow = {
  id: string
  workspaceId: string
  startedAt: number
  ms: number
  model: string
  steps: Step[]
  tokens?: Record<string, number | undefined>
  cost?: number
  verification?: unknown
  /** (c)'s extra fields (`prompt`, `turns`, `continued`, `error`) travel whole. */
  [extra: string]: unknown
}

export type FrameCacheRow = { key: string; frame: Frame; expiresAt: number }

export interface Store {
  /** Where the store lives (a directory for JSON, the database file for SQLite). */
  readonly location: string

  // ---- workspaces (the v1 WorkspaceStore API, unchanged apart from AnyWidget) ----
  list(): Promise<Workspace[]>
  get(id: string): Promise<Workspace | undefined>
  create(init?: WorkspaceInit): Promise<Workspace>
  patch(id: string, patch: WorkspacePatch): Promise<Workspace | undefined>
  appendMessage(id: string, message: Message): Promise<Workspace | undefined>
  delete(id: string): Promise<boolean>
  findWidget(widgetId: string): Promise<{ workspace: Workspace; widget: AnyWidget } | undefined>
  /** Import a workspace document as a new workspace (fresh id and timestamps). */
  importWorkspace(doc: { name: string; widgets: AnyWidget[]; messages?: Message[] }): Promise<Workspace>

  // ---- user recipes ----
  listRecipes(): Recipe[]
  /** Replace the user recipe list (promote, edit, delete all go through here). */
  setRecipes(recipes: Recipe[]): void

  // ---- catalog cache per connector ----
  getCatalog(connector: string): CatalogCacheRow | undefined
  setCatalog(row: CatalogCacheRow): void
  listCatalogs(): CatalogCacheRow[]

  // ---- liveness ----
  getLiveness(connector?: string): LivenessRow[]
  setLiveness(rows: LivenessRow | LivenessRow[]): void

  // ---- run log ----
  appendRun(row: RunLogRow): void
  listRuns(opts?: { workspaceId?: string; limit?: number }): RunLogRow[]

  // ---- frame cache ----
  getFrame(key: string, now?: number): Frame | undefined
  setFrame(key: string, frame: Frame, expiresAt: number): void
  deleteFrame(key: string): void
  clearFrames(): void
  /** Drop expired rows, then the oldest beyond `maxRows`. Returns how many were removed. */
  pruneFrames(now?: number, maxRows?: number): number
  countFrames(): number

  // ---- settings (small key → JSON values: the ticker strip symbols, provider overrides) ----
  getSetting<T = unknown>(key: string): T | undefined
  setSetting(key: string, value: unknown): void

  close(): void
}

export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/
