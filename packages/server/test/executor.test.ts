import { describe, expect, it } from 'vitest'
import { ConnectorRegistry, MemoryCache, type ServerMsg, type WidgetV2 } from '@openterminal/core'
import { Executor, nextExpiry, withProviderOverrides } from '../src/executor.js'
import { fakeConnector, fakeRecipes, type Call } from './fake-connector.js'

function setup() {
  const calls: Call[] = []
  const registry = new ConnectorRegistry({ cache: new MemoryCache(), recipes: fakeRecipes() })
  registry.register(fakeConnector({ calls }), {})
  const sent: ServerMsg[] = []
  const executor = new Executor(registry, { log: () => {} })
  return { registry, executor, sent, emit: (m: ServerMsg) => sent.push(m), calls }
}

const quote: WidgetV2 = { id: 'q', title: 'Quote', size: 'sm', data: { main: { recipe: 'quote', params: { symbols: ['MU', 'STX'] } } }, view: { preset: 'table' } }

describe('Executor', () => {
  it('a one-dataset widget emits one frame without a dataset field', async () => {
    const { executor, emit, sent, calls } = setup()
    const frames = await executor.run(quote, emit, { workspaceId: 'ws1' })
    expect(Object.keys(frames!)).toEqual(['main'])
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ t: 'frame', widgetId: 'q', workspaceId: 'ws1' })
    expect(sent[0]).not.toHaveProperty('dataset')
    expect(calls.map((c) => c.route)).toEqual(['quote'])
    expect((await executor.frameFor(quote)).rows).toHaveLength(2)
  })

  it('a data graph emits one frame per dataset and a frameError for the one that fails', async () => {
    const { executor, emit, sent } = setup()
    const w: WidgetV2 = {
      id: 'g',
      title: 'Graph',
      size: 'md',
      data: {
        main: { connector: 'fake', route: 'quote', params: { symbols: ['MU'] } },
        bars: { recipe: 'ohlcv', params: { symbols: ['MU'], interval: '1d', range: '3mo' } },
        broken: { connector: 'fake', route: 'nope', params: {} },
      },
      view: { preset: 'table' },
    }
    const frames = await executor.run(w, emit)
    expect(Object.keys(frames!).sort()).toEqual(['bars', 'main'])
    const types = sent.map((m) => [m.t, (m as { dataset?: string }).dataset])
    expect(types).toContainEqual(['frame', undefined])
    expect(types).toContainEqual(['frame', 'bars'])
    expect(types).toContainEqual(['frameError', 'broken'])
    await expect(executor.framesFor(w)).rejects.toThrow(/broken: /)
    expect((await executor.frameFor(w)).columns[1]?.name).toBe('price')
    expect((await executor.frameFor(w, { dataset: 'bars' })).columns.map((c) => c.name)).toContain('close')
    await expect(executor.frameFor(w, { dataset: 'x' })).rejects.toThrow(/no dataset "x"/)
  })

  it('a recipe nobody serves is a frameError, not a silent fallback', async () => {
    const { executor, emit, sent } = setup()
    const w: WidgetV2 = { ...quote, data: { main: { recipe: 'holdings', params: { symbol: 'SMH' } } } }
    const frames = await executor.run(w, emit, { workspaceId: 'ws1' })
    expect(frames).toBeUndefined()
    expect(sent.map((m) => m.t)).toEqual(['frameError'])
    expect((sent[0] as { error: string }).error).toMatch(/unknown recipe "holdings"/)
  })

  it('nextExpiry is the soonest frame expiry; provider overrides fill in missing providers only', () => {
    const f = (fetchedAt: number, ttl: number) => ({ columns: [], rows: [], meta: { connector: 'x', fetchedAt, ttl } })
    expect(nextExpiry({ a: f(10, 100), b: f(50, 10) })).toBe(60)
    const overrides = { 'openbb:equity/price/quote': 'fmp' }
    expect(withProviderOverrides({ connector: 'openbb', route: 'equity/price/quote', params: { symbol: 'MU' } }, overrides)).toEqual({ connector: 'openbb', route: 'equity/price/quote', params: { symbol: 'MU', provider: 'fmp' } })
    const params = (q: unknown) => (q as { params: Record<string, unknown> }).params
    expect(params(withProviderOverrides({ connector: 'openbb', route: 'equity/price/quote', params: { symbol: 'MU', provider: 'yfinance' } }, overrides)).provider).toBe('yfinance')
    expect(params(withProviderOverrides({ connector: 'openbb', route: 'news/company', params: {} }, overrides))).toEqual({})
    const t = withProviderOverrides({ inputs: { q: { connector: 'openbb', route: 'equity/price/quote', params: {} } }, code: 'result = q' }, overrides)
    expect('inputs' in t && (t.inputs.q as { params: Record<string, unknown> }).params.provider).toBe('fmp')
    const recipe = { recipe: 'quote', params: { symbols: ['MU'] } }
    expect(withProviderOverrides(recipe, overrides)).toBe(recipe)
  })
})
