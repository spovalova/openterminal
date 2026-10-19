import { describe, expect, it } from 'vitest'
import { ConnectorRegistry, MemoryCache, migrateWidget, type AnyWidget, type ServerMsg, type Widget } from '@terminal/core'
import { builtinRecipes } from '@terminal/core/node'
import { Executor, nextExpiry, withProviderOverrides } from '../src/executor.js'
import { fakeConnector } from './fake-connector.js'

function setup() {
  const calls: { kind: string; params: unknown }[] = []
  const registry = new ConnectorRegistry({ cache: new MemoryCache(), recipes: builtinRecipes() })
  registry.register(fakeConnector({ calls }), {})
  const sent: ServerMsg[] = []
  const executor = new Executor(registry, { log: () => {} })
  return { registry, executor, sent, emit: (m: ServerMsg) => sent.push(m), calls }
}

const v1: Widget = { id: 'q', title: 'Quote', size: 'sm', query: { kind: 'quote', params: { symbols: ['MU', 'STX'] } }, view: { type: 'table' } }

describe('Executor over v1 and v2 widgets', () => {
  it('a v1 widget emits one frame without a dataset field', async () => {
    const { executor, emit, sent } = setup()
    const frames = await executor.run(v1, emit, { workspaceId: 'ws1' })
    expect(Object.keys(frames!)).toEqual(['main'])
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ t: 'frame', widgetId: 'q', workspaceId: 'ws1' })
    expect(sent[0]).not.toHaveProperty('dataset')
  })

  it('a v2 widget emits one frame per dataset and a frameError for the one that fails', async () => {
    const { executor, emit, sent } = setup()
    const w: AnyWidget = {
      id: 'g',
      title: 'Graph',
      size: 'md',
      data: {
        main: { connector: 'fake', route: 'quote', params: { symbols: ['MU'] } },
        bars: { kind: 'ohlcv', params: { symbols: ['MU'], interval: '1d', range: '3mo' } },
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

  it('a migrated widget whose recipe route is not served yet falls back to its v1 query for main', async () => {
    const { executor, emit, sent, calls } = setup()
    const migrated = migrateWidget(v1) // main: { recipe: 'quote' } → openbb/yahoo/finnhub routes, none registered here
    const frames = await executor.run(migrated, emit, { workspaceId: 'ws1' })
    expect(Object.keys(frames!)).toEqual(['main'])
    expect(sent.map((m) => m.t)).toEqual(['frame'])
    expect(calls.map((c) => c.kind)).toEqual(['quote'])
    expect((await executor.frameFor(migrated)).rows).toHaveLength(2)
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
    const kind = { kind: 'quote' as const, params: { symbols: ['MU'] } }
    expect(withProviderOverrides(kind, overrides)).toBe(kind)
  })
})
