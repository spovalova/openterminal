// Test helpers for the agent loop: a fake connector with canned frames and a scripted mock model.
// No network, no real LLM.
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test'
import { z } from 'zod'
import { ConnectorRegistry, KINDS, createWorkspace, defineConnector, parseRecipes, toFrame, zodToJsonSchemaObject, type Kind, type Recipe, type ServerMsg, type Workspace } from '@terminal/core'

// Spec types, derived from the mock so this file needs no direct dependency on @ai-sdk/provider.
type CallOptions = Parameters<MockLanguageModelV4['doStream']>[0]
type StreamResult = Awaited<ReturnType<MockLanguageModelV4['doStream']>>
type StreamPart = StreamResult['stream'] extends ReadableStream<infer T> ? T : never

// ---------- fake connector ----------

export type FakeConnectorOptions = {
  /** Called at the start of every handler, with the kind. Use it to abort or count. */
  onCall?: (kind: string, params: Record<string, unknown>) => void | Promise<void>
  /** Kinds that throw instead of answering. */
  failing?: string[]
}

export function createFakeRegistry(opts: FakeConnectorOptions = {}) {
  const calls: { kind: string; params: Record<string, unknown> }[] = []
  const hook = async (kind: string, params: Record<string, unknown>) => {
    calls.push({ kind, params })
    await opts.onCall?.(kind, params)
    if (opts.failing?.includes(kind)) throw new Error(`${kind} is down`)
  }
  const connector = defineConnector({
    name: 'fake',
    config: z.object({}),
    queries: {
      search: async (p) => {
        await hook('search', p)
        return toFrame(
          'search',
          p.q.map((q) => ({ query: q, symbol: q.toUpperCase().slice(0, 5), name: `${q} Inc`, exchange: 'NMS' })),
          { connector: 'fake' },
        )
      },
      quote: async (p) => {
        await hook('quote', p)
        return toFrame(
          'quote',
          p.symbols.map((s, i) => ({
            symbol: s,
            price: 100 + i,
            change_pct: -1.5 * (i + 1),
            volume: 1_000_000 * (i + 1),
            market_state: 'REGULAR',
            extended_price: null,
            extended_change_pct: null,
          })),
          { connector: 'fake' },
        )
      },
      ohlcv: async (p) => {
        await hook('ohlcv', p)
        const bars = p.range === '1d' ? 78 : p.range === '5d' ? 5 : p.range === '6mo' ? 126 : 63
        const stepMs = p.interval === '5m' ? 5 * 60_000 : 86_400_000
        const t0 = Date.UTC(2026, 9, 16, 13, 30)
        const rows: Record<string, unknown>[] = []
        p.symbols.forEach((s, si) => {
          for (let i = 0; i < bars; i++) {
            const close = 100 + si * 10 + i * 0.5
            rows.push({ symbol: s, time: t0 + i * stepMs, open: close - 0.2, high: close + 1, low: close - 1, close, volume: 1000 + i })
          }
        })
        return toFrame('ohlcv', rows, { connector: 'fake' })
      },
      news: async (p) => {
        await hook('news', p)
        const rows: Record<string, unknown>[] = []
        for (let i = 0; i < Math.min(p.limit, 20); i++) {
          const s = p.symbols[i % p.symbols.length]!
          rows.push({ time: Date.UTC(2026, 9, 16) - i * 3_600_000, headline: `${s} headline ${i}`, source: 'Wire', url: `https://example.com/${s}/${i}`, symbol: s })
        }
        return toFrame('news', rows, { connector: 'fake' })
      },
      earnings: async (p) => {
        await hook('earnings', p)
        return toFrame(
          'earnings',
          p.symbols.map((s, i) => ({ symbol: s, date: `2026-12-${String(1 + i).padStart(2, '0')}`, session: i % 2 ? 'bmo' : 'amc', eps_estimate: 1 + i })),
          { connector: 'fake' },
        )
      },
      // v1.2 kinds with the two non-table views: options (chain) and macro (series keyed by `series`).
      options: async (p) => {
        await hook('options', p)
        const expiration = p.expiration ?? '2026-11-20'
        const rows: Record<string, unknown>[] = []
        for (const type of p.type === 'both' ? ['call', 'put'] : [p.type]) {
          for (let i = -p.strikes; i < p.strikes; i++) {
            const strike = 100 + i * 5
            rows.push({ symbol: p.symbol, expiration, type, strike, bid: 1, ask: 1.2, last: 1.1, volume: 10, open_interest: 100, iv: 45, delta: 0.5, gamma: 0.01, theta: -0.1, vega: 0.2, underlying_price: 101, dte: 33 })
          }
        }
        return toFrame('options', rows, { connector: 'fake' })
      },
      macro: async (p) => {
        await hook('macro', p)
        const rows: Record<string, unknown>[] = []
        p.series.forEach((series, si) => {
          for (let i = 0; i < 12; i++) rows.push({ series, time: Date.UTC(2025, 10 + i, 1), value: 4 - si * 0.5 + i * 0.01 })
        })
        return toFrame('macro', rows, { connector: 'fake' })
      },
    },
  })
  const registry = new ConnectorRegistry({ recipes: recipesForKinds('fake', connector.kinds) })
  registry.register(connector, {})
  return { registry, calls }
}

