import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { configPath, loadConfig, normalizeConfig, resolvedLlm, openterminalHome, saveConnectorConfig, saveLlmConfig, workspacesDir, DEFAULT_MODELS } from '../src/config.js'

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'openterminal-config-'))
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe('config', () => {
  it('creates the directory and a default config.yml on first run', () => {
    const cfg = loadConfig({ home, env: {} })
    expect(existsSync(configPath(home))).toBe(true)
    expect(existsSync(workspacesDir(home))).toBe(true)
    expect(cfg.connectors).toEqual([{ name: 'openbb' }, { name: 'yahoo' }])
    expect(cfg.llm).toBeUndefined()
  })

  it('honours OPENTERMINAL_HOME, then the deprecated TERMINAL_HOME, else ~/.openterminal', () => {
    expect(openterminalHome({ OPENTERMINAL_HOME: '/x/new', TERMINAL_HOME: '/x/y' })).toBe('/x/new')
    expect(openterminalHome({ TERMINAL_HOME: '/x/y' })).toBe('/x/y')
    expect(openterminalHome({})).toMatch(/\/\.openterminal$/)
  })

  it('fills llm from the environment when the file has none', () => {
    const cfg = loadConfig({ home, env: { ANTHROPIC_API_KEY: 'sk-ant-test' } })
    expect(cfg.llm).toEqual({ provider: 'anthropic', apiKey: 'sk-ant-test' })
    expect(resolvedLlm(cfg)).toEqual({ provider: 'anthropic', model: DEFAULT_MODELS.anthropic, apiKey: 'sk-ant-test' })
    const openai = normalizeConfig({ llm: { provider: 'openai', model: 'gpt-x' } }, { OPENAI_API_KEY: 'sk-oa' })
    expect(openai.llm).toEqual({ provider: 'openai', model: 'gpt-x', apiKey: 'sk-oa' })
  })

  it('prefers the file key and validates the connector list', () => {
    writeFileSync(configPath(home), 'llm:\n  provider: anthropic\n  apiKey: file-key\nconnectors:\n  - name: finnhub\n    config: { apiKey: fh }\n  - name: yahoo\n')
    const cfg = loadConfig({ home, env: { ANTHROPIC_API_KEY: 'env-key' } })
    expect(cfg.llm?.apiKey).toBe('file-key')
    expect(cfg.connectors.map((c) => c.name)).toEqual(['finnhub', 'yahoo'])
    expect(cfg.connectors[0]?.config).toEqual({ apiKey: 'fh' })
    expect(() => normalizeConfig({ connectors: [{ config: {} }] })).toThrow(/invalid/)
  })

  it('writes a connector config back, keeping comments, and updates in place', () => {
    loadConfig({ home, env: {} })
    let cfg = saveConnectorConfig(home, 'finnhub', { apiKey: 'abc' })
    expect(cfg.connectors).toEqual([{ name: 'openbb' }, { name: 'yahoo' }, { name: 'finnhub', config: { apiKey: 'abc' } }])
    const text = readFileSync(configPath(home), 'utf8')
    expect(text).toContain('Keys never leave this machine')
    cfg = saveConnectorConfig(home, 'finnhub', { apiKey: 'def' })
    expect(cfg.connectors).toEqual([{ name: 'openbb' }, { name: 'yahoo' }, { name: 'finnhub', config: { apiKey: 'def' } }])
    expect(loadConfig({ home, env: {} }).connectors).toHaveLength(3)
  })

  // POSIX modes only; Windows has no group or world bits to check.
  it.skipIf(process.platform === 'win32')('creates config.yml readable by its owner only', () => {
    loadConfig({ home, env: {} })
    expect(statSync(configPath(home)).mode & 0o777).toBe(0o600)
    saveConnectorConfig(home, 'finnhub', { apiKey: 'abc' })
    expect(statSync(configPath(home)).mode & 0o777).toBe(0o600)
  })

  it('writes the llm block from the first-run prompt: owner-only, comments and connectors kept, read back as the key', () => {
    loadConfig({ home, env: {} })
    saveConnectorConfig(home, 'finnhub', { apiKey: 'fh' })
    const cfg = saveLlmConfig(home, { provider: 'anthropic', apiKey: 'sk-ant-dummy' })
    expect(cfg.llm).toEqual({ provider: 'anthropic', apiKey: 'sk-ant-dummy' })
    expect(cfg.connectors.map((c) => c.name)).toEqual(['openbb', 'yahoo', 'finnhub'])
    const text = readFileSync(configPath(home), 'utf8')
    expect(text).toContain('Keys never leave this machine')
    expect(text).toMatch(/^llm:\n {2}provider: anthropic\n {2}apiKey: sk-ant-dummy$/m)
    if (process.platform !== 'win32') expect(statSync(configPath(home)).mode & 0o777).toBe(0o600)
    // The file key wins over the environment on the next start.
    expect(loadConfig({ home, env: { ANTHROPIC_API_KEY: 'env' } }).llm?.apiKey).toBe('sk-ant-dummy')
    // Saving again replaces the block, with a model when given.
    expect(saveLlmConfig(home, { provider: 'openai', apiKey: 'sk-oa', model: 'gpt-x' }).llm).toEqual({ provider: 'openai', apiKey: 'sk-oa', model: 'gpt-x' })
    expect(readFileSync(configPath(home), 'utf8').match(/^llm:/gm)).toHaveLength(1)
    expect(() => saveLlmConfig(home, { provider: 'anthropic', apiKey: '' })).toThrow()
  })
})
