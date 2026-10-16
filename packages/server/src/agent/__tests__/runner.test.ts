import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ConnectorRegistry, WIDGET_CHIP_RE, WidgetSchema, defineConnector, toFrame, type ServerMsg, type Widget } from '@terminal/core'
import { createRunner, AgentAbortError } from '../runner.js'
import { MAX_TOOL_CALLS } from '../tools.js'
import { collectEmit, createFakeRegistry, scriptedModel, systemPromptSentOn, toolResultsSentOn, workspace, type Turn, type TurnScript } from './helpers.js'

const MEMORY = ['MU', 'SNDK', 'WDC', 'STX']
const q = (kind: string, params: Record<string, unknown>) => ({ name: 'query', input: { kind, params } })

function useCaseA(): Turn[] {
  return [
    { toolCalls: [q('search', { q: ['memory', 'MU', 'SNDK', 'WDC', 'STX'] })] },
    {
      toolCalls: [
        q('ohlcv', { symbols: MEMORY, interval: '1d', range: '3mo' }),
        q('ohlcv', { symbols: ['MU'], interval: '1d', range: '6mo' }),
        q('quote', { symbols: MEMORY }),
        q('news', { symbols: MEMORY, limit: 20 }),
        q('earnings', { symbols: MEMORY, from: '2026-10-16', to: '2026-12-15' }),
      ],
    },
    {
      toolCalls: [
        {
          name: 'set_workspace',
          input: {
            name: 'Memory',
            widgets: [
              { title: 'Memory names, 3 months', size: 'lg', query: { kind: 'ohlcv', params: { symbols: MEMORY, interval: '1d', range: '3mo' } }, view: { type: 'series', normalize: true } },
              { title: 'MU daily', size: 'md', query: { kind: 'ohlcv', params: { symbols: ['MU'], interval: '1d', range: '6mo' } }, view: { type: 'series', candle: true } },
              { title: 'Basket snapshot', size: 'md', query: { kind: 'quote', params: { symbols: MEMORY } }, view: { type: 'table' } },
              { title: 'Upcoming earnings', size: 'sm', query: { kind: 'earnings', params: { symbols: MEMORY, from: '2026-10-16', to: '2026-12-15' } }, view: { type: 'table' } },
              { title: 'Memory news', size: 'md', query: { kind: 'news', params: { symbols: MEMORY, limit: 20 } }, view: { type: 'table' } },
            ],
          },
        },
      ],
    },
    { text: 'Over three months MU is up 31%, SNDK 31%, WDC 31%, STX 31%. MU reports on 2026-12-01. [[widget:w1]] [[widget:w5]]' },
  ]
}

const SEMIS = ['NVDA', 'AMD', 'AVGO', 'TSM', 'SMH', 'SPY']
function useCaseB(): Turn[] {
  return [
    { toolCalls: [q('search', { q: SEMIS })] },
    {
      toolCalls: [
        q('ohlcv', { symbols: ['NVDA', 'SPY', 'SMH'], interval: '5m', range: '1d' }),
        q('ohlcv', { symbols: ['NVDA'], interval: '5m', range: '1d' }),
        q('quote', { symbols: SEMIS }),
        q('news', { symbols: ['NVDA'], limit: 20 }),
      ],
    },
    {
      toolCalls: [
        {
          name: 'set_workspace',
          input: {
            widgets: [
              { id: 'hero', title: 'NVDA vs SPY vs SMH today', size: 'lg', query: { kind: 'ohlcv', params: { symbols: ['NVDA', 'SPY', 'SMH'], interval: '5m', range: '1d' } }, view: { type: 'series', normalize: true } },
              { id: 'hero', title: 'NVDA today', size: 'md', query: { kind: 'ohlcv', params: { symbols: ['NVDA'], interval: '5m', range: '1d' } }, view: { type: 'series', candle: true } },
              { title: 'Semis today', size: 'md', query: { kind: 'quote', params: { symbols: SEMIS } }, view: { type: 'table' } },
              { title: 'NVDA news, 24h', size: 'md', query: { kind: 'news', params: { symbols: ['NVDA'] } }, view: { type: 'table' } },
            ],
          },
        },
      ],
    },
    { text: 'NVDA is down 1.5% today against SMH down 7.5% and SPY down 9%, so most of the move is sector. [[widget:hero]] [[widget:w3]]' },
  ]
}

