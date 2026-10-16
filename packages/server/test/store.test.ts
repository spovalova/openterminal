import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkspaceStore } from '../src/store.js'
import { stubWidgets } from '../src/stub-agent.js'

let home: string
let store: WorkspaceStore
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'terminal-store-'))
  store = new WorkspaceStore(join(home, 'workspaces'), { log: () => {} })
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe('WorkspaceStore', () => {
  it('round-trips create, get, patch, list, delete', async () => {
    expect(await store.list()).toEqual([])
    const ws = await store.create({ name: 'Memory' })
    expect(ws.id).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(await store.get(ws.id)).toEqual(ws)

    const widgets = stubWidgets(new Date('2026-10-16T00:00:00Z'))
    const patched = await store.patch(ws.id, { widgets, messages: [{ role: 'user', text: 'hi' }] })
    expect(patched?.widgets).toHaveLength(5)
    expect(patched?.messages).toHaveLength(1)
    expect(patched!.updatedAt).toBeGreaterThanOrEqual(ws.updatedAt)
    expect((await store.get(ws.id))?.widgets).toEqual(widgets)

    const found = await store.findWidget('memory-news')
    expect(found?.workspace.id).toBe(ws.id)
    expect(found?.widget.query.kind).toBe('news')

    const second = await store.create({ name: 'Other' })
    expect((await store.list()).map((w) => w.id)).toEqual([ws.id, second.id])

    expect(await store.delete(ws.id)).toBe(true)
    expect(await store.delete(ws.id)).toBe(false)
    expect(await store.get(ws.id)).toBeUndefined()
    expect(readdirSync(store.dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('rejects invalid widgets on patch and skips unreadable files on list', async () => {
    const ws = await store.create()
    await expect(store.patch(ws.id, { widgets: [{ id: 'x', title: 'bad', size: 'lg', query: { kind: 'quote', params: { symbols: ['MU'] } }, view: { type: 'series' } } as never] })).rejects.toThrow()
    writeFileSync(join(store.dir, 'broken.json'), '{ not json')
    writeFileSync(join(store.dir, 'invalid.json'), JSON.stringify({ id: 'invalid' }))
    expect((await store.list()).map((w) => w.id)).toEqual([ws.id])
    expect(await store.get('../etc/passwd')).toBeUndefined()
  })

  it('serializes concurrent appends', async () => {
    const ws = await store.create()
    await Promise.all([1, 2, 3, 4, 5].map((i) => store.appendMessage(ws.id, { role: 'user', text: String(i) })))
    expect((await store.get(ws.id))?.messages.map((m) => m.text).sort()).toEqual(['1', '2', '3', '4', '5'])
  })
})
