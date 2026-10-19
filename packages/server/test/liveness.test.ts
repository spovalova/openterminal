import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Catalog, type Descriptor } from '@terminal/core'
import { FileLivenessStore, MemoryLivenessStore, applyLiveness, livenessOf, livenessPath, livenessRow, openLivenessStore, type LivenessRow } from '../src/liveness.js'

const d = (connector: string, route: string): Descriptor => ({ connector, route, summary: route, params: [], providers: [], fields: [] })
const rowA: LivenessRow = { connector: 'openbb', route: 'equity/price/quote', checkedAt: 1_000, ok: true, rows: 2, ms: 120, sampleColumns: ['symbol', 'last_price'] }
const rowB: LivenessRow = { connector: 'openbb', route: 'eia/petroleum_status_report', checkedAt: 1_000, ok: false, ms: 30, error: 'OpenBB 401 on /eia/petroleum_status_report: api_key missing' }
const rowC: LivenessRow = { connector: 'yahoo', route: 'quote', checkedAt: 2_000, ok: true, rows: 1 }

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'terminal-liveness-'))
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

describe('MemoryLivenessStore', () => {
  it('upserts by connector:route, gets, clears per connector, and rejects a malformed row', async () => {
    const s = new MemoryLivenessStore([rowA])
    await s.put([rowB, rowC, { ...rowA, rows: 5 }])
    expect((await s.all()).length).toBe(3)
    expect(await s.get({ connector: 'openbb', route: 'equity/price/quote' })).toMatchObject({ rows: 5 })
    expect(await s.get({ connector: 'openbb', route: 'nope' })).toBeUndefined()
    await s.clear('openbb')
    expect((await s.all()).map((r) => r.route)).toEqual(['quote'])
    await s.clear()
    expect(await s.all()).toEqual([])
    await expect(s.put([{ connector: 'x', route: 'y', checkedAt: 1 } as LivenessRow])).rejects.toThrow()
    expect(livenessRow(d('a', 'b'), { checkedAt: 1, ok: true })).toEqual({ connector: 'a', route: 'b', checkedAt: 1, ok: true })
    expect(livenessOf(rowB)).toEqual({ checkedAt: 1_000, ok: false, ms: 30, error: rowB.error })
  })
})

describe('FileLivenessStore', () => {
  it('persists rows under <home>/catalog/liveness.json and reads them back in a fresh instance', async () => {
    const path = livenessPath(home)
    expect(path).toBe(join(home, 'catalog', 'liveness.json'))
    const s = openLivenessStore(home)
    expect(await s.all()).toEqual([])
    await s.put([rowA, rowB])
    expect(existsSync(path)).toBe(true)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ rows: [rowA, rowB] })
    const again = new FileLivenessStore(path)
    expect(await again.get(rowB)).toEqual(rowB)
    await again.clear('openbb')
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ rows: [] })
  })
  it('starts empty on a corrupt or foreign file and says so', async () => {
    const logs: string[] = []
    const path = livenessPath(home)
    writeFileSync(join(home, 'liveness.json'), '{', 'utf8')
    const bad = new FileLivenessStore(join(home, 'liveness.json'), { log: (m) => logs.push(m) })
    expect(await bad.all()).toEqual([])
    expect(logs[0]).toMatch(/could not read/)
    const missing = new FileLivenessStore(path, { log: (m) => logs.push(m) })
    expect(await missing.all()).toEqual([])
    expect(logs).toHaveLength(1) // a missing file is not an error
    writeFileSync(join(home, 'foreign.json'), JSON.stringify({ rows: [{ connector: 'x' }] }), 'utf8')
    const foreign = new FileLivenessStore(join(home, 'foreign.json'), { log: (m) => logs.push(m) })
    expect(await foreign.all()).toEqual([])
    expect(logs[1]).toMatch(/not a liveness file/)
  })
})

describe('applyLiveness', () => {
  it('stamps stored rows onto the catalog’s descriptors and ignores routes the catalog lacks', async () => {
    const catalog = new Catalog([d('openbb', 'equity/price/quote'), d('openbb', 'eia/petroleum_status_report'), d('openbb', 'news/company')])
    const store = new MemoryLivenessStore([rowA, rowB, rowC])
    expect(await applyLiveness(catalog, store)).toBe(2)
    expect(catalog.get('openbb', 'equity/price/quote')!.liveness).toEqual(livenessOf(rowA))
    expect(catalog.get('openbb', 'eia/petroleum_status_report')!.liveness).toMatchObject({ ok: false })
    expect(catalog.get('openbb', 'news/company')!.liveness).toBeUndefined()
    expect(catalog.stats().openbb).toMatchObject({ routes: 3, alive: 1, dead: 1, unknown: 1, probedAt: 1_000 })
    expect(catalog.find('petroleum status').map((h) => h.route)).toEqual([]) // dead routes are hidden
    expect(catalog.find('petroleum status', { includeDead: true }).map((h) => h.route)).toEqual(['eia/petroleum_status_report'])
  })
})
