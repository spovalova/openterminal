// HTTP routes (PLAN.md section 7.4) and the WebSocket at /ws.
import { existsSync } from 'node:fs'
import { Hono } from 'hono'
import type { WSContext } from 'hono/ws'
import { serveStatic } from '@hono/node-server/serve-static'
import { createNodeWebSocket } from '@hono/node-ws'
import { z } from 'zod'
import {
  AnyWidgetSchema,
  ClientMsgSchema,
  MessageSchema,
  ServerMsgSchema,
  buildSnapshot,
  heldFrames,
  canonicalKey,
  releaseSnapshot,
  snapshotCurrent,
  type AgentRunner,
  type AnyQuery,
  type AnyWidget,
  type Frame,
  type Message,
  type Recipe,
  type ReplySnapshot,
  type ServerMsg,
  type Step,
} from '@openterminal/core'
import { LlmConfigSchema, PROVIDERS, saveConnectorConfig, saveLlmConfig, resolvedLlm, type Provider } from './config.js'
import { builtinConnector, connectorNeedsKey, describeConnectors, type ConnectorInfo } from './connectors.js'
import { Executor, PROVIDER_OVERRIDES_KEY, Poller, errorMessage, type ProviderOverrides } from './executor.js'
import { localOnly, type GuardOptions } from './guard.js'
import { createDataRoutes, type DataRouteDeps, type ProbeFn } from './routes-data.js'
import type { Store } from './store/index.js'

export type AppDeps = {
  registry: DataRouteDeps['registry']
  store: Store
  agent: AgentRunner
  /** The home directory (~/.openterminal or OPENTERMINAL_HOME), for writing connector config back to config.yml. */
  home: string
  /** Whether an LLM is configured (reported by /api/health). */
  llm: boolean
  /** The configured provider and model, for GET /api/llm (never the key). */
  llmInfo?: { provider: Provider; model: string }
  /**
   * Builds the real agent for a key saved through PUT /api/llm, so the app switches from the stub without a restart.
   * Without it, PUT /api/llm saves the key and answers that a restart is needed.
   */
  makeAgent?: (llm: { provider: Provider; model: string; apiKey: string }) => AgentRunner
  /** Which hosts and origins may reach the app (guard.ts); loopback and the app's own origin always may. */
  guard?: GuardOptions
  log?: (msg: string) => void
  now?: () => number
  /** Built web app to serve in production (static files, SPA fallback). Ignored when the directory does not exist. */
  webDist?: string
  /** The built-in recipes (from `@openterminal/core/node`); the data routes list them beside the user's. */
  builtinRecipes?: () => Recipe[]
  /** (a)'s catalog probe, when wired in; `POST /api/catalog/probe` answers 501 without it. */
  probe?: ProbeFn
  /** Extra fields for `GET /api/store` (the store kind, the migration report). */
  storeInfo?: () => Record<string, unknown>
}

const NameSchema = z.string().trim().min(1).max(60)
const WorkspaceBodySchema = z.object({
  name: NameSchema.optional(),
  widgets: z.array(AnyWidgetSchema).optional(),
  messages: z.array(MessageSchema).optional(),
})

export type InflightRun = { workspaceId: string; controller: AbortController; startedAt: number }

