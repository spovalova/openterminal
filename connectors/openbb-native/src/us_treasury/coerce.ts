// Ported from the pydantic behavior of openbb_core/provider/abstract/data.py and the Data models of openbb_government_us
// (OpenBB Platform 5.0.0, Apache-2.0); modified: a field table (name → type) replaces the pydantic class, and only the
// lax coercions the Treasury sources need are implemented (str, int, float, bool, date, datetime, "Yes"/"No").
import type { Row } from '../types.js'

/**
 * A field's type: `str`, `int`, `float`, `bool`, `date`, `datetime`, `yesno` (Literal["Yes", "No"]) or `any`, with a
 * trailing `!` when the field is required (a missing value is a validation error, as in pydantic).
 */
export type FieldTable = Record<string, string>

const INT_RE = /^[+-]?\d+(?:_\d+)*$/
const FLOAT_RE = /^[+-]?(?:(?:\d+(?:_\d+)*)?\.\d+(?:_\d+)*|\d+(?:_\d+)*\.?)(?:[eE][+-]?\d+(?:_\d+)*)?$/
const FLOAT_WORD_RE = /^[+-]?(?:inf|infinity|nan)$/i

/** Python's `float(text)`, or undefined where Python raises ValueError. */
export function pyFloat(text: string): number | undefined {
  const s = text.trim()
  if (FLOAT_RE.test(s)) return Number(s.replace(/_/g, ''))
  if (FLOAT_WORD_RE.test(s)) return /nan/i.test(s) ? Number.NaN : s.startsWith('-') ? -Infinity : Infinity
  return undefined
}

/** `float(value)` as the Treasury transforms call it: a string, number or boolean, else a TypeError/ValueError. */
export function toFloatStrict(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'string') {
    const n = pyFloat(value)
    if (n !== undefined) return n
  }
  throw new Error(`could not convert string to float: ${JSON.stringify(value)}`)
}

/** Dates and datetimes as pydantic reads them; `date` accepts a datetime only when the time is midnight. */
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?(Z|[+-]\d{2}(?::?\d{2})?)?)?$/i

function validDay(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate()
}

function parseIso(value: string): { date: string; time?: { h: number; mi: number; s: number; micro: number }; zone?: string } | undefined {
  const m = ISO_RE.exec(value.trim())
  if (!m) return undefined
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (!validDay(y, mo, d)) return undefined
  const date = `${m[1]}-${m[2]}-${m[3]}`
  if (m[4] === undefined) return { date }
  const h = Number(m[4])
  const mi = Number(m[5])
  const s = Number(m[6] ?? 0)
  if (h > 23 || mi > 59 || s > 59) return undefined
  const micro = m[7] ? Number(m[7].padEnd(6, '0').slice(0, 6)) : 0
  let zone: string | undefined
  if (m[8]) {
    const z = m[8].toUpperCase()
    zone = z === 'Z' ? '+00:00' : z.length === 3 ? `${z}:00` : z.includes(':') ? z : `${z.slice(0, 3)}:${z.slice(3)}`
  }
  return { date, time: { h, mi, s, micro }, ...(zone ? { zone } : {}) }
}

const BOOL_TRUE = new Set(['1', 'on', 't', 'true', 'y', 'yes'])
const BOOL_FALSE = new Set(['0', 'off', 'f', 'false', 'n', 'no'])

function invalid(field: string, type: string, value: unknown): Error {
  return new Error(`1 validation error for model\n${field}\n  Input should be a valid ${type} [input_value=${JSON.stringify(value)}]`)
}

