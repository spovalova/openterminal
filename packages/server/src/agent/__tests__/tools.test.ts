import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { WidgetV2Schema, type Step, type WidgetV2 } from '@terminal/core'
import { PreviewMemory, contentHintFor } from '../previews.js'
import { FindRouteInput, ONE_ROW_TABLE_MESSAGE, QueryToolInput, SetWorkspaceInput, TransformToolInput, createTools, layoutNote, resolveQueryInput, validateWidgets, type ValidateContext } from '../tools.js'
import { createFakeRegistry } from './helpers.js'

const MEMORY = ['MU', 'SNDK', 'WDC', 'STX']

/** A memory with the previews a typical run has seen: a basket quote, one quote, bars and news. */
async function seeded() {
  const { registry } = createFakeRegistry()
  const memory = new PreviewMemory()
  const run = async (q: Parameters<typeof registry.run>[0]) => memory.remember(q as never, await registry.run(q))
  await run({ recipe: 'quote', params: { symbols: MEMORY } })
  await run({ recipe: 'quote', params: { symbols: ['MU'] } })
  await run({ recipe: 'ohlcv', params: { symbols: ['MU'], interval: '1d', range: '6mo' } })
  await run({ recipe: 'ohlcv', params: { symbols: MEMORY, interval: '1d', range: '3mo' } })
  await run({ recipe: 'news', params: { symbols: MEMORY, limit: 20 } })
  await run({ recipe: 'earnings', params: { symbols: MEMORY, from: '2026-10-16', to: '2026-12-15' } })
  const ctx: ValidateContext = { answerable: registry.kinds(), recipes: registry.recipes(), catalog: await registry.catalog(), memory, now: Date.UTC(2026, 9, 16, 14) }
  return { registry, memory, ctx }
}

describe('tool input schemas', () => {
  it('are flat objects (no top-level anyOf) and accept the v2 and v1 widget shapes', () => {
    for (const schema of [FindRouteInput, QueryToolInput, TransformToolInput, SetWorkspaceInput]) {
      const json = z.toJSONSchema(schema, { io: 'input', target: 'draft-7', unrepresentable: 'any' }) as { type?: string; anyOf?: unknown; properties?: Record<string, unknown> }
      expect(json.type).toBe('object')
      expect(json.anyOf).toBeUndefined()
    }
    expect(QueryToolInput.parse({ recipe: 'quote', params: { symbols: ['MU'] } })).toEqual({ recipe: 'quote', params: { symbols: ['MU'] } })
    expect(QueryToolInput.parse({ connector: 'openbb', route: 'equity/price/quote' })).toMatchObject({ params: {} })
    expect(() => QueryToolInput.parse({ kind: 'peers', params: {} })).toThrow()
    expect(FindRouteInput.parse({ query: 'corporate bond prices', namespaces: ['fixedincome'] }).namespaces).toEqual(['fixedincome'])
    expect(TransformToolInput.parse({ inputs: { price: { recipe: 'ohlcv', params: {} } }, code: 'result = price', columns: { pe: { unit: 'ratio' } } }).columns).toEqual({ pe: { unit: 'ratio' } })
    expect(() => TransformToolInput.parse({ inputs: { 'bad name': {} }, code: 'x' })).toThrow()
    const v2 = SetWorkspaceInput.parse({ widgets: [{ title: 'MU', size: 'sm', data: { main: { recipe: 'quote', params: { symbols: ['MU'] } } }, view: { preset: 'stat', column: 'price' } }] })
    expect(v2.widgets[0]!.view).toEqual({ preset: 'stat', column: 'price' })
    const v1 = SetWorkspaceInput.parse({ widgets: [{ title: 'MU', size: 'sm', query: { kind: 'quote', params: { symbols: ['MU'] } }, view: { type: 'table' } }] })
    expect(v1.widgets[0]!.view).toEqual({ type: 'table' })
    expect(() => SetWorkspaceInput.parse({ widgets: [] })).toThrow()
  })

  it('resolves the flat query input to exactly one query shape', () => {
    expect(resolveQueryInput({ recipe: 'quote', params: { symbols: ['MU'] } })).toEqual({ ok: true, query: { recipe: 'quote', params: { symbols: ['MU'] } } })
    expect(resolveQueryInput({ connector: 'openbb', route: 'equity/price/quote', params: { symbol: ['MU'] } })).toEqual({ ok: true, query: { connector: 'openbb', route: 'equity/price/quote', params: { symbol: ['MU'] } } })
    expect(resolveQueryInput({ kind: 'quote', params: { symbols: ['MU'] } })).toEqual({ ok: true, query: { kind: 'quote', params: { symbols: ['MU'] } } })
    expect(resolveQueryInput({ kind: 'ohlcv', params: { symbols: 'MU' } })).toMatchObject({ ok: false, error: expect.stringContaining('invalid query') })
    expect(resolveQueryInput({ recipe: 'quote', kind: 'quote', params: {} })).toMatchObject({ ok: false, error: expect.stringContaining('exactly one of') })
    expect(resolveQueryInput({ params: {} })).toMatchObject({ ok: false })
    expect(resolveQueryInput({ connector: 'openbb', params: {} })).toMatchObject({ ok: false })
  })
})

