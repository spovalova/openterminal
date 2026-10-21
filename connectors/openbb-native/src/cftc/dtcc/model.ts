// A small stand-in for the pydantic `Data` models of openbb_cftc: rename source columns to field names, coerce each
// field the way pydantic's lax mode does, keep or drop extra keys, and emit the JSON the API would put in `results`.
import { daysInMonth } from './dates.js'
import { pyFloat } from './curve.js'

export type Kind = 'str' | 'float' | 'int' | 'bool' | 'date' | 'datetime'
export type Schema = {
  extra: 'allow' | 'ignore'
  /** Field name, value type, whether the field is required. */
  fields: [string, Kind, boolean][]
  /** Field name to the source column it is read from. */
  aliases: Record<string, string>
}

type Rec = Record<string, any>

export class ValidationError extends Error {
  constructor(field: string, type: string, input: unknown) {
    super(`1 validation error for model\n${field}\n  ${type} [input_value=${JSON.stringify(input)}]`)
    this.name = 'ValidationError'
  }
}

const TRUE = new Set(['1', 'on', 't', 'true', 'y', 'yes'])
const FALSE = new Set(['0', 'off', 'f', 'false', 'n', 'no'])

const pad = (n: number, w = 2): string => String(n).padStart(w, '0')

type Parsed = { y: number; mo: number; d: number; h: number; mi: number; s: number; micro: number; hasTime: boolean; tz: number | null }

const DT = /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?)?\s*(Z|z|[+-]\d{2}(?::?\d{2})?)?$/

function parseDateTime(text: string): Parsed | null {
  const m = DT.exec(text.trim())
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  if (y < 1 || mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null
  const hasTime = m[4] !== undefined
  const h = hasTime ? Number(m[4]) : 0
  const mi = hasTime ? Number(m[5]) : 0
  const s = m[6] !== undefined ? Number(m[6]) : 0
  if (h > 23 || mi > 59 || s > 59) return null
  const micro = m[7] !== undefined ? Number(m[7].slice(0, 6).padEnd(6, '0')) : 0
  let tz: number | null = null
  if (m[8] !== undefined) {
    if (m[8] === 'Z' || m[8] === 'z') tz = 0
    else {
      const sign = m[8][0] === '-' ? -1 : 1
      const digits = m[8].slice(1).replace(':', '')
      tz = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2) || '0'))
    }
  }
  return { y, mo, d, h, mi, s, micro, hasTime, tz }
}

/** `date` from a date or midnight datetime string, as pydantic parses it. */
export function toDateString(v: unknown, field = ''): string {
  if (typeof v === 'string') {
    const p = parseDateTime(v)
    if (p && !(p.hasTime && (p.h || p.mi || p.s || p.micro))) return `${pad(p.y, 4)}-${pad(p.mo)}-${pad(p.d)}`
  }
  throw new ValidationError(field, 'date_from_datetime_parsing', v)
}

/** `datetime` from an ISO string, serialized as pydantic does (`Z` for UTC, microseconds only when non-zero). */
export function toDatetimeString(v: unknown, field = ''): string {
  if (typeof v === 'string') {
    const p = parseDateTime(v)
    if (p) {
      let out = `${pad(p.y, 4)}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}`
      if (p.micro) out += `.${pad(p.micro, 6)}`
      if (p.tz !== null) out += p.tz === 0 ? 'Z' : `${p.tz < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(p.tz) / 60))}:${pad(Math.abs(p.tz) % 60)}`
      return out
    }
  }
  throw new ValidationError(field, 'datetime_from_date_parsing', v)
}

function coerce(kind: Kind, v: unknown, field: string): unknown {
  switch (kind) {
    case 'str':
      if (typeof v === 'string') return v
      throw new ValidationError(field, 'string_type', v)
    case 'float': {
      if (typeof v === 'number') return v
      if (typeof v === 'string') {
        const n = pyFloat(v)
        if (n !== null) return n
      }
      throw new ValidationError(field, 'float_parsing', v)
    }
    case 'int': {
      if (typeof v === 'number' && Number.isInteger(v)) return v
      if (typeof v === 'string') {
        const t = v.trim().replace(/(\d)_(?=\d)/g, '$1')
        if (/^[+-]?\d+$/.test(t)) return Number(t)
        if (/^[+-]?\d+\.0*$/.test(t)) return Number(t.split('.')[0])
      }
      throw new ValidationError(field, 'int_parsing', v)
    }
    case 'bool': {
      if (typeof v === 'boolean') return v
      if (typeof v === 'number' && (v === 0 || v === 1)) return v === 1
      if (typeof v === 'string') {
        const t = v.trim().toLowerCase()
        if (TRUE.has(t)) return true
        if (FALSE.has(t)) return false
      }
      throw new ValidationError(field, 'bool_parsing', v)
    }
    case 'date':
      return toDateString(v, field)
    case 'datetime':
      return toDatetimeString(v, field)
  }
}

/** Validate one source mapping against a schema; the row the API would return (None fields left out). */
export function validateRow(schema: Schema, values: Rec): Rec {
  const bySource = new Map<string, string>(Object.entries(schema.aliases).map(([field, source]) => [source, field]))
  const renamed: Rec = {}
  for (const [k, v] of Object.entries(values)) renamed[bySource.get(k) ?? k] = v
  const out: Rec = {}
  const known = new Set<string>()
  for (const [name, kind, required] of schema.fields) {
    known.add(name)
    const v = renamed[name]
    if (v === undefined || v === null) {
      if (required) throw new ValidationError(name, 'missing', undefined)
      continue
    }
    out[name] = coerce(kind, v, name)
  }
  if (schema.extra === 'allow') {
    for (const [k, v] of Object.entries(renamed)) if (!known.has(k) && v !== undefined && v !== null) out[k] = v
  }
  return out
}

/** The strings and numbers of a normalized source mapping, with empty strings dropped (the models' `_normalize_values`). */
export function normalizeValues(values: Rec, o: { aliasToField: Record<string, string>; numeric: ReadonlySet<string>; bool?: ReadonlySet<string>; notProvided?: ReadonlySet<string> }): { normalized: Rec; capped: boolean } {
  const normalized: Rec = {}
  let capped = false
  for (const [key, value] of Object.entries(values)) {
    if (typeof value !== 'string') {
      if (value !== null && value !== undefined) normalized[key] = value
      continue
    }
    let text = value.trim()
    if (!text) continue
    const field = o.aliasToField[key] ?? key
    if (o.numeric.has(field)) {
      if (text.endsWith('+')) {
        text = text.slice(0, -1)
        capped = true
      }
      text = text.replace(/,/g, '')
      if (!text || o.notProvided?.has(text)) continue
    } else if (o.bool?.has(field)) {
      normalized[key] = text.trim().toUpperCase() === 'TRUE'
      continue
    }
    normalized[key] = text
  }
  return { normalized, capped }
}
