import { z } from 'zod'
import { addDays, nyDate, rangeStart } from './clock.js'
import { type Descriptor, type DescriptorParam } from './descriptor.js'
import { FieldOverridesSchema } from './fields.js'
import { JsonSchemaObjectSchema, jsonSchemaToParams, jsonSchemaToZod, type JsonSchemaObject } from './json-schema.js'
import { ViewV2Schema, type ViewV2 } from './presets.js'
import type { RouteQuery, TransformQuery } from './query.js'
import { SizeSchema } from './view-options.js'
import type { Range } from './kinds.js'

/**
 * Recipes (PLAN.md section 17): a named, saved query with a title template, a param schema (JSON schema), a
 * preferred preset and size, and ordered route alternatives with param mappings per connector. Data, not code:
 * the built-in ones live in `packages/core/recipes.yml`, user ones in `~/.terminal/recipes.yml`. The 22 kinds
 * are 22 recipes; the prompt lists them as examples and the agent may use any route.
 *
 * Param mappings are templates over the recipe's params: `"{symbols}"` passes the value through (arrays stay
 * arrays; the connector joins them), `"{range|start_date}"` applies a filter, `"NVDA-{expiration}"` interpolates.
 * A route's `when` keeps it only for matching params (the macro recipe picks its route by series).
 */

export const RecipeRouteSchema = z.object({
  connector: z.string().min(1),
  route: z.string().min(1),
  /** The connector's provider to ask for (OpenBB); passed as the `provider` param. */
  provider: z.string().min(1).optional(),
  /** Route param → literal or template over the recipe params. */
  params: z.record(z.string(), z.unknown()).default({}),
  /** Use this route only when every listed recipe param equals (or, for arrays, contains) one of the values. */
  when: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
  /**
   * Column renames applied to this route's frame (`{ date: time }`): the recipe's frame keeps the column names the
   * kind of the same name had, whichever provider answered, so transforms and helpers that read `time` work on
   * every alternative. A rename whose source is missing or whose target already exists is skipped.
   */
  rename: z.record(z.string(), z.string().min(1)).optional(),
  /** What this route does not do that the kind handler did; shown to phase 1 and in the Data page. */
  note: z.string().optional(),
})
export type RecipeRoute = z.output<typeof RecipeRouteSchema>

/** A route query as a recipe expands it: the query plus the recipe route's column renames. */
export type RecipeRouteQuery = RouteQuery & { rename?: Record<string, string> }

/**
 * The reserved transform input that carries the recipe's validated params as a one-row frame (one column per param;
 * arrays joined with ", "), so a recipe's transform can pick an expiration, filter the calendar to the symbols or
 * select a macro series without code templating: `s = params.at[0, "series"]`. Phase 2; the v1 handlers did this in code.
 */
export const RECIPE_PARAMS_INPUT = 'params'

/** The one-row params frame bound as `params` for a recipe's transforms. */
export function recipeParamsFrame(params: Record<string, unknown>, fetchedAt = Date.now()): { columns: { name: string; type: 'string' | 'number' | 'boolean' }[]; rows: unknown[][]; meta: { connector: string; fetchedAt: number; ttl: number } } {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null)
  const columns = entries.map(([name, v]) => ({ name, type: typeof v === 'number' ? ('number' as const) : typeof v === 'boolean' ? ('boolean' as const) : ('string' as const) }))
  const row = entries.map(([, v]) => (Array.isArray(v) ? v.map(String).join(', ') : typeof v === 'object' ? JSON.stringify(v) : v))
  return { columns, rows: [row], meta: { connector: 'recipe', fetchedAt, ttl: 0 } }
}

/** The frame with columns (and their field config) renamed; the same frame when nothing applies. */
export function renameColumns<F extends { columns: { name: string }[]; meta?: { fields?: Record<string, unknown> } }>(frame: F, rename: Record<string, string> | undefined): F {
  if (!rename) return frame
  const names = new Set(frame.columns.map((c) => c.name))
  const applicable = Object.entries(rename).filter(([from, to]) => names.has(from) && !names.has(to) && from !== to)
  if (applicable.length === 0) return frame
  const map = new Map(applicable)
  const columns = frame.columns.map((c) => (map.has(c.name) ? { ...c, name: map.get(c.name)! } : c))
  const fields = frame.meta?.fields
  const renamedFields = fields ? Object.fromEntries(Object.entries(fields).map(([k, v]) => [map.get(k) ?? k, v])) : undefined
  return { ...frame, columns, ...(frame.meta ? { meta: { ...frame.meta, ...(renamedFields ? { fields: renamedFields } : {}) } } : {}) }
}

