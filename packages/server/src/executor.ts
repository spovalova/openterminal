// Widget execution: run each widget's datasets through the registry and emit frame / frameError per dataset.
// TTL polling: only the focused workspace re-executes widgets when their frames' TTLs expire.
//
// A widget is v1 (one `query`, dataset `main`) or v2 (a data graph, PLAN.md section 17). A migrated v2 widget keeps
// its v1 `query`; during the coexistence, when one of its recipe datasets fails (the route it names is not served
// yet), the v1 query answers `main` so the workspace renders as it did before the migration.
import {
  DEFAULT_DATASET,
  describeQuery,
  isLegacyQuery,
  isRouteQuery,
  isTransformQuery,
  isWidgetV2,
  widgetQueries,
  type AnyQuery,
  type AnyWidget,
  type Frame,
  type Registry,
  type ServerMsg,
  type Workspace,
} from '@terminal/core'

export type Emit = (m: ServerMsg) => void

export type RunOptions = { bypassCache?: boolean; signal?: AbortSignal; workspaceId?: string }

export type Frames = Record<string, Frame>
export type DatasetResult = { frames: Frames; errors: Record<string, string>; /** Set when the v1 query answered `main` for a migrated widget. */ legacy?: boolean }

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Setting key for the per-route provider overrides: `{ "openbb:equity/price/quote": "yfinance" }`. */
export const PROVIDER_OVERRIDES_KEY = 'providers'
export type ProviderOverrides = Record<string, string>

/** A route query with the overriding provider applied when it names none; transforms get it on their inputs. */
export function withProviderOverrides(q: AnyQuery, overrides: ProviderOverrides | undefined): AnyQuery {
  if (!overrides || Object.keys(overrides).length === 0) return q
  if (isTransformQuery(q)) {
    const inputs: Record<string, AnyQuery> = {}
    for (const [name, sub] of Object.entries(q.inputs)) inputs[name] = withProviderOverrides(sub, overrides)
    return { ...q, inputs }
  }
  if (isRouteQuery(q)) {
    const provider = overrides[`${q.connector}:${q.route}`]
    if (provider && (q.params.provider === undefined || q.params.provider === null || q.params.provider === '')) return { ...q, params: { ...q.params, provider } }
  }
  return q
}

export type ExecutorOptions = { log?: (msg: string) => void; /** Provider overrides, read per run so the Data page's changes apply live. */ overrides?: () => ProviderOverrides | undefined }

export class Executor {
  constructor(
    private readonly registry: Registry,
    private readonly opts: ExecutorOptions = {},
  ) {}

  private runQuery(q: AnyQuery, opts: RunOptions): Promise<Frame> {
    return this.registry.run(withProviderOverrides(q, this.opts.overrides?.()), { ...(opts.bypassCache ? { bypassCache: true } : {}), ...(opts.signal ? { signal: opts.signal } : {}) })
  }

  /** Every dataset's frame (or error), in parallel. Never throws. */
  async datasets(widget: AnyWidget, opts: RunOptions = {}): Promise<DatasetResult> {
    const queries = widgetQueries(widget)
    const frames: Frames = {}
    const errors: Record<string, string> = {}
    await Promise.all(
      Object.entries(queries).map(async ([name, q]) => {
        try {
          frames[name] = await this.runQuery(q, opts)
        } catch (err) {
          errors[name] = errorMessage(err)
        }
      }),
    )
    const legacy = isWidgetV2(widget) && widget.query && isLegacyQuery(widget.query) ? widget.query : undefined
    if (legacy && Object.keys(errors).length > 0) {
      try {
        const main = await this.runQuery(legacy, opts)
        this.opts.log?.(`widget ${widget.id}: ${Object.entries(errors).map(([n, e]) => `${n}: ${e}`).join(' | ')}; the v1 query answered main`)
        return { frames: { [DEFAULT_DATASET]: main }, errors: {}, legacy: true }
      } catch (err) {
        errors[DEFAULT_DATASET] = errorMessage(err)
      }
    }
    return { frames, errors }
  }

  /** Every dataset's frame; throws when any dataset fails. */
  async framesFor(widget: AnyWidget, opts: RunOptions = {}): Promise<Frames> {
    const r = await this.datasets(widget, opts)
    const failed = Object.entries(r.errors)
    if (failed.length > 0) throw new Error(failed.map(([n, e]) => (n === DEFAULT_DATASET && !isWidgetV2(widget) ? e : `${n}: ${e}`)).join(' | '))
    return r.frames
  }

  /** One frame: the named dataset, else `main`, else the first. Throws on failure. */
  async frameFor(widget: AnyWidget, opts: RunOptions & { dataset?: string } = {}): Promise<Frame> {
    const queries = widgetQueries(widget)
    const name = opts.dataset ?? (queries[DEFAULT_DATASET] ? DEFAULT_DATASET : Object.keys(queries)[0])
    if (!name || !queries[name]) throw new Error(`widget ${widget.id} has no dataset "${opts.dataset ?? DEFAULT_DATASET}"`)
    if (isWidgetV2(widget) && widget.query) {
      // a migrated widget: same fallback as `datasets`
      const r = await this.datasets(widget, opts)
      const f = r.frames[name] ?? (r.legacy ? r.frames[DEFAULT_DATASET] : undefined)
      if (f) return f
      throw new Error(r.errors[name] ?? Object.values(r.errors)[0] ?? 'no frame')
    }
    return this.runQuery(queries[name], opts)
  }

