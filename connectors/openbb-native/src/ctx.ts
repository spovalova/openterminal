import { createNativeHttp } from './http.js'
import type { NativeCtx } from './types.js'

export type NativeCtxOptions = {
  fetch?: typeof fetch
  /** Credentials by OpenBB's names, from config.yml. */
  credentials?: Record<string, string | undefined>
  /** Environment fallback: `fred_api_key` is also read from `FRED_API_KEY`. */
  env?: Record<string, string | undefined>
  log?: (msg: string) => void
  signal?: AbortSignal
  now?: () => Date
  timeoutMs?: number
  /** Where `ctx.cache` keeps entries; the process-wide one when omitted. */
  cache?: Map<string, CacheEntry>
}

export type CacheEntry = { expires: number; value: Promise<unknown> }

const shared = new Map<string, CacheEntry>()

export function createNativeCtx(opts: NativeCtxOptions = {}): NativeCtx {
  const now = opts.now ?? (() => new Date())
  const store = opts.cache ?? shared
  return {
    http: createNativeHttp(opts.fetch ?? fetch, { ...(opts.signal ? { signal: opts.signal } : {}), ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) }),
    credential: (name) => opts.credentials?.[name] || opts.env?.[name.toUpperCase()] || undefined,
    now,
    cache<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
      const t = now().getTime()
      const hit = store.get(key)
      if (hit && hit.expires > t) return hit.value as Promise<T>
      const value = load()
      store.set(key, { expires: t + ttlMs, value })
      // A failed load is not kept: the next call tries again.
      value.catch(() => {
        if (store.get(key)?.value === value) store.delete(key)
      })
      return value
    },
    log: opts.log ?? (() => {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  }
}
