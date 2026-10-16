// An AgentRunner that never calls an LLM: two fake steps, then use case A's widget set (PLAN.md section 5).
// Used when no LLM key is configured and in tests.
import type { AgentRunner, Kind, Message, ServerMsg, Step, Widget } from '@terminal/core'

export const STUB_SYMBOLS = ['MU', 'SNDK', 'WDC', 'STX'] as const
export const STUB_WORKSPACE_NAME = 'Memory'

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/** Use case A's five widgets. The earnings window is today to +60 days. */
export function stubWidgets(now: Date = new Date()): Widget[] {
  const symbols = [...STUB_SYMBOLS]
  const from = isoDate(now)
  const to = isoDate(new Date(now.getTime() + 60 * 86_400_000))
  return [
    { id: 'memory-3mo', title: 'Memory names, 3 months rebased', size: 'lg', query: { kind: 'ohlcv', params: { symbols, interval: '1d', range: '3mo' } }, view: { type: 'series', normalize: true } },
    { id: 'mu-daily', title: 'MU daily', size: 'md', query: { kind: 'ohlcv', params: { symbols: ['MU'], interval: '1d', range: '6mo' } }, view: { type: 'series', candle: true } },
    { id: 'memory-snapshot', title: 'Basket snapshot', size: 'md', query: { kind: 'quote', params: { symbols } }, view: { type: 'table' } },
    { id: 'memory-earnings', title: 'Upcoming earnings', size: 'sm', query: { kind: 'earnings', params: { symbols, from, to } }, view: { type: 'table' } },
    { id: 'memory-news', title: 'Memory news', size: 'md', query: { kind: 'news', params: { symbols, limit: 20 } }, view: { type: 'table' } },
  ]
}

export const STUB_REPLY =
  'No LLM key is configured, so this is a canned workspace for "What\'s happening with memory?": ' +
  'MU, SNDK, WDC, and STX over three months, MU daily, a basket snapshot, upcoming earnings, and news. ' +
  'Add an LLM key to ~/.terminal/config.yml to get real answers. [[widget:memory-3mo]] [[widget:memory-news]]'

export type StubAgentOptions = {
  now?: () => Date
  /** Pause between emitted messages, for a visible sequence in the UI. */
  delayMs?: number
  /** Kinds a connector can answer right now; widgets on other kinds are left out (e.g. news without a Finnhub key). */
  kinds?: () => Kind[]
}

export function createStubAgentRunner(opts: StubAgentOptions = {}): AgentRunner {
  const now = opts.now ?? (() => new Date())
  const delayMs = opts.delayMs ?? 0
  return {
    async run({ workspace, signal, emit }) {
      const workspaceId = workspace.id
      const symbols = [...STUB_SYMBOLS]
      const steps: Step[] = [
        { tool: 'query', args: { kind: 'search', params: { q: symbols } }, summary: `search ${symbols.join(', ')} · 4 rows`, ms: 120 },
        { tool: 'query', args: { kind: 'ohlcv', params: { symbols, interval: '1d', range: '3mo' } }, summary: `ohlcv ${symbols.join(', ')} 1d 3mo · 252 rows`, ms: 340 },
      ]
      const send = async (m: ServerMsg) => {
        if (signal.aborted) throw new Error('cancelled')
        if (delayMs > 0) await sleep(delayMs, signal)
        emit(m)
      }
      for (const step of steps) await send({ t: 'step', workspaceId, step })
      const answerable = opts.kinds?.()
      const widgets = stubWidgets(now()).filter((w) => !answerable || answerable.includes(w.query.kind))
      await send({ t: 'widgets', workspaceId, widgets, name: STUB_WORKSPACE_NAME })
      if (signal.aborted) throw new Error('cancelled')
      const ids = new Set(widgets.map((w) => w.id))
      const text = STUB_REPLY.replace(/\s*\[\[widget:([^\]]+)\]\]/g, (m, id: string) => (ids.has(id) ? m : ''))
      const message: Message = { role: 'agent', text, steps, at: now().getTime() }
      return message
    },
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      reject(new Error('cancelled'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