/**
 * One recipe per kind of a v1 connector, routed to that connector's kind route with every param passed through, so
 * `{ recipe: 'quote', params }` resolves without the real recipes.yml (whose routes name openbb, yahoo and finnhub).
 */
export function recipesForKinds(connector: string, kinds: readonly Kind[]): Recipe[] {
  return parseRecipes(
    kinds.map((kind) => {
      const params = zodToJsonSchemaObject(KINDS[kind].params)
      const names = Object.keys(params.properties ?? {})
      const view =
        kind === 'ohlcv' ? { preset: 'price' }
        : kind === 'macro' ? { preset: 'compare', normalize: false }
        : kind === 'options' ? { preset: 'chain' }
        : kind === 'quote' ? { preset: 'stat' }
        : { preset: 'table' }
      return { name: kind, title: kind, summary: KINDS[kind].description, params, view, routes: [{ connector, route: kind, params: Object.fromEntries(names.map((n) => [n, `{${n}}`])) }] }
    }),
  )
}

// ---------- scripted model ----------

export type ToolCallScript = { name: 'query' | 'set_workspace' | string; input: unknown; id?: string }
export type Turn = { text?: string; toolCalls?: ToolCallScript[] }
/** A turn can also be a function of the call options (to react to the tools offered). */
export type TurnScript = Turn | ((options: CallOptions, turnIndex: number) => Turn)

let callCounter = 0

export function turnToParts(turn: Turn, turnIndex: number): StreamPart[] {
  const parts: StreamPart[] = [{ type: 'stream-start', warnings: [] }]
  if (turn.text) {
    const id = `t${turnIndex}`
    parts.push({ type: 'text-start', id })
    for (const piece of chunk(turn.text, 12)) parts.push({ type: 'text-delta', id, delta: piece })
    parts.push({ type: 'text-end', id })
  }
  for (const call of turn.toolCalls ?? []) {
    parts.push({ type: 'tool-call', toolCallId: call.id ?? `call-${++callCounter}`, toolName: call.name, input: JSON.stringify(call.input) })
  }
  parts.push({
    type: 'finish',
    finishReason: { unified: turn.toolCalls?.length ? 'tool-calls' : 'stop', raw: undefined },
    usage: {
      inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 10, text: 10, reasoning: undefined },
    },
  })
  return parts
}

/**
 * A mock model that plays the given turns in order. When the script runs out it replies with a
 * fixed text so a runaway loop ends instead of hanging.
 */
export function scriptedModel(turns: TurnScript[]) {
  const model: MockLanguageModelV4 = new MockLanguageModelV4({
    doStream: async (options): Promise<StreamResult> => {
      const i = model.doStreamCalls.length - 1
      const script = turns[i]
      const turn: Turn = script === undefined ? { text: '[script exhausted]' } : typeof script === 'function' ? script(options, i) : script
      return { stream: convertArrayToReadableStream(turnToParts(turn, i)) }
    },
  })
  return model
}

function chunk(s: string, n: number): string[] {
  const out: string[] = []
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n))
  return out
}

// ---------- run harness ----------

export function collectEmit() {
  const messages: ServerMsg[] = []
  return { messages, emit: (m: ServerMsg) => messages.push(m) }
}

export function workspace(init: Partial<Workspace> = {}): Workspace {
  return { ...createWorkspace({ id: 'ws1', name: 'Untitled', now: 1_760_000_000_000 }), ...init }
}

/** Every tool result in the prompt the model received on a given turn (history accumulates), as parsed JSON values. */
export function toolResultsSentOn(model: MockLanguageModelV4, turn: number): unknown[] {
  const prompt = model.doStreamCalls[turn]?.prompt ?? []
  const out: unknown[] = []
  for (const m of prompt) {
    if (m.role !== 'tool') continue
    for (const part of m.content) {
      if (part.type !== 'tool-result') continue
      const o = part.output as { type: string; value?: unknown }
      out.push(o.type === 'json' ? o.value : o)
    }
  }
  return out
}

export function systemPromptSentOn(model: MockLanguageModelV4, turn: number): string {
  const prompt = model.doStreamCalls[turn]?.prompt ?? []
  return prompt
    .filter((m) => m.role === 'system')
    .map((m) => m.content as string)
    .join('\n')
}
