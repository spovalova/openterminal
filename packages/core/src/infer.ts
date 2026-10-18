import { nyWallToUtc } from './clock.js'
import type { Descriptor } from './descriptor.js'
import type { Column, ColumnType, Frame, FrameMeta } from './frame.js'

/**
 * Column inference (PLAN.md section 17): descriptor fields first; fields the response has that the descriptor
 * lacks are added with the type of the first non-null value, `time` when every value parses as a date. Nested
 * objects are flattened one level with dotted names; arrays of scalars are joined. This is how a v2 connector's
 * `call` turns provider rows into a Frame without a kind.
 */

export type Row = Record<string, unknown>

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const ISO_DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?(Z|[+-]\d{2}:?\d{2})?$/

/**
 * Provider date strings → epoch ms. Date-only values are New York midnight; zone-less datetimes are New York wall
 * time (exchange time); anything with a zone is parsed as such. Dates and finite numbers pass through.
 */
export function parseTime(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime()
  if (typeof value !== 'string') return null
  const s = value.trim()
  const d = ISO_DATE_RE.exec(s)
  if (d) return nyWallToUtc(Number(d[1]), Number(d[2]), Number(d[3]))
  const dt = ISO_DATETIME_RE.exec(s)
  if (dt) {
    if (dt[7]) {
      const t = Date.parse(s)
      return Number.isFinite(t) ? t : null
    }
    return nyWallToUtc(Number(dt[1]), Number(dt[2]), Number(dt[3]), Number(dt[4]), Number(dt[5])) + Math.round(Number(dt[6] ?? 0) * 1000)
  }
  return null
}

export function looksLikeDate(value: unknown): boolean {
  return value instanceof Date || (typeof value === 'string' && (ISO_DATE_RE.test(value.trim()) || ISO_DATETIME_RE.test(value.trim())))
}

/** One level of nesting flattened to dotted names; arrays of scalars joined with ", "; arrays of objects kept as JSON text. */
export function flattenRow(row: Row): Row {
  const out: Row = {}
  for (const [k, v] of Object.entries(row)) {
    if (v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v)) {
      for (const [k2, v2] of Object.entries(v as Row)) out[`${k}.${k2}`] = scalar(v2)
    } else out[k] = scalar(v)
  }
  return out
}

function scalar(v: unknown): unknown {
  if (Array.isArray(v)) {
    if (v.every((x) => x === null || typeof x !== 'object')) return v.map((x) => (x === null || x === undefined ? '' : String(x))).join(', ')
    return JSON.stringify(v).slice(0, 2000)
  }
  if (v && typeof v === 'object' && !(v instanceof Date)) return JSON.stringify(v).slice(0, 2000)
  return v
}

/** The type of a value for inference. */
function typeOfValue(v: unknown): ColumnType | undefined {
  if (v === null || v === undefined) return undefined
  if (typeof v === 'number') return 'number'
  if (typeof v === 'boolean') return 'boolean'
  if (v instanceof Date) return 'time'
  return 'string'
}

export type InferOptions = {
  descriptor?: Pick<Descriptor, 'fields'>
  /** Only descriptor fields plus these, in this order, when given (a connector that wants a fixed shape). */
  only?: readonly string[]
  /** Drop columns whose every value is null. Off by default so descriptor columns always appear. */
  dropEmpty?: boolean
}

/** Columns for a row list: descriptor fields present in the rows (descriptor order), then extra keys in first-seen order. */
export function inferColumns(rows: readonly Row[], opts: InferOptions = {}): Column[] {
  const keys: string[] = []
  const seen = new Set<string>()
  const add = (k: string) => {
    if (!seen.has(k)) {
      seen.add(k)
      keys.push(k)
    }
  }
  const present = new Set<string>()
  for (const r of rows) for (const k of Object.keys(r)) present.add(k)
  const descriptorTypes = new Map<string, ColumnType>()
  for (const f of opts.descriptor?.fields ?? []) {
    descriptorTypes.set(f.name, f.type)
    if (present.has(f.name) || !opts.dropEmpty) add(f.name)
  }
  if (opts.only) {
    for (const k of opts.only) if (present.has(k)) add(k)
  } else {
    for (const k of present) add(k)
  }

  return keys
    .map((name): Column | undefined => {
      const fromDescriptor = descriptorTypes.get(name)
      let type: ColumnType | undefined = fromDescriptor
      let allDates = true
      let any = false
      for (const r of rows) {
        const v = r[name]
        if (v === null || v === undefined || v === '') continue
        any = true
        if (!fromDescriptor && !type) type = typeOfValue(v)
        if (!looksLikeDate(v)) allDates = false
        if (!allDates && type) break
      }
      if (!any && opts.dropEmpty) return undefined
      if (!fromDescriptor && any && allDates) type = 'time'
      if (!type) type = 'string'
      return { name, type }
    })
    .filter((c): c is Column => !!c)
}

/** A cell coerced to its column type; anything that does not fit becomes null. */
export function coerceCell(v: unknown, type: ColumnType): unknown {
  if (v === null || v === undefined) return null
  switch (type) {
    case 'number': {
      if (typeof v === 'number') return Number.isFinite(v) ? v : null
      if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v)
      if (typeof v === 'boolean') return v ? 1 : 0
      return null
    }
    case 'time':
      return parseTime(v)
    case 'boolean': {
      if (typeof v === 'boolean') return v
      if (v === 'true' || v === 1) return true
      if (v === 'false' || v === 0) return false
      return null
    }
    case 'string': {
      if (typeof v === 'string') return v
      if (v instanceof Date) return v.toISOString()
      if (typeof v === 'object') return JSON.stringify(v)
      return String(v)
    }
  }
}

/** Rows (objects, possibly nested) → a Frame with inferred columns and coerced cells. */
export function inferFrame(rows: readonly Row[], meta: Partial<FrameMeta> & { connector: string }, opts: InferOptions = {}): Frame {
  const flat = rows.map(flattenRow)
  const columns = inferColumns(flat, opts)
  return {
    columns,
    rows: flat.map((r) => columns.map((c) => coerceCell(r[c.name], c.type))),
    meta: { fetchedAt: Date.now(), ttl: 0, ...meta },
  }
}
