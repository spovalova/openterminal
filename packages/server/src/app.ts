// HTTP routes (PLAN.md section 7.4) and the WebSocket at /ws.
import { existsSync } from 'node:fs'
import { Hono } from 'hono'
import type { WSContext } from 'hono/ws'
import { serveStatic } from '@hono/node-server/serve-static'
import { createNodeWebSocket } from '@hono/node-ws'
import { z } from 'zod'
import {
  ClientMsgSchema,
  MessageSchema,
  ServerMsgSchema,
  WidgetSchema,
  type AgentRunner,
  type Message,
  type Registry,
  type ServerMsg,
  type Step,
  type Widget,
} from '@terminal/core'
import { saveConnectorConfig } from './config.js'
import { builtinConnector, connectorNeedsKey, describeConnectors, type ConnectorInfo } from './connectors.js'
import { Executor, Poller, errorMessage } from './executor.js'
import type { WorkspaceStore } from './store.js'

export type AppDeps = {
  registry: Registry
  store: WorkspaceStore
  agent: AgentRunner
  /** TERMINAL_HOME, for writing connector config back to config.yml. */
  home: string
  /** Whether an LLM is configured (reported by /api/health). */
  llm: boolean
  log?: (msg: string) => void
  now?: () => number
  /** Built web app to serve in production (static files, SPA fallback). Ignored when the directory does not exist. */
  webDist?: string
}

const NameSchema = z.string().trim().min(1).max(60)
const WorkspaceBodySchema = z.object({
  name: NameSchema.optional(),
  widgets: z.array(WidgetSchema).optional(),
  messages: z.array(MessageSchema).optional(),
})

export type InflightRun = { workspaceId: string; controller: AbortController; startedAt: number }

export function createApp(deps: AppDeps) {
  const log = deps.log ?? (() => {})
  const now = deps.now ?? Date.now
  const { registry, store, agent } = deps
  const executor = new Executor(registry, { log })
  /** One in-flight prompt per workspace, across every client. */
  const inflight = new Map<string, InflightRun>()

  const app = new Hono()
  const { upgradeWebSocket, injectWebSocket, wss } = createNodeWebSocket({ app })

  app.onError((err, c) => {
    if (err instanceof z.ZodError) return c.json({ error: 'invalid body', issues: err.issues }, 400)
    if (err instanceof SyntaxError) return c.json({ error: 'invalid JSON body' }, 400)
    log(`${c.req.method} ${c.req.path}: ${errorMessage(err)}`)
    return c.json({ error: errorMessage(err) }, 500)
  })

  // ---- health ----
  app.get('/api/health', (c) => c.json({ ok: true, kinds: registry.kinds(), llm: deps.llm }))

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
    return removed ? c.body(null, 204) : c.json({ error: 'workspace not found' }, 404)
  })

  // ---- widgets ----
  app.get('/api/widgets/:id/frame', async (c) => {
    const found = await store.findWidget(c.req.param('id'))
    if (!found) return c.json({ error: 'widget not found' }, 404)
    const bypassCache = c.req.query('refresh') === '1'
    try {
      return c.json(await executor.frameFor(found.widget, { bypassCache }))
    } catch (err) {
      return c.json({ error: errorMessage(err) }, 502)
    }
  })

  // ---- connectors ----
  app.get('/api/connectors', (c) => c.json(describeConnectors(registry.connectors())))

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
    const out: ConnectorInfo = { name, kinds: info.kinds, status: info.status, needsKey: connectorNeedsKey(connector), configured: true, ...(info.error ? { error: info.error } : {}) }
    log(`connector ${name}: config saved · ${info.status}`)
    return c.json(out)
  })

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

  /** One per socket: the client's focused workspace, its poller, and the prompt it may be running. */
  class Session {
    private ws: WSContext | undefined
    readonly send = (m: ServerMsg): void => {
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
            await this.refresh(msg.widgetId)
            break
          case 'focus':
            await this.focus(msg.workspaceId)
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
      await this.poller.focus(workspace)
    }

    private async refresh(widgetId: string) {
      if (await this.poller.refresh(widgetId)) return
      const found = await store.findWidget(widgetId)
      if (!found) {
        this.send({ t: 'frameError', widgetId, error: 'widget not found' })
        return
      }
      await executor.run(found.widget, this.send, { bypassCache: true })
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
          if (out.t === 'widgets') executions.push(this.applyWidgets(workspaceId, out.widgets, out.name))
        }
        const reply = await agent.run({ workspace, prompt: text, signal: controller.signal, emit })
        await Promise.all(executions)
        const message: Message = {
          ...reply,
          role: 'agent',
          at: reply.at ?? now(),
          ...(reply.steps ? {} : steps.length > 0 ? { steps } : {}),
        }
        await store.appendMessage(workspaceId, message)
        this.send({ t: 'done', workspaceId, message })
      } catch (err) {
        const error = controller.signal.aborted ? 'cancelled' : errorMessage(err)
        log(`prompt ${workspaceId}: ${error}`)
        this.send({ t: 'failed', workspaceId, error })
      } finally {
        inflight.delete(workspaceId)
      }
    }

    /** Persist the new widget set, then execute it: through the poller when this client has the workspace focused. */
    private async applyWidgets(workspaceId: string, widgets: Widget[], name?: string) {
      const patch = name ? { widgets, name: name.trim().slice(0, 60) || undefined } : { widgets }
      const saved = await store.patch(workspaceId, patch)
      if (!saved) throw new Error('workspace not found')
      const polled = this.poller.replaceWidgets(workspaceId, widgets)
      if (polled) await polled
      else await executor.runAll(widgets, this.send)
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
