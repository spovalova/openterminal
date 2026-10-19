import { tool } from 'ai'
import { z } from 'zod'
import {
  Catalog,
  FieldConfigSchema,
  PREVIEW_MAX_ROWS,
  SizeSchema,
  ViewV2Schema,
  WidgetV2Schema,
  controlFor,
  describeDescriptor,
  describeQuery,
  expandRecipe,
  isRecipeQuery,
  isRouteQuery,
  isTransformQuery,
  packLayout,
  parseAnyQuery,
  recipeDescriptor,
  validateParams,
  type AnyQuery,
  type CatalogHit,
  type Recipe,
  type Registry,
  type ServerMsg,
  type Step,
  type WidgetV2,
} from '@terminal/core'
import { PreviewMemory, contentHintFor, previewResult, primaryDatasetOf, type PreviewResult } from './previews.js'
import { TRANSFORM_TOOL_DESCRIPTION, TransformToolInput, runTransformTool, type TransformToolResult } from './tools-transform.js'

/** Hard cap of tool calls per prompt, including set_workspace. */
export const MAX_TOOL_CALLS = 10

/** Mutable per-run budget shared by the tools and the loop. */
export type ToolBudget = { used: number; max: number }

/**
 * The `widgets` message with v2 widgets. Since phase 2 the protocol's `widgets` message carries `AnyWidgetSchema`, so
 * this is a narrowing of `ServerMsg`'s `widgets` member (kept as a named type for the tools' `emit`).
 */
export type WidgetsV2Msg = { t: 'widgets'; workspaceId: string; widgets: WidgetV2[]; name?: string }

export type ToolDeps = {
  registry: Registry
  workspaceId: string
  /** The recipes the registry resolves (`registry.recipes()`), for validating recipe queries in widgets. */
  recipes: readonly Recipe[]
  /** The catalog (`registry.catalog()`), for `find_route` and for validating route queries in widgets. */
  catalog?: Catalog
  /** Previews seen this run; shared with reply verification. */
  memory: PreviewMemory
  signal: AbortSignal
  emit(m: ServerMsg | WidgetsV2Msg): void
  /** Called once per tool call with the finished step (also when it failed). */
  onStep(step: Step): void
  /** Called when set_workspace succeeds, with the validated widgets. */
  onWidgets(widgets: WidgetV2[], name?: string): void
  budget: ToolBudget
  now?: () => number
}

// ---------- input schemas ----------

export const FindRouteInput = z.object({
  query: z.string().min(1).describe('Keywords: what the data is, not a sentence ("corporate bond prices issuer", "sector performance", "short interest").'),
  namespaces: z.array(z.string().min(1)).optional().describe('Only routes under these first path segments (equity, fixedincome, economy, derivatives, news, etf, index, …).'),
})
export type FindRouteInputT = z.input<typeof FindRouteInput>

/**
 * `query` takes one of two shapes in one flat object (the Anthropic API rejects a top-level anyOf): a recipe
 * (`recipe` + `params`) or a route (`connector` + `route` + `params`).
 */
export const QueryToolInput = z.object({
  recipe: z.string().min(1).optional().describe('A recipe name from the prompt\'s list.'),
  connector: z.string().min(1).optional().describe('With `route`: the connector a find_route hit named.'),
  route: z.string().min(1).optional().describe('With `connector`: the route path a find_route hit named.'),
  params: z.record(z.string(), z.unknown()).default({}).describe('Params exactly as the recipe line or the descriptor lists them. Symbol lists are arrays.'),
})
export type QueryToolInputT = z.input<typeof QueryToolInput>

const openQuery = z.record(z.string(), z.unknown())

export { TransformToolInput }
export type TransformToolInputT = z.input<typeof TransformToolInput>

/** A widget: a data graph (`data`) and a preset `view`, id optional. */
export const WidgetToolInput = z.object({
  id: z.string().min(1).optional().describe('Optional. Assigned as w1..wN when omitted.'),
  title: z.string().min(1).max(80),
  size: SizeSchema,
  data: z.record(z.string().min(1), openQuery).describe('Datasets by name: `main` plus any events, levels or comparison datasets the view names. Each is a recipe, route or transform query.'),
  view: ViewV2Schema.describe('A preset with options ({ preset: "price" | "compare" | "curve" | "indicator" | "table" | "stat" | "facts" | "chain" | "heatmap", … }).'),
  fields: z.record(z.string().min(1), FieldConfigSchema).optional().describe('Per-column overrides: label, unit, priority, hidden.'),
})
export type WidgetToolInputT = z.input<typeof WidgetToolInput>

