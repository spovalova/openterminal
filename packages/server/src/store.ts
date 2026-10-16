// ~/.terminal/workspaces/<id>.json, one file per workspace. No database.
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { nanoid } from 'nanoid'
import { WorkspaceSchema, createWorkspace, type Message, type Widget, type Workspace } from '@terminal/core'

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/

export type WorkspaceInit = { name?: string; widgets?: Widget[]; messages?: Message[] }
export type WorkspacePatch = { name?: string; widgets?: Widget[]; messages?: Message[] }

export class WorkspaceStore {
  private locks = new Map<string, Promise<unknown>>()

  constructor(
    readonly dir: string,
    private readonly opts: { log?: (msg: string) => void; now?: () => number; id?: () => string } = {},
  ) {}

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
  async findWidget(widgetId: string): Promise<{ workspace: Workspace; widget: Widget } | undefined> {
    for (const workspace of await this.list()) {
      const widget = workspace.widgets.find((w) => w.id === widgetId)
      if (widget) return { workspace, widget }
    }
    return undefined
  }

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
