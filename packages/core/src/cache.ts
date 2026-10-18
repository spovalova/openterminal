import type { Frame } from './frame.js'
import { canonicalKey, type AnyQuery } from './query.js'

/**
 * The frame cache. Keyed by `canonicalKey`: `kind:params` for v1 queries (unchanged from v1), `route:…`,
 * `recipe:…` and `transform:…` for v2 ones. The server's persistent cache (phase 1) implements the same interface.
 */
export interface Cache {
  get(q: AnyQuery): Frame | undefined
  /** ttl overrides frame.meta.ttl when given. */
  set(q: AnyQuery, f: Frame, ttl?: number): void
  delete(q: AnyQuery): void
  clear(): void
}

/** The cache key for any query. Equal to v1's `kind:stable(params)` for kind queries. */
export function cacheKey(q: AnyQuery): string {
  return canonicalKey(q)
}

/** In-memory cache keyed by canonical query, TTL per entry. */
export class MemoryCache implements Cache {
  private entries = new Map<string, { frame: Frame; expiresAt: number }>()
  constructor(private readonly now: () => number = Date.now) {}

  get(q: AnyQuery): Frame | undefined {
    return this.getByKey(cacheKey(q))
  }

  set(q: AnyQuery, f: Frame, ttl?: number): void {
    this.setByKey(cacheKey(q), f, ttl)
  }

  delete(q: AnyQuery): void {
    this.entries.delete(cacheKey(q))
  }

  clear(): void {
    this.entries.clear()
  }

  getByKey(key: string): Frame | undefined {
    const e = this.entries.get(key)
    if (!e) return undefined
    if (e.expiresAt <= this.now()) {
      this.entries.delete(key)
      return undefined
    }
    return e.frame
  }

  setByKey(key: string, f: Frame, ttl?: number): void {
    const t = ttl ?? f.meta.ttl
    if (t <= 0) return
    this.entries.set(key, { frame: f, expiresAt: this.now() + t })
  }

  get size(): number {
    return this.entries.size
  }
}
