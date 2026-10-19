import stringify from 'fast-json-stable-stringify'
import { z } from 'zod'
import { FieldOverridesSchema } from './fields.js'
import { expandRecipe, type Recipe } from './recipes.js'

/**
 * Queries (PLAN.md section 17). A widget's dataset is one of three things:
 * - a route: `{ connector, route, params }`, validated against the connector's descriptor;
 * - a recipe: `{ recipe, params }`, a named saved query with ordered route alternatives (the 22 kinds became recipes);
 * - a transform: `{ inputs, code, columns? }`, Python over the input frames, run by the TransformEngine.
 */

export const RouteQuerySchema = z.object({
  connector: z.string().min(1),
  route: z.string().min(1),
  params: z.record(z.string(), z.unknown()).default({}),
})
export type RouteQuery = z.output<typeof RouteQuerySchema>

export const RecipeQuerySchema = z.object({
  recipe: z.string().min(1),
  params: z.record(z.string(), z.unknown()).default({}),
})
export type RecipeQuery = z.output<typeof RecipeQuerySchema>

/** Transform code and input limits live in transform.ts; the schema only bounds the text. */
export const TRANSFORM_CODE_MAX = 20_000

export type TransformQuery = {
  inputs: Record<string, AnyQuery>
  code: string
  columns?: z.output<typeof FieldOverridesSchema>
}
export type TransformQueryInput = {
  inputs: Record<string, AnyQueryInput>
  code: string
  columns?: z.input<typeof FieldOverridesSchema>
}

export type QueryV2 = RouteQuery | RecipeQuery | TransformQuery
export type QueryV2Input = z.input<typeof RouteQuerySchema> | z.input<typeof RecipeQuerySchema> | TransformQueryInput

export const TransformQuerySchema: z.ZodType<TransformQuery, TransformQueryInput> = z.object({
  inputs: z.record(
    z.string().regex(/^[a-z_][a-z0-9_]*$/i, 'input names are Python identifiers'),
    z.lazy((): z.ZodType<AnyQuery, AnyQueryInput> => AnyQuerySchema),
  ),
  code: z.string().min(1).max(TRANSFORM_CODE_MAX),
  columns: FieldOverridesSchema.optional(),
}) as unknown as z.ZodType<TransformQuery, TransformQueryInput>

/** A query: route, recipe or transform. Shapes are disjoint, so the union is tried most-specific first. */
export const QueryV2Schema: z.ZodType<QueryV2, QueryV2Input> = z.union([TransformQuerySchema, RouteQuerySchema, RecipeQuerySchema]) as unknown as z.ZodType<QueryV2, QueryV2Input>

/** Any query a widget or the registry may hold. The name dates from the v1 coexistence; it is the v2 union. */
export type AnyQuery = QueryV2
export type AnyQueryInput = QueryV2Input
export const AnyQuerySchema: z.ZodType<AnyQuery, AnyQueryInput> = QueryV2Schema

export function isRouteQuery(q: unknown): q is RouteQuery {
  return !!q && typeof q === 'object' && typeof (q as RouteQuery).connector === 'string' && typeof (q as RouteQuery).route === 'string'
}
export function isRecipeQuery(q: unknown): q is RecipeQuery {
  return !!q && typeof q === 'object' && typeof (q as RecipeQuery).recipe === 'string'
}
export function isTransformQuery(q: unknown): q is TransformQuery {
  return !!q && typeof q === 'object' && typeof (q as TransformQuery).code === 'string' && !!(q as TransformQuery).inputs
}

/** Validate any query shape (applies the `params: {}` default). Throws ZodError. */
export function parseAnyQuery(input: unknown): AnyQuery {
  return AnyQuerySchema.parse(input)
}

/**
 * The cache key. Stable across param order. Route params are sorted; recipe keys are by recipe name (the resolved
 * route frame is cached under its own route key too); transform keys cover the inputs' keys and the code. Unchanged
 * from the v2 keys of the coexistence, so the persistent cache survives phase 3.
 */
export function canonicalKey(q: AnyQuery): string {
  if (isTransformQuery(q)) {
    const inputs: Record<string, string> = {}
    for (const [name, sub] of Object.entries(q.inputs)) inputs[name] = canonicalKey(sub)
    return `transform:${stringify({ inputs, code: q.code, columns: q.columns ?? null })}`
  }
  if (isRecipeQuery(q)) return `recipe:${q.recipe}:${stringify(q.params ?? {})}`
  return `route:${q.connector}/${q.route}:${stringify(canonicalParams(q.params ?? {}))}`
}

/** Params with undefined and null dropped and arrays kept in order (order is meaning for symbols). */
export function canonicalParams(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(params).sort()) {
    const v = params[k]
    if (v === undefined || v === null || v === '') continue
    out[k] = v
  }
  return out
}

/**
 * Ordered route alternatives for a recipe query: params validated against the recipe's schema with defaults applied,
 * each route's param mapping expanded, routes whose `when` filter does not match dropped. Throws when the recipe is
 * unknown or the params are invalid.
 */
export function resolveRecipe(recipes: readonly Recipe[] | ReadonlyMap<string, Recipe>, q: RecipeQuery, opts: { now?: Date | number } = {}): RouteQuery[] {
  const recipe = recipes instanceof Map ? recipes.get(q.recipe) : (recipes as readonly Recipe[]).find((r) => r.name === q.recipe)
  if (!recipe) throw new Error(`unknown recipe "${q.recipe}"`)
  return expandRecipe(recipe, q.params ?? {}, opts).routes
}

/** Symbols a query is about, when it has any: `symbols[]`, `symbol`, or none. Transform queries take the union of their inputs. */
export function anyQuerySymbols(q: AnyQuery): string[] {
  if (isTransformQuery(q)) return [...new Set(Object.values(q.inputs).flatMap(anyQuerySymbols))]
  const p = (q as { params?: Record<string, unknown> }).params ?? {}
  const symbols = p.symbols
  if (Array.isArray(symbols)) return symbols.map(String)
  const symbol = p.symbol
  if (typeof symbol === 'string') return symbol.split(',').map((s) => s.trim()).filter(Boolean)
  if (Array.isArray(symbol)) return symbol.map(String)
  return []
}

/** One line for steps and logs: "openbb equity/price/quote symbol=NVDA", "recipe ohlcv symbols=MU,SNDK", "transform(price, eps)". */
export function describeQuery(q: AnyQuery): string {
  if (isTransformQuery(q)) return `transform(${Object.keys(q.inputs).join(', ')})`
  if (isRecipeQuery(q)) return `recipe ${q.recipe} ${describeParams(q.params)}`.trim()
  return `${q.connector} ${q.route} ${describeParams(q.params)}`.trim()
}

function describeParams(p: Record<string, unknown>): string {
  return Object.entries(p)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : String(v)}`)
    .join(' ')
}