function run(turns: TurnScript[], opts: { registry?: ReturnType<typeof createFakeRegistry>['registry']; signal?: AbortSignal; ws?: ReturnType<typeof workspace> } = {}) {
  const fake = createFakeRegistry()
  const registry = opts.registry ?? fake.registry
  const model = scriptedModel(turns)
  const { messages, emit } = collectEmit()
  const runner = createRunner({ registry, model, now: () => new Date('2026-10-16T14:00:00Z') })
  const promise = runner.run({ workspace: opts.ws ?? workspace(), prompt: 'prompt', signal: opts.signal ?? new AbortController().signal, emit })
  return { promise, model, messages, fake }
}

const widgetsOf = (messages: ServerMsg[]): Widget[][] => messages.filter((m) => m.t === 'widgets').map((m) => (m as Extract<ServerMsg, { t: 'widgets' }>).widgets)

describe('use case A: theme research', () => {
  it('produces a valid five-widget set, steps, deltas and a chip-bearing reply', async () => {
    const { promise, model, messages, fake } = run(useCaseA())
    const message = await promise

    // Every emitted widget validates against core, ids assigned w1..w5, hero first.
    const sets = widgetsOf(messages)
    expect(sets).toHaveLength(1)
    const widgets = sets[0]!
    expect(widgets).toHaveLength(5)
    for (const w of widgets) expect(WidgetSchema.safeParse(w).success).toBe(true)
    expect(widgets.map((w) => w.id)).toEqual(['w1', 'w2', 'w3', 'w4', 'w5'])
    expect(widgets[0]).toMatchObject({ size: 'lg', query: { kind: 'ohlcv' }, view: { type: 'series', normalize: true } })
    expect(widgets[1]).toMatchObject({ view: { type: 'series', candle: true }, query: { params: { symbols: ['MU'] } } })
    expect(widgets.map((w) => w.query.kind)).toEqual(['ohlcv', 'ohlcv', 'quote', 'earnings', 'news'])
    const wmsg = messages.find((m) => m.t === 'widgets') as Extract<ServerMsg, { t: 'widgets' }>
    expect(wmsg.name).toBe('Memory')
    expect(wmsg.workspaceId).toBe('ws1')

    // Steps: 1 search + 5 queries + 1 set_workspace, each with the documented summary format.
    expect(message.role).toBe('agent')
    expect(message.steps).toHaveLength(7)
    const summaries = message.steps!.map((s) => s.summary)
    expect(summaries[0]).toBe('search memory, MU, SNDK, WDC, STX · 5 rows')
    expect(summaries).toContain('ohlcv MU, SNDK, WDC, STX 1d 3mo · 252 rows')
    expect(summaries).toContain('ohlcv MU 1d 6mo · 126 rows')
    expect(summaries).toContain('quote MU, SNDK, WDC, STX · 4 rows')
    expect(summaries).toContain('news MU, SNDK, WDC, STX · 20 rows')
    expect(summaries).toContain('earnings MU, SNDK, WDC, STX 2026-10-16→2026-12-15 · 4 rows')
    expect(summaries[6]).toBe('set_workspace · 5 widgets')
    for (const s of message.steps!) {
      expect(s.error).toBeUndefined()
      expect(s.ms).toBeGreaterThanOrEqual(0)
    }
    // Every step was also emitted.
    expect(messages.filter((m) => m.t === 'step')).toHaveLength(7)

    // The connector answered every query once (the registry has no cache here).
    expect(fake.calls.map((c) => c.kind).sort()).toEqual(['earnings', 'news', 'ohlcv', 'ohlcv', 'quote', 'search'])

    // Reply text streamed as deltas and returned, with chips.
    const deltas = messages.filter((m) => m.t === 'delta').map((m) => (m as Extract<ServerMsg, { t: 'delta' }>).text)
    expect(deltas.join('')).toBe(message.text)
    expect([...message.text.matchAll(WIDGET_CHIP_RE)].map((m) => m[1])).toEqual(['w1', 'w5'])

    // The model saw previews with stats on turn 3 (search plus the five parallel queries), and the result of set_workspace on turn 4.
    const previews = toolResultsSentOn(model, 2) as { ok: boolean; kind: string; connector: string; preview: { stats: Record<string, Record<string, { changePct: number | null }>> } }[]
    expect(previews).toHaveLength(6)
    expect(previews.every((p) => p.ok)).toBe(true)
    const basket = previews.find((p) => p.kind === 'ohlcv' && 'SNDK' in p.preview.stats)!
    expect(basket.connector).toBe('fake')
    expect(basket.preview.stats.MU!.close!.changePct).toBe(31)
    const applied = toolResultsSentOn(model, 3).at(-1) as { ok: boolean; widgetIds: string[]; name: string }
    expect(applied).toMatchObject({ ok: true, widgetIds: ['w1', 'w2', 'w3', 'w4', 'w5'], name: 'Memory' })

    // The model was offered exactly the two tools, with schemas derived from core.
    const tools = (model.doStreamCalls[0]!.tools ?? []) as { name: string; inputSchema: { properties?: Record<string, unknown> } }[]
    expect(tools.map((t) => t.name).sort()).toEqual(['query', 'set_workspace'])
    const sw = tools.find((t) => t.name === 'set_workspace')!
    expect(Object.keys(sw.inputSchema.properties ?? {})).toEqual(['name', 'widgets'])
    expect(JSON.stringify(sw.inputSchema)).toContain('"normalize"')
    const qt = tools.find((t) => t.name === 'query')!
    expect(JSON.stringify(qt.inputSchema)).toContain('"1mo"')
    expect(systemPromptSentOn(model, 0)).toContain('Answerable now: search, quote, ohlcv, news, earnings.')
  })
})

