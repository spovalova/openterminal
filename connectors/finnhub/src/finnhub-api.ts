// Helpers for talking to Finnhub: URL building, rate limiting, 429 retry, per-symbol fan-out.
// Handlers live in index.ts; nothing here knows about frames.
import { HttpError, type Ctx } from '@terminal/core'

export const BASE_URL = 'https://finnhub.io/api/v1'

export type Config = { apiKey: string }

// Finnhub response shapes (only the fields the connector reads). https://finnhub.io/docs/api
export type FinnhubQuote = { c: number; d: number | null; dp: number | null; h: number; l: number; o: number; pc: number; t: number }
export type FinnhubNewsItem = { category: string; datetime: number; headline: string; id: number; image: string; related: string; source: string; summary: string; url: string }
export type FinnhubEarningsCalendar = {
  earningsCalendar: { date: string; epsActual: number | null; epsEstimate: number | null; hour: 'bmo' | 'amc' | 'dmh' | ''; quarter: number; revenueActual: number | null; revenueEstimate: number | null; symbol: string; year: number }[]
}

/** Free tier is 60 calls/min with a 30/s burst; stay under the burst. */
export const MAX_PER_SECOND = 30
export const RETRY_AFTER_MS = 1_000

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Sliding-window limiter: at most `max` requests started per `windowMs`. */
export function createLimiter(max: number, windowMs: number, deps: { now?: () => number; wait?: (ms: number) => Promise<void> } = {}) {
  const now = deps.now ?? Date.now
  const wait = deps.wait ?? sleep
  let started: number[] = []
  return {
    async acquire(): Promise<void> {
      for (;;) {
        const t = now()
        started = started.filter((s) => t - s < windowMs)
        if (started.length < max) {
          started.push(t)
          return
        }
        await wait(windowMs - (t - started[0]!))
      }
    },
    reset(): void {
      started = []
    },
  }
}

const limiter = createLimiter(MAX_PER_SECOND, 1_000)
/** Test hook: forget the request history so a frozen clock cannot saturate the window. */
export const resetLimiter = (): void => limiter.reset()

export function buildUrl(path: string, params: Record<string, string>, token: string): string {
  const qs = new URLSearchParams({ ...params, token })
  return `${BASE_URL}${path}?${qs.toString()}`
}

/** Throttled GET that retries once after a 429. Resolves to the parsed JSON body. */
export async function get<T>(ctx: Ctx<Config>, path: string, params: Record<string, string>, wait: (ms: number) => Promise<void> = sleep): Promise<T> {
  const url = buildUrl(path, params, ctx.config.apiKey)
  const once = async () => {
    await limiter.acquire()
    return (await ctx.http.get(url, { signal: ctx.signal })) as T
  }
  try {
    return await once()
  } catch (err) {
    if (!(err instanceof HttpError) || err.status !== 429) throw err
    ctx.log(`429 on ${path}, retrying in ${RETRY_AFTER_MS}ms`)
    await wait(RETRY_AFTER_MS)
    return once()
  }
}

/**
 * Run `fn` for every symbol in parallel and concatenate the rows.
 * A failing symbol is logged and skipped; the call only throws when every symbol failed.
 */
export async function perSymbol<R>(ctx: Ctx<Config>, symbols: string[], fn: (symbol: string) => Promise<R[]>): Promise<R[]> {
  const results = await Promise.allSettled(symbols.map(fn))
  const rows: R[] = []
  const failures: string[] = []
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') rows.push(...r.value)
    else failures.push(`${symbols[i]}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`)
  })
  failures.forEach((f) => ctx.log(`skipped ${f}`))
  if (symbols.length > 0 && failures.length === symbols.length) throw new Error(`finnhub: every symbol failed (${failures.join('; ')})`)
  return rows
}

/** YYYY-MM-DD in UTC. */
export const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

/** Finnhub `hour` → catalog `session`. */
export const toSession = (hour: string | undefined): 'bmo' | 'amc' | null => (hour === 'bmo' || hour === 'amc' ? hour : null)
