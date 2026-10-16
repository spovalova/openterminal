import { describe, expect, it } from 'vitest'
import { parseWidget, WorkspaceSchema, createWorkspace, ClientMsgSchema, ServerMsgSchema } from '../src/index.js'

const ohlcv = (symbols: string[]) => ({ kind: 'ohlcv', params: { symbols, interval: '1d', range: '3mo' } })

describe('widget schema', () => {
  it('accepts a normalized multi-symbol series', () => {
    const w = parseWidget({ id: 'w1', title: 'Memory names', size: 'lg', query: ohlcv(['MU', 'SNDK']), view: { type: 'series', normalize: true } })
    expect(w.size).toBe('lg')
  })
  it('accepts a single-symbol candle', () => {
    expect(() => parseWidget({ id: 'w', title: 'MU', size: 'md', query: ohlcv(['MU']), view: { type: 'series', candle: true } })).not.toThrow()
  })
  it('rejects candle with more than one symbol', () => {
    expect(() => parseWidget({ id: 'w', title: 'x', size: 'md', query: ohlcv(['MU', 'WDC']), view: { type: 'series', candle: true } })).toThrow(/exactly one symbol/)
  })
  it('rejects candle together with normalize', () => {
    expect(() => parseWidget({ id: 'w', title: 'x', size: 'md', query: ohlcv(['MU']), view: { type: 'series', candle: true, normalize: true } })).toThrow(/mutually exclusive/)
  })
  it('rejects a series view on a non-ohlcv query', () => {
    expect(() => parseWidget({ id: 'w', title: 'x', size: 'md', query: { kind: 'quote', params: { symbols: ['MU'] } }, view: { type: 'series' } })).toThrow(/ohlcv/)
  })
  it('accepts a table on any kind', () => {
    for (const query of [
      { kind: 'quote', params: { symbols: ['MU'] } },
      { kind: 'news', params: { symbols: ['MU'], limit: 10 } },
      { kind: 'earnings', params: { symbols: ['MU'], from: '2026-10-16', to: '2026-12-15' } },
      ohlcv(['MU']),
    ]) {
      expect(() => parseWidget({ id: 'w', title: 'x', size: 'sm', query, view: { type: 'table' } })).not.toThrow()
    }
  })
  it('rejects unknown sizes and views', () => {
    expect(() => parseWidget({ id: 'w', title: 'x', size: 'xl', query: ohlcv(['MU']), view: { type: 'table' } })).toThrow()
    expect(() => parseWidget({ id: 'w', title: 'x', size: 'sm', query: ohlcv(['MU']), view: { type: 'stat' } })).toThrow()
  })
})

describe('workspace and protocol schemas', () => {
  it('creates and validates a workspace', () => {
    const ws = createWorkspace({ id: 'abc', name: 'Morning', now: 1 })
    expect(WorkspaceSchema.parse(ws)).toEqual(ws)
  })
  it('validates messages on both directions', () => {
    expect(ClientMsgSchema.parse({ t: 'prompt', workspaceId: 'a', text: 'MU' }).t).toBe('prompt')
    expect(() => ClientMsgSchema.parse({ t: 'prompt', workspaceId: 'a', text: '' })).toThrow()
    expect(ServerMsgSchema.parse({ t: 'started', workspaceId: 'a' }).t).toBe('started')
    expect(ServerMsgSchema.parse({ t: 'done', workspaceId: 'a', message: { role: 'agent', text: 'hi [[widget:w1]]' } }).t).toBe('done')
    expect(() => ServerMsgSchema.parse({ t: 'nope' })).toThrow()
  })
})
