import type { Cache } from './cache.js'
import { createHttp, type Connector, type Ctx, type Http } from './connector.js'
import type { Frame } from './frame.js'
import { KINDS, KIND_NAMES, parseQuery, ttlFor, type Kind, type Query, type QueryInput } from './kinds.js'

export type ConnectorStatus = 'ok' | 'missing_config' | 'error'

export type RegisteredConnector = {
  name: string
  kinds: Kind[]
  status: ConnectorStatus
  error?: string
}

export interface Registry {
  /** Register a connector with its raw config. Registration order is routing priority. */
  register(c: Connector, config: unknown): RegisteredConnector
  /** Kinds currently answerable by at least one healthy connector. */
  kinds(): Kind[]
  connectors(): RegisteredConnector[]
  /** Validate the query, serve from cache, else try connectors in order and validate the frame. */
  run(q: QueryInput, opts?: { signal?: AbortSignal; bypassCache?: boolean }): Promise<Frame>
}

export class RegistryError extends Error {
  constructor(
    message: string,
    public readonly causes: { connector: string; error: string }[] = [],
  ) {
    super(message)
    this.name = 'RegistryError'
  }
}

type Entry = { connector: Connector; ctx: Ctx<unknown>; info: RegisteredConnector }

export type RegistryOptions = { cache?: Cache; http?: Http; log?: (msg: string) => void }

export class ConnectorRegistry implements Registry {
  private entries: Entry[] = []
  private readonly cache?: Cache
  private readonly http: Http
  private readonly log: (msg: string) => void

  constructor(opts: RegistryOptions = {}) {
    this.cache = opts.cache
    this.http = opts.http ?? createHttp()
    this.log = opts.log ?? (() => {})
  }

  register(c: Connector, config: unknown): RegisteredConnector {
    const parsed = c.config.safeParse(config ?? {})
    const info: RegisteredConnector = parsed.success
      ? { name: c.name, kinds: c.kinds, status: 'ok' }
      : { name: c.name, kinds: c.kinds, status: 'missing_config', error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') }
    const ctx: Ctx<unknown> = {
      http: this.http,
      config: parsed.success ? parsed.data : undefined,
      log: (msg) => this.log(`[${c.name}] ${msg}`),
    }
    // Re-registering (for example after a key is saved) keeps the connector's routing priority.
    const existing = this.entries.findIndex((e) => e.connector.name === c.name)
    if (existing >= 0) this.entries[existing] = { connector: c, ctx, info }
    else this.entries.push({ connector: c, ctx, info })
    return info
  }

  kinds(): Kind[] {
    const set = new Set<Kind>()
    for (const e of this.entries) if (e.info.status === 'ok') e.connector.kinds.forEach((k) => set.add(k))
    return KIND_NAMES.filter((k) => set.has(k))
  }

  connectors(): RegisteredConnector[] {
    return this.entries.map((e) => ({ ...e.info }))
  }

  async run(input: QueryInput, opts: { signal?: AbortSignal; bypassCache?: boolean } = {}): Promise<Frame> {
    const q = parseQuery(input)
    if (!opts.bypassCache) {
      const hit = this.cache?.get(q)
      if (hit) return hit
    }
    const candidates = this.entries.filter((e) => e.info.status === 'ok' && e.connector.kinds.includes(q.kind))
    if (candidates.length === 0) throw new RegistryError(`no connector answers kind "${q.kind}"`)

    const causes: { connector: string; error: string }[] = []
    for (const e of candidates) {
      const handler = e.connector.queries[q.kind] as ((p: unknown, ctx: Ctx<unknown>) => Promise<Frame>) | undefined
      if (!handler) continue
      try {
        const raw = await handler(q.params, { ...e.ctx, signal: opts.signal })
        const frame = validateFrame(q, raw, e.connector.name)
        this.cache?.set(q, frame)
        return frame
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        causes.push({ connector: e.connector.name, error: msg })
        this.log(`[${e.connector.name}] ${q.kind} failed: ${msg}`)
        if (opts.signal?.aborted) break
      }
    }
    throw new RegistryError(`${q.kind} failed on every connector: ${causes.map((c) => `${c.connector}: ${c.error}`).join(' | ')}`, causes)
  }
}

/** Validates columns against the catalog exactly (names, types, order), checks every non-null cell's type, and stamps meta. */
export function validateFrame(q: Query, frame: Frame, connector: string): Frame {
  const expected = KINDS[q.kind].columns
  const got = frame.columns
  const same = got.length === expected.length && got.every((c, i) => c.name === expected[i]!.name && c.type === expected[i]!.type)
  if (!same) {
    throw new Error(
      `frame columns for ${q.kind} do not match catalog. expected [${expected.map((c) => c.name).join(', ')}] got [${got.map((c) => c.name).join(', ')}]`,
    )
  }
  frame.rows.forEach((row, r) => {
    if (row.length !== expected.length) throw new Error(`row ${r} has ${row.length} cells, expected ${expected.length}`)
    row.forEach((cell, i) => {
      if (cell === null || cell === undefined) return
      const want = expected[i]!.type
      const ok =
        want === 'string' ? typeof cell === 'string'
        : want === 'boolean' ? typeof cell === 'boolean'
        : typeof cell === 'number' && Number.isFinite(cell) // number and time (epoch ms)
      if (!ok) throw new Error(`row ${r} column ${expected[i]!.name}: expected ${want}, got ${cell instanceof Date ? 'Date' : typeof cell}`)
    })
  })
  return { ...frame, meta: { connector, fetchedAt: frame.meta?.fetchedAt ?? Date.now(), ttl: ttlFor(q) } }
}