describe('validateWidgets', () => {
  it('accepts v2 widgets over previewed recipes, assigns ids and keeps given ones', async () => {
    const { ctx } = await seeded()
    const res = validateWidgets(
      [
        { title: 'Memory names, 3 months', size: 'lg', data: { main: { recipe: 'ohlcv', params: { symbols: MEMORY, interval: '1d', range: '3mo' } } }, view: { preset: 'compare', normalize: true } },
        { id: 'snap', title: 'Basket snapshot', size: 'md', data: { main: { recipe: 'quote', params: { symbols: MEMORY } } }, view: { preset: 'stat' } },
        { title: 'MU daily', size: 'md', data: { main: { recipe: 'ohlcv', params: { symbols: ['MU'], interval: '1d', range: '6mo' } }, events: { recipe: 'earnings', params: { symbols: MEMORY, from: '2026-10-16', to: '2026-12-15' } } }, view: { preset: 'price', candle: true, events: 'events' } },
        { title: 'Memory news', size: 'md', data: { main: { recipe: 'news', params: { symbols: MEMORY, limit: 20 } } }, view: { preset: 'table', columns: ['headline', 'source'] } },
      ],
      ctx,
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.widgets.map((w) => w.id)).toEqual(['w1', 'snap', 'w2', 'w3'])
    for (const w of res.widgets) expect(WidgetV2Schema.safeParse(w).success).toBe(true)
    expect(res.widgets[2]!.data.events).toMatchObject({ recipe: 'earnings' })
  })

  it('refuses a table over a one-row preview with the rule 8 message, and accepts stat or facts over it (product rule 8)', async () => {
    const { ctx } = await seeded()
    const one = { recipe: 'quote', params: { symbols: ['MU'] } }
    const bad = validateWidgets([{ title: 'MU quote', size: 'sm', data: { main: one }, view: { preset: 'table' } }], ctx)
    expect(bad.ok).toBe(false)
    if (bad.ok) return
    expect(bad.errors).toHaveLength(1)
    expect(bad.errors[0]).toContain('widgets[0] view: ' + ONE_ROW_TABLE_MESSAGE)
    expect(bad.errors[0]).toContain('"recipe quote symbols=MU" has one row')
    const good = validateWidgets(
      [
        { title: 'MU', size: 'sm', data: { main: one }, view: { preset: 'stat' } },
        { title: 'MU facts', size: 'sm', data: { main: one }, view: { preset: 'facts' } },
        // A four-row quote table compares, so it is fine.
        { title: 'Basket', size: 'md', data: { main: { recipe: 'quote', params: { symbols: MEMORY } } }, view: { preset: 'table' } },
      ],
      ctx,
    )
    expect(good.ok).toBe(true)
  })

  it('refuses a chart preset over a frame it cannot draw, and a chain over a non-chain frame', async () => {
    const { ctx } = await seeded()
    const res = validateWidgets(
      [
        { title: 'Quote as chart', size: 'lg', data: { main: { recipe: 'quote', params: { symbols: MEMORY } } }, view: { preset: 'price' } },
        { title: 'News as curve', size: 'md', data: { main: { recipe: 'news', params: { symbols: MEMORY, limit: 20 } } }, view: { preset: 'curve' } },
        { title: 'Quote as chain', size: 'md', data: { main: { recipe: 'quote', params: { symbols: MEMORY } } }, view: { preset: 'chain' } },
        { title: 'Fine', size: 'md', data: { main: { recipe: 'ohlcv', params: { symbols: ['MU'], interval: '1d', range: '6mo' } } }, view: { preset: 'price' } },
      ],
      ctx,
    )
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.errors).toHaveLength(3)
    expect(res.errors[0]).toContain('widgets[0] view: preset "price" cannot draw "recipe quote symbols=MU,SNDK,WDC,STX": it needs a time column and a numeric column')
    expect(res.errors[1]).toContain('preset "curve" cannot draw')
    expect(res.errors[1]).toContain('a numeric x column')
    expect(res.errors[2]).toContain('preset "chain" needs an option chain')
  })

  it('validates every dataset query: unknown recipe, bad recipe params, routes outside the catalog, unanswerable kinds', async () => {
    const { ctx } = await seeded()
    const res = validateWidgets(
      [
        { title: 'Unknown', size: 'md', data: { main: { recipe: 'bonds', params: {} } }, view: { preset: 'table' } },
        { title: 'Bad params', size: 'md', data: { main: { recipe: 'ohlcv', params: { symbols: 'MU' } } }, view: { preset: 'price' } },
        { title: 'No such route', size: 'md', data: { main: { connector: 'fake', route: 'equity/price/quote', params: {} } }, view: { preset: 'table' } },
        { title: 'No such connector', size: 'md', data: { main: { connector: 'openbb', route: 'quote', params: {} } }, view: { preset: 'table' } },
        { title: 'Bad route params', size: 'md', data: { main: { connector: 'fake', route: 'ohlcv', params: { symbols: ['MU'], interval: '2d' } } }, view: { preset: 'table' } },
        { title: 'Dead kind', size: 'md', data: { main: { kind: 'metrics', params: { symbols: ['MU'] } } }, view: { preset: 'table' } },
        { title: 'Events missing', size: 'md', data: { main: { recipe: 'ohlcv', params: { symbols: ['MU'] } } }, view: { preset: 'price', events: 'earnings' } },
      ],
      ctx,
    )
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.errors[0]).toContain('widgets[0] data.main: unknown recipe "bonds"')
    expect(res.errors[1]).toContain('widgets[1] data.main: recipe ohlcv:')
    expect(res.errors[2]).toContain('widgets[2] data.main: connector "fake" has no route "equity/price/quote"; use find_route')
    expect(res.errors[3]).toContain('widgets[3] data.main: connector "openbb" is not available')
    expect(res.errors[4]).toContain('widgets[4] data.main: fake ohlcv params:')
    expect(res.errors[5]).toContain('widgets[5] data.main: kind "metrics" is not answerable now')
    expect(res.errors[6]).toContain('widgets[6] view.events: view.events names dataset "earnings", which the widget does not have')
  })

  it('accepts v1 widgets through parseAnyWidget (migrated to recipes and presets) and keeps the v1 refinements', async () => {
    const { ctx } = await seeded()
    const res = validateWidgets(
      [
        { title: 'MU daily', size: 'md', query: { kind: 'ohlcv', params: { symbols: ['MU'], interval: '1d', range: '6mo' } }, view: { type: 'series', candle: true } },
        { title: 'Two as candle', size: 'md', query: { kind: 'ohlcv', params: { symbols: ['MU', 'WDC'], interval: '1d', range: '3mo' } }, view: { type: 'series', candle: true } },
      ],
      ctx,
    )
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.errors).toEqual(['widgets[1] view.candle: candle requires exactly one symbol'])
    const ok = validateWidgets([{ title: 'MU daily', size: 'md', query: { kind: 'ohlcv', params: { symbols: ['MU'], interval: '1d', range: '6mo' } }, view: { type: 'series', candle: true } }], ctx)
    expect(ok.ok).toBe(true)
    if (!ok.ok) return
    expect(ok.widgets[0]).toMatchObject({ id: 'w1', data: { main: { recipe: 'ohlcv', params: { symbols: ['MU'], interval: '1d', range: '6mo' } } }, view: { preset: 'price', candle: true }, query: { kind: 'ohlcv' } })
  })
})

