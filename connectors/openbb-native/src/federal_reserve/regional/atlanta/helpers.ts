// Shared by the Atlanta Fed routes, provider federal_reserve. Ported from the downloads in
// openbb_federal_reserve/models/regional/atlanta_*.py (OpenBB Platform 5.0.0, Apache-2.0); modified: ctx.cache
// instead of the on-disk cache, and plain arrays instead of pandas frames.
import { BROWSER_UA, NativeHttpError } from '../../../http.js'
import type { NativeCtx, NativeParams } from '../../../types.js'

export const ATLANTA_DOCS = 'https://www.atlantafed.org/-/media/Project/Atlanta/FRBA/Documents'
const DAY_MS = 24 * 3600 * 1000

/** A workbook download, kept for a day (the Python cache expires at the next release boundary). */
export function downloadWorkbook(ctx: NativeCtx, key: string, url: string): Promise<Uint8Array> {
  return ctx.cache(`atlanta:${key}`, DAY_MS, async () => {
    const get = () => ctx.http.bytes(url, { headers: { 'user-agent': BROWSER_UA }, timeoutMs: 120_000 })
    // The 11 MB GDPNow workbook sometimes gets its connection cut halfway ("terminated"): one more try.
    const bytes = await get().catch((err: unknown) => {
      if (err instanceof NativeHttpError) throw err
      return get()
    })
    if (bytes.length === 0) throw new Error('The request was returned empty.')
    return bytes
  })
}

export const dateParam = (params: NativeParams, name: 'start_date' | 'end_date'): string | undefined => (typeof params[name] === 'string' && params[name] ? (params[name] as string) : undefined)

export function emptyData(): never {
  throw new Error('The request was returned empty.')
}