/** A recipe dataset is ordered route alternatives, or a transform over the recipe's other datasets. */
export const RecipeDatasetSchema = z.union([
  z.object({ routes: z.array(RecipeRouteSchema).min(1) }),
  z.object({ inputs: z.array(z.string().min(1)).min(1), code: z.string().min(1), columns: FieldOverridesSchema.optional() }),
])
export type RecipeDataset = z.output<typeof RecipeDatasetSchema>

export const RecipeSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9_]*$/, 'recipe names are snake_case'),
    /** Title template over the params: "{symbols} {interval} {range}". */
    title: z.string().min(1).max(120),
    /** One line for the prompt and the Data page. */
    summary: z.string().optional(),
    params: JsonSchemaObjectSchema,
    view: ViewV2Schema,
    size: SizeSchema.optional(),
    /** Shorthand for `data.main.routes`. */
    routes: z.array(RecipeRouteSchema).min(1).optional(),
    data: z.record(z.string().regex(/^[a-z_][a-z0-9_]*$/), RecipeDatasetSchema).optional(),
    /** Cache TTL override in ms. */
    ttl: z.number().nonnegative().optional(),
    /** A recipe that supplies event markers for this one (earnings for ohlcv). */
    events: z.string().optional(),
    /** Field config the recipe applies on top of annotations (labels for its own columns). */
    fields: FieldOverridesSchema.optional(),
    tags: z.array(z.string()).optional(),
    /** Set on recipes a user promoted from a widget. */
    user: z.boolean().optional(),
  })
  .refine((r) => r.routes || r.data?.main, { message: 'a recipe needs `routes` or a `data.main` dataset' })
export type Recipe = z.output<typeof RecipeSchema>
export type RecipeInput = z.input<typeof RecipeSchema>

const TEMPLATE_RE = /\{([a-z_][a-z0-9_]*)((?:\|[a-z_]+(?::[^|}]*)?)*)\}/gi
const WHOLE_TEMPLATE_RE = /^\{([a-z_][a-z0-9_]*)((?:\|[a-z_]+(?::[^|}]*)?)*)\}$/i

/** Parse a recipes document (`{ recipes: [...] }` or a bare list), checking names are unique and templates name real params. */
export function parseRecipes(doc: unknown): Recipe[] {
  const list = Array.isArray(doc) ? doc : ((doc as { recipes?: unknown } | null)?.recipes ?? [])
  const recipes = z.array(RecipeSchema).parse(list)
  const seen = new Set<string>()
  for (const r of recipes) {
    if (seen.has(r.name)) throw new Error(`duplicate recipe "${r.name}"`)
    seen.add(r.name)
    for (const issue of validateRecipe(r)) throw new Error(`recipe "${r.name}": ${issue}`)
  }
  return recipes
}

/** Problems with one recipe: templates over unknown params, transforms over unknown datasets, `when` on unknown params. */
export function validateRecipe(r: Recipe): string[] {
  const issues: string[] = []
  const known = new Set(Object.keys(r.params.properties ?? {}))
  const checkTemplate = (text: string, where: string) => {
    for (const m of text.matchAll(TEMPLATE_RE)) {
      if (!known.has(m[1]!)) issues.push(`${where} references unknown param {${m[1]}}`)
      for (const f of (m[2] ?? '').split('|').filter(Boolean)) {
        const name = f.split(':')[0]!
        if (!(name in FILTERS)) issues.push(`${where} uses unknown filter |${name}`)
      }
    }
  }
  checkTemplate(r.title, 'title')
  const datasets = recipeDatasets(r)
  for (const [name, ds] of Object.entries(datasets)) {
    if ('routes' in ds) {
      for (const route of ds.routes) {
        for (const [k, v] of Object.entries(route.params)) if (typeof v === 'string') checkTemplate(v, `${name}: ${route.connector} ${route.route} ${k}`)
        for (const k of Object.keys(route.when ?? {})) if (!known.has(k)) issues.push(`${name}: ${route.route} when.${k} is not a param`)
      }
    } else {
      for (const input of ds.inputs) if (input !== RECIPE_PARAMS_INPUT && (!datasets[input] || input === name)) issues.push(`${name}: transform input "${input}" is not a dataset of the recipe`)
    }
  }
  return issues
}

/** The recipe's datasets with `routes` folded in as `main`. */
export function recipeDatasets(r: Recipe): Record<string, RecipeDataset> {
  const out: Record<string, RecipeDataset> = { ...(r.data ?? {}) }
  if (r.routes) out.main = { routes: r.routes }
  return out
}

