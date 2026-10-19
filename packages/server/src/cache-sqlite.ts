// The persistent frame cache (PLAN.md section 17, "Store on SQLite"): `Cache` over the store's frames table, keyed
// by `canonicalKey`, so a restart does not refetch two years of bars. A small in-memory front keeps the hot frames
// parsed; TTL expiry is enforced on read; a row cap and a per-frame byte cap bound the file.
import { cacheKey, type AnyQuery, type Cache, type Frame } from '@openterminal/core'
import type { Store } from './store/index.js'

export type SqliteCacheOptions = {
  now?: () => number
  /** Rows kept in the table; the oldest beyond this are pruned (default 2000). */
  maxRows?: number
  /** Frames whose JSON is larger than this stay in memory only (default 8 MB). */
  maxFrameBytes?: number
  /** Parsed frames kept in memory (default 256). */
  memoryEntries?: number
  /** Prune the table every this many writes (default 100). */
  pruneEvery?: number
}

export class SqliteCache implements Cache {
  private readonly now: () => number
  private readonly maxRows: number
  private readonly maxFrameBytes: number
  private readonly memoryEntries: number
  private readonly pruneEvery: number
  private writes = 0
  private memory = new Map<string, { frame: Frame; expiresAt: number }>()

  constructor(
    private readonly store: Store,
    opts: SqliteCacheOptions = {},
  ) {
    this.now = opts.now ?? Date.now
    this.maxRows = opts.maxRows ?? 2_000
    this.maxFrameBytes = opts.maxFrameBytes ?? 8 * 1024 * 1024
    this.memoryEntries = opts.memoryEntries ?? 256
    this.pruneEvery = opts.pruneEvery ?? 100
  }

  get(q: AnyQuery): Frame | undefined {
    return this.getByKey(cacheKey(q))
  }

  set(q: AnyQuery, f: Frame, ttl?: number): void {
    this.setByKey(cacheKey(q), f, ttl)
  }

  delete(q: AnyQuery): void {
    const key = cacheKey(q)
    this.memory.delete(key)
    this.store.deleteFrame(key)
  }

  clear(): void {
    this.memory.clear()
    this.store.clearFrames()
  }

  getByKey(key: string): Frame | undefined {
    const now = this.now()
    const hot = this.memory.get(key)
    if (hot) {
      if (hot.expiresAt > now) {
        // refresh recency
        this.memory.delete(key)
        this.memory.set(key, hot)
        return hot.frame
      }
      this.memory.delete(key)
    }
    const frame = this.store.getFrame(key, now)
    if (frame) this.remember(key, frame, frame.meta.fetchedAt + frame.meta.ttl)
    return frame
  }

  setByKey(key: string, f: Frame, ttl?: number): void {
    const t = ttl ?? f.meta.ttl
    if (t <= 0) return
    const expiresAt = this.now() + t
    this.remember(key, f, expiresAt)
    // The byte cap is checked on the serialised size; frames over it are served from memory for this process only.
    if (JSON.stringify(f).length > this.maxFrameBytes) return
    this.store.setFrame(key, f, expiresAt)
    if (++this.writes % this.pruneEvery === 0) this.store.pruneFrames(this.now(), this.maxRows)
  }

  /** Rows in the table (expired ones included until the next prune). */
  get size(): number {
    return this.store.countFrames()
  }

  prune(): number {
    for (const [k, e] of this.memory) if (e.expiresAt <= this.now()) this.memory.delete(k)
    return this.store.pruneFrames(this.now(), this.maxRows)
  }

  private remember(key: string, frame: Frame, expiresAt: number): void {
    this.memory.delete(key)
    this.memory.set(key, { frame, expiresAt })
    while (this.memory.size > this.memoryEntries) {
      const oldest = this.memory.keys().next().value
      if (oldest === undefined) break
      this.memory.delete(oldest)
    }
  }
}
