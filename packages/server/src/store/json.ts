// The v1 store: ~/.terminal/workspaces/<id>.json, one file per workspace. Kept behind the `Store` interface for
// the one-time migration (`migrate.ts` reads it) and as the fallback when SQLite cannot open; the tables SQLite
// adds (recipes, catalog, liveness, run log, frames, settings) are in memory here.
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { nanoid } from 'nanoid'
import { WorkspaceSchema, createWorkspace, type AnyWidget, type Frame, type Message, type Recipe, type Workspace } from '@terminal/core'
import { ID_RE, type CatalogCacheRow, type LivenessRow, type RunLogRow, type Store, type WorkspaceInit, type WorkspacePatch } from './types.js'

export type StoreOptions = { log?: (msg: string) => void; now?: () => number; id?: () => string }

export class WorkspaceStore implements Store {
  private locks = new Map<string, Promise<unknown>>()
  private recipes: Recipe[] = []
  private catalogs = new Map<string, CatalogCacheRow>()
  private liveness = new Map<string, LivenessRow>()
  private runs: RunLogRow[] = []
  private frames = new Map<string, { frame: Frame; expiresAt: number }>()
  private settings = new Map<string, unknown>()

  constructor(
    readonly dir: string,
    private readonly opts: StoreOptions = {},
  ) {}

  get location(): string {
    return this.dir
  }

  private get now() {
    return this.opts.now ?? Date.now
  }

  private file(id: string): string {
    if (!ID_RE.test(id)) throw new Error(`invalid workspace id "${id}"`)
    return join(this.dir, `${id}.json`)
  }

