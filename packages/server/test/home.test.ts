// The config directory's one-time copy from ~/.terminal to ~/.openterminal (home.ts), against temporary home
// directories only: nothing here may touch the real ~/.terminal or ~/.openterminal.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConnectorRegistry, MemoryCache } from '@openterminal/core'
import { configPath, loadConfig } from '../src/config.js'
import { MIGRATED_NOTE, migrateLegacyHome, resolveHome } from '../src/home.js'
import { startServer } from '../src/main.js'
import { SqliteStore } from '../src/store/index.js'
import { createStubAgentRunner } from '../src/stub-agent.js'
import { fakeConnector, fakeRecipes } from './fake-connector.js'

let user: string
let oldHome: string
let newHome: string
let lines: string[]
const log = (msg: string) => lines.push(msg)
const NOW = new Date('2026-10-19T12:00:00Z')

beforeEach(() => {
  user = mkdtempSync(join(tmpdir(), 'openterminal-userhome-'))
  oldHome = join(user, '.terminal')
  newHome = join(user, '.openterminal')
  lines = []
})
afterEach(() => {
  rmSync(user, { recursive: true, force: true })
})

/** A ~/.terminal as production has it: config.yml (0600), the SQLite store, the catalog cache and liveness, recipes.yml. */
async function writeOldHome(): Promise<void> {
  mkdirSync(join(oldHome, 'catalog'), { recursive: true })
  writeFileSync(configPath(oldHome), 'llm:\nconnectors:\n  - name: yahoo\n  - name: finnhub\n    config: { apiKey: test-key }\n')
  chmodSync(configPath(oldHome), 0o600)
  writeFileSync(join(oldHome, 'catalog', 'openbb.json'), JSON.stringify({ connector: 'openbb', fingerprint: 'abc', descriptors: [] }))
  writeFileSync(join(oldHome, 'catalog', 'liveness.json'), '[]\n')
  writeFileSync(join(oldHome, 'recipes.yml'), 'recipes: []\n')
  utimesSync(join(oldHome, 'recipes.yml'), new Date('2026-10-01T00:00:00Z'), new Date('2026-10-01T00:00:00Z'))
  const store = new SqliteStore(join(oldHome, 'terminal.db'), { log: () => {} })
  await store.create({ name: 'Memory' })
  await store.create({ name: 'Rates' })
  store.close()
  chmodSync(oldHome, 0o700)
}

function tree(dir: string, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? tree(join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`])).sort()
}

describe('migrateLegacyHome', () => {
  it('copies ~/.terminal to ~/.openterminal when only the old directory exists, and leaves a note in the old one', async () => {
    await writeOldHome()
    const before = tree(oldHome)
    const bytes = Object.fromEntries(before.map((f) => [f, readFileSync(join(oldHome, f))]))

    expect(migrateLegacyHome(oldHome, newHome, { log, now: () => NOW })).toEqual({ action: 'copied', from: oldHome, to: newHome })

    // the new directory is a byte-for-byte copy, modes and timestamps kept, and no MIGRATED.txt in it
    expect(tree(newHome)).toEqual(before)
    for (const f of before) expect(readFileSync(join(newHome, f)).equals(bytes[f]!)).toBe(true)
    expect(statSync(configPath(newHome)).mode & 0o777).toBe(0o600)
    expect(statSync(newHome).mode & 0o777).toBe(0o700)
    expect(statSync(join(newHome, 'recipes.yml')).mtimeMs).toBe(statSync(join(oldHome, 'recipes.yml')).mtimeMs)

    // the SQLite file opens in its new place with its rows
    const copied = new SqliteStore(join(newHome, 'terminal.db'), { log: () => {} })
    expect((await copied.list()).map((w) => w.name)).toEqual(['Memory', 'Rates'])
    copied.close()

    // the old directory keeps every file, plus the note saying where the data went
    expect(tree(oldHome)).toEqual([...before, MIGRATED_NOTE].sort())
    for (const f of before) expect(readFileSync(join(oldHome, f)).equals(bytes[f]!)).toBe(true)
    const note = readFileSync(join(oldHome, MIGRATED_NOTE), 'utf8')
    expect(note).toContain(newHome)
    expect(note).toContain(NOW.toISOString())
    expect(note).toMatch(/Nothing in .* was moved or deleted/)

    // one log line, and no temporary directory left beside the new one
    expect(lines).toHaveLength(1)
    expect(lines[0]).toBe(`copied ${oldHome} to ${newHome}, the config directory's new name; ${oldHome} is left as it was, with ${MIGRATED_NOTE}`)
    expect(readdirSync(user).sort()).toEqual(['.openterminal', '.terminal'])
  })

  it('uses ~/.openterminal and does nothing else when both exist', async () => {
    await writeOldHome()
    mkdirSync(newHome)
    writeFileSync(configPath(newHome), 'connectors:\n  - name: openbb\n')
    const oldBefore = tree(oldHome)

    expect(migrateLegacyHome(oldHome, newHome, { log })).toEqual({ action: 'none', reason: 'exists' })
    expect(resolveHome({}, { userHome: user, log })).toBe(newHome)

    expect(tree(newHome)).toEqual(['config.yml'])
    expect(readFileSync(configPath(newHome), 'utf8')).toBe('connectors:\n  - name: openbb\n')
    expect(tree(oldHome)).toEqual(oldBefore)
    expect(existsSync(join(oldHome, MIGRATED_NOTE))).toBe(false)
    expect(lines).toEqual([])
  })

  it('does nothing when neither exists, and the first loadConfig creates a fresh ~/.openterminal', () => {
    expect(migrateLegacyHome(oldHome, newHome, { log })).toEqual({ action: 'none', reason: 'no-legacy' })
    const home = resolveHome({}, { userHome: user, log })
    expect(home).toBe(newHome)
    expect(existsSync(newHome)).toBe(false)
    expect(existsSync(oldHome)).toBe(false)
    expect(lines).toEqual([])

    loadConfig({ home, env: {} })
    expect(existsSync(configPath(newHome))).toBe(true)
    expect(existsSync(oldHome)).toBe(false)
  })

  it('leaves no half-copied ~/.openterminal when the copy fails', () => {
    mkdirSync(oldHome)
    writeFileSync(configPath(oldHome), 'connectors: []\n')
    // a file where the parent of the new directory should be: the copy cannot be created
    const blocked = join(user, 'blocked')
    writeFileSync(blocked, '')
    expect(() => migrateLegacyHome(oldHome, join(blocked, '.openterminal'), { log })).toThrow(/could not copy/)
    expect(existsSync(join(oldHome, MIGRATED_NOTE))).toBe(false)
    expect(readdirSync(user).sort()).toEqual(['.terminal', 'blocked'])
  })
})

