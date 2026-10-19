// Promote to recipe (PLAN.md section 17, feature 11): a widget the user likes becomes a user recipe. Pure, tested.
import { DEFAULT_DATASET, RecipeSchema, isRecipeQuery, isRouteQuery, isTransformQuery, widgetQueries, type AnyQuery, type AnyWidget, type JsonSchemaObject, type Recipe, type RecipeDataset, type RecipeRoute } from '@terminal/core'
import { z } from 'zod'

/** Params that become recipe params (templated) when promoting a route; everything else stays literal. */
const TEMPLATED = ['symbols', 'symbol', 'q', 'query', 'series']

export function recipeNameFrom(title: string, taken: Set<string>): string {
  const base =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .replace(/^[^a-z]+/, '')
      .slice(0, 40) || 'my_recipe'
  if (!taken.has(base)) return base
  for (let i = 2; ; i++) if (!taken.has(`${base}_${i}`)) return `${base}_${i}`
}

type Built = { params: JsonSchemaObject['properties']; required: string[]; dataset: RecipeDataset; title: string }

/** A route query as a recipe dataset: symbol-like params become `{param}` templates with the widget's value as the default. */
function routeDataset(q: { connector: string; route: string; params: Record<string, unknown> }): Built {
  const props: NonNullable<JsonSchemaObject['properties']> = {}
  const required: string[] = []
  const params: Record<string, unknown> = {}
  let provider: string | undefined
  for (const [k, v] of Object.entries(q.params)) {
    if (k === 'provider' && typeof v === 'string') {
      provider = v
      continue
    }
    if (TEMPLATED.includes(k) && (typeof v === 'string' || Array.isArray(v))) {
      props[k] = Array.isArray(v) ? { type: 'array', items: { type: 'string' }, default: v.map(String), minItems: 1 } : { type: 'string', default: v }
      params[k] = `{${k}}`
    } else params[k] = v
  }
  const route: RecipeRoute = { connector: q.connector, route: q.route, params, ...(provider ? { provider } : {}) }
  const first = Object.keys(props)[0]
  return { params: props, required, dataset: { routes: [route] }, title: first ? `{${first}} ${q.route}` : q.route }
}

/**
 * The user recipe for a widget. Recipe datasets copy the base recipe's routes with the widget's params
 * as the defaults; route datasets template their symbol params; a transform carries its inputs as datasets.
 */
export function recipeFromWidget(widget: AnyWidget, builtin: readonly Recipe[], taken: Set<string> = new Set(builtin.map((r) => r.name))): Recipe {
  const queries = widgetQueries(widget)
  const props: NonNullable<JsonSchemaObject['properties']> = {}
  const required: string[] = []
  const data: Record<string, RecipeDataset> = {}
  let title = widget.title

  const add = (name: string, q: AnyQuery): void => {
    if (isTransformQuery(q)) {
      for (const [input, sub] of Object.entries(q.inputs)) if (!data[input]) add(input, sub)
      data[name] = { inputs: Object.keys(q.inputs), code: q.code, ...(q.columns ? { columns: q.columns } : {}) }
      return
    }
    if (isRouteQuery(q)) {
      const b = routeDataset(q)
      Object.assign(props, b.params)
      data[name] = b.dataset
      if (name === DEFAULT_DATASET && b.title) title = widget.title
      return
    }
    const baseName = isRecipeQuery(q) ? q.recipe : undefined
    const base = baseName ? builtin.find((r) => r.name === baseName) : undefined
    const params = (q as { params: Record<string, unknown> }).params ?? {}
    if (base) {
      for (const [k, p] of Object.entries(base.params.properties ?? {})) {
        const given = params[k]
        props[k] = given !== undefined ? { ...(p as Record<string, unknown>), default: given } : (p as Record<string, unknown>)
      }
      const baseData: Record<string, RecipeDataset> = { ...(base.data ?? {}) }
      if (base.routes) baseData.main = { routes: base.routes }
      for (const [dn, ds] of Object.entries(baseData)) data[dn === 'main' ? name : dn] = ds
      return
    }
    // an unknown recipe: keep the reference as a route-less dataset is impossible, so record it as a route on the pseudo connector
    data[name] = { routes: [{ connector: 'recipe', route: baseName ?? 'unknown', params }] }
  }

  for (const [name, q] of Object.entries(queries)) add(name, q)
  if (!data.main) {
    const first = Object.keys(data)[0]
    if (first) {
      data.main = data[first]!
      delete data[first]
    }
  }
  const schema: JsonSchemaObject = { type: 'object', properties: props, ...(required.length ? { required } : {}) }
  const name = recipeNameFrom(widget.title, taken)
  const view = 'preset' in widget.view ? widget.view : { preset: 'table' as const }
  const recipe = { name, title, summary: `Promoted from the widget "${widget.title}"`, params: schema, view, size: widget.size, data, user: true }
  return RecipeSchema.parse(recipe)
}

/** Validate a recipe document typed in the library's editor. Returns the recipe or the first error line. */
export function parseRecipeText(text: string): { ok: true; recipe: Recipe } | { ok: false; error: string } {
  try {
    const recipe = RecipeSchema.parse(JSON.parse(text))
    return { ok: true, recipe }
  } catch (err) {
    if (err instanceof z.ZodError) return { ok: false, error: err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ') }
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