/** Zod schema for a recipe's params: defaults applied, required demanded. */
export function recipeParamsSchema(r: Recipe): z.ZodObject<Record<string, z.ZodType>> {
  return jsonSchemaToZod(r.params)
}

/** The recipe's params as descriptor params (for the prompt, the editor form and `recipeDescriptor`). */
export function recipeParams(r: Recipe): DescriptorParam[] {
  return jsonSchemaToParams(r.params)
}

/** A recipe as a catalog descriptor under the pseudo-connector `recipe`, so `find_route` can surface recipes beside routes. */
export function recipeDescriptor(r: Recipe): Descriptor {
  const d: Descriptor = { connector: 'recipe', route: r.name, summary: r.summary ?? r.title, params: recipeParams(r), providers: [], fields: [] }
  if (r.summary && r.title !== r.summary) d.description = `Title: ${r.title}`
  return d
}

export type ExpandedDataset = { routes: RecipeRouteQuery[] } | { transform: Omit<TransformQuery, 'inputs'> & { inputs: string[] } }
export type ExpandedRecipe = {
  recipe: Recipe
  /** Validated params with defaults. */
  params: Record<string, unknown>
  title: string
  /** `main`'s route alternatives (empty when `main` is a transform). */
  routes: RecipeRouteQuery[]
  data: Record<string, ExpandedDataset>
}

export type ExpandOptions = { now?: Date | number }

/** Validate params against the recipe and expand every dataset's route templates. Throws ZodError on bad params. */
export function expandRecipe(r: Recipe, rawParams: Record<string, unknown>, opts: ExpandOptions = {}): ExpandedRecipe {
  const params = recipeParamsSchema(r).parse(rawParams) as Record<string, unknown>
  const ctx: FilterCtx = { now: opts.now ?? Date.now() }
  const data: Record<string, ExpandedDataset> = {}
  for (const [name, ds] of Object.entries(recipeDatasets(r))) {
    if ('routes' in ds) {
      const routes: RecipeRouteQuery[] = []
      for (const route of ds.routes) {
        if (!whenMatches(route.when, params)) continue
        const p: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(route.params)) {
          const rendered = renderValue(v, params, ctx)
          if (rendered !== undefined && rendered !== null && rendered !== '') p[k] = rendered
        }
        if (route.provider) p.provider = route.provider
        routes.push({ connector: route.connector, route: route.route, params: p, ...(route.rename ? { rename: route.rename } : {}) })
      }
      data[name] = { routes }
    } else {
      const t: ExpandedDataset = { transform: { inputs: ds.inputs, code: ds.code } }
      if (ds.columns) (t as { transform: { columns?: typeof ds.columns } }).transform.columns = ds.columns
      data[name] = t
    }
  }
  const main = data.main
  // The route alternatives the recipe calls: main's, or, when main is a transform (options, earnings, macro), the
  // first route dataset's (what `resolveRecipe` and the catalog views report as the recipe's routes).
  const firstRoutes = Object.values(data).find((d): d is { routes: RecipeRouteQuery[] } => 'routes' in d)
  const routes = main && 'routes' in main ? main.routes : (firstRoutes?.routes ?? [])
  return { recipe: r, params, title: titleFor(r, params), routes, data }
}

/**
 * A short hash of the recipe definition (FNV-1a over its JSON). Stamped on the frames a recipe produces as
 * `lineage.recipeVersion`, so a frame cached under an older definition (the persistent cache outlives a restart and a
 * recipes.yml edit) is a cache miss rather than a stale shape.
 */
