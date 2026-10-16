import { describe, expect, it } from 'vitest'
import { DEFAULT_MODEL, createAgentRunner, resolveModel } from '../index.js'
import { createFakeRegistry } from './helpers.js'

describe('createAgentRunner', () => {
  it('resolves provider models without touching the network and falls back to the default id', () => {
    const anthropic = resolveModel({ provider: 'anthropic', model: '', apiKey: 'k' })
    expect(anthropic.modelId).toBe(DEFAULT_MODEL.anthropic)
    expect(anthropic.provider).toContain('anthropic')
    const openai = resolveModel({ provider: 'openai', model: 'gpt-5.4-mini', apiKey: 'k' })
    expect(openai.modelId).toBe('gpt-5.4-mini')
    expect(openai.provider).toContain('openai')
  })

  it('returns a runner for a configured provider and rejects a missing key', () => {
    const { registry } = createFakeRegistry()
    const runner = createAgentRunner({ registry, llm: { provider: 'anthropic', model: DEFAULT_MODEL.anthropic, apiKey: 'k' } })
    expect(typeof runner.run).toBe('function')
    expect(() => createAgentRunner({ registry, llm: { provider: 'openai', model: '', apiKey: '' } })).toThrow(/apiKey/)
  })
})