describe('resolveHome', () => {
  it('copies on the default path only: a directory named by OPENTERMINAL_HOME or TERMINAL_HOME is used as is', async () => {
    await writeOldHome()
    const explicit = join(user, 'elsewhere')
    expect(resolveHome({ OPENTERMINAL_HOME: explicit }, { userHome: user, log })).toBe(explicit)
    expect(lines).toEqual([])
    expect(resolveHome({ TERMINAL_HOME: oldHome }, { userHome: user, log })).toBe(oldHome)
    expect(lines).toEqual(['TERMINAL_HOME is deprecated; set OPENTERMINAL_HOME instead'])
    expect(existsSync(newHome)).toBe(false)
    expect(existsSync(join(oldHome, MIGRATED_NOTE))).toBe(false)
  })

  it('takes the user home from the env HOME, then copies once', async () => {
    await writeOldHome()
    expect(resolveHome({ HOME: user }, { log })).toBe(newHome)
    expect(existsSync(configPath(newHome))).toBe(true)
    expect(resolveHome({ HOME: user }, { log })).toBe(newHome)
    expect(lines.filter((l) => l.startsWith('copied '))).toHaveLength(1)
  })
})

describe('startServer', () => {
  it('copies the old directory before it opens the store, so the JSON store migrates in the new directory', async () => {
    // a pre-v2 ~/.terminal: config.yml and the JSON workspaces directory, no terminal.db yet (production today)
    mkdirSync(join(oldHome, 'workspaces'), { recursive: true })
    writeFileSync(configPath(oldHome), 'llm:\nconnectors:\n  - name: yahoo\n')
    const widget = { id: 'mu', title: 'MU', size: 'md', query: { kind: 'quote', params: { symbols: ['MU'] } }, view: { type: 'table' } }
    writeFileSync(join(oldHome, 'workspaces', 'ws1.json'), JSON.stringify({ id: 'ws1', name: 'Memory', widgets: [widget], messages: [], createdAt: 1, updatedAt: 2 }))

    const registry = new ConnectorRegistry({ cache: new MemoryCache(), recipes: fakeRecipes() })
    registry.register(fakeConnector(), {})
    const running = await startServer({ env: { HOME: user }, port: 0, registry, agent: createStubAgentRunner(), webDist: false, log })
    try {
      expect(running.storeKind).toBe('sqlite')
      expect(running.store.location).toBe(join(newHome, 'terminal.db'))
      expect(running.migration).toMatchObject({ workspaces: 1, v1Widgets: 1, backup: join(newHome, 'workspaces.json-backup') })
      expect((await running.store.list()).map((w) => w.name)).toEqual(['Memory'])
      const copiedAt = lines.findIndex((l) => l.startsWith('copied '))
      const openedAt = lines.findIndex((l) => l.startsWith('store: sqlite'))
      expect(copiedAt).toBeGreaterThanOrEqual(0)
      expect(openedAt).toBeGreaterThan(copiedAt)
    } finally {
      await running.close()
    }
    // the old directory is untouched apart from the note: its JSON workspaces are still there, nothing was migrated in it
    expect(tree(oldHome)).toEqual([MIGRATED_NOTE, 'config.yml', 'workspaces/ws1.json'])
  })
})