describe('use case B: event diagnosis', () => {
  it('produces a valid four-widget set and resolves colliding ids', async () => {
    const { promise, messages } = run(useCaseB())
    const message = await promise
    const widgets = widgetsOf(messages)[0]!
    expect(widgets).toHaveLength(4)
    for (const w of widgets) expect(WidgetSchema.safeParse(w).success).toBe(true)
    // Given id kept; the duplicate and the missing ids are generated in order.
    expect(widgets.map((w) => w.id)).toEqual(['hero', 'w1', 'w2', 'w3'])
    expect(widgets[0]).toMatchObject({ size: 'lg', view: { type: 'series', normalize: true }, query: { params: { symbols: ['NVDA', 'SPY', 'SMH'], interval: '5m', range: '1d' } } })
    expect(widgets[1]).toMatchObject({ view: { type: 'series', candle: true } })
    expect(widgets[3]!.query.params).toEqual({ symbols: ['NVDA'], limit: 20 }) // default applied by core
    expect(message.steps!.map((s) => s.summary)).toContain('ohlcv NVDA, SPY, SMH 5m 1d · 234 rows')
    expect(message.text).toContain('[[widget:hero]]')
  })
})

describe('emission order', () => {
  it('emits step per tool call, then step + widgets for set_workspace, then deltas', async () => {
    const { promise, messages } = run(useCaseA())
    await promise
    const types = messages.map((m) => m.t)
    const firstDelta = types.indexOf('delta')
    const widgetsAt = types.indexOf('widgets')
    expect(types.slice(0, 7).every((t) => t === 'step')).toBe(true)
    expect(widgetsAt).toBe(7)
    expect(types[6]).toBe('step')
    expect((messages[6] as Extract<ServerMsg, { t: 'step' }>).step.tool).toBe('set_workspace')
    expect(firstDelta).toBe(8)
    expect(types.slice(8).every((t) => t === 'delta')).toBe(true)
    expect(types.filter((t) => t === 'started' || t === 'done' || t === 'failed')).toHaveLength(0)
  })
})

