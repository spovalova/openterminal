import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ConnectorRegistry, WIDGET_CHIP_RE, WidgetV2Schema, defineConnector, toFrame, type ServerMsg, type WidgetV2 } from '@terminal/core'
import { MemoryRunLog } from '../../runlog.js'
import { createRunner, AgentAbortError } from '../runner.js'
import { MAX_TOOL_CALLS } from '../tools.js'
import { collectEmit, createFakeRegistry, scriptedModel, systemPromptSentOn, toolResultsSentOn, workspace, type Turn, type TurnScript } from './helpers.js'

const MEMORY = ['MU', 'SNDK', 'WDC', 'STX']
/** A v2 recipe query. */
const rq = (recipe: string, params: Record<string, unknown>) => ({ name: 'query', input: { recipe, params } })
/** A v1 kind query (accepted until phase 3). */
const kq = (kind: string, params: Record<string, unknown>) => ({ name: 'query', input: { kind, params } })
const r = (recipe: string, params: Record<string, unknown>) => ({ recipe, params })

function useCaseA(): Turn[] {
  return [
    { toolCalls: [rq('search', { q: ['memory', 'MU', 'SNDK', 'WDC', 'STX'] })] },
    {
      toolCalls: [
        rq('ohlcv', { symbols: MEMORY, interval: '1d', range: '3mo' }),
        rq('ohlcv', { symbols: ['MU'], interval: '1d', range: '6mo' }),
        rq('quote', { symbols: MEMORY }),
        rq('news', { symbols: MEMORY, limit: 20 }),
        rq('earnings', { symbols: MEMORY, from: '2026-10-16', to: '2026-12-15' }),
      ],
    },
    {
      toolCalls: [
        {
          name: 'set_workspace',
          input: {
            name: 'Memory',
            widgets: [
              { title: 'Memory names, 3 months', size: 'lg', data: { main: r('ohlcv', { symbols: MEMORY, interval: '1d', range: '3mo' }) }, view: { preset: 'compare', normalize: true } },
              { title: 'MU daily', size: 'md', data: { main: r('ohlcv', { symbols: ['MU'], interval: '1d', range: '6mo' }), events: r('earnings', { symbols: MEMORY, from: '2026-10-16', to: '2026-12-15' }) }, view: { preset: 'price', candle: true, events: 'events' } },
              { title: 'Basket snapshot', size: 'md', data: { main: r('quote', { symbols: MEMORY }) }, view: { preset: 'stat' } },
              { title: 'Upcoming earnings', size: 'sm', data: { main: r('earnings', { symbols: MEMORY, from: '2026-10-16', to: '2026-12-15' }) }, view: { preset: 'table' } },
              { title: 'Memory news', size: 'md', data: { main: r('news', { symbols: MEMORY, limit: 20 }) }, view: { preset: 'table' } },
            ],
          },
        },
      ],
    },
    { text: 'Over three months MU is up 31%, SNDK 28.2%, WDC 25.8%, STX 23.9%. MU reports on 2026-12-01. [[widget:w1]] [[widget:w5]]' },
  ]
}

