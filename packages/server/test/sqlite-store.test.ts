import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isWidgetV2, type Frame, type Recipe, type Widget } from '@terminal/core'
import { SqliteStore, migrateJsonStore, migrateWorkspaceDoc, openStore, MIGRATION_KEY } from '../src/store/index.js'
import { stubWidgets } from '../src/stub-agent.js'

let home: string
let store: SqliteStore
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'terminal-sqlite-'))
  store = new SqliteStore(join(home, 'terminal.db'), { log: () => {} })
})
afterEach(() => {
  store.close()
  rmSync(home, { recursive: true, force: true })
})

const frame = (rows = 2, ttl = 10_000): Frame => ({
  columns: [{ name: 'symbol', type: 'string' }, { name: 'price', type: 'number' }],
  rows: Array.from({ length: rows }, (_, i) => [`S${i}`, 100 + i]),
  meta: { connector: 'fake', fetchedAt: 1_000, ttl },
})

const v2Widget = {
  id: 'w-v2',
  title: 'P/E over time',
  size: 'lg',
  data: {
    price: { recipe: 'ohlcv', params: { symbols: ['NVDA'], interval: '1d', range: '2y' } },
    eps: { recipe: 'eps_history', params: { symbols: ['NVDA'], limit: 12 } },
    main: { inputs: { price: { recipe: 'ohlcv', params: { symbols: ['NVDA'] } } }, code: 'result = price' },
  },
  view: { preset: 'price' },
  fields: { pe: { label: 'P/E (TTM)', unit: 'ratio' } },
} as const

