import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { JsonFileRunLog, MemoryRunLog, RunLogRowSchema, runCost, type RunLogRow } from '../src/runlog.js'

const dir = mkdtempSync(join(tmpdir(), 'terminal-runlog-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const row = (over: Partial<RunLogRow> = {}): RunLogRow => ({
  id: 'r1',
  workspaceId: 'ws1',
  startedAt: 1_760_000_000_000,
  ms: 1234,
  model: 'claude-opus-5-5',
  prompt: 'Why is CRWV down?',
  steps: [{ tool: 'query', args: { recipe: 'quote', params: { symbols: ['CRWV'] } }, summary: 'recipe quote symbols=CRWV · 1 row', ms: 120 }],
  tokens: { input: 12_000, output: 800 },
  verification: { ok: false, checked: 3, matched: 2, unmatched: [{ text: '13.63%', value: 13.63, unit: 'percent' }] },
  ...over,
})

describe('MemoryRunLog', () => {
  it('appends validated rows and lists them newest first, filtered by workspace and limited', async () => {
    const log = new MemoryRunLog()
    await log.append(row())
    await log.append(row({ id: 'r2', startedAt: 1_760_000_100_000, workspaceId: 'ws2' }))
    await log.append(row({ id: 'r3', startedAt: 1_760_000_200_000 }))
    expect((await log.list()).map((r) => r.id)).toEqual(['r3', 'r2', 'r1'])
    expect((await log.list({ workspaceId: 'ws1' })).map((r) => r.id)).toEqual(['r3', 'r1'])
    expect((await log.list({ limit: 1 })).map((r) => r.id)).toEqual(['r3'])
    await expect(log.append({ ...row(), steps: [{ tool: 'nope' as never, args: {}, summary: '', ms: 0 }] })).rejects.toThrow()
  })
})

describe('JsonFileRunLog', () => {
  it('appends one JSON line per row, in order, and reads them back', async () => {
    const path = join(dir, 'nested', 'runs.jsonl')
    const log = new JsonFileRunLog(path)
    await Promise.all([log.append(row()), log.append(row({ id: 'r2', startedAt: 1_760_000_100_000, error: 'cancelled' }))])
    const lines = readFileSync(path, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!)).toMatchObject({ id: 'r1', verification: { ok: false } })
    expect(JSON.parse(lines[1]!)).toMatchObject({ id: 'r2', error: 'cancelled' })
    const rows = await log.list()
    expect(rows.map((r) => r.id)).toEqual(['r2', 'r1'])
    expect(RunLogRowSchema.safeParse(rows[0]).success).toBe(true)
  })

  it('returns no rows for a missing file and skips lines that do not parse', async () => {
    expect(await new JsonFileRunLog(join(dir, 'missing.jsonl')).list()).toEqual([])
    const path = join(dir, 'broken.jsonl')
    writeFileSync(path, `${JSON.stringify(row())}\nnot json\n{"id":"x"}\n`)
    const warnings: string[] = []
    const rows = await new JsonFileRunLog(path, { log: (m) => warnings.push(m) }).list()
    expect(rows.map((r) => r.id)).toEqual(['r1'])
    expect(warnings).toHaveLength(1)
  })
})

describe('runCost', () => {
  it('prices tokens per million when a price is known, else undefined', () => {
    expect(runCost({ input: 1_000_000, output: 100_000 }, { inputPerMtok: 15, outputPerMtok: 75 })).toBe(22.5)
    expect(runCost({ input: 10 }, undefined)).toBeUndefined()
    expect(runCost(undefined, { inputPerMtok: 1, outputPerMtok: 1 })).toBeUndefined()
  })
})
