import { tool } from 'ai'
import { z } from 'zod'
import {
  KIND_NAMES,
  QuerySchema,
  WidgetSchema,
  parseQuery,
  preview,
  PREVIEW_MAX_ROWS,
  type Kind,
  type Preview,
  type Query,
  type Registry,
  type ServerMsg,
  type Step,
  type Widget,
} from '@terminal/core'

/** Hard cap of tool calls per prompt, including set_workspace. */
export const MAX_TOOL_CALLS = 10

/** Mutable per-run budget shared by the tools and the loop. */
export type ToolBudget = { used: number; max: number }

export type ToolDeps = {
  registry: Registry
  workspaceId: string
  /** Kinds answerable right now; widgets on other kinds are rejected so they never render as permanent errors. */
  answerable: Kind[]
  signal: AbortSignal
  emit(m: ServerMsg): void
  /** Called once per tool call with the finished step (also when it failed). */
  onStep(step: Step): void
  /** Called when set_workspace succeeds, with the validated widgets. */
  onWidgets(widgets: Widget[], name?: string): void
  budget: ToolBudget
  now?: () => number
}

// ---------- input schemas, derived from core ----------

/** `query` takes exactly a core Query: the kind discriminates the params. */
export const QueryToolInput = QuerySchema

const widgetShape = WidgetSchema.shape
/** A Widget whose id is optional; ids are assigned (w1..wN) when missing or colliding. */
export const WidgetToolInput = z.object({ ...widgetShape, id: widgetShape.id.optional().describe('Optional. Assigned as w1..wN when omitted.') })
export type WidgetToolInputT = z.input<typeof WidgetToolInput>

export const SetWorkspaceInput = z.object({
  name: z.string().trim().min(1).max(60).optional().describe('Short workspace name, two to four words. Set it on the first prompt.'),
  widgets: z.array(WidgetToolInput).min(1).max(8).describe('The complete widget set. The first widget is the hero.'),
})
export type SetWorkspaceInputT = z.input<typeof SetWorkspaceInput>

export type QueryToolResult =
  | { ok: true; kind: Kind; connector: string; note: string; preview: Preview }
  | { ok: false; error: string }
export type SetWorkspaceResult =
  | { ok: true; widgetIds: string[]; name?: string; note: string }
  | { ok: false; errors: string[]; note: string }

// ---------- summaries ----------

/** One-line step summary, e.g. `ohlcv MU, SNDK, WDC, STX 1d 3mo · 252 rows`. */
export function querySummary(input: unknown, rowCount?: number, failed = false): string {
  const head = queryHead(input)
  if (failed) return `${head} · failed`
  return rowCount === undefined ? head : `${head} · ${rowCount} ${rowCount === 1 ? 'row' : 'rows'}`
}

function queryHead(input: unknown): string {
  const q = (input ?? {}) as { kind?: unknown; params?: Record<string, unknown> }
  const kind = typeof q.kind === 'string' ? q.kind : 'query'
  const p = q.params ?? {}
  const list = (v: unknown) => (Array.isArray(v) ? v.map(String).join(', ') : typeof v === 'string' ? v : '')
  switch (kind) {
    case 'search':
      return `search ${list(p.q)}`.trim()
    case 'ohlcv':
      return `ohlcv ${list(p.symbols)} ${p.interval ?? ''} ${p.range ?? ''}`.replace(/\s+/g, ' ').trim()
    case 'news':
      return `news ${list(p.symbols)}`.trim()
    case 'earnings':
      return `earnings ${list(p.symbols)} ${p.from ?? ''}→${p.to ?? ''}`.replace(/\s+/g, ' ').trim()
    case 'quote':
      return `quote ${list(p.symbols)}`.trim()
    default:
      return `${kind} ${list(p.symbols)}`.trim()
  }
}

export function workspaceSummary(count: number, invalid = 0): string {
  if (invalid > 0) return `set_workspace · ${invalid} invalid ${invalid === 1 ? 'widget' : 'widgets'}`
  return `set_workspace · ${count} ${count === 1 ? 'widget' : 'widgets'}`
}

// ---------- widget validation ----------

/**
 * Assign ids and validate every widget with core's WidgetSchema (refinements included).
 * Returns the validated widgets or the list of errors, one line per problem, keyed by index.
 */