const SEMIS = ['NVDA', 'AMD', 'AVGO', 'TSM', 'SMH', 'SPY']
function useCaseB(): Turn[] {
  return [
    { toolCalls: [kq('search', { q: SEMIS })] },
    {
      toolCalls: [
        kq('ohlcv', { symbols: ['NVDA', 'SPY', 'SMH'], interval: '5m', range: '1d' }),
        kq('ohlcv', { symbols: ['NVDA'], interval: '5m', range: '1d' }),
        kq('quote', { symbols: SEMIS }),
        kq('news', { symbols: ['NVDA'], limit: 20 }),
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

function run(turns: TurnScript[], opts: { registry?: ReturnType<typeof createFakeRegistry>['registry']; signal?: AbortSignal; ws?: ReturnType<typeof workspace>; runLog?: MemoryRunLog } = {}) {
  const fake = createFakeRegistry()
  const registry = opts.registry ?? fake.registry
  const model = scriptedModel(turns)
  const { messages, emit } = collectEmit()
  const runner = createRunner({ registry, model, now: () => new Date('2026-10-16T14:00:00Z'), runLog: opts.runLog })
  const promise = runner.run({ workspace: opts.ws ?? workspace(), prompt: 'prompt', signal: opts.signal ?? new AbortController().signal, emit })
  return { promise, model, messages, fake }
}

const widgetsOf = (messages: ServerMsg[]): WidgetV2[][] => messages.filter((m) => m.t === 'widgets').map((m) => (m as unknown as { widgets: WidgetV2[] }).widgets)

describe('use case A: theme research (v2 recipes and presets)', () => {
  it('produces a valid five-widget set, steps, deltas, a verified reply and a run log row', async () => {
    const runLog = new MemoryRunLog()
    const { promise, model, messages, fake } = run(useCaseA(), { runLog })
    const message = await promise

    // Every emitted widget is a v2 widget, ids assigned w1..w5, hero first.
    const sets = widgetsOf(messages)
    expect(sets).toHaveLength(1)
    const widgets = sets[0]!
    expect(widgets).toHaveLength(5)
    for (const w of widgets) expect(WidgetV2Schema.safeParse(w).success).toBe(true)
    expect(widgets.map((w) => w.id)).toEqual(['w1', 'w2', 'w3', 'w4', 'w5'])
    expect(widgets[0]).toMatchObject({ size: 'lg', data: { main: { recipe: 'ohlcv' } }, view: { preset: 'compare', normalize: true } })
    expect(widgets[1]).toMatchObject({ view: { preset: 'price', candle: true, events: 'events' }, data: { main: { params: { symbols: ['MU'] } }, events: { recipe: 'earnings' } } })
    expect(widgets.map((w) => (w.data.main as { recipe: string }).recipe)).toEqual(['ohlcv', 'ohlcv', 'quote', 'earnings', 'news'])
    const wmsg = messages.find((m) => m.t === 'widgets') as Extract<ServerMsg, { t: 'widgets' }>
    expect(wmsg.name).toBe('Memory')
    expect(wmsg.workspaceId).toBe('ws1')

    // Steps: 1 search + 5 queries + 1 set_workspace, each with the v2 summary format.
    expect(message.role).toBe('agent')
    expect(message.steps).toHaveLength(7)
    const summaries = message.steps!.map((s) => s.summary)
    expect(summaries[0]).toBe('recipe search q=memory,MU,SNDK,WDC,STX · 5 rows')
    expect(summaries).toContain('recipe ohlcv symbols=MU,SNDK,WDC,STX interval=1d range=3mo · 252 rows')
    expect(summaries).toContain('recipe ohlcv symbols=MU interval=1d range=6mo · 126 rows')
    expect(summaries).toContain('recipe quote symbols=MU,SNDK,WDC,STX · 4 rows')
    expect(summaries).toContain('recipe news symbols=MU,SNDK,WDC,STX limit=20 · 20 rows')
    expect(summaries).toContain('recipe earnings symbols=MU,SNDK,WDC,STX from=2026-10-16 to=2026-12-15 · 4 rows')
    expect(summaries[6]).toBe('set_workspace · 5 widgets')
    for (const s of message.steps!) {
      expect(s.error).toBeUndefined()
      expect(s.ms).toBeGreaterThanOrEqual(0)
    }
    expect(messages.filter((m) => m.t === 'step')).toHaveLength(7)

    // The connector answered every recipe through its kind route once (the registry has no cache here).
    expect(fake.calls.map((c) => c.kind).sort()).toEqual(['earnings', 'news', 'ohlcv', 'ohlcv', 'quote', 'search'])

    // Reply text streamed as deltas and returned, with chips, and every figure matched a preview.
    const deltas = messages.filter((m) => m.t === 'delta').map((m) => (m as Extract<ServerMsg, { t: 'delta' }>).text)
    expect(deltas.join('')).toBe(message.text)
    expect([...message.text.matchAll(WIDGET_CHIP_RE)].map((m) => m[1])).toEqual(['w1', 'w5'])
    expect(message.verification).toEqual({ ok: true, checked: 4, matched: 4, unmatched: [] })

    // The model saw previews with stats, units and lineage on turn 3, and the result of set_workspace on turn 4.
    const previews = toolResultsSentOn(model, 2) as { ok: boolean; query: { recipe: string }; connector: string; columns: string; units: Record<string, string>; lineage?: { recipe?: string }; preview: { stats: Record<string, Record<string, { changePct: number | null }>> } }[]
    expect(previews).toHaveLength(6)
    expect(previews.every((p) => p.ok)).toBe(true)
    const basket = previews.find((p) => p.query.recipe === 'ohlcv' && 'SNDK' in p.preview.stats)!
    expect(basket.connector).toBe('fake')
    expect(basket.lineage).toMatchObject({ recipe: 'ohlcv', connector: 'fake', route: 'ohlcv' })
    expect(basket.columns).toContain('close:number')
    expect(basket.preview.stats.MU!.close!.changePct).toBe(31)
    const applied = toolResultsSentOn(model, 3).at(-1) as { ok: boolean; widgetIds: string[]; name: string; note: string }
    expect(applied).toMatchObject({ ok: true, widgetIds: ['w1', 'w2', 'w3', 'w4', 'w5'], name: 'Memory' })
    expect(applied.note).toContain('Sized by content: w2 (price, md) is one column wide and 2 rows tall')

    // The model was offered the four tools, with schemas derived from core.
    const tools = (model.doStreamCalls[0]!.tools ?? []) as { name: string; inputSchema: { properties?: Record<string, unknown> } }[]
    expect(tools.map((t) => t.name).sort()).toEqual(['find_route', 'query', 'set_workspace', 'transform'])
    const sw = tools.find((t) => t.name === 'set_workspace')!
    expect(Object.keys(sw.inputSchema.properties ?? {})).toEqual(['name', 'widgets'])
    expect(JSON.stringify(sw.inputSchema)).toContain('"preset"')
    const qt = tools.find((t) => t.name === 'query')!
    expect(Object.keys(qt.inputSchema.properties ?? {})).toEqual(['recipe', 'connector', 'route', 'kind', 'params'])
    const system = systemPromptSentOn(model, 0)
    expect(system).toContain('Connectors, in routing order: fake (7 routes in the catalog).')
    expect(system).toContain('- quote(symbols[]) ·')

    // The run log row carries the steps, the verification and the mock's token counts.
    expect(runLog.rows).toHaveLength(1)
    expect(runLog.rows[0]).toMatchObject({ workspaceId: 'ws1', model: 'mock-model-id', prompt: 'prompt', verification: { ok: true, checked: 4 } })
    expect(runLog.rows[0]!.steps).toHaveLength(7)
    expect(runLog.rows[0]!.tokens).toEqual({ input: 40, output: 40 })
    expect(runLog.rows[0]!.ms).toBeGreaterThanOrEqual(0)
  })
})

describe('use case B: event diagnosis (v1 kinds and widgets, accepted until phase 3)', () => {
  it('runs kind queries, migrates v1 widgets to v2 and resolves colliding ids', async () => {
    const { promise, messages } = run(useCaseB())
    const message = await promise
    const widgets = widgetsOf(messages)[0]!
    expect(widgets).toHaveLength(4)
    for (const w of widgets) expect(WidgetV2Schema.safeParse(w).success).toBe(true)
    // Given id kept; the duplicate and the missing ids are generated in order.
    expect(widgets.map((w) => w.id)).toEqual(['hero', 'w1', 'w2', 'w3'])
    expect(widgets[0]).toMatchObject({ size: 'lg', view: { preset: 'compare', normalize: true }, data: { main: { recipe: 'ohlcv', params: { symbols: ['NVDA', 'SPY', 'SMH'], interval: '5m', range: '1d' } } }, query: { kind: 'ohlcv' } })
    expect(widgets[1]).toMatchObject({ view: { preset: 'price', candle: true } })
    expect(widgets[3]!.data.main).toEqual({ recipe: 'news', params: { symbols: ['NVDA'], limit: 20 } }) // default applied by core
    expect(message.steps!.map((s) => s.summary)).toContain('ohlcv NVDA, SPY, SMH 5m 1d · 234 rows')
    expect(message.text).toContain('[[widget:hero]]')
    expect(message.verification).toEqual({ ok: true, checked: 3, matched: 3, unmatched: [] })
  })
})

describe('reply verification', () => {
  it('flags a figure that is in no preview and carries the result on the message and the run log', async () => {
    const runLog = new MemoryRunLog()
    const turns: Turn[] = [{ toolCalls: [rq('quote', { symbols: ['MU'] })] }, { text: 'MU is at $100.00, down 1.5% today; its bonds yield 13.63%. [[widget:w1]]' }]
    const { promise } = run(turns, { runLog })
    const message = await promise
    expect(message.verification).toEqual({ ok: false, checked: 3, matched: 2, unmatched: [{ text: '13.63%', value: 13.63, unit: 'percent' }] })
    expect(runLog.rows[0]!.verification).toEqual(message.verification)
  })
})

describe('planning text in tool-call turns', () => {
  it('drops a short note written before tool calls and streams the reply turn, with a paragraph break between turns', async () => {
    const turns: Turn[] = [
      { text: 'Tickers are known; skip search.', toolCalls: [rq('quote', { symbols: ['MU'] })] },
      { text: 'MU is at $100.00, down 1.5% today, the only name in the basket moving more than a percent before the open; the rest are flat. [[widget:w1]]' },
    ]
    const { promise, messages } = run(turns)
    const message = await promise
    expect(message.text).toBe('MU is at $100.00, down 1.5% today, the only name in the basket moving more than a percent before the open; the rest are flat. [[widget:w1]]')
    const deltas = messages.filter((m) => m.t === 'delta').map((m) => (m as Extract<ServerMsg, { t: 'delta' }>).text)
    expect(deltas.join('')).toBe(message.text)
    expect(deltas.length).toBeGreaterThan(1) // the first 120 characters arrive in one piece, the rest streams
  })

  it('keeps text from a tool-call turn once it is long enough to be a reply, and separates turns with a blank line', async () => {
    const long = 'MU is at $100.00, down 1.5% today, which is the biggest move in the basket by a wide margin and worth a closer look before the open. '.repeat(2).trim()
    const turns: Turn[] = [{ text: long, toolCalls: [rq('quote', { symbols: ['MU'] })] }, { text: 'Second paragraph.' }]
    const { promise } = run(turns)
    const message = await promise
    expect(message.text).toBe(`${long}\n\nSecond paragraph.`)
  })
})

describe('empty reply backstop', () => {
  it('asks once more without tools when the model ends with no text, and records the turns and the continuation', async () => {
    const runLog = new MemoryRunLog()
    const turns: TurnScript[] = [
      { toolCalls: [rq('quote', { symbols: ['MU'] })] },
      { text: '' }, // the model's turn after the tool result carries nothing (seen live once the budget was spent)
      (options): Turn => {
        // The continuation offers no tools and ends with the nudge as a user message.
        expect(options.tools ?? []).toHaveLength(0)
        const last = options.prompt.at(-1)!
        expect(last.role).toBe('user')
        expect(JSON.stringify(last.content)).toContain('Write the reply now')
        return { text: 'MU is at $100.00, down 1.5% today.' }
      },
    ]
    const { promise, model, messages } = run(turns, { runLog })
    const message = await promise
    expect(message.text).toBe('MU is at $100.00, down 1.5% today.')
    expect(messages.filter((m) => m.t === 'delta').map((m) => (m as Extract<ServerMsg, { t: 'delta' }>).text).join('')).toBe(message.text)
    expect(message.verification).toMatchObject({ ok: true, checked: 2, matched: 2 })
    expect(model.doStreamCalls).toHaveLength(3)
    expect(runLog.rows[0]).toMatchObject({ continued: true })
    expect(runLog.rows[0]!.turns!.map((t) => [t.finishReason, t.textChars, t.toolCalls])).toEqual([
      ['tool-calls', 0, 1],
      ['stop', 0, 0],
      ['stop', 34, 0],
    ])
  })

  it('does not continue when the model wrote a reply, nor when it never used a tool', async () => {
    const { promise, model } = run([{ text: '' }])
    const message = await promise
    expect(message.text).toBe('')
    expect(model.doStreamCalls).toHaveLength(1)
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
        ? { toolCalls: Array.from({ length: 4 }, (_, i) => rq('quote', { symbols: [`S${i}`] })) }
        : { text: 'Out of budget, here is what I have.' }
    const { promise, model, messages, fake } = run(Array.from({ length: 6 }, () => greedy))
    const message = await promise
    expect(fake.calls).toHaveLength(MAX_TOOL_CALLS)
    // 12 calls were attempted: 10 ran, 2 were refused with an error step.
    expect(message.steps).toHaveLength(12)
    expect(message.steps!.filter((s) => s.error).map((s) => s.summary)).toEqual(['recipe quote symbols=S2 · over budget', 'recipe quote symbols=S3 · over budget'])
    // Turns: 3 with tools (4+4+4), then one without tools that produced the reply.
    expect(model.doStreamCalls).toHaveLength(4)
    expect(model.doStreamCalls[3]!.tools ?? []).toHaveLength(0)
    expect(message.text).toBe('Out of budget, here is what I have.')
    expect(widgetsOf(messages)).toHaveLength(0) // no set_workspace: current widgets are kept
  })
})

describe('set_workspace validation', () => {
  it('returns errors to the model, applies nothing, and accepts the retry (v1 refinements still apply to v1 widgets)', async () => {
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
          { title: 'MU, 3 months', size: 'lg', data: { main: r('ohlcv', { symbols: ['MU', 'WDC'], interval: '1d', range: '3mo' }) }, view: { preset: 'compare', normalize: true } },
          { title: 'MU quote', size: 'sm', data: { main: r('quote', { symbols: ['MU'] }) }, view: { preset: 'stat' } },
        ],
      },
    }
    const { promise, model, messages } = run([{ toolCalls: [bad] }, { toolCalls: [good] }, { text: 'Done. [[widget:w1]]' }])
    const message = await promise

    expect(message.steps).toHaveLength(2)
    const [first, second] = message.steps!
    expect(first!.summary).toBe('set_workspace · 3 invalid widgets')
    expect(first!.error).toContain('candle requires exactly one symbol')
    expect(first!.error).toContain('series view requires an ohlcv or macro query')
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

  it('refuses a table over a one-row preview (rule 8) and a chart over a frame without time, and accepts the fix', async () => {
    const bad = {
      name: 'set_workspace',
      input: {
        widgets: [
          { title: 'NVDA quote', size: 'sm', data: { main: r('quote', { symbols: ['NVDA'] }) }, view: { preset: 'table' } },
          { title: 'Quote as chart', size: 'lg', data: { main: r('quote', { symbols: ['NVDA'] }) }, view: { preset: 'price' } },
          { title: 'Rates', size: 'md', data: { ten: r('macro', { series: ['treasury_10y'] }), two: r('macro', { series: ['treasury_2y'] }) }, view: { preset: 'compare', normalize: false } },
        ],
      },
    }
    const good = {
      name: 'set_workspace',
      input: {
        widgets: [
          { title: 'NVDA', size: 'sm', data: { main: r('quote', { symbols: ['NVDA'] }) }, view: { preset: 'stat' } },
          { title: 'Rates', size: 'md', data: { ten: r('macro', { series: ['treasury_10y'] }), two: r('macro', { series: ['treasury_2y'] }) }, view: { preset: 'compare', normalize: false } },
        ],
      },
    }
    const turns: Turn[] = [
      { toolCalls: [rq('quote', { symbols: ['NVDA'] }), rq('macro', { series: ['treasury_10y'] }), rq('macro', { series: ['treasury_2y'] })] },
      { toolCalls: [bad] },
      { toolCalls: [good] },
      { text: 'The 10-year is at 4.11%. [[widget:w1]] [[widget:w2]]' },
    ]
    const { promise, messages } = run(turns)
    const message = await promise
    const [, , , badStep, goodStep] = message.steps!
    expect(badStep!.summary).toBe('set_workspace · 2 invalid widgets')
    expect(badStep!.error).toContain('widgets[0] view: a table over one row compares nothing (product rule 8)')
    expect(badStep!.error).toContain('widgets[1] view: preset "price" cannot draw "recipe quote symbols=NVDA"')
    expect(badStep!.error).not.toContain('widgets[2]')
    expect(goodStep!.summary).toBe('set_workspace · 2 widgets')
    const sets = widgetsOf(messages)
    expect(sets).toHaveLength(1)
    expect(sets[0]![0]).toMatchObject({ id: 'w1', view: { preset: 'stat' } })
    expect(sets[0]![1]).toMatchObject({ id: 'w2', data: { ten: { recipe: 'macro' }, two: { recipe: 'macro' } } })
    expect(message.verification).toMatchObject({ ok: true, checked: 1 })
  })

  it('rejects widgets whose queries no connector answers: an unknown recipe, and a v1 kind without a connector', async () => {
    // A registry whose only connector answers nothing but quote, and has no recipes at all.
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
            input: {
              widgets: [
                { title: 'News', size: 'lg', data: { main: r('news', { symbols: ['MU'] }) }, view: { preset: 'table' } },
                { title: 'News v1', size: 'md', data: { main: { kind: 'news', params: { symbols: ['MU'] } } }, view: { preset: 'table' } },
              ],
            },
          },
        ],
      },
      { text: 'News is not available right now.' },
    ]
    const { promise, model, messages } = run(turns, { registry })
    const message = await promise
    expect(message.steps![0]!.error).toContain('widgets[0] data.main: unknown recipe "news"')
    expect(message.steps![0]!.error).toContain('widgets[1] data.main: kind "news" is not answerable now (answerable: quote)')
    expect(widgetsOf(messages)).toHaveLength(0)
    expect(systemPromptSentOn(model, 0)).toContain('(no recipes are loaded; use find_route and routes)')
  })
})

