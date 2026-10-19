import { describe, expect, it } from 'vitest'
import { ClientMsgSchema, LegacyWidgetSchema, ServerMsgSchema, WorkspaceSchema, createWorkspace, isLegacyWidget } from '../src/index.js'

describe('the v1 JSON shape', () => {
  it('is recognised and read, but only to migrate: an open params object, the four typed views', () => {
    const quote = { id: 'w1', title: 'Quotes', size: 'sm', query: { kind: 'quote', params: { symbols: ['MU'] } }, view: { type: 'table' } }
    expect(isLegacyWidget(quote)).toBe(true)
    expect(isLegacyWidget({ ...quote, data: {} })).toBe(false)
    expect(isLegacyWidget({ id: 'w', title: 'x', size: 'sm', data: { main: { recipe: 'quote' } }, view: { preset: 'table' } })).toBe(false)
    expect(LegacyWidgetSchema.parse(quote).query).toEqual({ kind: 'quote', params: { symbols: ['MU'] } })
    expect(LegacyWidgetSchema.parse({ ...quote, view: { type: 'series', candle: true, labels: { MU: 'Micron' } } }).view).toEqual({ type: 'series', candle: true, labels: { MU: 'Micron' } })
    expect(() => LegacyWidgetSchema.parse({ ...quote, view: { type: 'gauge' } })).toThrow()
    expect(() => LegacyWidgetSchema.parse({ ...quote, size: 'xl' })).toThrow()
  })
})

describe('workspace and protocol schemas', () => {
  it('creates and validates a workspace, migrating v1 widgets on read', () => {
    const ws = createWorkspace({ id: 'abc', name: 'Morning', now: 1 })
    expect(WorkspaceSchema.parse(ws)).toEqual(ws)
    const stored = { ...ws, widgets: [{ id: 'w1', title: 'Quotes', size: 'sm', query: { kind: 'quote', params: { symbols: ['MU'] } }, view: { type: 'table' } }] }
    expect(WorkspaceSchema.parse(stored).widgets).toEqual([{ id: 'w1', title: 'Quotes', size: 'sm', data: { main: { recipe: 'quote', params: { symbols: ['MU'] } } }, view: { preset: 'table' } }])
  })
  it('validates messages on both directions', () => {
    expect(ClientMsgSchema.parse({ t: 'prompt', workspaceId: 'a', text: 'MU' }).t).toBe('prompt')
    expect(() => ClientMsgSchema.parse({ t: 'prompt', workspaceId: 'a', text: '' })).toThrow()
    expect(ServerMsgSchema.parse({ t: 'started', workspaceId: 'a' }).t).toBe('started')
    expect(ServerMsgSchema.parse({ t: 'done', workspaceId: 'a', message: { role: 'agent', text: 'hi [[widget:w1]]' } }).t).toBe('done')
    expect(() => ServerMsgSchema.parse({ t: 'nope' })).toThrow()
  })
})