  /** Every workspace on disk, oldest first (tab order). Unreadable files are logged and skipped. */
  async list(): Promise<Workspace[]> {
    await mkdir(this.dir, { recursive: true })
    const names = await readdir(this.dir)
    const out: Workspace[] = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const id = name.slice(0, -'.json'.length)
      if (!ID_RE.test(id)) continue
      try {
        const ws = await this.read(id)
        if (ws) out.push(ws)
      } catch (err) {
        this.opts.log?.(`workspace ${id}: ${err instanceof Error ? err.message : String(err)}; skipped`)
      }
    }
    return out.sort((a, b) => a.createdAt - b.createdAt)
  }

  /** The workspace, or undefined when there is no file. Throws when the file does not validate. */
  async get(id: string): Promise<Workspace | undefined> {
    if (!ID_RE.test(id)) return undefined
    return this.read(id)
  }

  async create(init: WorkspaceInit = {}): Promise<Workspace> {
    const ws = createWorkspace({ id: (this.opts.id ?? nanoid)(), name: init.name, now: this.now() })
    if (init.widgets) ws.widgets = init.widgets
    if (init.messages) ws.messages = init.messages
    const valid = WorkspaceSchema.parse(ws)
    await this.write(valid)
    return valid
  }

  importWorkspace(doc: { name: string; widgets: AnyWidget[]; messages?: Message[] }): Promise<Workspace> {
    return this.create({ name: doc.name, widgets: doc.widgets, messages: doc.messages ?? [] })
  }

  /** Apply a partial update and bump updatedAt. Undefined when the workspace does not exist. */
  async patch(id: string, patch: WorkspacePatch): Promise<Workspace | undefined> {
    if (!ID_RE.test(id)) return undefined
    return this.locked(id, async () => {
      const current = await this.read(id)
      if (!current) return undefined
      const next: Workspace = {
        ...current,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.widgets !== undefined ? { widgets: patch.widgets } : {}),
        ...(patch.messages !== undefined ? { messages: patch.messages } : {}),
        updatedAt: this.now(),
      }
      const valid = WorkspaceSchema.parse(next)
      await this.write(valid)
      return valid
    })
  }

  /** Append a message and bump updatedAt. */
  async appendMessage(id: string, message: Message): Promise<Workspace | undefined> {
    if (!ID_RE.test(id)) return undefined
    return this.locked(id, async () => {
      const current = await this.read(id)
      if (!current) return undefined
      const valid = WorkspaceSchema.parse({ ...current, messages: [...current.messages, message], updatedAt: this.now() })
      await this.write(valid)
      return valid
    })
  }

  /** True when a file was removed. */
  async delete(id: string): Promise<boolean> {
    if (!ID_RE.test(id)) return false
    return this.locked(id, async () => {
      const existing = await this.read(id)
      if (!existing) return false
      await rm(this.file(id), { force: true })
      return true
    })
  }

  /** Find a widget by id across every workspace. Widget ids are only unique within a workspace, so the first match wins. */
  async findWidget(widgetId: string): Promise<{ workspace: Workspace; widget: AnyWidget } | undefined> {
    for (const workspace of await this.list()) {
      const widget = workspace.widgets.find((w) => w.id === widgetId)
      if (widget) return { workspace, widget }
    }
    return undefined
  }

  // ---- in-memory extras ----

  listRecipes(): Recipe[] {
    return [...this.recipes]
  }
  setRecipes(recipes: Recipe[]): void {
    this.recipes = [...recipes]
  }
  getCatalog(connector: string): CatalogCacheRow | undefined {
    return this.catalogs.get(connector)
  }
  setCatalog(row: CatalogCacheRow): void {
    this.catalogs.set(row.connector, row)
  }
  listCatalogs(): CatalogCacheRow[] {
    return [...this.catalogs.values()]
  }
  getLiveness(connector?: string): LivenessRow[] {
    return [...this.liveness.values()].filter((r) => !connector || r.connector === connector)
  }
  setLiveness(rows: LivenessRow | LivenessRow[]): void {
    for (const r of Array.isArray(rows) ? rows : [rows]) this.liveness.set(`${r.connector}:${r.route}`, r)
  }
  appendRun(row: RunLogRow): void {
    this.runs.push(row)
  }
  listRuns(opts: { workspaceId?: string; limit?: number } = {}): RunLogRow[] {
    const rows = this.runs.filter((r) => !opts.workspaceId || r.workspaceId === opts.workspaceId).sort((a, b) => b.startedAt - a.startedAt)
    return rows.slice(0, opts.limit ?? 50)
  }
  getFrame(key: string, now = this.now()): Frame | undefined {
    const e = this.frames.get(key)
    if (!e) return undefined
    if (e.expiresAt <= now) {
      this.frames.delete(key)
      return undefined
    }
    return e.frame
  }
  setFrame(key: string, frame: Frame, expiresAt: number): void {
    this.frames.set(key, { frame, expiresAt })
  }
  deleteFrame(key: string): void {
    this.frames.delete(key)
  }
  clearFrames(): void {
    this.frames.clear()
  }
  pruneFrames(now = this.now(), maxRows = Infinity): number {
    let removed = 0
    for (const [k, e] of this.frames) {
      if (e.expiresAt <= now) {
        this.frames.delete(k)
        removed++
      }
    }
    while (this.frames.size > maxRows) {
      const oldest = this.frames.keys().next().value
      if (oldest === undefined) break
      this.frames.delete(oldest)
      removed++
    }
    return removed
  }
  countFrames(): number {
    return this.frames.size
  }
  getSetting<T = unknown>(key: string): T | undefined {
    return this.settings.get(key) as T | undefined
  }
  setSetting(key: string, value: unknown): void {
    this.settings.set(key, value)
  }
  close(): void {}

  private async read(id: string): Promise<Workspace | undefined> {
    let text: string
    try {
      text = await readFile(this.file(id), 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw err
    }
    return WorkspaceSchema.parse(JSON.parse(text))
  }

  /** Write the temp file then rename so a crash never leaves a half-written workspace. */
  private async write(ws: Workspace): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    const target = this.file(ws.id)
    const tmp = `${target}.${process.pid}.${nanoid(6)}.tmp`
    await writeFile(tmp, JSON.stringify(ws, null, 2), 'utf8')
    await rename(tmp, target)
  }

  /** Serialize read-modify-write cycles per workspace. */
  private locked<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    const tail: Promise<unknown> = next.catch(() => undefined).finally(() => {
      if (this.locks.get(id) === tail) this.locks.delete(id)
    })
    this.locks.set(id, tail)
    return next
  }
}
