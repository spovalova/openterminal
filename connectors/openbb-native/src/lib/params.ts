// Reading the params a handler gets: they arrive the way the openbb connector sends them to the API, list params as
// arrays (OpenBB's API joins those with commas), booleans and numbers typed.
import type { NativeParams } from '../types.js'

/** A text param; list params arrive as arrays and OpenBB's API joins them with commas. Empty is absent. */
export function text(params: NativeParams, name: string): string | undefined {
  const v = params[name]
  if (v === undefined || v === null) return undefined
  const s = Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean).join(',') : String(v)
  return s === '' ? undefined : s
}

export function flag(params: NativeParams, name: string, fallback: boolean): boolean {
  const v = params[name]
  return typeof v === 'boolean' ? v : v === undefined ? fallback : String(v).toLowerCase() === 'true'
}

/** An integer param. */
export function whole(params: NativeParams, name: string): number | undefined {
  const v = params[name]
  if (v === undefined || v === null || v === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? Math.trunc(n) : undefined
}

/** Python's `date.today()` / `datetime.now().date()`: the local calendar date of `now`, as YYYY-MM-DD. */
export function localDate(now: Date): string {
  return `${String(now.getFullYear()).padStart(4, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}
