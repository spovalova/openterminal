// The command set (src/commands/): the catalog's routes that take no provider go through the harness under the name
// `commands`, shaped without a provider and redacted with the credentials the set declares.
import { describe, expect, it } from 'vitest'
import { COMMANDS, nativeDescriptorFor, snapshotDescriptors } from '../src/index.js'
import { secretsFor, shapeCase, sourceDef } from '../src/harness/run.js'

describe('commands', () => {
  it('are the catalog routes with no provider', () => {
    const providerless = snapshotDescriptors().filter((d) => d.providers.length === 0).map((d) => d.route)
    expect(providerless.length).toBe(18)
    for (const route of Object.keys(COMMANDS.routes)) {
      expect(providerless).toContain(route)
      expect(nativeDescriptorFor(route)?.providers).toEqual([])
    }
  })

  it('shape their params without a provider, and refuse a route that takes one', () => {
    expect(shapeCase('commands', { route: 'oecd/list_tables', params: { topic: 'ECO' } }).sent).toEqual({ topic: 'ECO' })
    expect(() => shapeCase('commands', { route: 'equity/price/quote', params: { symbol: 'AAPL' } })).toThrow(/takes a provider/)
  })

  it('redact the credentials the set declares', () => {
    expect(sourceDef('commands')).toBe(COMMANDS)
    expect(secretsFor('commands', { EIA_API_KEY: 'k-123' })).toEqual({ eia_api_key: 'k-123' })
  })
})
