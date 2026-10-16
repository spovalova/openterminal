import stringify from 'fast-json-stable-stringify'
import type { Frame } from './frame.js'
import type { Query } from './kinds.js'

export interface Cache {
  get(q: Query): Frame | undefined
  /** ttl overrides frame.meta.ttl when given. */
  set(q: Query, f: Frame, ttl?: number): void
  delete(q: Query): void
  clear(): void
}

export function cacheKey(q: Query): string {
  return `${q.kind}:${stringify(q.params)}`
}

/** In-memory cache keyed by kind plus stable-stringified params, TTL per entry. */
export class MemoryCache implements Cache {
  private entries = new Map<string, { frame: Frame; expiresAt: number }>()
  constructor(private readonly now: () => number = Date.now) {}

  get(q: Query): Frame | undefined {
    const key = cacheKey(q)
    const e = this.entries.get(key)
    if (!e) return undefined
    if (e.expiresAt <= this.now()) {
      this.entries.delete(key)
      return undefined
    }
    return e.frame
  }

  set(q: Query, f: Frame, ttl?: number): void {
    const t = ttl ?? f.meta.ttl
    if (t <= 0) return
    this.entries.set(cacheKey(q), { frame: f, expiresAt: this.now() + t })
  }

  delete(q: Query): void {
    this.entries.delete(cacheKey(q))
  }

  clear(): void {
    this.entries.clear()
  }

  get size(): number {
    return this.entries.size
  }
}