describe('content hints and the layout note', () => {
  it('sizes by content from the previews it has seen', async () => {
    const { ctx, memory } = await seeded()
    const chart: WidgetV2 = { id: 'c', title: 'c', size: 'lg', data: { main: { recipe: 'ohlcv', params: { symbols: ['MU'], interval: '1d', range: '6mo' } } }, view: { preset: 'price' } }
    const table4: WidgetV2 = { id: 't', title: 't', size: 'md', data: { main: { recipe: 'quote', params: { symbols: MEMORY } } }, view: { preset: 'table' } }
    const news: WidgetV2 = { id: 'n', title: 'n', size: 'md', data: { main: { recipe: 'news', params: { symbols: MEMORY, limit: 20 } } }, view: { preset: 'table' } }
    const unseen: WidgetV2 = { id: 'u', title: 'u', size: 'md', data: { main: { recipe: 'news', params: { symbols: ['AAPL'], limit: 20 } } }, view: { preset: 'table' } }
    expect(contentHintFor(chart, memory)).toEqual({ kind: 'chart', rows: 126 })
    expect(contentHintFor(table4, memory)).toEqual({ kind: 'table', rows: 4 })
    expect(contentHintFor(news, memory)).toEqual({ kind: 'table', rows: 20 })
    expect(contentHintFor(unseen, memory)).toEqual({ kind: 'table' })
    expect(contentHintFor({ ...table4, view: { preset: 'stat' } }, memory)).toEqual({ kind: 'stat', rows: 4 })
    void ctx
  })

  it('names demoted and stretched widgets, and says nothing for a set that tiles', async () => {
    const { memory } = await seeded()
    const chart: WidgetV2 = { id: 'w1', title: 'c', size: 'lg', data: { main: { recipe: 'ohlcv', params: { symbols: ['MU'], interval: '1d', range: '6mo' } } }, view: { preset: 'price' } }
    const short: WidgetV2 = { id: 'w2', title: 't', size: 'lg', data: { main: { recipe: 'quote', params: { symbols: MEMORY } } }, view: { preset: 'table' } }
    const stat: WidgetV2 = { id: 'w3', title: 's', size: 'sm', data: { main: { recipe: 'quote', params: { symbols: ['MU'] } } }, view: { preset: 'stat' } }
    const news: WidgetV2 = { id: 'w4', title: 'n', size: 'md', data: { main: { recipe: 'news', params: { symbols: MEMORY, limit: 20 } } }, view: { preset: 'price' } }
    const note = layoutNote([chart, short, stat, news], memory)
    // The lg four-row table is one row tall; the md chart is two rows tall; the lg chart and the sm stat keep their span.
    expect(note).toContain('Sized by content: w2 (table, lg) is one row tall, w4 (price, md) is 2 rows tall (tables with six rows or fewer, stats and facts cards are one row; charts are two).')
    expect(note).toMatch(/stretched to fill cells that would have stayed empty/)
    // A set that tiles without resizing: an lg chart (2x2) beside two sm tables stacked.
    const tiles = layoutNote([chart, { ...news, id: 'w2', size: 'sm', view: { preset: 'table' } }, { ...news, id: 'w3', size: 'sm', view: { preset: 'table' } }], memory)
    expect(tiles).toBe('')
  })
})

