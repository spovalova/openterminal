import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { configPath, loadConfig, normalizeConfig, resolvedLlm, saveConnectorConfig, terminalHome, workspacesDir, DEFAULT_MODELS } from '../src/config.js'

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'terminal-config-'))
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe('config', () => {
  it('creates the directory and a default config.yml on first run', () => {
    const cfg = loadConfig({ home, env: {} })
    expect(existsSync(configPath(home))).toBe(true)
    expect(existsSync(workspacesDir(home))).toBe(true)
    expect(cfg.connectors).toEqual([{ name: 'yahoo' }])
    expect(cfg.llm).toBeUndefined()
  })

  it('honours TERMINAL_HOME', () => {
    expect(terminalHome({ TERMINAL_HOME: '/x/y' })).toBe('/x/y')
    expect(terminalHome({})).toMatch(/\.terminal$/)
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
    expect(cfg.connectors).toEqual([{ name: 'yahoo' }, { name: 'finnhub', config: { apiKey: 'abc' } }])
    const text = readFileSync(configPath(home), 'utf8')
    expect(text).toContain('Keys never leave this machine')
    cfg = saveConnectorConfig(home, 'finnhub', { apiKey: 'def' })
    expect(cfg.connectors).toEqual([{ name: 'yahoo' }, { name: 'finnhub', config: { apiKey: 'def' } }])
    expect(loadConfig({ home, env: {} }).connectors).toHaveLength(2)
  })
})