describe('SqliteStore', () => {
  it('round-trips workspaces with v1 and v2 widgets, messages, patch, list, delete', async () => {
    expect(await store.list()).toEqual([])
    const ws = await store.create({ name: 'Memory' })
    expect(await store.get(ws.id)).toEqual(ws)

    const widgets = [...stubWidgets(new Date('2026-10-16T00:00:00Z')), v2Widget as never]
    const patched = await store.patch(ws.id, { widgets, messages: [{ role: 'user', text: 'hi' }] })
    expect(patched?.widgets).toHaveLength(6)
    expect(patched?.widgets.map((w) => isWidgetV2(w))).toEqual([false, false, false, false, false, true])
    expect((await store.get(ws.id))?.widgets).toEqual(widgets)
    expect(patched!.updatedAt).toBeGreaterThanOrEqual(ws.updatedAt)

    const found = await store.findWidget('w-v2')
    expect(found?.workspace.id).toBe(ws.id)
    expect(isWidgetV2(found!.widget) && Object.keys(found!.widget.data)).toEqual(['price', 'eps', 'main'])

    await Promise.all([1, 2, 3].map((i) => store.appendMessage(ws.id, { role: 'agent', text: String(i) })))
    expect((await store.get(ws.id))?.messages.map((m) => m.text)).toEqual(['hi', '1', '2', '3'])

    const second = await store.create({ name: 'Other' })
    expect((await store.list()).map((w) => w.id)).toEqual([ws.id, second.id])
    expect(await store.delete(ws.id)).toBe(true)
    expect(await store.delete(ws.id)).toBe(false)
    expect(await store.get(ws.id)).toBeUndefined()
    expect(await store.findWidget('w-v2')).toBeUndefined()
    expect(await store.get('../etc/passwd')).toBeUndefined()
  })

  it('rejects an invalid widget set and keeps the previous one', async () => {
    const ws = await store.create()
    await store.patch(ws.id, { widgets: stubWidgets() })
    await expect(store.patch(ws.id, { widgets: [{ id: 'x', title: 'bad', size: 'lg', query: { kind: 'quote', params: { symbols: ['MU'] } }, view: { type: 'series' } } as never] })).rejects.toThrow()
    expect((await store.get(ws.id))?.widgets).toHaveLength(5)
  })

  it('survives reopening the same file', async () => {
    const ws = await store.create({ name: 'Persisted', widgets: stubWidgets() })
    store.setSetting('ticker', ['^GSPC'])
    store.close()
    store = new SqliteStore(join(home, 'terminal.db'))
    expect((await store.get(ws.id))?.widgets).toHaveLength(5)
    expect(store.getSetting('ticker')).toEqual(['^GSPC'])
  })

  it('stores user recipes, the catalog cache, liveness, the run log and settings', () => {
    const recipe: Recipe = {
      name: 'my_quote',
      title: '{symbols} quote',
      params: { type: 'object', properties: { symbols: { type: 'array', items: { type: 'string' } } }, required: ['symbols'] },
      view: { preset: 'stat' },
      routes: [{ connector: 'fake', route: 'quote', params: { symbols: '{symbols}' } }],
      user: true,
    }
    store.setRecipes([recipe])
    expect(store.listRecipes()).toEqual([recipe])
    store.setRecipes([])
    expect(store.listRecipes()).toEqual([])

    const d = { connector: 'fake', route: 'quote', summary: 'Quote', params: [], providers: [], fields: [{ name: 'price', type: 'number' as const }] }
    store.setCatalog({ connector: 'fake', version: '1.0', descriptors: [d], generatedAt: 5 })
    expect(store.getCatalog('fake')).toEqual({ connector: 'fake', version: '1.0', descriptors: [d], generatedAt: 5 })
    store.setCatalog({ connector: 'fake', version: '1.1', descriptors: [], generatedAt: 6 })
    expect(store.listCatalogs().map((c) => c.version)).toEqual(['1.1'])

    store.setLiveness([
      { connector: 'fake', route: 'quote', checkedAt: 1, ok: true, rows: 4, ms: 12.5, sampleColumns: ['symbol', 'price'] },
      { connector: 'fake', route: 'news', checkedAt: 1, ok: false, error: 'HTTP 500' },
    ])
    store.setLiveness({ connector: 'fake', route: 'news', checkedAt: 2, ok: true, rows: 1 })
    expect(store.getLiveness('fake')).toEqual([
      { connector: 'fake', route: 'news', checkedAt: 2, ok: true, rows: 1 },
      { connector: 'fake', route: 'quote', checkedAt: 1, ok: true, rows: 4, ms: 12.5, sampleColumns: ['symbol', 'price'] },
    ])
    expect(store.getLiveness('other')).toEqual([])

    store.appendRun({ id: 'r1', workspaceId: 'ws1', startedAt: 10, ms: 1200, model: 'test', steps: [{ tool: 'query', args: {}, summary: 'quote', ms: 3 }], tokens: { input: 1, output: 2 }, cost: 0.01, verification: { ok: true } })
    store.appendRun({ id: 'r2', workspaceId: 'ws2', startedAt: 20, ms: 100, model: 'test', steps: [] })
    expect(store.listRuns().map((r) => r.id)).toEqual(['r2', 'r1'])
    expect(store.listRuns({ workspaceId: 'ws1' })[0]).toMatchObject({ id: 'r1', tokens: { input: 1, output: 2 }, cost: 0.01, verification: { ok: true } })
    expect(store.listRuns({ workspaceId: 'ws2' })[0]).not.toHaveProperty('tokens')

    expect(store.getSetting('providers')).toBeUndefined()
    store.setSetting('providers', { 'openbb:equity/price/quote': 'yfinance' })
    expect(store.getSetting('providers')).toEqual({ 'openbb:equity/price/quote': 'yfinance' })
    store.setSetting('providers', undefined)
    expect(store.getSetting('providers')).toBeUndefined()
  })

  it('frame rows expire and prune to the row cap, oldest first', () => {
    store.setFrame('a', frame(), 1_500)
    store.setFrame('b', frame(), 5_000)
    expect(store.getFrame('a', 1_000)?.rows).toHaveLength(2)
    expect(store.getFrame('a', 1_500)).toBeUndefined() // expired on read, row removed
    expect(store.countFrames()).toBe(1)
    const now = Date.now()
    for (let i = 0; i < 10; i++) store.setFrame(`k${i}`, frame(1), now + 60_000)
    expect(store.pruneFrames(now, 5)).toBe(6) // 11 rows: nothing expired, 6 oldest dropped (b first)
    expect(store.countFrames()).toBe(5)
    expect(store.getFrame('b', now)).toBeUndefined()
    expect(store.getFrame('k9', now)).toBeDefined()
    store.clearFrames()
    expect(store.countFrames()).toBe(0)
  })
})