describe('query tool', () => {
  it('returns connector failures to the model as { ok: false } and records an error step', async () => {
    const fake = createFakeRegistry({ failing: ['news'] })
    const turns: Turn[] = [{ toolCalls: [rq('news', { symbols: ['MU'], limit: 5 })] }, { text: 'No news available.' }]
    const { promise, model } = run(turns, { registry: fake.registry })
    const message = await promise
    expect(message.steps![0]).toMatchObject({ tool: 'query', summary: 'recipe news symbols=MU limit=5 · failed' })
    expect(message.steps![0]!.error).toContain('news is down')
    const fed = toolResultsSentOn(model, 1)[0] as { ok: boolean; error: string }
    expect(fed.ok).toBe(false)
    expect(fed.error).toContain('recipe news symbols=MU limit=5 failed')
    expect(message.text).toBe('No news available.')
  })

  it('points a recipe whose routes are not served at the kind of the same name (until phase 3)', async () => {
    const registry = new ConnectorRegistry({
      recipes: [{ name: 'quote', title: 'quote', params: { type: 'object', properties: { symbols: { type: 'array', items: { type: 'string' } } }, required: ['symbols'] }, view: { preset: 'stat' }, routes: [{ connector: 'openbb', route: 'equity/price/quote', params: { symbol: '{symbols}' } }] }],
    })
    registry.register(defineConnector({ name: 'openbb', config: z.object({}), queries: { quote: async (p) => toFrame('quote', p.symbols.map((s) => ({ symbol: s, price: 1 }))) } }), {})
    const turns: Turn[] = [{ toolCalls: [rq('quote', { symbols: ['MU'] })] }, { toolCalls: [kq('quote', { symbols: ['MU'] })] }, { text: 'MU is at 1. [[widget:w1]]' }]
    const { promise, model } = run(turns, { registry })
    const message = await promise
    expect(message.steps!.map((s) => s.summary)).toEqual(['recipe quote symbols=MU · failed', 'quote MU · 1 row'])
    const fed = toolResultsSentOn(model, 1)[0] as { ok: false; error: string }
    expect(fed.error).toContain('has no route "equity/price/quote"')
    expect(fed.error).toContain('The kind of the same name still answers: query({ kind: "quote", params })')
  })

  it('runs a route query against a connector route and points at find_route for an unknown route', async () => {
    const turns: Turn[] = [
      { toolCalls: [{ name: 'query', input: { connector: 'fake', route: 'quote', params: { symbols: ['MU'] } } }, { name: 'query', input: { connector: 'fake', route: 'equity/price/quote', params: { symbol: ['MU'] } } }] },
      { text: 'MU is at 100. [[widget:w1]]' },
    ]
    const { promise, model } = run(turns)
    const message = await promise
    expect(message.steps!.map((s) => s.summary).sort()).toEqual(['fake equity/price/quote symbol=MU · failed', 'fake quote symbols=MU · 1 row'])
    const results = toolResultsSentOn(model, 1) as ({ ok: true; units: Record<string, string>; lineage: { route: string } } | { ok: false; error: string })[]
    const ok = results.find((x) => x.ok) as { ok: true; lineage: { route: string } }
    const bad = results.find((x) => !x.ok) as { ok: false; error: string }
    expect(ok.lineage).toMatchObject({ connector: 'fake', route: 'quote' })
    expect(bad.error).toContain('has no route "equity/price/quote"')
    expect(bad.error).toContain('Use find_route')
  })

  it('records a rejected step when the model sends input the schema refuses', async () => {
    // An unknown kind fails the enum, so the SDK refuses the input before execute.
    const turns: Turn[] = [{ toolCalls: [kq('peers' as never, { symbols: ['MU'] })] }, { text: 'Retrying is left to the model.' }]
    const { promise, model, fake } = run(turns)
    const message = await promise
    expect(fake.calls).toHaveLength(0)
    expect(message.steps).toHaveLength(1)
    expect(message.steps![0]!.summary).toBe('query · rejected')
    expect(message.steps![0]!.error).toBeTruthy()
    expect(model.doStreamCalls).toHaveLength(2)
  })

  it('records a failed step when params do not fit the kind (params are an open object at the schema level)', async () => {
    const turns: Turn[] = [{ toolCalls: [kq('ohlcv', { symbols: 'MU', interval: '1d', range: '3mo' } as never)] }, { text: 'Retrying is left to the model.' }]
    const { promise, model, fake } = run(turns)
    const message = await promise
    expect(fake.calls).toHaveLength(0)
    expect(message.steps).toHaveLength(1)
    expect(message.steps![0]!.summary).toBe('ohlcv MU 1d 3mo · failed')
    expect(message.steps![0]!.error).toContain('invalid query')
    const fed = toolResultsSentOn(model, 1)[0] as { ok: boolean; error: string }
    expect(fed.ok).toBe(false)
    expect(fed.error).toContain('invalid query')
  })

  it('records a failed step when a recipe gets params its schema refuses', async () => {
    const turns: Turn[] = [{ toolCalls: [rq('ohlcv', { symbols: 'MU' })] }, { text: 'Retrying is left to the model.' }]
    const { promise, fake } = run(turns)
    const message = await promise
    expect(fake.calls).toHaveLength(0)
    expect(message.steps![0]!.summary).toBe('recipe ohlcv symbols=MU · failed')
  })
})

