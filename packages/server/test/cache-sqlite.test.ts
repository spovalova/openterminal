import { describe, expect, it } from 'vitest'
import { ConnectorRegistry, type AnyQuery, type Frame } from '@terminal/core'
import { SqliteCache } from '../src/cache-sqlite.js'
import { SqliteStore } from '../src/store/index.js'
import { fakeConnector } from './fake-connector.js'

const frame = (fetchedAt: number, ttl: number, rows = 1): Frame => ({
  columns: [{ name: 'symbol', type: 'string' }, { name: 'price', type: 'number' }],
  rows: Array.from({ length: rows }, (_, i) => [`S${i}`, i]),
  meta: { connector: 'fake', fetchedAt, ttl },
})

describe('SqliteCache', () => {
  it('serves a frame until its TTL and shares keys with the in-memory cache', () => {
    let now = 1_000
    const store = new SqliteStore(':memory:', { now: () => now })
    const cache = new SqliteCache(store, { now: () => now })
    const q: AnyQuery = { kind: 'quote', params: { symbols: ['MU'] } }
    expect(cache.get(q)).toBeUndefined()
    cache.set(q, frame(now, 10_000))
    expect(cache.get(q)?.rows).toHaveLength(1)
    expect(cache.get({ kind: 'quote', params: { symbols: ['MU'] } })).toBeDefined()
    expect(cache.getByKey('quote:{"symbols":["MU"]}')).toBeDefined()
    now += 9_999
    expect(cache.get(q)).toBeDefined()
    now += 1
    expect(cache.get(q)).toBeUndefined()
    // a zero TTL is never stored
    cache.set(q, frame(now, 0))
    expect(cache.size).toBe(0)
    // ttl override
    cache.set(q, frame(now, 0), 5_000)
    expect(cache.get(q)).toBeDefined()
    cache.delete(q)
    expect(cache.get(q)).toBeUndefined()
  })

  it('persists across processes: a new cache over the same store hits', () => {
    const now = 5_000
    const store = new SqliteStore(':memory:', { now: () => now })
    const a = new SqliteCache(store, { now: () => now })
    const route = { connector: 'openbb', route: 'equity/price/historical', params: { symbol: ['NVDA'], start_date: '2024-10-18' } }
    a.set(route, frame(now, 600_000, 500))
    const b = new SqliteCache(store, { now: () => now + 1 })
    expect(b.get(route)?.rows).toHaveLength(500)
    // param order does not matter
    expect(b.get({ connector: 'openbb', route: 'equity/price/historical', params: { start_date: '2024-10-18', symbol: ['NVDA'] } })).toBeDefined()
    a.clear()
    expect(new SqliteCache(store, { now: () => now + 2 }).get(route)).toBeUndefined()
  })

  it('caps the table at maxRows (oldest first) and keeps oversized frames in memory only', () => {
    let now = 1
    const store = new SqliteStore(':memory:', { now: () => now })
    const cache = new SqliteCache(store, { now: () => now, maxRows: 3, pruneEvery: 1, maxFrameBytes: 200 })
    for (let i = 0; i < 6; i++) {
      now = i + 1
      cache.set({ kind: 'quote', params: { symbols: [`S${i}`] } }, frame(now, 60_000))
    }
    expect(store.countFrames()).toBe(3)
    expect(store.getFrame('quote:{"symbols":["S0"]}', now)).toBeUndefined()
    expect(store.getFrame('quote:{"symbols":["S5"]}', now)).toBeDefined()
    const big: AnyQuery = { kind: 'quote', params: { symbols: ['BIG'] } }
    cache.set(big, frame(now, 60_000, 50))
    expect(cache.get(big)?.rows).toHaveLength(50)
    expect(store.getFrame('quote:{"symbols":["BIG"]}', now)).toBeUndefined()
  })

  it('is what the registry reads: a second run of the same query does not call the connector', async () => {
    const store = new SqliteStore(':memory:')
    const calls: { kind: string; params: unknown }[] = []
    const registry = new ConnectorRegistry({ cache: new SqliteCache(store) })
    registry.register(fakeConnector({ calls }), {})
    await registry.run({ kind: 'quote', params: { symbols: ['MU'] } })
    await registry.run({ kind: 'quote', params: { symbols: ['MU'] } })
    expect(calls).toHaveLength(1)
    // a fresh registry over the same store still hits
    const again = new ConnectorRegistry({ cache: new SqliteCache(store) })
    again.register(fakeConnector({ calls }), {})
    await again.run({ kind: 'quote', params: { symbols: ['MU'] } })
    expect(calls).toHaveLength(1)
    await again.run({ kind: 'quote', params: { symbols: ['MU'] } }, { bypassCache: true })
    expect(calls).toHaveLength(2)
  })
})
