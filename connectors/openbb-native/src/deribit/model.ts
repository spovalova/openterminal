// What OpenBB's `Data` base class does to a record (openbb_core/provider/abstract/data.py): names in `__alias_dict__`
// are renamed to the model's field (a later key wins when two land on the same field), the field's validator runs,
// anything the model does not declare is kept as it came, and a missing value is left out of the answer.
import type { Row } from '../types.js'

type Convert = Record<string, (value: any) => unknown>

/**
 * @param aliases `__alias_dict__`: model field → the name the record carries it under.
 * @param convert validators by model field (the value is the record's, after the rename).
 */
export function shape(record: Row, aliases: Record<string, string> = {}, convert: Convert = {}): Row {
  const byName = new Map(Object.entries(aliases).map(([field, name]) => [name, field]))
  const renamed: Row = {}
  for (const [name, value] of Object.entries(record)) renamed[byName.get(name) ?? name] = value
  const out: Row = {}
  for (const [field, value] of Object.entries(renamed)) {
    const v = convert[field] ? convert[field]!(value) : value
    if (v !== undefined && v !== null && !(typeof v === 'number' && Number.isNaN(v))) out[field] = v
  }
  return out
}

/** The validator for a rate the exchange sends as a fraction and the model carries in percent. */
export const asPercent = (v: unknown): unknown => (v === null || v === undefined ? null : (v as number) * 100)

/** Python's `sorted(key=...)` over tuples: each key in turn, text and numbers by their natural order, missing last. */
export function by<T>(...keys: ((item: T) => unknown)[]): (a: T, b: T) => number {
  return (a, b) => {
    for (const key of keys) {
      const x = key(a) as string | number
      const y = key(b) as string | number
      if (x < y) return -1
      if (x > y) return 1
    }
    return 0
  }
}

/** A comma-separated query value (`"BTC,ETH"`, or the list the connector sends) as trimmed items, empty ones dropped. */
export function items(value: unknown, transform: (s: string) => string = (s) => s): string[] {
  const list = Array.isArray(value) ? value : String(value ?? '').split(',')
  return list.flatMap((v) => String(v).split(',')).map((s) => s.trim()).filter(Boolean).map(transform)
}

/** Python's `str(value)`: a missing value reads `None`. */
export const pyStr = (v: unknown): string => (v === null || v === undefined ? 'None' : String(v))
