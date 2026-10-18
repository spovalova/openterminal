import { z } from 'zod'
import { ColumnTypeSchema, type Column } from './frame.js'

/**
 * The descriptor (PLAN.md section 17): one entry per route of a connector. Replaces the kind as the unit of data.
 * OpenBB's are generated from its OpenAPI document (`descriptorsFromOpenApi`); yahoo and finnhub ship a file in
 * the same format; v1 connectors get theirs derived from the kind catalog (`descriptorFromKind`).
 */

export const PARAM_TYPES = ['string', 'number', 'integer', 'boolean', 'date', 'string[]'] as const
export const ParamTypeSchema = z.enum(PARAM_TYPES)
export type ParamType = z.infer<typeof ParamTypeSchema>

export const DescriptorParamSchema = z.object({
  name: z.string().min(1),
  type: ParamTypeSchema,
  enum: z.array(z.string()).min(1).optional(),
  default: z.unknown().optional(),
  required: z.boolean(),
  description: z.string().optional(),
  /** Providers that accept this param; absent means all of the route's providers (or the connector has none). */
  providers: z.array(z.string()).optional(),
})
export type DescriptorParam = z.infer<typeof DescriptorParamSchema>

export const DescriptorFieldSchema = z.object({
  name: z.string().min(1),
  type: ColumnTypeSchema,
  description: z.string().optional(),
})
export type DescriptorField = z.infer<typeof DescriptorFieldSchema>

export const LivenessSchema = z.object({
  checkedAt: z.number(),
  ok: z.boolean(),
  rows: z.number().int().nonnegative().optional(),
  ms: z.number().nonnegative().optional(),
  error: z.string().optional(),
  sampleColumns: z.array(z.string()).optional(),
})
export type Liveness = z.infer<typeof LivenessSchema>

export const DescriptorSchema = z.object({
  connector: z.string().regex(/^[a-z][a-z0-9-]*$/),
  /** 'equity/price/historical', 'fixedincome/corporate/bond_prices', 'quote'. No leading slash, no API prefix. */
  route: z.string().min(1).regex(/^[^\s/][^\s]*$/, 'route has no leading slash and no spaces'),
  summary: z.string(),
  description: z.string().optional(),
  params: z.array(DescriptorParamSchema),
  /** [] for connectors without the concept. */
  providers: z.array(z.string()),
  fields: z.array(DescriptorFieldSchema),
  liveness: LivenessSchema.optional(),
})
export type Descriptor = z.infer<typeof DescriptorSchema>

export const DescriptorRefSchema = z.object({ connector: z.string(), route: z.string() })
export type DescriptorRef = z.infer<typeof DescriptorRefSchema>

/** `connector:route`, the catalog's primary key. */
export function descriptorKey(ref: DescriptorRef): string {
  return `${ref.connector}:${ref.route}`
}

/** The first path segment: 'equity', 'fixedincome', 'yfinance'. */
export function routeNamespace(route: string): string {
  return route.split('/')[0] ?? route
}

export function parseDescriptors(input: unknown): Descriptor[] {
  return z.array(DescriptorSchema).parse(input)
}

/** The frame columns a route promises: its fields, in order. */
export function fieldsToColumns(descriptor: Pick<Descriptor, 'fields'>): Column[] {
  return descriptor.fields.map((f) => ({ name: f.name, type: f.type }))
}

export class ParamError extends Error {
  constructor(
    public readonly ref: DescriptorRef,
    public readonly issues: string[],
  ) {
    super(`${descriptorKey(ref)}: ${issues.join('; ')}`)
    this.name = 'ParamError'
  }
}

export type ValidatedParams = Record<string, string | number | boolean | string[]>
export type ValidateResult = { ok: true; params: ValidatedParams } | { ok: false; issues: string[] }

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Validate and coerce params against a descriptor: types are coerced from strings (query strings, the agent),
 * enums checked, defaults applied, required params demanded, unknown params refused. `provider` is accepted
 * when the route lists providers and must be one of them. Params left at `undefined` or `null` are dropped
 * (the connector treats them as absent).
 */
