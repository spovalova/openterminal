// The v2 store on node:sqlite (Node 22, no native dependency): workspaces with their widgets, user recipes, the
// catalog cache per connector, liveness rows, the run log, the frame cache and small settings, all in one file
// (`~/.openterminal/terminal.db`). Every method is synchronous underneath; the workspace API stays async so the HTTP
// layer is unchanged from the JSON store.
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { nanoid } from 'nanoid'
import { AnyWidgetSchema, FrameSchema, MessageSchema, RecipeSchema, WorkspaceSchema, createWorkspace, type AnyWidget, type Frame, type Message, type Recipe, type Workspace } from '@openterminal/core'
import { z } from 'zod'
import { ID_RE, type CatalogCacheRow, type LivenessRow, type RunLogRow, type Store, type WorkspaceInit, type WorkspacePatch } from './types.js'

export const SCHEMA_VERSION = 2

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  messages TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS widgets (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  id TEXT NOT NULL,
  doc TEXT NOT NULL,
  PRIMARY KEY (workspace_id, position)
);
CREATE INDEX IF NOT EXISTS widgets_by_id ON widgets(id);
CREATE TABLE IF NOT EXISTS recipes (
  name TEXT PRIMARY KEY,
  position INTEGER NOT NULL,
  doc TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS catalog (
  connector TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  descriptors TEXT NOT NULL,
  generated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS liveness (
  connector TEXT NOT NULL,
  route TEXT NOT NULL,
  checked_at INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  rows INTEGER,
  ms REAL,
  error TEXT,
  sample_columns TEXT,
  PRIMARY KEY (connector, route)
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ms REAL NOT NULL,
  model TEXT NOT NULL,
  steps TEXT NOT NULL,
  tokens TEXT,
  cost REAL,
  verification TEXT,
  extra TEXT
);
CREATE INDEX IF NOT EXISTS runs_by_workspace ON runs(workspace_id, started_at);
CREATE TABLE IF NOT EXISTS frames (
  key TEXT PRIMARY KEY,
  frame TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  stored_at INTEGER NOT NULL,
  bytes INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS frames_by_expiry ON frames(expires_at);
CREATE INDEX IF NOT EXISTS frames_by_stored ON frames(stored_at);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

export type SqliteStoreOptions = { log?: (msg: string) => void; now?: () => number; id?: () => string }

type WorkspaceRow = { id: string; name: string; created_at: number; updated_at: number; messages: string }
type WidgetRow = { workspace_id: string; position: number; id: string; doc: string }

const MessagesSchema = z.array(MessageSchema)

export class SqliteStore implements Store {
  readonly db: DatabaseSync
  private readonly stmts: Record<string, StatementSync> = {}

  constructor(
    readonly location: string,
    private readonly opts: SqliteStoreOptions = {},
  ) {
    if (location !== ':memory:') mkdirSync(dirname(location), { recursive: true })
    this.db = new DatabaseSync(location)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec(SCHEMA)
    const { user_version } = this.db.prepare('PRAGMA user_version').get() as { user_version: number }
    if (user_version > 0 && user_version < 2) {
      // v1 → v2: run log rows keep the fields the agent adds beyond the fixed columns
      try {
        this.db.exec('ALTER TABLE runs ADD COLUMN extra TEXT')
      } catch {
        /* already there */
      }
    }
    if (user_version < SCHEMA_VERSION) this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
  }

  private get now() {
    return this.opts.now ?? Date.now
  }

  private stmt(sql: string): StatementSync {
    return (this.stmts[sql] ??= this.db.prepare(sql))
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN')
    try {
      const out = fn()
      this.db.exec('COMMIT')
      return out
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  // ------------------------------------------------------------------------------------------ workspaces

  private readWorkspace(row: WorkspaceRow): Workspace {
    const widgetRows = this.stmt('SELECT doc FROM widgets WHERE workspace_id = ? ORDER BY position').all(row.id) as { doc: string }[]
    const widgets: AnyWidget[] = []
    for (const w of widgetRows) {
      const parsed = AnyWidgetSchema.safeParse(JSON.parse(w.doc))
      if (parsed.success) widgets.push(parsed.data)
      else this.opts.log?.(`workspace ${row.id}: widget skipped (${parsed.error.issues[0]?.message ?? 'invalid'})`)
    }
    const messages = MessagesSchema.safeParse(JSON.parse(row.messages))
    return { id: row.id, name: row.name, widgets, messages: messages.success ? messages.data : [], createdAt: row.created_at, updatedAt: row.updated_at }
  }

  private writeWorkspace(ws: Workspace): void {
    const valid = WorkspaceSchema.parse(ws)
    this.transaction(() => {
      this.stmt('INSERT INTO workspaces (id, name, created_at, updated_at, messages) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at, messages = excluded.messages').run(
        valid.id,
        valid.name,
        valid.createdAt,
        valid.updatedAt,
        JSON.stringify(valid.messages),
      )
      this.stmt('DELETE FROM widgets WHERE workspace_id = ?').run(valid.id)
      const insert = this.stmt('INSERT INTO widgets (workspace_id, position, id, doc) VALUES (?, ?, ?, ?)')
      valid.widgets.forEach((w, i) => insert.run(valid.id, i, w.id, JSON.stringify(w)))
    })
  }

  private readById(id: string): Workspace | undefined {
    if (!ID_RE.test(id)) return undefined
    const row = this.stmt('SELECT * FROM workspaces WHERE id = ?').get(id) as WorkspaceRow | undefined
    return row ? this.readWorkspace(row) : undefined
  }

  async list(): Promise<Workspace[]> {
    const rows = this.stmt('SELECT * FROM workspaces ORDER BY created_at, id').all() as WorkspaceRow[]
    return rows.map((r) => this.readWorkspace(r))
  }

  async get(id: string): Promise<Workspace | undefined> {
    return this.readById(id)
  }

  async create(init: WorkspaceInit = {}): Promise<Workspace> {
    const ws = createWorkspace({ id: (this.opts.id ?? nanoid)(), name: init.name, now: this.now() })
    if (init.widgets) ws.widgets = init.widgets
    if (init.messages) ws.messages = init.messages
    const valid = WorkspaceSchema.parse(ws)
    this.writeWorkspace(valid)
    return valid
  }

  importWorkspace(doc: { name: string; widgets: AnyWidget[]; messages?: Message[] }): Promise<Workspace> {
    return this.create({ name: doc.name, widgets: doc.widgets, messages: doc.messages ?? [] })
  }

  /** Insert a workspace keeping its id and timestamps (the migration). Replaces an existing row with the same id. */
  put(ws: Workspace): Workspace {
    const valid = WorkspaceSchema.parse(ws)
    this.writeWorkspace(valid)
    return valid
  }

  async patch(id: string, patch: WorkspacePatch): Promise<Workspace | undefined> {
    const current = this.readById(id)
    if (!current) return undefined
    const next: Workspace = {
      ...current,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.widgets !== undefined ? { widgets: patch.widgets } : {}),
      ...(patch.messages !== undefined ? { messages: patch.messages } : {}),
      updatedAt: this.now(),
    }
    const valid = WorkspaceSchema.parse(next)
    this.writeWorkspace(valid)
    return valid
  }

  async appendMessage(id: string, message: Message): Promise<Workspace | undefined> {
    const current = this.readById(id)
    if (!current) return undefined
    const valid = WorkspaceSchema.parse({ ...current, messages: [...current.messages, message], updatedAt: this.now() })
    this.writeWorkspace(valid)
    return valid
  }

  async delete(id: string): Promise<boolean> {
    if (!ID_RE.test(id)) return false
    const res = this.transaction(() => {
      this.stmt('DELETE FROM widgets WHERE workspace_id = ?').run(id)
      return this.stmt('DELETE FROM workspaces WHERE id = ?').run(id)
    })
    return Number(res.changes) > 0
  }

  async findWidget(widgetId: string): Promise<{ workspace: Workspace; widget: AnyWidget } | undefined> {
    const hit = this.stmt('SELECT w.workspace_id FROM widgets w JOIN workspaces s ON s.id = w.workspace_id WHERE w.id = ? ORDER BY s.created_at, w.position LIMIT 1').get(widgetId) as
      | Pick<WidgetRow, 'workspace_id'>
      | undefined
    if (!hit) return undefined
    const workspace = this.readById(hit.workspace_id)
    const widget = workspace?.widgets.find((w) => w.id === widgetId)
    return workspace && widget ? { workspace, widget } : undefined
  }

  // ------------------------------------------------------------------------------------------ recipes

  listRecipes(): Recipe[] {
    const rows = this.stmt('SELECT doc FROM recipes ORDER BY position, name').all() as { doc: string }[]
    const out: Recipe[] = []
    for (const r of rows) {
      const parsed = RecipeSchema.safeParse(JSON.parse(r.doc))
      if (parsed.success) out.push(parsed.data)
    }
    return out
  }

  setRecipes(recipes: Recipe[]): void {
    this.transaction(() => {
      this.stmt('DELETE FROM recipes').run()
      const insert = this.stmt('INSERT INTO recipes (name, position, doc) VALUES (?, ?, ?)')
      recipes.forEach((r, i) => insert.run(r.name, i, JSON.stringify(RecipeSchema.parse(r))))
    })
  }

  // ------------------------------------------------------------------------------------------ catalog

  getCatalog(connector: string): CatalogCacheRow | undefined {
    const row = this.stmt('SELECT * FROM catalog WHERE connector = ?').get(connector) as { connector: string; version: string; descriptors: string; generated_at: number } | undefined
    return row ? { connector: row.connector, version: row.version, descriptors: JSON.parse(row.descriptors), generatedAt: row.generated_at } : undefined
  }

  setCatalog(row: CatalogCacheRow): void {
    this.stmt('INSERT INTO catalog (connector, version, descriptors, generated_at) VALUES (?, ?, ?, ?) ON CONFLICT(connector) DO UPDATE SET version = excluded.version, descriptors = excluded.descriptors, generated_at = excluded.generated_at').run(
      row.connector,
      row.version,
      JSON.stringify(row.descriptors),
      row.generatedAt,
    )
  }

  listCatalogs(): CatalogCacheRow[] {
    const rows = this.stmt('SELECT * FROM catalog ORDER BY connector').all() as { connector: string; version: string; descriptors: string; generated_at: number }[]
    return rows.map((row) => ({ connector: row.connector, version: row.version, descriptors: JSON.parse(row.descriptors), generatedAt: row.generated_at }))
  }

  // ------------------------------------------------------------------------------------------ liveness

  getLiveness(connector?: string): LivenessRow[] {
    const rows = (connector ? this.stmt('SELECT * FROM liveness WHERE connector = ? ORDER BY route').all(connector) : this.stmt('SELECT * FROM liveness ORDER BY connector, route').all()) as {
      connector: string
      route: string
      checked_at: number
      ok: number
      rows: number | null
      ms: number | null
      error: string | null
      sample_columns: string | null
    }[]
    return rows.map((r) => {
      const out: LivenessRow = { connector: r.connector, route: r.route, checkedAt: r.checked_at, ok: r.ok === 1 }
      if (r.rows !== null) out.rows = r.rows
      if (r.ms !== null) out.ms = r.ms
      if (r.error !== null) out.error = r.error
      if (r.sample_columns !== null) out.sampleColumns = JSON.parse(r.sample_columns)
      return out
    })
  }

  setLiveness(rows: LivenessRow | LivenessRow[]): void {
    const list = Array.isArray(rows) ? rows : [rows]
    const insert = this.stmt(
      'INSERT INTO liveness (connector, route, checked_at, ok, rows, ms, error, sample_columns) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(connector, route) DO UPDATE SET checked_at = excluded.checked_at, ok = excluded.ok, rows = excluded.rows, ms = excluded.ms, error = excluded.error, sample_columns = excluded.sample_columns',
    )
    this.transaction(() => {
      for (const r of list) insert.run(r.connector, r.route, r.checkedAt, r.ok ? 1 : 0, r.rows ?? null, r.ms ?? null, r.error ?? null, r.sampleColumns ? JSON.stringify(r.sampleColumns) : null)
    })
  }

  // ------------------------------------------------------------------------------------------ run log

  appendRun(row: RunLogRow): void {
    const { id, workspaceId, startedAt, ms, model, steps, tokens, cost, verification, ...extra } = row
    this.stmt('INSERT OR REPLACE INTO runs (id, workspace_id, started_at, ms, model, steps, tokens, cost, verification, extra) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      id,
      workspaceId,
      startedAt,
      ms,
      model,
      JSON.stringify(steps),
      tokens ? JSON.stringify(tokens) : null,
      cost ?? null,
      verification === undefined ? null : JSON.stringify(verification),
      Object.keys(extra).length ? JSON.stringify(extra) : null,
    )
  }

  listRuns(opts: { workspaceId?: string; limit?: number } = {}): RunLogRow[] {
    const limit = opts.limit ?? 50
    const rows = (
      opts.workspaceId
        ? this.stmt('SELECT * FROM runs WHERE workspace_id = ? ORDER BY started_at DESC LIMIT ?').all(opts.workspaceId, limit)
        : this.stmt('SELECT * FROM runs ORDER BY started_at DESC LIMIT ?').all(limit)
    ) as { id: string; workspace_id: string; started_at: number; ms: number; model: string; steps: string; tokens: string | null; cost: number | null; verification: string | null; extra: string | null }[]
    return rows.map((r) => {
      const out: RunLogRow = { ...(r.extra ? (JSON.parse(r.extra) as Record<string, unknown>) : {}), id: r.id, workspaceId: r.workspace_id, startedAt: r.started_at, ms: r.ms, model: r.model, steps: JSON.parse(r.steps) }
      if (r.tokens !== null) out.tokens = JSON.parse(r.tokens)
      if (r.cost !== null) out.cost = r.cost
      if (r.verification !== null) out.verification = JSON.parse(r.verification)
      return out
    })
  }

  // ------------------------------------------------------------------------------------------ frames

  getFrame(key: string, now = this.now()): Frame | undefined {
    const row = this.stmt('SELECT frame, expires_at FROM frames WHERE key = ?').get(key) as { frame: string; expires_at: number } | undefined
    if (!row) return undefined
    if (row.expires_at <= now) {
      this.stmt('DELETE FROM frames WHERE key = ?').run(key)
      return undefined
    }
    const parsed = FrameSchema.safeParse(JSON.parse(row.frame))
    return parsed.success ? parsed.data : undefined
  }

  setFrame(key: string, frame: Frame, expiresAt: number): void {
    const text = JSON.stringify(frame)
    this.stmt('INSERT INTO frames (key, frame, expires_at, stored_at, bytes) VALUES (?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET frame = excluded.frame, expires_at = excluded.expires_at, stored_at = excluded.stored_at, bytes = excluded.bytes').run(
      key,
      text,
      expiresAt,
      this.now(),
      text.length,
    )
  }

  deleteFrame(key: string): void {
    this.stmt('DELETE FROM frames WHERE key = ?').run(key)
  }

  clearFrames(): void {
    this.stmt('DELETE FROM frames').run()
  }

  pruneFrames(now = this.now(), maxRows = Infinity): number {
    let removed = Number(this.stmt('DELETE FROM frames WHERE expires_at <= ?').run(now).changes)
    if (Number.isFinite(maxRows)) {
      const count = this.countFrames()
      if (count > maxRows) {
        removed += Number(this.stmt('DELETE FROM frames WHERE key IN (SELECT key FROM frames ORDER BY stored_at ASC LIMIT ?)').run(count - maxRows).changes)
      }
    }
    return removed
  }

  countFrames(): number {
    const { n } = this.stmt('SELECT COUNT(*) AS n FROM frames').get() as { n: number }
    return Number(n)
  }

  /** Bytes of frame JSON stored, for the Data page. */
  frameBytes(): number {
    const { b } = this.stmt('SELECT COALESCE(SUM(bytes), 0) AS b FROM frames').get() as { b: number }
    return Number(b)
  }

  // ------------------------------------------------------------------------------------------ settings

  getSetting<T = unknown>(key: string): T | undefined {
    const row = this.stmt('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    return row ? (JSON.parse(row.value) as T) : undefined
  }

  setSetting(key: string, value: unknown): void {
    if (value === undefined) this.stmt('DELETE FROM settings WHERE key = ?').run(key)
    else this.stmt('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value))
  }

  close(): void {
    try {
      this.db.close()
    } catch {
      /* already closed */
    }
  }
}
