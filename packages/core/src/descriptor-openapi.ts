import type { ColumnType } from './frame.js'
import type { Descriptor, DescriptorField, DescriptorParam, ParamType } from './descriptor.js'

/**
 * Descriptors from an OpenAPI 3 document (PLAN.md section 17). Written for OpenBB's `/openapi.json` and kept
 * generic enough that any REST API with a schema and a results envelope becomes a connector by config:
 * one entry per GET route, the `provider` query param lifted into `providers`, every other param collapsed to
 * one entry (OpenBB already merges per-provider variants into one parameter with an `anyOf` and provider-keyed
 * extras), the 200 response's `results` model resolved to fields, `date` and `date-time` fields typed `time`.
 * Pure: no network, no file system.
 */

export type JsonSchema = Record<string, unknown>
export type OpenApiOperation = {
  summary?: string
  description?: string
  deprecated?: boolean
  parameters?: Array<{ name: string; in?: string; required?: boolean; description?: string; schema?: JsonSchema }>
  responses?: Record<string, { content?: Record<string, { schema?: JsonSchema }> }>
}
export type OpenApiDoc = {
  openapi?: string
  info?: { title?: string; version?: string }
  paths?: Record<string, Record<string, OpenApiOperation>>
  components?: { schemas?: Record<string, JsonSchema> }
}

export type FromOpenApiOptions = {
  /** Path prefix stripped from every route; '/api/v1' for OpenBB. */
  prefix?: string
  /** Query params dropped from every descriptor (OpenBB's `chart` toggles its own charting). */
  skipParams?: readonly string[]
  /** Property that holds the row list in the response envelope. */
  resultsKey?: string
  /** Keep routes whose response is not a results envelope (coverage endpoints); off by default. */
  includeNonEnvelope?: boolean
}

const DEFAULTS: Required<FromOpenApiOptions> = { prefix: '/api/v1', skipParams: ['chart'], resultsKey: 'results', includeNonEnvelope: false }

export function descriptorsFromOpenApi(doc: unknown, connector: string, options: FromOpenApiOptions = {}): Descriptor[] {
  const opts = { ...DEFAULTS, ...options }
  const d = (doc ?? {}) as OpenApiDoc
  const schemas = d.components?.schemas ?? {}
  const resolve = (s: JsonSchema | undefined): JsonSchema | undefined => {
    let cur = s
    for (let i = 0; cur && typeof cur.$ref === 'string' && i < 10; i++) {
      const name = cur.$ref.split('/').pop() ?? ''
      cur = schemas[name]
    }
    return cur
  }
  const out: Descriptor[] = []
  for (const [path, methods] of Object.entries(d.paths ?? {})) {
    const op = methods.get
    if (!op || op.deprecated) continue
    const route = stripPrefix(path, opts.prefix)
    if (!route) continue
    const models = responseModels(op, resolve, opts.resultsKey)
    if (!models && !opts.includeNonEnvelope) continue

    const providerParam = (op.parameters ?? []).find((p) => p.name === 'provider' && (p.in ?? 'query') === 'query')
    const providers = providerParam ? providerNames(providerParam.schema) : []
    const params: DescriptorParam[] = []
    for (const p of op.parameters ?? []) {
      if ((p.in ?? 'query') !== 'query' || p.name === 'provider' || opts.skipParams.includes(p.name)) continue
      params.push(collapseParam(p, providers))
    }
    const fields = models ? mergeFields(models, resolve) : []
    const summary = (op.summary ?? route.split('/').pop() ?? route).trim()
    const description = op.description?.trim()
    const desc: Descriptor = { connector, route, summary, params, providers, fields }
    if (description && description !== summary) desc.description = description
    out.push(desc)
  }
  return out.sort((a, b) => a.route.localeCompare(b.route))
}

function stripPrefix(path: string, prefix: string): string {
  const p = prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path
  return p.replace(/^\/+/, '').replace(/\/+$/, '')
}

function providerNames(schema: JsonSchema | undefined): string[] {
  if (!schema) return []
  if (Array.isArray(schema.enum)) return schema.enum.map(String)
  if (typeof schema.const === 'string') return [schema.const]
  if (typeof schema.default === 'string') return [schema.default]
  return []
}

