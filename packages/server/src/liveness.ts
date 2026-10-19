// Liveness rows (PLAN.md section 17): what the catalog probe records per route, kept across restarts so the
// agent's `find_route` hides dead routes before the next probe. The row shape agreed with (e) is the
// `Liveness` block plus the descriptor ref: `{ connector, route, checkedAt, ok, rows?, ms?, error?, sampleColumns? }`.
// Two implementations: in memory, and a JSON file under TERMINAL_HOME (`catalog/liveness.json`) that (e) replaces
// with the SQLite store behind the same interface.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { descriptorKey, LivenessSchema, type Catalog, type DescriptorRef, type Liveness } from '@openterminal/core'
import { terminalHome } from './config.js'

export const LivenessRowSchema = LivenessSchema.extend({ connector: z.string().min(1), route: z.string().min(1) })
export type LivenessRow = z.infer<typeof LivenessRowSchema>

export interface LivenessStore {
  /** Every row, in no particular order. */
  all(): Promise<LivenessRow[]>
  get(ref: DescriptorRef): Promise<LivenessRow | undefined>
  /** Upsert by `connector:route`. */
  put(rows: readonly LivenessRow[]): Promise<void>
  /** Forget one connector's rows, or all of them. */
  clear(connector?: string): Promise<void>
}

export function livenessRow(ref: DescriptorRef, liveness: Liveness): LivenessRow {
  return { connector: ref.connector, route: ref.route, ...liveness }
}

/** The `Liveness` block of a row (what `Catalog.setLiveness` takes). */
export function livenessOf(row: LivenessRow): Liveness {
  const liveness: Liveness = { checkedAt: row.checkedAt, ok: row.ok }
  if (row.rows !== undefined) liveness.rows = row.rows
  if (row.ms !== undefined) liveness.ms = row.ms
  if (row.error !== undefined) liveness.error = row.error
  if (row.sampleColumns !== undefined) liveness.sampleColumns = row.sampleColumns
  return liveness
}

export class MemoryLivenessStore implements LivenessStore {
  protected rows = new Map<string, LivenessRow>()

  constructor(initial: readonly LivenessRow[] = []) {
    for (const r of initial) this.rows.set(descriptorKey(r), r)
  }

  async all(): Promise<LivenessRow[]> {
    return [...this.rows.values()]
  }
  async get(ref: DescriptorRef): Promise<LivenessRow | undefined> {
    return this.rows.get(descriptorKey(ref))
  }
  async put(rows: readonly LivenessRow[]): Promise<void> {
    for (const r of rows) this.rows.set(descriptorKey(r), LivenessRowSchema.parse(r))
  }
  async clear(connector?: string): Promise<void> {
    if (connector === undefined) this.rows.clear()
    else for (const [k, r] of this.rows) if (r.connector === connector) this.rows.delete(k)
  }
}

export function livenessPath(home: string): string {
  return join(home, 'catalog', 'liveness.json')
}

/**
 * The JSON file fallback: `{ rows: LivenessRow[] }` at `<home>/catalog/liveness.json`, read once on first use,
 * written atomically after every `put` and `clear`. Unreadable or invalid files start empty (and are logged).
 */
export class FileLivenessStore extends MemoryLivenessStore {
  private loaded = false

  constructor(
    readonly path: string,
    private readonly opts: { log?: (msg: string) => void } = {},
  ) {
    super()
  }

  private load(): void {
    if (this.loaded) return
    this.loaded = true
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(this.path, 'utf8'))
    } catch (err) {
      if ((err as { code?: string }).code !== 'ENOENT') this.opts.log?.(`liveness: could not read ${this.path}: ${err instanceof Error ? err.message : String(err)}; starting empty`)
      return
    }
    const parsed = z.object({ rows: z.array(LivenessRowSchema) }).safeParse(raw)
    if (!parsed.success) {
      this.opts.log?.(`liveness: ${this.path} is not a liveness file; starting empty`)
      return
    }
    for (const r of parsed.data.rows) this.rows.set(descriptorKey(r), r)
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ rows: [...this.rows.values()] }), 'utf8')
    renameSync(tmp, this.path)
  }

  override async all(): Promise<LivenessRow[]> {
    this.load()
    return super.all()
  }
  override async get(ref: DescriptorRef): Promise<LivenessRow | undefined> {
    this.load()
    return super.get(ref)
  }
  override async put(rows: readonly LivenessRow[]): Promise<void> {
    this.load()
    await super.put(rows)
    this.save()
  }
  override async clear(connector?: string): Promise<void> {
    this.load()
    await super.clear(connector)
    this.save()
  }
}

/** The file store for a TERMINAL_HOME: what the script uses when (e)'s store is not open. */
export function openLivenessStore(home: string = terminalHome(), opts: { log?: (msg: string) => void } = {}): LivenessStore {
  return new FileLivenessStore(livenessPath(home), opts)
}

/** The part of (e)'s `Store` the probe needs. */
export type LivenessBackend = { getLiveness(connector?: string): LivenessRow[]; setLiveness(rows: LivenessRow | LivenessRow[]): void }

/**
 * `LivenessStore` over (e)'s store (SQLite in production, JSON in the fallback), so the probe's rows land where the
 * Data page and `GET /api/catalog/:connector` read them. The store has no delete: `clear` leaves rows in place and
 * the probe's upserts overwrite them route by route.
 */
export function livenessStoreOver(store: LivenessBackend): LivenessStore {
  return {
    async all() {
      return store.getLiveness()
    },
    async get(ref) {
      return store.getLiveness(ref.connector).find((r) => r.route === ref.route)
    },
    async put(rows) {
      if (rows.length > 0) store.setLiveness(rows.map((r) => LivenessRowSchema.parse(r)))
    },
    async clear() {
      // (e)'s store keeps rows until the next probe overwrites them.
    },
  }
}

/** Stamp every stored row onto the catalog (unknown routes are ignored by the catalog). Returns how many rows were applied. */
export async function applyLiveness(catalog: Catalog, store: LivenessStore): Promise<number> {
  let n = 0
  for (const row of await store.all()) {
    if (!catalog.get(row.connector, row.route)) continue
    catalog.setLiveness(row, livenessOf(row))
    n++
  }
  return n
}