describe('find_route tool', () => {
  it('returns catalog hits with a describe line and records a step', async () => {
    const turns: Turn[] = [{ toolCalls: [{ name: 'find_route', input: { query: 'earnings dates calendar' } }] }, { text: 'Found it.' }]
    const { promise, model } = run(turns)
    const message = await promise
    expect(message.steps![0]).toMatchObject({ tool: 'find_route' })
    expect(message.steps![0]!.summary).toMatch(/^find_route "earnings dates calendar" · \d hits?$/)
    const res = toolResultsSentOn(model, 1)[0] as { ok: true; routes: { connector: string; route: string; describe: string }[] }
    expect(res.routes[0]).toMatchObject({ connector: 'fake', route: 'earnings' })
    expect(res.routes[0]!.describe).toMatch(/^fake earnings · /)
  })
})

describe('abort', () => {
  it('stops the loop and rejects with AbortError when the signal fires mid-run', async () => {
    const ac = new AbortController()
    const fake = createFakeRegistry({ onCall: () => ac.abort() })
    const runLog = new MemoryRunLog()
    const turns: Turn[] = [{ toolCalls: [rq('quote', { symbols: ['MU'] })] }, { toolCalls: [rq('quote', { symbols: ['WDC'] })] }, { text: 'never' }]
    const { promise, model, messages } = run(turns, { registry: fake.registry, signal: ac.signal, runLog })
    await expect(promise).rejects.toBeInstanceOf(AgentAbortError)
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    expect(model.doStreamCalls.length).toBeLessThanOrEqual(1)
    expect(fake.calls).toHaveLength(1)
    expect(messages.filter((m) => m.t === 'delta')).toHaveLength(0)
    expect(runLog.rows).toHaveLength(1)
    expect(runLog.rows[0]).toMatchObject({ error: 'cancelled' })
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
    expect(message.verification).toEqual({ ok: true, checked: 0, matched: 0, unmatched: [] })
    expect(model.doStreamCalls).toHaveLength(1) // a text-only turn ends the loop
    expect(systemPromptSentOn(model, 0)).toContain('"title":"MU"')
  })
})