/** The non-null branches of a schema: itself, or its anyOf/oneOf members, flattened one level. */
function branches(schema: JsonSchema | undefined): JsonSchema[] {
  if (!schema) return []
  const alts = (schema.anyOf ?? schema.oneOf) as JsonSchema[] | undefined
  if (Array.isArray(alts)) return alts.flatMap((a) => branches(a)).filter((b) => b.type !== 'null')
  return schema.type === 'null' ? [] : [schema]
}

const PROVIDER_IN_DESC = /\(provider(?:s)?:\s*([a-z0-9_,\s-]+)\)/gi

/**
 * Providers that take a param, from how OpenBB writes its descriptions. A provider-specific param's description
 * is one segment per provider, each ending in `(provider: x)`, joined with `;` and spaces, and its title is the
 * provider list (`cboe,tmx,yfinance`). A standard param has a plain sentence with no marker (its title is the
 * field name) and may still carry a `Multiple comma separated items allowed for provider(s): …` note, which says
 * who takes a list, not who takes the param, and provider-keyed extras in the schema (`choices`, widget config),
 * which say the same. So: every segment marked → the union of the markers; any segment unmarked → everyone.
 */
function paramProviders(description: string | undefined, title: unknown, routeProviders: string[]): string[] | undefined {
  if (routeProviders.length === 0) return undefined
  const named = new Set<string>()
  const add = (list: string) => list.split(',').forEach((x) => routeProviders.includes(x.trim()) && named.add(x.trim()))
  const text = description ?? ''
  // A trimmed document (the test fixture) cuts descriptions short with "..."; the title then decides.
  const truncated = /\.\.\.$/.test(text)
  const segments = text.split(/;\s{2,}/).map((s) => s.trim()).filter(Boolean)
  segments.forEach((seg, i) => {
    const marks = [...seg.matchAll(PROVIDER_IN_DESC)]
    if (marks.length === 0 && !(truncated && i === segments.length - 1)) {
      named.clear()
      named.add('*')
      return
    }
    for (const m of marks) add(m[1]!)
  })
  if (named.has('*')) return undefined
  if ((truncated || named.size === 0) && typeof title === 'string') {
    const parts = title.split(',').map((s) => s.trim())
    if (parts.length > 0 && parts.every((x) => routeProviders.includes(x))) parts.forEach((x) => named.add(x))
  }
  return named.size > 0 && named.size < routeProviders.length ? routeProviders.filter((x) => named.has(x)) : undefined
}

/** One param entry: type from the union of its per-provider variants, enum when every variant constrains it, providers from the description's markers. */
function collapseParam(p: NonNullable<OpenApiOperation['parameters']>[number], routeProviders: string[]): DescriptorParam {
  const schema = p.schema ?? {}
  const alts = branches(schema)
  const description = (p.description ?? (schema.description as string | undefined))?.trim()

  const providers = paramProviders(description, schema.title, routeProviders)
  const applicable = providers ?? routeProviders

  // Type: the widest scalar type across the variants.
  const types = new Set(alts.map((a) => String(a.type ?? (a.enum ? 'string' : a.const !== undefined ? typeof a.const : 'string'))))
  const multiple =
    alts.some((a) => a.type === 'array') ||
    /multiple comma separated items allowed/i.test(description ?? '') ||
    applicable.some((prov) => (schema[prov] as JsonSchema | undefined)?.multiple_items_allowed === true)
  let type: ParamType
  if (types.has('string') && alts.some((a) => a.format === 'date' || a.format === 'date-time')) type = 'date'
  else if (types.has('string') || types.has('array')) type = multiple ? 'string[]' : 'string'
  else if (types.has('number')) type = 'number'
  else if (types.has('integer')) type = 'integer'
  else if (types.has('boolean')) type = 'boolean'
  else type = 'string'

  // Enum: only when every variant is constrained (an unconstrained string or integer branch means free text).
  let enumValues: string[] | undefined
  const enumBranches = alts.filter((a) => Array.isArray(a.enum) || a.const !== undefined)
  const free = alts.filter((a) => !Array.isArray(a.enum) && a.const === undefined && a.type !== 'array')
  if (enumBranches.length > 0 && free.length === 0) {
    enumValues = uniq(enumBranches.flatMap((a) => (Array.isArray(a.enum) ? a.enum.map(String) : [String(a.const)])))
  } else if (applicable.length > 0 && type !== 'date') {
    const choiceLists = applicable.map((prov) => (schema[prov] as JsonSchema | undefined)?.choices)
    if (choiceLists.every((c) => Array.isArray(c) && c.length > 0)) enumValues = uniq(choiceLists.flatMap((c) => (c as unknown[]).map(String)))
  }

  const param: DescriptorParam = { name: p.name, type, required: p.required === true }
  if (enumValues && enumValues.length > 0) param.enum = enumValues
  const def = schema.default !== undefined ? schema.default : alts.find((a) => a.default !== undefined)?.default
  if (def !== undefined && def !== null) param.default = def
  if (description) param.description = description
  if (providers) param.providers = providers
  return param
}

