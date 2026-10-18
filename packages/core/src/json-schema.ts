import { z } from 'zod'
import type { DescriptorParam, ParamType } from './descriptor.js'

/**
 * The JSON Schema subset recipes use for their params (and that the agent tools pass through as-is): an object
 * of string, number, integer, boolean and string-array properties with enum, default, bounds, format `date`,
 * and a `required` list. Converted to Zod for validation and to descriptor params for the catalog and the prompt.
 */

export type JsonSchemaProperty = {
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'array'
  description?: string
  enum?: (string | number)[]
  default?: unknown
  format?: string
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  minItems?: number
  maxItems?: number
  items?: { type?: 'string' | 'number'; enum?: (string | number)[] }
}

export type JsonSchemaObject = {
  type?: 'object'
  properties?: Record<string, JsonSchemaProperty>
  required?: string[]
  description?: string
  additionalProperties?: boolean
}

export const JsonSchemaPropertySchema: z.ZodType<JsonSchemaProperty> = z.object({
  type: z.enum(['string', 'number', 'integer', 'boolean', 'array']).optional(),
  description: z.string().optional(),
  enum: z.array(z.union([z.string(), z.number()])).min(1).optional(),
  default: z.unknown().optional(),
  format: z.string().optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  minLength: z.number().int().optional(),
  maxLength: z.number().int().optional(),
  minItems: z.number().int().optional(),
  maxItems: z.number().int().optional(),
  items: z.object({ type: z.enum(['string', 'number']).optional(), enum: z.array(z.union([z.string(), z.number()])).min(1).optional() }).optional(),
})

export const JsonSchemaObjectSchema: z.ZodType<JsonSchemaObject> = z.object({
  type: z.literal('object').optional(),
  properties: z.record(z.string(), JsonSchemaPropertySchema).optional(),
  required: z.array(z.string()).optional(),
  description: z.string().optional(),
  additionalProperties: z.boolean().optional(),
})

/** A Zod object schema for a JSON-schema object: required keys demanded, defaults applied, unknown keys stripped. */
export function jsonSchemaToZod(schema: JsonSchemaObject): z.ZodObject<Record<string, z.ZodType>> {
  const shape: Record<string, z.ZodType> = {}
  const required = new Set(schema.required ?? [])
  for (const [name, prop] of Object.entries(schema.properties ?? {})) {
    let s = propertyToZod(prop)
    if (prop.description) s = s.describe(prop.description)
    if (prop.default !== undefined) s = s.default(prop.default as never)
    else if (!required.has(name)) s = s.optional()
    shape[name] = s
  }
  return z.object(shape)
}

function propertyToZod(prop: JsonSchemaProperty): z.ZodType {
  const type = prop.type ?? (prop.items ? 'array' : prop.enum ? (typeof prop.enum[0] === 'number' ? 'number' : 'string') : 'string')
  switch (type) {
    case 'string': {
      if (prop.enum) return z.enum(prop.enum.map(String) as [string, ...string[]])
      if (prop.format === 'date') return z.iso.date()
      let s = z.string().trim()
      if (prop.minLength !== undefined) s = s.min(prop.minLength)
      if (prop.maxLength !== undefined) s = s.max(prop.maxLength)
      return s
    }
    case 'number':
    case 'integer': {
      let n = z.coerce.number()
      if (type === 'integer') n = n.int()
      if (prop.minimum !== undefined) n = n.min(prop.minimum)
      if (prop.maximum !== undefined) n = n.max(prop.maximum)
      return n
    }
    case 'boolean':
      return z.boolean()
    case 'array': {
      const item = prop.items?.enum ? z.enum(prop.items.enum.map(String) as [string, ...string[]]) : prop.items?.type === 'number' ? z.coerce.number() : z.string().trim().min(1)
      let a = z.array(item)
      if (prop.minItems !== undefined) a = a.min(prop.minItems)
      if (prop.maxItems !== undefined) a = a.max(prop.maxItems)
      // A comma-separated string is accepted for string arrays (query strings, the agent).
      return z.preprocess((v) => (typeof v === 'string' && prop.items?.type !== 'number' ? v.split(',').map((x) => x.trim()).filter(Boolean) : v), a)
    }
  }
}

/** Descriptor params for a JSON-schema object (the recipe's param list for the prompt and the editor). */
export function jsonSchemaToParams(schema: JsonSchemaObject): DescriptorParam[] {
  const required = new Set(schema.required ?? [])
  return Object.entries(schema.properties ?? {}).map(([name, prop]) => {
    const p: DescriptorParam = { name, type: paramTypeOf(prop), required: required.has(name) && prop.default === undefined }
    const en = prop.enum ?? prop.items?.enum
    if (en) p.enum = en.map(String)
    if (prop.default !== undefined) p.default = prop.default
    if (prop.description) p.description = prop.description
    return p
  })
}

function paramTypeOf(prop: JsonSchemaProperty): ParamType {
  const type = prop.type ?? (prop.items ? 'array' : 'string')
  if (type === 'array') return 'string[]'
  if (type === 'string') return prop.format === 'date' ? 'date' : 'string'
  return type
}

/**
 * A JSON-schema object from a Zod object schema (what `z.toJSONSchema` gives, reduced to the subset above). Used to
 * derive descriptors from the v1 kind catalog. Refinements are dropped; `anyOf` of a type and null collapses to the type.
 */
export function zodToJsonSchemaObject(schema: z.ZodType): JsonSchemaObject {
  const raw = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>
  const props = (raw.properties ?? {}) as Record<string, Record<string, unknown>>
  const out: JsonSchemaObject = { type: 'object', properties: {}, required: Array.isArray(raw.required) ? (raw.required as string[]) : [] }
  for (const [name, p] of Object.entries(props)) out.properties![name] = reduceProperty(p)
  if (typeof raw.description === 'string') out.description = raw.description
  return out
}

function reduceProperty(p: Record<string, unknown>): JsonSchemaProperty {
  let s = p
  const alts = (s.anyOf ?? s.oneOf) as Record<string, unknown>[] | undefined
  if (Array.isArray(alts)) s = { ...s, ...(alts.find((a) => a.type !== 'null') ?? {}) }
  const out: JsonSchemaProperty = {}
  const type = Array.isArray(s.type) ? (s.type as string[]).find((t) => t !== 'null') : s.type
  if (type === 'string' || type === 'number' || type === 'integer' || type === 'boolean' || type === 'array') out.type = type
  if (typeof s.description === 'string') out.description = s.description
  if (Array.isArray(s.enum)) out.enum = s.enum as (string | number)[]
  if (s.default !== undefined) out.default = s.default
  if (typeof s.format === 'string') out.format = s.format
  for (const k of ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems'] as const) if (typeof s[k] === 'number') out[k] = s[k] as number
  if (s.items && typeof s.items === 'object') {
    const it = s.items as Record<string, unknown>
    out.items = {}
    if (it.type === 'string' || it.type === 'number') out.items.type = it.type
    if (Array.isArray(it.enum)) out.items.enum = it.enum as (string | number)[]
  }
  return out
}
