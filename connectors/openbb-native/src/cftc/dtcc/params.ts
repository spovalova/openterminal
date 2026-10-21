// Reading the route params the connector sends (all optional, as the Python query models declare them).
import type { NativeHandler, NativeParams } from '../../types.js'
import { EmptyDataError } from './curve.js'
import { parseIso, type D } from './dates.js'

export const pStr = (p: NativeParams, key: string): string | undefined => {
  const v = p[key]
  return typeof v === 'string' && v !== '' ? v : undefined
}

export const pNum = (p: NativeParams, key: string): number | undefined => {
  const v = p[key]
  if (typeof v === 'number') return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return undefined
}

export const pBool = (p: NativeParams, key: string): boolean | undefined => {
  const v = p[key]
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') {
    const t = v.trim().toLowerCase()
    if (['true', '1', 'yes', 'on', 't', 'y'].includes(t)) return true
    if (['false', '0', 'no', 'off', 'f', 'n'].includes(t)) return false
  }
  return undefined
}

export const pDate = (p: NativeParams, key: string): D | undefined => {
  const v = p[key]
  return typeof v === 'string' && v !== '' ? (parseIso(v) ?? undefined) : undefined
}

/** Run `fn` over the items with at most `limit` in flight, results in item order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      results[i] = await fn(items[i]!)
    }
  })
  await Promise.all(workers)
  return results
}

/** OpenBB's API answers an `EmptyDataError` with HTTP 204 and no body, which is no rows. */
export function answerEmpty(handler: NativeHandler): NativeHandler {
  return async (params, ctx) => {
    try {
      return await handler(params, ctx)
    } catch (err) {
      if (err instanceof EmptyDataError) return []
      throw err
    }
  }
}