/** The data models behind the 200 response's results list, or undefined when the response is not a results envelope. */
function responseModels(op: OpenApiOperation, resolve: (s: JsonSchema | undefined) => JsonSchema | undefined, resultsKey: string): JsonSchema[] | undefined {
  const content = op.responses?.['200']?.content
  const schema = content?.['application/json']?.schema ?? Object.values(content ?? {})[0]?.schema
  const envelope = resolve(schema)
  const props = envelope?.properties as Record<string, JsonSchema> | undefined
  const results = props?.[resultsKey]
  if (!results) return undefined
  const out: JsonSchema[] = []
  const visit = (s: JsonSchema | undefined, depth: number): void => {
    if (!s || depth > 6) return
    const r = resolve(s)
    if (!r) return
    if (r.type === 'array' || r.items) {
      visit(r.items as JsonSchema | undefined, depth + 1)
      return
    }
    const alts = (r.anyOf ?? r.oneOf) as JsonSchema[] | undefined
    if (Array.isArray(alts)) {
      alts.forEach((a) => visit(a, depth + 1))
      return
    }
    if (r.type === 'null') return
    if (r.properties || Array.isArray(r.allOf)) out.push(r)
  }
  visit(results, 0)
  return out
}

/** Fields across the provider models, by name in first-seen order; the first model's type wins. */
function mergeFields(models: JsonSchema[], resolve: (s: JsonSchema | undefined) => JsonSchema | undefined): DescriptorField[] {
  const seen = new Map<string, DescriptorField>()
  for (const model of models) {
    for (const [name, prop] of Object.entries(propertiesOf(model, resolve))) {
      if (seen.has(name)) {
        const f = seen.get(name)!
        if (!f.description && typeof prop.description === 'string') f.description = prop.description
        continue
      }
      const f: DescriptorField = { name, type: fieldType(prop) }
      if (typeof prop.description === 'string' && prop.description.trim()) f.description = prop.description.trim()
      seen.set(name, f)
    }
  }
  return [...seen.values()]
}

function propertiesOf(model: JsonSchema, resolve: (s: JsonSchema | undefined) => JsonSchema | undefined): Record<string, JsonSchema> {
  const out: Record<string, JsonSchema> = {}
  if (Array.isArray(model.allOf)) for (const part of model.allOf as JsonSchema[]) Object.assign(out, propertiesOf(resolve(part) ?? {}, resolve))
  Object.assign(out, (model.properties as Record<string, JsonSchema> | undefined) ?? {})
  return out
}

/** Column type for a response property: date-like strings are `time`; numbers and integers `number`. */
export function fieldType(prop: JsonSchema): ColumnType {
  const alts = branches(prop)
  if (alts.some((a) => a.format === 'date' || a.format === 'date-time')) return 'time'
  const types = new Set(alts.map((a) => String(a.type ?? 'string')))
  if (types.has('number') || types.has('integer')) return types.has('string') ? 'string' : 'number'
  if (types.has('boolean') && types.size === 1) return 'boolean'
  return 'string'
}

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)]
}
