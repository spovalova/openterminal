import { readFileSync } from 'node:fs'
import { HttpError, type Ctx } from '@openterminal/core'
import { ConfigSchema, resetBreaker, type Config } from '../src/openbb-api.js'

export const BASE = 'http://127.0.0.1:6900/api/v1'
/** Fixed clock for every test: Friday 2026-10-16 14:30:00Z (10:30 ET, market open). */
export const NOW = Date.UTC(2026, 9, 16, 14, 30, 0)

export const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'))

/** A route answers with a JSON value, throws an Error, or runs a function (for sequences). */
export type Route = unknown | Error | (() => unknown)

/** Fake ctx whose http.get answers from a URL → route table and records every call with its init. */
export function fakeCtx(routes: Record<string, Route>, config: Partial<Config> = {}) {
  const calls: string[] = []
  const inits: (RequestInit | undefined)[] = []
  const logs: string[] = []
  const ctx: Ctx<Config> = {
    // The API path by default; native.test.ts covers the native one.
    config: ConfigSchema.parse({ native: 'off', ...config }),
    log: (m) => logs.push(m),
    http: {
      async get(url, init) {
        calls.push(url)
        inits.push(init)
        if (!(url in routes)) throw new Error(`unexpected request: ${url}`)
        const r = routes[url]
        if (r instanceof Error) throw r
        return typeof r === 'function' ? (r as () => unknown)() : r
      },
    },
  }
  resetBreaker()
  return { ctx, calls, inits, logs }
}

export const status = (code: number, body: string, url = `${BASE}/x`) => new HttpError(code, url, body)

/** What fetch throws when nothing listens on the port. */
export function connectionRefused(): Error {
  const err = new TypeError('fetch failed')
  ;(err as { cause?: unknown }).cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:6900'), { code: 'ECONNREFUSED' })
  return err
}
