// Shared by the congress_gov routes. Ported from openbb_government_us/congress/utils/{helpers,constants}.py and the
// parts of bulk.py every route uses (OpenBB Platform 5.0.0, Apache-2.0).
import type { NativeCtx, NativeParams } from '../types.js'
import { GOVINFO } from './billstatus.js'

export const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

/** An integer param; undefined when absent. */
export function int(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined
  const n = Number(v)
  return Number.isNaN(n) ? undefined : Math.trunc(n)
}

/** The PDF/HTM/XML content URLs of a GovInfo package (`package_urls`). */
export function packageUrls(pkg: string): { pdf: string; htm: string; xml: string } {
  const base = `${GOVINFO}/content/pkg/${pkg}`
  return { pdf: `${base}/pdf/${pkg}.pdf`, htm: `${base}/html/${pkg}.htm`, xml: `${base}/xml/${pkg}.xml` }
}

/** The current Congress, from ctx.now(). */
export const currentCongress = (ctx: NativeCtx): number => {
  const year = ctx.now().getUTCFullYear()
  return 74 + Math.floor((year - 1935) / 2)
}

/** `out[offset:]` then the limit: unset is 100, 0 is all (`filter_laws` and friends). */
export function paginate<T>(rows: T[], limit: number | undefined, offset: number | undefined): T[] {
  const out = rows.slice(offset ?? 0)
  if (limit === undefined) return out.slice(0, 100)
  if (limit === 0) return out
  return out.slice(0, limit)
}

/** Stable sort by a string key, descending or ascending; equal keys keep their order. */
export function sortByKey<T>(rows: T[], key: (r: T) => string, desc: boolean): T[] {
  return [...rows].sort((a, b) => {
    const ka = key(a)
    const kb = key(b)
    if (ka === kb) return 0
    return desc ? (ka < kb ? 1 : -1) : ka < kb ? -1 : 1
  })
}

export const flagParam = (params: NativeParams, name: string, dflt: boolean): boolean => (params[name] === undefined ? dflt : params[name] === true || params[name] === 'true')