/** One value through a field type; null/undefined stay missing (the caller decides whether that is allowed). */
export function coerceValue(type: string, value: unknown, field = 'value'): unknown {
  if (value === null || value === undefined) return null
  switch (type) {
    case 'any':
      return value
    case 'str':
      if (typeof value === 'string') return value
      throw invalid(field, 'string', value)
    case 'float': {
      if (typeof value === 'number') return value
      if (typeof value === 'boolean') return value ? 1 : 0
      if (typeof value === 'string') {
        const n = pyFloat(value)
        if (n !== undefined) return n
      }
      throw invalid(field, 'number', value)
    }
    case 'int': {
      if (typeof value === 'boolean') return value ? 1 : 0
      if (typeof value === 'number') {
        if (Number.isInteger(value)) return value
        throw invalid(field, 'integer, got a number with a fractional part', value)
      }
      if (typeof value === 'string') {
        const s = value.trim()
        if (INT_RE.test(s)) return Number(s.replace(/_/g, ''))
        const f = FLOAT_RE.test(s) && !/[eE]/.test(s) ? Number(s.replace(/_/g, '')) : Number.NaN
        if (Number.isInteger(f)) return f
      }
      throw invalid(field, 'integer, unable to parse string as an integer', value)
    }
    case 'bool': {
      if (typeof value === 'boolean') return value
      if (typeof value === 'number' && (value === 0 || value === 1)) return value === 1
      if (typeof value === 'string') {
        const s = value.trim().toLowerCase()
        if (BOOL_TRUE.has(s)) return true
        if (BOOL_FALSE.has(s)) return false
      }
      throw invalid(field, 'boolean', value)
    }
    case 'yesno':
      if (value === 'Yes' || value === 'No') return value
      throw invalid(field, "'Yes' or 'No'", value)
    case 'date': {
      const p = typeof value === 'string' ? parseIso(value) : undefined
      if (p && (!p.time || (p.time.h === 0 && p.time.mi === 0 && p.time.s === 0 && p.time.micro === 0))) return p.date
      throw invalid(field, 'date', value)
    }
    case 'datetime': {
      const p = typeof value === 'string' ? parseIso(value) : undefined
      if (!p) throw invalid(field, 'datetime', value)
      const t = p.time ?? { h: 0, mi: 0, s: 0, micro: 0 }
      const two = (n: number) => String(n).padStart(2, '0')
      const micro = t.micro ? `.${String(t.micro).padStart(6, '0')}` : ''
      return `${p.date}T${two(t.h)}:${two(t.mi)}:${two(t.s)}${micro}${p.zone ?? ''}`
    }
    default:
      throw new Error(`unknown field type ${type}`)
  }
}

/** pydantic's `alias_generators.to_camel`. */
export function toCamel(snake: string): string {
  if (/^[a-z]+[A-Za-z0-9]*$/.test(snake) && !/\d[a-z]/.test(snake)) return snake
  // str.title(): a letter is upper case when the previous character is not a letter.
  const title = snake.replace(/[A-Za-z]+/g, (word) => word[0]!.toUpperCase() + word.slice(1).toLowerCase())
  const pascal = title.replace(/([0-9A-Za-z])_(?=[0-9A-Z])/g, '$1')
  return pascal[0]!.toLowerCase() + pascal.slice(1)
}

/**
 * `Data.model_validate` for a Data model with `extra="allow"`: keys named by `__alias_dict__` (field → source key) or by
 * the camel-case form of a field are renamed, known fields are coerced, unknown keys pass through unchanged, and
 * values that are None are dropped from the row.
 */
export function validateModel(table: FieldTable, aliasDict: Record<string, string>, raw: Row, model = 'model'): Row {
  const sourceToField = new Map<string, string>()
  for (const [field, source] of Object.entries(aliasDict)) sourceToField.set(source, field)
  const types = new Map<string, { type: string; required: boolean }>()
  for (const [field, spec] of Object.entries(table)) {
    types.set(field, { type: spec.replace(/!$/, ''), required: spec.endsWith('!') })
    if (!sourceToField.has(toCamel(field))) sourceToField.set(toCamel(field), field)
  }
  const renamed: Row = {}
  for (const [k, v] of Object.entries(raw)) renamed[types.has(k) ? k : (sourceToField.get(k) ?? k)] = v
  const out: Row = {}
  for (const [k, v] of Object.entries(renamed)) {
    const t = types.get(k)
    const value = t ? coerceValue(t.type, v, k) : v
    if (value !== null && value !== undefined) out[k] = value
  }
  for (const [field, t] of types) if (t.required && out[field] === undefined) throw new Error(`1 validation error for ${model}\n${field}\n  Field required`)
  return out
}