export function validateParams(descriptor: Descriptor, params: Record<string, unknown> | undefined): ValidateResult {
  const issues: string[] = []
  const out: ValidatedParams = {}
  const input = params ?? {}
  const known = new Set(descriptor.params.map((p) => p.name))
  for (const name of Object.keys(input)) {
    if (name === 'provider') continue
    if (!known.has(name)) issues.push(`unknown param "${name}" (known: ${[...known].join(', ') || 'none'})`)
  }
  if (input.provider !== undefined && input.provider !== null) {
    const p = String(input.provider)
    if (descriptor.providers.length === 0) issues.push(`"${descriptor.route}" has no providers`)
    else if (!descriptor.providers.includes(p)) issues.push(`provider "${p}" is not one of ${descriptor.providers.join(', ')}`)
    else out.provider = p
  }
  for (const p of descriptor.params) {
    let v = input[p.name]
    if (v === undefined || v === null || v === '') v = p.default
    if (v === undefined || v === null) {
      if (p.required) issues.push(`"${p.name}" is required`)
      continue
    }
    const coerced = coerce(v, p)
    if (coerced.error) {
      issues.push(`"${p.name}": ${coerced.error}`)
      continue
    }
    if (p.enum) {
      const bad = (Array.isArray(coerced.value) ? coerced.value : [String(coerced.value)]).filter((x) => !p.enum!.includes(String(x)))
      if (bad.length > 0) {
        issues.push(`"${p.name}": ${bad.map((b) => JSON.stringify(b)).join(', ')} not in ${p.enum.join(', ')}`)
        continue
      }
    }
    out[p.name] = coerced.value!
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, params: out }
}

/** `validateParams` that throws a ParamError. */
export function parseParams(descriptor: Descriptor, params: Record<string, unknown> | undefined): ValidatedParams {
  const r = validateParams(descriptor, params)
  if (!r.ok) throw new ParamError(descriptor, r.issues)
  return r.params
}

function coerce(v: unknown, p: DescriptorParam): { value?: string | number | boolean | string[]; error?: string } {
  switch (p.type) {
    case 'string': {
      if (typeof v === 'string') return { value: v }
      if (typeof v === 'number' || typeof v === 'boolean') return { value: String(v) }
      if (Array.isArray(v)) return { value: v.map(String).join(',') }
      return { error: `expected a string, got ${typeOf(v)}` }
    }
    case 'string[]': {
      if (Array.isArray(v)) {
        if (!v.every((x) => typeof x === 'string' || typeof x === 'number')) return { error: 'expected strings' }
        const items = v.map(String).map((s) => s.trim()).filter(Boolean)
        return items.length > 0 ? { value: items } : { error: 'expected at least one item' }
      }
      if (typeof v === 'string') {
        const items = v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
        return items.length > 0 ? { value: items } : { error: 'expected at least one item' }
      }
      if (typeof v === 'number') return { value: [String(v)] }
      return { error: `expected a list of strings, got ${typeOf(v)}` }
    }
    case 'number':
    case 'integer': {
      const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
      if (!Number.isFinite(n)) return { error: `expected a number, got ${JSON.stringify(v)}` }
      if (p.type === 'integer' && !Number.isInteger(n)) return { error: `expected an integer, got ${n}` }
      return { value: n }
    }
    case 'boolean': {
      if (typeof v === 'boolean') return { value: v }
      if (v === 'true' || v === 1 || v === '1') return { value: true }
      if (v === 'false' || v === 0 || v === '0') return { value: false }
      return { error: `expected true or false, got ${JSON.stringify(v)}` }
    }
    case 'date': {
      if (v instanceof Date && !Number.isNaN(v.getTime())) return { value: v.toISOString().slice(0, 10) }
      if (typeof v === 'number' && Number.isFinite(v)) return { value: new Date(v).toISOString().slice(0, 10) }
      if (typeof v === 'string') {
        const s = v.trim()
        if (ISO_DATE.test(s)) return { value: s }
        if (/^\d{4}-\d{2}-\d{2}[T ]/.test(s) && Number.isFinite(Date.parse(s))) return { value: s.slice(0, 10) }
      }
      return { error: `expected a date as YYYY-MM-DD, got ${JSON.stringify(v)}` }
    }
  }
}

function typeOf(v: unknown): string {
  return Array.isArray(v) ? 'an array' : v === null ? 'null' : `a ${typeof v}`
}

/** A compact one-line rendering for prompts and the Data page: route, required params, first fields. */
export function describeDescriptor(d: Descriptor, opts: { fields?: number } = {}): string {
  const req = d.params.filter((p) => p.required).map((p) => p.name)
  const opt = d.params.filter((p) => !p.required).map((p) => p.name)
  const fields = d.fields.slice(0, opts.fields ?? 8).map((f) => f.name)
  const parts = [`${d.connector} ${d.route}`, d.summary]
  if (req.length) parts.push(`required: ${req.join(', ')}`)
  if (opt.length) parts.push(`optional: ${opt.slice(0, 6).join(', ')}${opt.length > 6 ? ', …' : ''}`)
  if (fields.length) parts.push(`fields: ${fields.join(', ')}${d.fields.length > fields.length ? ', …' : ''}`)
  return parts.join(' · ')
}