describe('migration from the JSON store', () => {
  function writeJsonStore(dir: string) {
    mkdirSync(dir, { recursive: true })
    const widgets = stubWidgets(new Date('2026-10-16T00:00:00Z'))
    const macro: Widget = { id: 'rates', title: 'Rates', size: 'md', query: { kind: 'macro', params: { series: ['treasury_10y', 'fed_funds'], range: '1y' } }, view: { type: 'series' } }
    writeFileSync(join(dir, 'ws1.json'), JSON.stringify({ id: 'ws1', name: 'Memory', widgets, messages: [{ role: 'user', text: 'memory?' }], createdAt: 1, updatedAt: 2 }))
    writeFileSync(join(dir, 'ws2.json'), JSON.stringify({ id: 'ws2', name: 'Rates', widgets: [macro, v2Widget], messages: [], createdAt: 3, updatedAt: 4 }))
    writeFileSync(join(dir, 'broken.json'), '{ not json')
    writeFileSync(join(dir, 'notes.txt'), 'ignored')
  }

  it('migrateWorkspaceDoc rewrites v1 widgets through migrateWidget and keeps v2 ones', () => {
    const widgets = stubWidgets(new Date('2026-10-16T00:00:00Z'))
    const { workspace, v1Widgets } = migrateWorkspaceDoc({ id: 'x', name: 'X', widgets: [...widgets, v2Widget], messages: [], createdAt: 1, updatedAt: 1 })
    expect(v1Widgets).toBe(5)
    expect(workspace.widgets.every((w) => isWidgetV2(w))).toBe(true)
    const first = workspace.widgets[0]!
    expect(isWidgetV2(first) && first.data).toEqual({ main: { recipe: 'ohlcv', params: { symbols: ['MU', 'SNDK', 'WDC', 'STX'], interval: '1d', range: '3mo' } } })
    expect(isWidgetV2(first) && first.view).toEqual({ preset: 'compare', normalize: true })
    expect(isWidgetV2(first) && first.query).toEqual(widgets[0]!.query)
    expect(workspace.widgets[5]).toEqual(v2Widget)
  })

  it('copies every workspace into SQLite once, backs up the JSON directory and skips broken files', async () => {
    const dir = join(home, 'workspaces')
    writeJsonStore(dir)
    const report = migrateJsonStore(dir, store, { now: () => 1_700_000_000_000 })
    expect(report).toMatchObject({ alreadyDone: false, workspaces: 2, widgets: 7, v1Widgets: 6 })
    expect(report.skipped.map((s) => s.file)).toEqual(['broken.json'])
    expect(report.backup).toBe(`${dir}.json-backup`)
    expect(existsSync(dir)).toBe(false)
    expect(readdirSync(report.backup!).sort()).toEqual(['broken.json', 'notes.txt', 'ws1.json', 'ws2.json'])

    const list = await store.list()
    expect(list.map((w) => [w.id, w.name, w.createdAt, w.widgets.length])).toEqual([
      ['ws1', 'Memory', 1, 5],
      ['ws2', 'Rates', 3, 2],
    ])
    expect(list[0]!.messages).toEqual([{ role: 'user', text: 'memory?' }])
    // a multi-series macro widget becomes one macro dataset per series
    const rates = list[1]!.widgets[0]!
    expect(isWidgetV2(rates) && Object.keys(rates.data)).toEqual(['treasury_10y', 'fed_funds'])

    // a second run is a no-op, even with a fresh JSON directory
    writeJsonStore(dir)
    const again = migrateJsonStore(dir, store)
    expect(again.alreadyDone).toBe(true)
    expect(existsSync(dir)).toBe(true)
    expect((await store.list()).length).toBe(2)
    expect(store.getSetting(MIGRATION_KEY)).toMatchObject({ workspaces: 2 })
  })

  it('openStore returns sqlite with the report and an empty home migrates nothing', async () => {
    const opened = openStore(home, { jsonDir: join(home, 'workspaces'), log: () => {} })
    expect(opened.kind).toBe('sqlite')
    expect(opened.migration).toMatchObject({ workspaces: 0, alreadyDone: false })
    expect(await opened.store.list()).toEqual([])
    opened.store.close()
    const reopened = openStore(home, { jsonDir: join(home, 'workspaces'), log: () => {} })
    expect(reopened.migration?.alreadyDone).toBe(true)
    reopened.store.close()
  })
})