export function createApp(deps: AppDeps) {
  const log = deps.log ?? (() => {})
  const now = deps.now ?? Date.now
  const { registry, store } = deps
  // The agent and whether it is the real one change when a key is saved through PUT /api/llm.
  let agent = deps.agent
  let llmOn = deps.llm
  let llmInfo = deps.llmInfo
  const executor = new Executor(registry, { log, overrides: () => store.getSetting<ProviderOverrides>(PROVIDER_OVERRIDES_KEY) })
  /** One in-flight prompt per workspace, across every client. */
  const inflight = new Map<string, InflightRun>()

  const app = new Hono()
  const { upgradeWebSocket, injectWebSocket, wss } = createNodeWebSocket({ app })

  app.use('*', localOnly(deps.guard, log))

  app.onError((err, c) => {
    if (err instanceof z.ZodError) return c.json({ error: 'invalid body', issues: err.issues }, 400)
    if (err instanceof SyntaxError) return c.json({ error: 'invalid JSON body' }, 400)
    log(`${c.req.method} ${c.req.path}: ${errorMessage(err)}`)
    return c.json({ error: errorMessage(err) }, 500)
  })

  // ---- health ----
  app.get('/api/health', (c) =>
    c.json({
      ok: true,
      connectors: registry.connectors().filter((x) => x.status === 'ok').map((x) => x.name),
      recipes: registry.recipes?.().length ?? 0,
      llm: llmOn,
    }),
  )

  // ---- the LLM key (the app's onboarding screen) ----
  // The key is written to config.yml (mode 600) and never sent back: GET answers the provider and model only.
  app.get('/api/llm', (c) => c.json({ configured: llmOn, ...(llmOn && llmInfo ? llmInfo : {}), providers: PROVIDERS }))

  app.put('/api/llm', async (c) => {
    const parsed = LlmConfigSchema.safeParse(await jsonBody(c.req.raw))
    if (!parsed.success) return c.json({ error: 'invalid key', issues: parsed.error.issues.map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`) }, 400)
    const llm = { provider: parsed.data.provider, apiKey: parsed.data.apiKey.trim(), ...(parsed.data.model ? { model: parsed.data.model } : {}) }
    const config = saveLlmConfig(deps.home, llm)
    const resolved = resolvedLlm(config)
    if (!resolved) return c.json({ error: 'the key was saved but could not be read back' }, 500)
    llmInfo = { provider: resolved.provider, model: resolved.model }
    if (!deps.makeAgent) {
      log(`llm: ${resolved.provider} key saved; applies after a restart`)
      return c.json({ configured: false, saved: true, restart: true, ...llmInfo })
    }
    agent = deps.makeAgent(resolved)
    llmOn = true
    log(`llm: ${resolved.provider} ${resolved.model} key saved; the agent is live`)
    return c.json({ configured: true, ...llmInfo })
  })

  // ---- workspaces ----
  app.get('/api/workspaces', async (c) => c.json(await store.list()))

  app.post('/api/workspaces', async (c) => {
    const body = WorkspaceBodySchema.parse(await jsonBody(c.req.raw))
    const ws = await store.create(body)
    return c.json(ws, 201)
  })

  app.get('/api/workspaces/:id', async (c) => {
    const ws = await store.get(c.req.param('id'))
    return ws ? c.json(ws) : c.json({ error: 'workspace not found' }, 404)
  })

  app.patch('/api/workspaces/:id', async (c) => {
    const body = WorkspaceBodySchema.parse(await jsonBody(c.req.raw))
    const ws = await store.patch(c.req.param('id'), body)
    return ws ? c.json(ws) : c.json({ error: 'workspace not found' }, 404)
  })

  app.delete('/api/workspaces/:id', async (c) => {
    const id = c.req.param('id')
    inflight.get(id)?.controller.abort()
    const removed = await store.delete(id)
    if (removed) store.setSetting(snapshotKey(id), undefined)
    return removed ? c.body(null, 204) : c.json({ error: 'workspace not found' }, 404)
  })

  // ---- widgets ----
  // `?workspace=` scopes the lookup: widget ids repeat across workspaces (w1..wN in every one), so without it the
  // first workspace holding the id answers, which may be another tab's widget. The web always passes it (phase 2).
  app.get('/api/widgets/:id/frame', async (c) => {
    const id = c.req.param('id')
    const workspaceId = c.req.query('workspace') || undefined
    let widget: AnyWidget | undefined
    if (workspaceId) {
      const ws = await store.get(workspaceId)
      if (!ws) return c.json({ error: 'workspace not found' }, 404)
      widget = ws.widgets.find((w) => w.id === id)
    } else widget = (await store.findWidget(id))?.widget
    if (!widget) return c.json({ error: 'widget not found' }, 404)
    const bypassCache = c.req.query('refresh') === '1'
    const dataset = c.req.query('dataset') || undefined
    // The reply's held frame when the snapshot holds this widget (taste round 2, change 5): the HTTP fallback a page
    // uses before its socket opens must not overwrite the held frames with live ones.
    const held = workspaceId && !bypassCache ? heldFrames(readSnapshot(workspaceId), widget, now()) : undefined
    const heldFrame = held ? (held[dataset ?? 'main'] ?? Object.values(held)[0]) : undefined
    if (heldFrame) return c.json(heldFrame)
    try {
      return c.json(await executor.frameFor(widget, { bypassCache, ...(dataset ? { dataset } : {}) }))
    } catch (err) {
      return c.json({ error: errorMessage(err) }, 502)
    }
  })

  // ---- connectors ----
  app.get('/api/connectors', async (c) => c.json(await describeConnectors(registry)))

  app.put('/api/connectors/:name/config', async (c) => {
    const name = c.req.param('name')
    const connector = builtinConnector(name)
    if (!connector) return c.json({ error: `unknown connector "${name}"` }, 404)
    const body = await jsonBody(c.req.raw)
    if (!body || typeof body !== 'object' || Array.isArray(body)) return c.json({ error: 'config must be an object' }, 400)
    const config = body as Record<string, unknown>
    const parsed = connector.config.safeParse(config)
    if (!parsed.success) {
      return c.json({ error: 'invalid config', issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) }, 400)
    }
    saveConnectorConfig(deps.home, name, config)
    // Apply live. A connector new to the file is appended, matching its place in the file; an existing one
    // keeps its config but moves to the end of the routing order until restart (the registry has no reorder).
    const info = registry.register(connector, config)
    const out: ConnectorInfo = { name, status: info.status, needsKey: connectorNeedsKey(connector), configured: true, ...(info.error ? { error: info.error } : {}) }
    log(`connector ${name}: config saved · ${info.status}`)
    return c.json(out)
  })

  // ---- data: catalog, recipes, export and import, ad-hoc queries, settings, run log ----
  app.route(
    '/',
    createDataRoutes({
      registry,
      store,
      home: deps.home,
      builtinRecipes: deps.builtinRecipes ?? (() => registry.recipes?.() ?? []),
      log,
      now,
      ...(deps.probe ? { probe: deps.probe } : {}),
      ...(deps.storeInfo ? { storeInfo: deps.storeInfo } : {}),
    }),
  )

  app.all('/api/*', (c) => c.json({ error: 'not found' }, 404))

  // ---- websocket ----
  app.get(
    '/ws',
    upgradeWebSocket(() => {
      const session = new Session()
      return {
        onOpen: (_evt, ws) => session.open(ws),
        onMessage: (evt, _ws) => {
          if (typeof evt.data === 'string') void session.handle(evt.data)
        },
        onClose: () => session.close(),
        onError: (evt) => log(`ws error: ${errorMessage((evt as { error?: unknown }).error ?? evt)}`),
      }
    }, { onError: (err) => log(`ws: ${errorMessage(err)}`) }),
  )

  // ---- web app (production) ----
  if (deps.webDist && existsSync(deps.webDist)) {
    const root = deps.webDist
    app.use('*', serveStatic({ root }))
    app.get('*', serveStatic({ root, path: 'index.html' }))
    log(`serving web app from ${root}`)
  }

  /** The reply's snapshot of a workspace lives in settings (taste round 2, change 5): one per workspace, the latest reply's. */
  const snapshotKey = (workspaceId: string) => `snapshot:${workspaceId}`
  const readSnapshot = (workspaceId: string): ReplySnapshot | undefined => {
    const snap = store.getSetting<ReplySnapshot>(snapshotKey(workspaceId))
    if (snap && !snapshotCurrent(snap, now())) {
      // A reply from an earlier trading day: the workspace is live again.
      store.setSetting(snapshotKey(workspaceId), undefined)
      return undefined
    }
    return snap
  }
  const releaseStored = (workspaceId: string, widgetId?: string) => {
    const snap = store.getSetting<ReplySnapshot>(snapshotKey(workspaceId))
    if (!snap) return
    const next = releaseSnapshot(snap, widgetId ? [widgetId] : undefined)
    store.setSetting(snapshotKey(workspaceId), Object.keys(next.widgets).length > 0 ? next : undefined)
  }

  /** One per socket: the client's focused workspace, its poller, and the prompt it may be running. */
  class Session {
    private ws: WSContext | undefined
    /** While a prompt runs: the frames its workspace's widgets showed, by `widgetId/dataset` (the reply's snapshot). */
    private readonly captures = new Map<string, Map<string, Frame>>()
    readonly send = (m: ServerMsg): void => {
      const shown = m.t === 'frame' && m.workspaceId ? this.captures.get(m.workspaceId) : undefined
      if (shown && m.t === 'frame') shown.set(`${m.widgetId}/${m.dataset ?? 'main'}`, m.frame)
      if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(m))
    }
    private readonly poller = new Poller(executor, this.send, { now, log })

    open(ws: WSContext) {
      this.ws = ws
    }

    close() {
      this.poller.stop()
      this.ws = undefined
    }

    async handle(raw: string) {
      let data: unknown
      try {
        data = JSON.parse(raw)
      } catch {
        log('ws: ignoring non-JSON message')
        return
      }
      const parsed = ClientMsgSchema.safeParse(data)
      if (!parsed.success) {
        log(`ws: ignoring invalid message: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
        return
      }
      const msg = parsed.data
      try {
        switch (msg.t) {
          case 'prompt':
            await this.prompt(msg.workspaceId, msg.text)
            break
          case 'cancel':
            inflight.get(msg.workspaceId)?.controller.abort()
            break
          case 'refresh':
            await this.refresh(msg.widgetId, msg.workspaceId)
            break
          case 'focus':
            await this.focus(msg.workspaceId)
            break
          case 'live':
            releaseStored(msg.workspaceId, msg.widgetId)
            if (this.poller.focusedWorkspaceId === msg.workspaceId) await this.poller.release(msg.widgetId)
            break
        }
      } catch (err) {
        log(`ws ${msg.t}: ${errorMessage(err)}`)
      }
    }

    private async focus(workspaceId: string) {
      const workspace = await store.get(workspaceId)
      if (!workspace) {
        this.poller.stop()
        this.send({ t: 'failed', workspaceId, error: 'workspace not found' })
        return
      }
      await this.poller.focus(workspace, readSnapshot(workspace.id))
    }

    private async refresh(widgetId: string, workspaceId?: string) {
      // A refresh is a request for live data: the widget leaves the reply's snapshot.
      if (workspaceId) releaseStored(workspaceId, widgetId)
      if (await this.poller.refresh(widgetId)) return
      // Widget ids are unique only within a workspace, so prefer the workspace the client names.
      const scoped = workspaceId ? (await store.get(workspaceId))?.widgets.find((w) => w.id === widgetId) : undefined
      const widget = scoped ?? (await store.findWidget(widgetId))?.widget
      if (!widget) {
        this.send({ t: 'frameError', widgetId, error: 'widget not found' })
        return
      }
      await executor.run(widget, this.send, { bypassCache: true, ...(workspaceId ? { workspaceId } : {}) })
    }

    /** started → step… → widgets (persist, execute, frame…) → done; failed replaces anything after started. */
    private async prompt(workspaceId: string, text: string) {
      if (inflight.has(workspaceId)) {
        this.send({ t: 'failed', workspaceId, error: 'a prompt is already running for this workspace' })
        return
      }
      const initial = await store.get(workspaceId)
      if (!initial) {
        this.send({ t: 'failed', workspaceId, error: 'workspace not found' })
        return
      }
      const controller = new AbortController()
      inflight.set(workspaceId, { workspaceId, controller, startedAt: now() })
      this.send({ t: 'started', workspaceId })
      // One snapshot for the reply and the widgets (taste round 2, change 5): every frame the run fetches is kept by
      // query; the widgets it sets are shown those very frames, and when the reply is done the frames on screen are
      // held (no live refresh) until the user asks for live data, so the verified figures and the widgets agree.
      const seen = new Map<string, Frame>()
      const overlay = (q: AnyQuery) => seen.get(canonicalKey(q))
      const shown = new Map<string, Frame>()
      this.captures.set(workspaceId, shown)
      try {
        const workspace = (await store.appendMessage(workspaceId, { role: 'user', text, at: now() })) ?? initial
        const executions: Promise<void>[] = []
        const steps: Step[] = []
        const emit = (m: ServerMsg) => {
          const ok = ServerMsgSchema.safeParse(m)
          if (!ok.success) {
            log(`agent emitted an invalid message (${(m as { t?: string }).t}): ${ok.error.issues[0]?.message}`)
            return
          }
          const out = ok.data
          if (out.t === 'step') steps.push(out.step)
          this.send(out)
          if (out.t === 'widgets') executions.push(this.applyWidgets(workspaceId, out.widgets, out.name, overlay))
        }
        const record = (q: AnyQuery, frame: Frame) => {
          seen.set(canonicalKey(q), frame)
        }
        const reply = await agent.run({ workspace, prompt: text, signal: controller.signal, emit, record })
        await Promise.all(executions)
        const message: Message = {
          ...reply,
          role: 'agent',
          at: reply.at ?? now(),
          ...(reply.steps ? {} : steps.length > 0 ? { steps } : {}),
        }
        await store.appendMessage(workspaceId, message)
        const current = await store.get(workspaceId)
        if (current) {
          const snapshot = buildSnapshot(current.widgets, shown, overlay, message.at ?? now())
          store.setSetting(snapshotKey(workspaceId), Object.keys(snapshot.widgets).length > 0 ? snapshot : undefined)
          this.poller.hold(workspaceId, snapshot)
        }
        this.send({ t: 'done', workspaceId, message })
      } catch (err) {
        const error = controller.signal.aborted ? 'cancelled' : errorMessage(err)
        log(`prompt ${workspaceId}: ${error}`)
        this.send({ t: 'failed', workspaceId, error })
      } finally {
        this.captures.delete(workspaceId)
        inflight.delete(workspaceId)
      }
    }

    /** Persist the new widget set, then execute it: through the poller when this client has the workspace focused. */
    private async applyWidgets(workspaceId: string, widgets: AnyWidget[], name?: string, overlay?: (q: AnyQuery) => Frame | undefined) {
      const patch = name ? { widgets, name: name.trim().slice(0, 60) || undefined } : { widgets }
      const saved = await store.patch(workspaceId, patch)
      if (!saved) throw new Error('workspace not found')
      const polled = this.poller.replaceWidgets(workspaceId, widgets, overlay)
      if (polled) await polled
      else await executor.runAll(widgets, this.send, { workspaceId, ...(overlay ? { overlay } : {}) })
    }
  }

  return { app, injectWebSocket, wss, executor, inflight }
}

export type App = ReturnType<typeof createApp>

async function jsonBody(req: Request): Promise<unknown> {
  const text = await req.text()
  if (text.trim().length === 0) return {}
  return JSON.parse(text) as unknown
}
