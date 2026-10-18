// Cell helpers shared by the v1.2 handlers: Yahoo returns fractions where the catalog wants percent,
// and leaves fields out (or sets them to null) when it has no value.

/** A finite number, else null. */
export function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** A non-empty string, else null. */
export function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

/** Round to `dp` decimals, clearing the float noise that ×100 leaves behind (0.27618998 × 100). */
export function round(v: number, dp: number): number {
  const f = 10 ** dp
  return Math.round(v * f) / f
}

/** A Yahoo fraction (0.0563) as a catalog percent (5.63), or null. */
export function pct(v: unknown): number | null {
  const n = num(v)
  return n === null ? null : round(n * 100, 4)
}

/** A valid Date, else undefined (yahoo-finance2 leaves out dates it cannot parse). */
export function date(v: unknown): Date | undefined {
  return v instanceof Date && !Number.isNaN(v.getTime()) ? v : undefined
}