describe('tool call cap', () => {
  it('executes at most ten tool calls, then forces the reply by withholding tools', async () => {
    // A greedy model: four quote calls per turn while tools are offered; a reply once they are not.
    const greedy: TurnScript = (options): Turn =>
      (options.tools?.length ?? 0) > 0
        ? { toolCalls: Array.from({ length: 4 }, (_, i) => q('quote', { symbols: [`S${i}`] })) }
        : { text: 'Out of budget, here is what I have.' }
    const { promise, model, messages, fake } = run(Array.from({ length: 6 }, () => greedy))
    const message = await promise
    expect(fake.calls).toHaveLength(MAX_TOOL_CALLS)
    // 12 calls were attempted: 10 ran, 2 were refused with an error step.
    expect(message.steps).toHaveLength(12)
    expect(message.steps!.filter((s) => s.error).map((s) => s.summary)).toEqual(['quote S2 · over budget', 'quote S3 · over budget'])
    // Turns: 3 with tools (4+4+4), then one without tools that produced the reply.
    expect(model.doStreamCalls).toHaveLength(4)
    expect(model.doStreamCalls[3]!.tools ?? []).toHaveLength(0)
    expect(message.text).toBe('Out of budget, here is what I have.')
    expect(widgetsOf(messages)).toHaveLength(0) // no set_workspace: current widgets are kept
  })
})

describe('set_workspace validation', () => {
  it('returns errors to the model, applies nothing, and accepts the retry', async () => {
    const bad = {
      name: 'set_workspace',
      input: {
        widgets: [
          { title: 'Two symbols as candle', size: 'lg', query: { kind: 'ohlcv', params: { symbols: ['MU', 'WDC'], interval: '1d', range: '3mo' } }, view: { type: 'series', candle: true } },
          { title: 'Series on quote', size: 'md', query: { kind: 'quote', params: { symbols: ['MU'] } }, view: { type: 'series' } },
          { title: 'Both flags', size: 'md', query: { kind: 'ohlcv', params: { symbols: ['MU'], interval: '1d', range: '3mo' } }, view: { type: 'series', candle: true, normalize: true } },
          { title: 'Fine', size: 'sm', query: { kind: 'quote', params: { symbols: ['MU'] } }, view: { type: 'table' } },
        ],
      },
    }
    const good = {
      name: 'set_workspace',
      input: {
        widgets: [
          { title: 'MU, 3 months', size: 'lg', query: { kind: 'ohlcv', params: { symbols: ['MU', 'WDC'], interval: '1d', range: '3mo' } }, view: { type: 'series', normalize: true } },
          { title: 'MU quote', size: 'sm', query: { kind: 'quote', params: { symbols: ['MU'] } }, view: { type: 'table' } },
        ],
      },
    }
    const { promise, model, messages } = run([{ toolCalls: [bad] }, { toolCalls: [good] }, { text: 'Done. [[widget:w1]]' }])
    const message = await promise

    expect(message.steps).toHaveLength(2)
    const [first, second] = message.steps!
    expect(first!.summary).toBe('set_workspace · 3 invalid widgets')
    expect(first!.error).toContain('candle requires exactly one symbol')
    expect(first!.error).toContain('series view requires an ohlcv query')
    expect(first!.error).toContain('candle and normalize are mutually exclusive')
    expect(second!.error).toBeUndefined()
    expect(second!.summary).toBe('set_workspace · 2 widgets')

    const sets = widgetsOf(messages)
    expect(sets).toHaveLength(1)
    expect(sets[0]!.map((w) => w.id)).toEqual(['w1', 'w2'])

    const fed = toolResultsSentOn(model, 1)[0] as { ok: boolean; errors: string[] }
    expect(fed.ok).toBe(false)
    expect(fed.errors).toHaveLength(3)
    expect(fed.errors[0]).toMatch(/^widgets\[0\] view\.candle:/)
  })

  it('rejects widgets on kinds no connector answers', async () => {
    // A registry whose only connector answers nothing but quote.
    const registry = new ConnectorRegistry()
    registry.register(
      defineConnector({ name: 'quoteonly', config: z.object({}), queries: { quote: async (p) => toFrame('quote', p.symbols.map((s) => ({ symbol: s, price: 1 }))) } }),
      {},
    )
    const turns: Turn[] = [
      {
        toolCalls: [
          {
            name: 'set_workspace',
            input: { widgets: [{ title: 'News', size: 'lg', query: { kind: 'news', params: { symbols: ['MU'] } }, view: { type: 'table' } }] },
          },
        ],
      },
      { text: 'News is not available right now.' },
    ]
    const { promise, model, messages } = run(turns, { registry })
    const message = await promise
    expect(message.steps![0]!.error).toContain('"news" is not answerable now (answerable: quote)')
    expect(widgetsOf(messages)).toHaveLength(0)
    expect(systemPromptSentOn(model, 0)).toContain('Not answerable now (no connector): search, ohlcv, news, earnings.')
  })
})

