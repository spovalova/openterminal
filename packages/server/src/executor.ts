// Widget execution: run each widget's query through the registry and emit frame / frameError.
// TTL polling: only the focused workspace re-executes widgets when their frame's TTL expires.
import type { Frame, Registry, ServerMsg, Widget, Workspace } from '@terminal/core'

export type Emit = (m: ServerMsg) => void

export type RunOptions = { bypassCache?: boolean; signal?: AbortSignal }

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export class Executor {
  constructor(
    private readonly registry: Registry,
    private readonly opts: { log?: (msg: string) => void } = {},
  ) {}

  /** The frame for a widget: served from cache when fresh, else fetched. Throws on failure. */
  frameFor(widget: Widget, opts: RunOptions = {}): Promise<Frame> {
    return this.registry.run(widget.query, opts)
  }

  /** Run one widget and emit `frame` or `frameError`. Resolves with the frame, or undefined on error. */
  async run(widget: Widget, emit: Emit, opts: RunOptions = {}): Promise<Frame | undefined> {
    try {
      const frame = await this.frameFor(widget, opts)
      emit({ t: 'frame', widgetId: widget.id, frame })
      return frame
    } catch (err) {
      const error = errorMessage(err)
      this.opts.log?.(`widget ${widget.id} (${widget.query.kind}): ${error}`)
      emit({ t: 'frameError', widgetId: widget.id, error })
      return undefined
    }
  }

  /** Run every widget in parallel. Resolves once every frame or frameError has been emitted. */
  async runAll(widgets: Widget[], emit: Emit, opts: RunOptions = {}): Promise<(Frame | undefined)[]> {
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

/**
 * One per client socket. Tracks the client's focused workspace: runs its widgets, then re-runs
 * each one when its frame's TTL expires. Stops when focus moves or the socket closes.
 */
export class Poller {
  private workspaceId: string | undefined
  private widgets = new Map<string, Widget>()
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
  replaceWidgets(workspaceId: string, widgets: Widget[]): Promise<void> | undefined {
    if (workspaceId !== this.workspaceId) return undefined
    this.clearTimers()
    this.generation++
    return this.track(widgets)
  }

  /** The focused workspace's widget with this id, if any. */
  widget(widgetId: string): Widget | undefined {
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

  private track(widgets: Widget[]): Promise<void> {
    this.widgets = new Map(widgets.map((w) => [w.id, w]))
    const gen = this.generation
    return Promise.all(widgets.map((w) => this.cycle(w, gen, false))).then(() => undefined)
  }

  private async cycle(widget: Widget, gen: number, bypassCache: boolean): Promise<void> {
    const signal = this.controller.signal
    const frame = await this.executor.run(widget, this.emit, { bypassCache, signal })
    if (gen !== this.generation || this.widgets.get(widget.id) !== widget) return
    const delay = frame ? Math.max(this.minDelayMs, frame.meta.fetchedAt + frame.meta.ttl - this.now()) : this.errorRetryMs
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
