import { readFileSync } from 'node:fs'
import { HttpError, type Ctx } from '@terminal/core'
import { resetLimiter, type Config } from '../src/finnhub-api.js'

export const TOKEN = 'test-token'
/** Fixed clock for every test: 2026-10-16T14:30:00Z. */
export const NOW = Date.UTC(2026, 9, 16, 14, 30, 0)

export const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'))

/** A route answers with a JSON value, throws an Error, or runs a function (for sequences). */
export type Route = unknown | Error | (() => unknown)

/** Fake ctx whose http.get answers from a URL → route table and records every call. */
export function fakeCtx(routes: Record<string, Route>) {
  const calls: string[] = []
  const logs: string[] = []
  const ctx: Ctx<Config> = {
    config: { apiKey: TOKEN },
    log: (m) => logs.push(m),
    http: {
      async get(url) {
        calls.push(url)
        if (!(url in routes)) throw new Error(`unexpected request: ${url}`)
        const r = routes[url]
        if (r instanceof Error) throw r
        return typeof r === 'function' ? (r as () => unknown)() : r
      },
    },
  }
  resetLimiter()
  return { ctx, calls, logs }
}

export const status = (code: number, url = 'https://finnhub.io/api/v1/x') => new HttpError(code, url, `{"error":"status ${code}"}`)