  /** Run one widget and emit `frame` or `frameError` per dataset. Resolves with the frames, or undefined when none landed. */
  async run(widget: AnyWidget, emit: Emit, opts: RunOptions = {}): Promise<Frames | undefined> {
    const r = await this.datasets(widget, opts)
    const scope = opts.workspaceId ? { workspaceId: opts.workspaceId } : {}
    for (const [dataset, frame] of Object.entries(r.frames)) {
      emit({ t: 'frame', widgetId: widget.id, frame, ...scope, ...(dataset === DEFAULT_DATASET ? {} : { dataset }) })
    }
    for (const [dataset, error] of Object.entries(r.errors)) {
      this.opts.log?.(`widget ${widget.id} (${describeQuery(widgetQueries(widget)[dataset]!)}): ${error}`)
      emit({ t: 'frameError', widgetId: widget.id, error, ...scope, ...(dataset === DEFAULT_DATASET ? {} : { dataset }) })
    }
    return Object.keys(r.frames).length > 0 ? r.frames : undefined
  }

  /** Run every widget in parallel. Resolves once every frame or frameError has been emitted. */
  async runAll(widgets: AnyWidget[], emit: Emit, opts: RunOptions = {}): Promise<(Frames | undefined)[]> {
    return Promise.all(widgets.map((w) => this.run(w, emit, opts)))
  }
}

export type PollerOptions = {
  now?: () => number
  /** Never re-run a widget sooner than this after its last frame. */
  minDelayMs?: number
  /** Retry delay after a frameError. */
  errorRetryMs?: number
  log?: (msg: string) => void
}

/** The soonest expiry among a widget's frames. */
export function nextExpiry(frames: Frames): number {
  return Math.min(...Object.values(frames).map((f) => f.meta.fetchedAt + f.meta.ttl))
}

/**
 * One per client socket. Tracks the client's focused workspace: runs its widgets, then re-runs
 * each one when its frames' TTL expires. Stops when focus moves or the socket closes.
 */
export class Poller {
  private workspaceId: string | undefined
  private widgets = new Map<string, AnyWidget>()
  private timers = new Map<string, NodeJS.Timeout>()
  private generation = 0
  private controller = new AbortController()
  private readonly now: () => number
  private readonly minDelayMs: number
  private readonly errorRetryMs: number

  constructor(
    private readonly executor: Executor,
    private readonly emit: Emit,
    opts: PollerOptions = {},
  ) {
    this.now = opts.now ?? Date.now
    this.minDelayMs = opts.minDelayMs ?? 1_000
    this.errorRetryMs = opts.errorRetryMs ?? 30_000
  }

  get focusedWorkspaceId(): string | undefined {
    return this.workspaceId
  }

  /** Focus a workspace: stop polling the previous one, run every widget, start the TTL timers. */
  focus(workspace: Workspace): Promise<void> {
    this.stop()
    this.workspaceId = workspace.id
    return this.track(workspace.widgets)
  }

  /** Replace the focused workspace's widgets (after a prompt). No-op for an unfocused workspace. */
  replaceWidgets(workspaceId: string, widgets: AnyWidget[]): Promise<void> | undefined {
    if (workspaceId !== this.workspaceId) return undefined
    this.clearTimers()
    this.generation++
    return this.track(widgets)
  }

  /** The focused workspace's widget with this id, if any. */
  widget(widgetId: string): AnyWidget | undefined {
    return this.widgets.get(widgetId)
  }

  /** Re-run a focused widget bypassing the cache. Resolves false when the widget is not focused. */
  async refresh(widgetId: string): Promise<boolean> {
    const widget = this.widgets.get(widgetId)
    if (!widget) return false
    this.clearTimer(widgetId)
    await this.cycle(widget, this.generation, true)
    return true
  }

  /** Stop every timer and abort in-flight fetches. */
  stop(): void {
    this.clearTimers()
    this.generation++
    this.controller.abort()
    this.controller = new AbortController()
    this.workspaceId = undefined
    this.widgets.clear()
  }

  private track(widgets: AnyWidget[]): Promise<void> {
    this.widgets = new Map(widgets.map((w) => [w.id, w]))
    const gen = this.generation
    return Promise.all(widgets.map((w) => this.cycle(w, gen, false))).then(() => undefined)
  }

  private async cycle(widget: AnyWidget, gen: number, bypassCache: boolean): Promise<void> {
    const signal = this.controller.signal
    const frames = await this.executor.run(widget, this.emit, { bypassCache, signal, ...(this.workspaceId ? { workspaceId: this.workspaceId } : {}) })
    if (gen !== this.generation || this.widgets.get(widget.id) !== widget) return
    const delay = frames ? Math.max(this.minDelayMs, nextExpiry(frames) - this.now()) : this.errorRetryMs
    this.clearTimer(widget.id)
    const timer = setTimeout(() => {
      this.timers.delete(widget.id)
      if (gen !== this.generation) return
      void this.cycle(widget, gen, false)
    }, delay)
    timer.unref()
    this.timers.set(widget.id, timer)
  }

  private clearTimer(widgetId: string): void {
    const t = this.timers.get(widgetId)
    if (t) clearTimeout(t)
    this.timers.delete(widgetId)
  }

  private clearTimers(): void {
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
  }
}