export const SetWorkspaceInput = z.object({
  name: z.string().trim().min(1).max(60).optional().describe('Short workspace name, two to four words. Set it on the first prompt.'),
  widgets: z.array(WidgetToolInput).min(1).max(8).describe('The complete widget set. The first widget is the hero.'),
})
export type SetWorkspaceInputT = z.input<typeof SetWorkspaceInput>

export type QueryToolResult = PreviewResult | { ok: false; error: string; traceback?: string }
export type FindRouteResult = { ok: true; routes: (CatalogHit & { describe: string })[]; recipes: string[]; note: string } | { ok: false; error: string }
export type SetWorkspaceResult = { ok: true; widgetIds: string[]; name?: string; note: string } | { ok: false; errors: string[]; note: string }

// ---------- summaries ----------

/** One-line step summary: `recipe quote symbols=NVDA · 1 row`, `openbb equity/price/quote symbol=NVDA · failed`. */
export function querySummary(input: unknown, rowCount?: number, failed = false): string {
  const head = queryHead(input)
  if (failed) return `${head} · failed`
  return rowCount === undefined ? head : `${head} · ${rowCount} ${rowCount === 1 ? 'row' : 'rows'}`
}

function queryHead(input: unknown): string {
  const q = (input ?? {}) as Record<string, unknown>
  if (isTransformQuery(q) || isRecipeQuery(q) || isRouteQuery(q)) return describeQuery(q as AnyQuery)
  return 'query'
}

export function workspaceSummary(count: number, invalid = 0): string {
  if (invalid > 0) return `set_workspace · ${invalid} invalid ${invalid === 1 ? 'widget' : 'widgets'}`
  return `set_workspace · ${count} ${count === 1 ? 'widget' : 'widgets'}`
}

/**
 * How the packer laid the widgets out in the three-column grid with their content hints. Empty when the sizes tile;
 * otherwise names the widgets that were stretched to fill cells that would have stayed empty, and the ones the
 * size-by-content rule demoted (a short table, a stat, a facts card are one row tall), so the agent can pick a
 * tiling set next time.
 */
export function layoutNote(widgets: readonly WidgetV2[], memory: PreviewMemory): string {
  const placements = packLayout(
    widgets.map((w) => ({ size: w.size, contentHint: contentHintFor(w, memory) })),
    3,
  )
  const stretched = placements.flatMap((p, i) => (p.stretched ? [widgets[i]!] : []))
  const sized = placements.flatMap((p, i) => (p.demoted ? [`${widgets[i]!.id} (${widgets[i]!.view.preset}, ${widgets[i]!.size}) is ${p.cols === 1 && widgets[i]!.size !== 'sm' ? 'one column wide and ' : ''}${p.rows === 1 ? 'one row' : `${p.rows} rows`} tall`] : []))
  const parts: string[] = []
  if (stretched.length > 0) {
    const names = stretched.map((w) => `${w.id} (${w.size})`).join(', ')
    parts.push(`Layout repaired: ${names} ${stretched.length === 1 ? 'was' : 'were'} stretched to fill cells that would have stayed empty in the 3-column grid (lg is 2x2, md 2x1, sm 1x1). This is fine; a set that tiles (an md beside an sm, two sm in a row) needs no repair.`)
  }
  if (sized.length > 0) parts.push(`Sized by content: ${sized.join(', ')} (tables with six rows or fewer, stats and facts cards are one row and never full width; the lg hero is 2x2 and every other chart one cell, never taller than wide).`)
  return parts.length ? `${parts.join(' ')} ` : ''
}

// ---------- widget validation ----------

export type ValidateContext = {
  recipes: readonly Recipe[]
  catalog?: Catalog | undefined
  memory: PreviewMemory
  now?: number
}

/** Product rule 8, as set_workspace states it. */
export const ONE_ROW_TABLE_MESSAGE =
  'a table over one row compares nothing (product rule 8): use `stat` for one or two headline numbers, `facts` for a snapshot with several, the reply or a chart marker for a single date or fact, or a pivot through a transform for one symbol\'s financials'

/**
 * Assign ids and validate every widget: the schema (`WidgetV2Schema`), every dataset query (recipe known and params
 * valid; route in the catalog and params valid),
 * and, for datasets this run previewed, that the preset can draw the frame and that no table sits over one row.
 * Returns the validated widgets or the list of errors, one line per problem, keyed by index.
 */
