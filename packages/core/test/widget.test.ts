import { describe, expect, it } from 'vitest'
import { parseWidget, WorkspaceSchema, createWorkspace, ClientMsgSchema, ServerMsgSchema, STAT_KINDS, STAT_KEY_COLUMN, statColumn, numericColumns } from '../src/index.js'

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
    expect(() => parseWidget({ id: 'w', title: 'x', size: 'sm', query: ohlcv(['MU']), view: { type: 'gauge' } })).toThrow()
  })

  describe('stat view', () => {
    const stat = (query: unknown, view: Record<string, unknown> = { type: 'stat' }) => parseWidget({ id: 'w', title: 'x', size: 'sm', query, view })

    it('is allowed on the kinds with one row per symbol, and on nothing else', () => {
      expect(STAT_KINDS).toEqual(new Set(['quote', 'metrics', 'volatility', 'estimates', 'profile', 'short_interest']))
      for (const kind of STAT_KINDS) {
        expect(() => stat({ kind, params: { symbols: ['MU'] } }), kind).not.toThrow()
        expect(statColumn(kind, { type: 'stat' }), kind).toBe(STAT_KEY_COLUMN[kind as keyof typeof STAT_KEY_COLUMN])
      }
      expect(() => stat(ohlcv(['MU']))).toThrow(/stat view requires a quote, metrics, volatility, estimates, profile, short_interest query/)
      expect(() => stat({ kind: 'news', params: { symbols: ['MU'] } })).toThrow(/stat view requires/)
      expect(() => stat({ kind: 'options', params: { symbol: 'MU' } })).toThrow(/stat view requires/)
    })

    it('takes an optional column that must be a numeric column of the kind', () => {
      const w = stat({ kind: 'metrics', params: { symbols: ['MU'] } }, { type: 'stat', column: 'forward_pe' })
      expect(w.view).toEqual({ type: 'stat', column: 'forward_pe' })
      expect(statColumn('metrics', w.view)).toBe('forward_pe')
      // ZodError messages are JSON, so the quotes around the column name are escaped
      expect(() => stat({ kind: 'metrics', params: { symbols: ['MU'] } }, { type: 'stat', column: 'symbol' })).toThrow(/metrics has no numeric column \\"symbol\\"/)
      expect(() => stat({ kind: 'quote', params: { symbols: ['MU'] } }, { type: 'stat', column: 'pe' })).toThrow(/quote has no numeric column \\"pe\\" \(one of price, change_pct, volume, extended_price, extended_change_pct\)/)
      expect(() => stat({ kind: 'quote', params: { symbols: ['MU'] } }, { type: 'stat', column: '' })).toThrow()
      expect(numericColumns('quote')).toEqual(['price', 'change_pct', 'volume', 'extended_price', 'extended_change_pct'])
    })
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