describe('find_route and transform tools', () => {
  it('find_route searches the catalog (kind routes of a v1 connector included) and records a step', async () => {
    const { registry, memory } = await seeded()
    const steps: Step[] = []
    const tools = createTools({ registry, workspaceId: 'ws1', answerable: registry.kinds(), recipes: registry.recipes(), catalog: await registry.catalog(), memory, signal: new AbortController().signal, emit: () => {}, onStep: (s) => steps.push(s), onWidgets: () => {}, budget: { used: 0, max: 10 } })
    const res = (await tools.find_route.execute!({ query: 'option chain strikes' }, { toolCallId: 't1', messages: [] } as never)) as { ok: true; routes: { connector: string; route: string; describe: string }[]; recipes: string[] }
    expect(res.ok).toBe(true)
    expect(res.routes[0]).toMatchObject({ connector: 'fake', route: 'options' })
    expect(res.routes[0]!.describe).toContain('fake options ·')
    expect(res.routes[0]!.describe).toContain('required: symbol')
    expect(res.recipes).toContain('options')
    expect(steps[0]).toMatchObject({ tool: 'find_route', summary: expect.stringMatching(/^find_route "option chain strikes" · \d hits?$/) })
  })

  it('transform without an engine returns the registry error for the model to read, with a failed step', async () => {
    const { registry, memory } = await seeded()
    const steps: Step[] = []
    const tools = createTools({ registry, workspaceId: 'ws1', answerable: registry.kinds(), recipes: registry.recipes(), memory, signal: new AbortController().signal, emit: () => {}, onStep: (s) => steps.push(s), onWidgets: () => {}, budget: { used: 0, max: 10 } })
    const res = (await tools.transform.execute!({ inputs: { q: { recipe: 'quote', params: { symbols: ['MU'] } } }, code: 'result = q' }, { toolCallId: 't1', messages: [] } as never)) as { ok: false; error: string }
    expect(res.ok).toBe(false)
    expect(res.error).toContain('transform(q) failed: transforms are not available: no transform engine is configured')
    expect(steps[0]).toMatchObject({ tool: 'transform', summary: 'transform(q) · failed' })
    const bad = (await tools.transform.execute!({ inputs: { q: { nope: 1 } }, code: 'result = q' }, { toolCallId: 't2', messages: [] } as never)) as { ok: false; error: string }
    expect(bad.error).toContain('invalid transform inputs')
  })
})