export function validateWidgets(input: WidgetToolInputT[], ctx: ValidateContext): { ok: true; widgets: WidgetV2[] } | { ok: false; errors: string[] } {
  const errors: string[] = []
  const widgets: WidgetV2[] = []
  const seen = new Set<string>()
  let counter = 0
  const nextId = () => {
    let id: string
    do id = `w${++counter}`
    while (seen.has(id))
    return id
  }
  input.forEach((raw, i) => {
    const given = typeof raw.id === 'string' && raw.id.trim().length > 0 ? raw.id.trim() : undefined
    const id = given && !seen.has(given) ? given : nextId()
    seen.add(id)
    let widget: WidgetV2
    try {
      widget = WidgetV2Schema.parse({ ...raw, id })
    } catch (err) {
      if (err instanceof z.ZodError) for (const issue of err.issues) errors.push(`widgets[${i}] ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      else errors.push(`widgets[${i}]: ${errorMessage(err)}`)
      return
    }
    const before = errors.length
    for (const [name, q] of Object.entries(widget.data)) {
      for (const problem of queryProblems(q, ctx)) errors.push(`widgets[${i}] data.${name}: ${problem}`)
    }
    if (errors.length === before) for (const problem of viewProblems(widget, ctx)) errors.push(`widgets[${i}] view: ${problem}`)
    if (errors.length === before) widgets.push(widget)
  })
  return errors.length > 0 ? { ok: false, errors } : { ok: true, widgets }
}

/** Why a query would fail at render time: unknown recipe or route, bad params. */
export function queryProblems(q: AnyQuery, ctx: ValidateContext): string[] {
  if (isTransformQuery(q)) {
    const out: string[] = []
    for (const [name, sub] of Object.entries(q.inputs)) for (const p of queryProblems(sub, ctx)) out.push(`input ${name}: ${p}`)
    return out
  }
  if (isRecipeQuery(q)) {
    const recipe = ctx.recipes.find((r) => r.name === q.recipe)
    if (!recipe) return [`unknown recipe "${q.recipe}"${ctx.recipes.length ? ` (recipes: ${ctx.recipes.map((r) => r.name).join(', ')})` : ''}`]
    try {
      expandRecipe(recipe, q.params ?? {}, { now: ctx.now ?? Date.now() })
    } catch (err) {
      return [`recipe ${q.recipe}: ${errorMessage(err)}`]
    }
    return []
  }
  if (isRouteQuery(q)) {
    if (!ctx.catalog) return []
    const d = ctx.catalog.get(q.connector, q.route)
    if (!d) {
      const known = ctx.catalog.connectors()
      if (!known.includes(q.connector)) return [`connector "${q.connector}" is not available (connectors: ${known.join(', ') || 'none'})`]
      return [`connector "${q.connector}" has no route "${q.route}"; use find_route`]
    }
    const v = validateParams(d, q.params ?? {})
    return v.ok ? [] : [`${q.connector} ${q.route} params: ${v.issues.join('; ')}`]
  }
  return ['unrecognised query shape']
}

/** Why the preset would render nothing or badly over the frames this run previewed. Datasets not previewed are not checked. */
export function viewProblems(widget: WidgetV2, ctx: ValidateContext): string[] {
  const primary = primaryDatasetOf(widget)
  const seen = ctx.memory.get(widget.data[primary]!)
  if (!seen) return []
  const datasets = ctx.memory.datasetsOf(widget)
  const columns = seen.frame.columns.map((c) => c.name).join(', ')
  const preset = widget.view.preset
  if (preset === 'table' && seen.rowCount === 1) return [`${ONE_ROW_TABLE_MESSAGE}. "${seen.label}" has one row.`]
  const control = controlFor(widget.view, datasets)
  if (!control) return [`preset "${preset}" needs a numeric column; "${seen.label}" has columns ${columns}`]
  if (control.kind === 'chart' && control.panes.length === 0) {
    const need =
      preset === 'curve' ? 'a numeric x column (maturity, strike, years)'
      : preset === 'heatmap' ? 'a group column and numeric columns'
      : preset === 'indicator' ? 'a time column and a close column'
      : 'a time column and a numeric column'
    return [`preset "${preset}" cannot draw "${seen.label}": it needs ${need}; the frame has ${columns}. Use table, stat or facts for it.`]
  }
  if (control.kind === 'chain' && !datasets[primary]?.shape.options) return [`preset "chain" needs an option chain (strike, expiration, option_type); "${seen.label}" has ${columns}`]
  return []
}

// ---------- the tools ----------

export function createTools(deps: ToolDeps) {
  const now = deps.now ?? Date.now
  const memory = deps.memory
  const recipeCatalog = new Catalog(deps.recipes.map(recipeDescriptor))

  /** Returns the error (and records a failed step) when the budget is exhausted. */
  function charge(toolName: Step['tool'], args: unknown, summary: string): string | undefined {
    deps.budget.used += 1
    if (deps.budget.used <= deps.budget.max) return undefined
    const error = `Tool call budget of ${deps.budget.max} per prompt exhausted. Write the reply now with what you have.`
    deps.onStep({ tool: toolName, args, summary: `${summary} · over budget`, ms: 0, error })
    return error
  }

  const find_route = tool({
    description: [
      'Search the catalog of provider routes when no recipe answers the question. Returns up to five routes with their connector, summary, required params, providers and first fields, plus recipe names that match.',
      'Then call `query` with { connector, route, params }. Routes whose last probe failed are hidden. One search per concept; keywords, not sentences.',
    ].join(' '),
    inputSchema: FindRouteInput,
    execute: async (input): Promise<FindRouteResult> => {
      const t0 = now()
      const head = `find_route "${input.query}"`
      const over = charge('find_route', input, head)
      if (over) return { ok: false, error: over }
      try {
        const catalog = deps.catalog ?? (await deps.registry.catalog?.())
        const hits = catalog ? catalog.find(input.query, { limit: 5, ...(input.namespaces ? { namespaces: input.namespaces } : {}) }) : []
        const routes = hits.map((h) => {
          const d = catalog?.get(h.connector, h.route)
          return { ...h, describe: d ? describeDescriptor(d) : `${h.connector} ${h.route} · ${h.summary}` }
        })
        const recipes = recipeCatalog.find(input.query, { limit: 3 }).map((h) => h.route)
        deps.onStep({ tool: 'find_route', args: input, summary: `${head} · ${routes.length} ${routes.length === 1 ? 'hit' : 'hits'}`, ms: now() - t0 })
        const note =
          routes.length === 0 ? 'No route matched. Try other words, drop the namespace filter, or answer from the recipes.'
          : 'Pick the route whose fields hold what you need and call query with { connector, route, params }. Numbers in columns without a unit carry no unit guarantee.'
        return { ok: true, routes, recipes, note }
      } catch (err) {
        const error = errorMessage(err)
        deps.onStep({ tool: 'find_route', args: input, summary: `${head} · failed`, ms: now() - t0, error })
        return { ok: false, error }
      }
    },
  })

  const query = tool({
    description: [
      'Run one recipe ({ recipe, params }) or one route ({ connector, route, params }) and get a preview: columns with their units, rowCount, the rows (all of them when rowCount <= ' +
        `${PREVIEW_MAX_ROWS}, else the first ${PREVIEW_MAX_ROWS}), and per symbol (per series when the frame has one) per numeric column { first, last, min, max, change, changePct }.`,
      'Every number in your reply must come from a preview. Issue independent queries in parallel. `symbols` are arrays; `search` takes one `q` per call.',
      'A column listed in `units` is in that unit (percent means 5.63 is 5.63%); a column not listed carries no unit guarantee, so do not state a unit for it.',
    ].join(' '),
    inputSchema: QueryToolInput,
    execute: async (input): Promise<QueryToolResult> => {
      const t0 = now()
      const resolved = resolveQueryInput(input)
      const head = queryHead(resolved.ok ? resolved.query : rawQueryOf(input))
      const over = charge('query', input, head)
      if (over) return { ok: false, error: over }
      if (!resolved.ok) {
        deps.onStep({ tool: 'query', args: input, summary: `${head} · failed`, ms: now() - t0, error: resolved.error })
        return { ok: false, error: resolved.error }
      }
      const q = resolved.query
      try {
        const frame = await deps.registry.run(q, { signal: deps.signal })
        const seen = memory.remember(q, frame)
        deps.onStep({ tool: 'query', args: q, summary: querySummary(q, frame.rows.length), ms: now() - t0 })
        const shown = seen.preview.rows.length
        const note =
          `${describeQuery(q)} from connector "${frame.meta.connector}": ${seen.rowCount} rows` +
          (shown < seen.rowCount ? `, first ${shown} shown; use stats for the rest or a transform to slice` : '') +
          '. Widgets on this query render the full frame.'
        return previewResult(seen, note)
      } catch (err) {
        const error = errorMessage(err)
        deps.onStep({ tool: 'query', args: q, summary: querySummary(q, undefined, true), ms: now() - t0, error })
        const hint = isRouteQuery(q) && /has no route/.test(error) ? ' Use find_route to find the right route.' : ''
        return { ok: false, error: `${describeQuery(q)} failed: ${error}${hint}` }
      }
    },
  })

  // (b)'s tool body (tools-transform.ts) behind this run's budget and step hooks; a successful result also goes into the
  // preview memory so reply verification and set_workspace's checks see transform previews like any query's.
  const transform = tool({
    description: TRANSFORM_TOOL_DESCRIPTION,
    inputSchema: TransformToolInput,
    execute: async (input): Promise<TransformToolResult> => {
      const res = await runTransformTool({ registry: deps.registry, signal: deps.signal, onStep: deps.onStep, charge: (args, summary) => charge('transform', args, summary), now }, input)
      if (res.ok) {
        try {
          memory.rememberResult(parseAnyQuery(input), { preview: res.preview, fields: res.fields, lineage: res.lineage }, now())
        } catch {
          // the body validated the input already; nothing to record if it somehow does not parse here
        }
      }
      return res
    },
  })

  const set_workspace = tool({
    description: [
      'Replace the workspace widgets with a complete set: four to six by default, not a floor; when the user asks for one or two widgets, send one or two. The first widget is the hero and should be lg.',
      'A widget is { title, size, data: { main: <query>, … }, view: { preset, … } }. Every dataset query is validated (recipe params, route params against the descriptor); for datasets you previewed this turn the preset is checked against the frame: charts need a time column, stat a numeric column, chain an option chain, and a table over a one-row frame is refused (use stat or facts).',
      'Sizes are hints: the grid sizes by content (short tables, stats and facts cards are one row tall; charts two). On errors nothing changes: fix the listed widgets and call again. On success it returns the widget ids to use in [[widget:<id>]] chips.',
    ].join(' '),
    inputSchema: SetWorkspaceInput,
    execute: async (input): Promise<SetWorkspaceResult> => {
      const t0 = now()
      const over = charge('set_workspace', input, workspaceSummary(input.widgets?.length ?? 0))
      if (over) return { ok: false, errors: [over], note: 'Not applied.' }
      const catalog = deps.catalog ?? (await deps.registry.catalog?.().catch(() => undefined))
      const res = validateWidgets(input.widgets, { recipes: deps.recipes, catalog, memory, now: now() })
      if (!res.ok) {
        deps.onStep({
          tool: 'set_workspace',
          args: input,
          summary: workspaceSummary(input.widgets.length, res.errors.length),
          ms: now() - t0,
          error: res.errors.join('; '),
        })
        return { ok: false, errors: res.errors, note: 'Nothing was applied. Fix these widgets and call set_workspace again with the full set.' }
      }
      const name = input.name?.trim() || undefined
      deps.onStep({ tool: 'set_workspace', args: input, summary: workspaceSummary(res.widgets.length), ms: now() - t0 })
      deps.emit({ t: 'widgets', workspaceId: deps.workspaceId, widgets: res.widgets, ...(name ? { name } : {}) })
      deps.onWidgets(res.widgets, name)
      return {
        ok: true,
        widgetIds: res.widgets.map((x) => x.id),
        ...(name ? { name } : {}),
        note: `Applied ${res.widgets.length} widgets. ${layoutNote(res.widgets, memory)}Now write the reply and end it with [[widget:<id>]] chips.`,
      }
    },
  })

  return { find_route, query, transform, set_workspace }
}

export type AgentTools = ReturnType<typeof createTools>

/** The flat `query` input as the query shape it names, unvalidated (for step summaries of inputs that fail). */
function rawQueryOf(input: QueryToolInputT): Record<string, unknown> {
  const params = input.params ?? {}
  if (input.recipe) return { recipe: input.recipe, params }
  if (input.connector && input.route) return { connector: input.connector, route: input.route, params }
  return {}
}

/** The flat `query` input as one AnyQuery, or the reason it is not one. */
export function resolveQueryInput(input: QueryToolInputT): { ok: true; query: AnyQuery } | { ok: false; error: string } {
  const params = { ...(input.params ?? {}) }
  const forms = [input.recipe ? 'recipe' : '', input.connector || input.route ? 'route' : ''].filter(Boolean)
  if (forms.length !== 1) return { ok: false, error: `give exactly one of { recipe, params } or { connector, route, params }; got ${forms.length ? forms.join(' and ') : 'none'}` }
  if (input.recipe) return { ok: true, query: { recipe: input.recipe, params } }
  if (!input.connector || !input.route) return { ok: false, error: 'a route query needs both `connector` and `route`' }
  return { ok: true, query: { connector: input.connector, route: input.route, params } }
}

export function errorMessage(err: unknown): string {
  if (err instanceof z.ZodError) return err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
  if (err instanceof Error) return err.message
  return String(err)
}

export { ViewV2Schema, WidgetV2Schema }