export function recipeVersion(r: Recipe): string {
  const s = JSON.stringify(r)
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** The recipe's route alternatives as written: main's, else the first route dataset's (the one main transforms over). */
export function recipeRouteAlternatives(r: Recipe): RecipeRoute[] {
  const datasets = recipeDatasets(r)
  const main = datasets.main
  if (main && 'routes' in main) return main.routes
  const first = Object.values(datasets).find((d): d is { routes: RecipeRoute[] } => 'routes' in d)
  return first?.routes ?? []
}

/** The title template rendered with the params: arrays joined with ", ", missing params dropped, whitespace collapsed. */
export function titleFor(r: Pick<Recipe, 'title'>, params: Record<string, unknown>): string {
  const ctx: FilterCtx = { now: Date.now() }
  return r.title
    .replace(TEMPLATE_RE, (_m, name: string, filters: string) => {
      const v = applyFilters(params[name], filters, ctx)
      return v === undefined || v === null ? '' : Array.isArray(v) ? v.join(', ') : String(v)
    })
    .replace(/\s+/g, ' ')
    .trim()
}

function whenMatches(when: RecipeRoute['when'], params: Record<string, unknown>): boolean {
  if (!when) return true
  for (const [k, allowed] of Object.entries(when)) {
    const list = Array.isArray(allowed) ? allowed : [allowed]
    const v = params[k]
    const values = Array.isArray(v) ? v.map(String) : v === undefined || v === null ? [] : [String(v)]
    if (!values.some((x) => list.includes(x))) return false
  }
  return true
}

type FilterCtx = { now: Date | number }

/** Template filters: `{param|filter}` or `{param|filter:arg}`. */
export const FILTERS: Record<string, (v: unknown, arg: string | undefined, ctx: FilterCtx) => unknown> = {
  /** A range → the ISO date it starts (clock.rangeStart). */
  start_date: (v, _a, ctx) => (typeof v === 'string' ? rangeStart(v as Range, ctx.now) : v),
  /** Today in New York. */
  today: (_v, _a, ctx) => nyDate(ctx.now),
  /** N days before today, ISO date: `{x|days_ago:365}` (ignores the param value). */
  days_ago: (_v, a, ctx) => addDays(nyDate(ctx.now), -Number(a ?? 0)),
  /** N days after today. */
  days_ahead: (_v, a, ctx) => addDays(nyDate(ctx.now), Number(a ?? 0)),
  join: (v, a) => (Array.isArray(v) ? v.map(String).join(a ?? ',') : v),
  first: (v) => (Array.isArray(v) ? v[0] : v),
  upper: (v) => (typeof v === 'string' ? v.toUpperCase() : Array.isArray(v) ? v.map((x) => String(x).toUpperCase()) : v),
  lower: (v) => (typeof v === 'string' ? v.toLowerCase() : v),
  /** "United States" → "united_states". */
  country: (v) => (typeof v === 'string' ? v.trim().toLowerCase().replace(/[\s-]+/g, '_') : v),
  /** Our interval names → yahoo-finance2's (`1w` → `1wk`). */
  yahoo_interval: (v) => (v === '1w' ? '1wk' : v),
  /** Our interval names → OpenBB yfinance's (`1w` → `1W`). */
  openbb_interval: (v) => (v === '1w' ? '1W' : v),
  /** `{list|map:gainers=day_gainers,losers=day_losers}`; unmapped values pass through. */
  map: (v, a) => {
    const table = Object.fromEntries((a ?? '').split(',').map((pair) => pair.split('=') as [string, string]))
    return typeof v === 'string' && v in table ? table[v] : v
  },
  /** A number multiplied by the argument: `{limit|times:5}`. */
  times: (v, a) => (typeof v === 'number' ? v * Number(a ?? 1) : v),
  /** A fixed value regardless of the param: `{range|const:1mo}`. */
  const: (_v, a) => a,
}

function applyFilters(value: unknown, filters: string, ctx: FilterCtx): unknown {
  let v = value
  for (const f of filters.split('|').filter(Boolean)) {
    const [name, arg] = f.split(':', 2) as [string, string | undefined]
    const fn = FILTERS[name]
    if (!fn) throw new Error(`unknown template filter |${name}`)
    v = fn(v, arg, ctx)
  }
  return v
}

/** Render one route param: a whole template keeps the value's type; embedded templates interpolate to a string; literals pass. */
export function renderValue(template: unknown, params: Record<string, unknown>, ctx: FilterCtx): unknown {
  if (typeof template !== 'string') return template
  const whole = WHOLE_TEMPLATE_RE.exec(template)
  if (whole) return applyFilters(params[whole[1]!], whole[2] ?? '', ctx)
  if (!TEMPLATE_RE.test(template)) return template
  return template.replace(TEMPLATE_RE, (_m, name: string, filters: string) => {
    const v = applyFilters(params[name], filters, ctx)
    return v === undefined || v === null ? '' : Array.isArray(v) ? v.join(',') : String(v)
  })
}

/** The prompt's recipe list: one line per recipe with its params and an example query. */
export function recipeSummaryLines(recipes: readonly Recipe[]): string[] {
  return recipes.map((r) => {
    const params = recipeParams(r)
      .map((p) => `${p.name}${p.required ? '' : '?'}${p.enum ? `=${p.enum.slice(0, 6).join('|')}${p.enum.length > 6 ? '|…' : ''}` : p.type === 'string[]' ? '[]' : ''}`)
      .join(', ')
    return `${r.name}(${params}) · ${r.summary ?? r.title} · view ${r.view.preset}`
  })
}

export function recipeMap(recipes: readonly Recipe[]): Map<string, Recipe> {
  return new Map(recipes.map((r) => [r.name, r]))
}

export { type JsonSchemaObject as RecipeParamsSchema, type ViewV2 as RecipeView }