export function validateWidgets(input: WidgetToolInputT[], answerable: Kind[]): { ok: true; widgets: Widget[] } | { ok: false; errors: string[] } {
  const errors: string[] = []
  const widgets: Widget[] = []
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
    const res = WidgetSchema.safeParse({ ...raw, id })
    if (!res.success) {
      for (const issue of res.error.issues) errors.push(`widgets[${i}] ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      return
    }
    const kind = res.data.query.kind
    if (!answerable.includes(kind)) {
      errors.push(`widgets[${i}] query.kind: "${kind}" is not answerable now (answerable: ${answerable.join(', ') || 'none'})`)
      return
    }
    widgets.push(res.data)
  })
  return errors.length > 0 ? { ok: false, errors } : { ok: true, widgets }
}

// ---------- the tools ----------

export function createTools(deps: ToolDeps) {
  const now = deps.now ?? Date.now

  /** Returns false (and records a failed step) when the budget is exhausted. */
  function charge(toolName: Step['tool'], args: unknown, summary: string): string | undefined {
    deps.budget.used += 1
    if (deps.budget.used <= deps.budget.max) return undefined
    const error = `Tool call budget of ${deps.budget.max} per prompt exhausted. Write the reply now with what you have.`
    deps.onStep({ tool: toolName, args, summary: `${summary} · over budget`, ms: 0, error })
    return error
  }

  const query = tool({
    description: [
      'Run one query against the connectors and get a preview: columns, rowCount, the rows (all of them when rowCount <= ' +
        `${PREVIEW_MAX_ROWS}, else the first ${PREVIEW_MAX_ROWS}), and per symbol per numeric column { first, last, min, max, changePct }.`,
      'Every number in your reply must come from a preview. Issue independent queries in parallel. Batch all symbol lookups into one search call.',
      `Kinds: ${KIND_NAMES.join(', ')}.`,
    ].join(' '),
    inputSchema: QueryToolInput,
    execute: async (input): Promise<QueryToolResult> => {
      const t0 = now()
      const over = charge('query', input, queryHead(input))
      if (over) return { ok: false, error: over }
      let q: Query
      try {
        q = parseQuery(input)
      } catch (err) {
        const error = `invalid query: ${errorMessage(err)}`
        deps.onStep({ tool: 'query', args: input, summary: querySummary(input, undefined, true), ms: now() - t0, error })
        return { ok: false, error }
      }
      try {
        const frame = await deps.registry.run(q, { signal: deps.signal })
        const pv = preview(frame)
        deps.onStep({ tool: 'query', args: q, summary: querySummary(q, frame.rows.length), ms: now() - t0 })
        const shown = pv.rows.length
        const note =
          `${q.kind} from connector "${frame.meta.connector}": ${pv.rowCount} rows` +
          (shown < pv.rowCount ? `, first ${shown} shown; use stats for the rest` : '') +
          '. Widgets on this query render the full frame.'
        return { ok: true, kind: q.kind, connector: frame.meta.connector, note, preview: pv }
      } catch (err) {
        const error = errorMessage(err)
        deps.onStep({ tool: 'query', args: q, summary: querySummary(q, undefined, true), ms: now() - t0, error })
        return { ok: false, error: `${q.kind} failed: ${error}` }
      }
    },
  })

  const set_workspace = tool({
    description: [
      'Replace the workspace widgets with a complete set (four to six). The first widget is the hero and should be lg.',
      'Every widget is validated: series views only on ohlcv; candle needs exactly one symbol; candle and normalize are exclusive; kinds must be answerable.',
      'On errors nothing changes: fix the listed widgets and call again. On success it returns the widget ids to use in [[widget:<id>]] chips.',
    ].join(' '),
    inputSchema: SetWorkspaceInput,
    execute: async (input): Promise<SetWorkspaceResult> => {
      const t0 = now()
      const over = charge('set_workspace', input, workspaceSummary(input.widgets?.length ?? 0))
      if (over) return { ok: false, errors: [over], note: 'Not applied.' }
      const res = validateWidgets(input.widgets, deps.answerable)
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
        note: `Applied ${res.widgets.length} widgets. Now write the reply and end it with [[widget:<id>]] chips.`,
      }
    },
  })

  return { query, set_workspace }
}

export type AgentTools = ReturnType<typeof createTools>

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