describe('query tool', () => {
  it('returns connector failures to the model as { ok: false } and records an error step', async () => {
    const fake = createFakeRegistry({ failing: ['news'] })
    const turns: Turn[] = [{ toolCalls: [q('news', { symbols: ['MU'], limit: 5 })] }, { text: 'No news available.' }]
    const { promise, model } = run(turns, { registry: fake.registry })
    const message = await promise
    expect(message.steps![0]).toMatchObject({ tool: 'query', summary: 'news MU · failed' })
    expect(message.steps![0]!.error).toContain('news is down')
    const fed = toolResultsSentOn(model, 1)[0] as { ok: boolean; error: string }
    expect(fed.ok).toBe(false)
    expect(fed.error).toContain('news failed')
    expect(message.text).toBe('No news available.')
  })

  it('records a rejected step when the model sends input the schema refuses', async () => {
    // symbols as a string matches no params shape, so the SDK refuses the input before execute.
    const turns: Turn[] = [{ toolCalls: [q('ohlcv', { symbols: 'MU', interval: '1d', range: '3mo' } as never)] }, { text: 'Retrying is left to the model.' }]
    const { promise, model, fake } = run(turns)
    const message = await promise
    expect(fake.calls).toHaveLength(0)
    expect(message.steps).toHaveLength(1)
    expect(message.steps![0]!.summary).toBe('query · rejected')
    expect(message.steps![0]!.error).toBeTruthy()
    expect(model.doStreamCalls).toHaveLength(2)
  })
})

describe('abort', () => {
  it('stops the loop and rejects with AbortError when the signal fires mid-run', async () => {
    const ac = new AbortController()
    const fake = createFakeRegistry({ onCall: () => ac.abort() })
    const turns: Turn[] = [{ toolCalls: [q('quote', { symbols: ['MU'] })] }, { toolCalls: [q('quote', { symbols: ['WDC'] })] }, { text: 'never' }]
    const { promise, model, messages } = run(turns, { registry: fake.registry, signal: ac.signal })
    await expect(promise).rejects.toBeInstanceOf(AgentAbortError)
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    expect(model.doStreamCalls.length).toBeLessThanOrEqual(1)
    expect(fake.calls).toHaveLength(1)
    expect(messages.filter((m) => m.t === 'delta')).toHaveLength(0)
  })

  it('rejects immediately when the signal is already aborted', async () => {
    const ac = new AbortController()
    ac.abort()
    const { promise, model, fake } = run(useCaseA(), { signal: ac.signal })
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    expect(model.doStreamCalls).toHaveLength(0)
    expect(fake.calls).toHaveLength(0)
  })
})

describe('reply without set_workspace', () => {
  it('keeps the current widgets and still returns the reply', async () => {
    const ws = workspace({
      widgets: [{ id: 'w1', title: 'MU', size: 'lg', query: { kind: 'quote', params: { symbols: ['MU'] } }, view: { type: 'table' } }],
    })
    const { promise, messages, model } = run([{ text: 'Hello. ' }, { text: 'Nothing to do.' }], { ws })
    const message = await promise
    expect(widgetsOf(messages)).toHaveLength(0)
    expect(message.text).toBe('Hello.')
    expect(message.steps).toEqual([])
    expect(model.doStreamCalls).toHaveLength(1) // a text-only turn ends the loop
    expect(systemPromptSentOn(model, 0)).toContain('"title":"MU"')
  })
})
