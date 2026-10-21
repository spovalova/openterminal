// The five OECD metadata commands against OpenBB's own router, run on the same metadata cache
// (test/fixtures/commands/unit/generate.py): every dataflow's parameters (JSON and markdown) and table detail, the
// short ids several dataflows share, the topic list, and the dataflow and table lists under many filters.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { getDataflowParameters, getTableDetail, listDataflows, listTables, listTopics } from '../src/oecd/dataflows.js'
import type { Row } from '../src/types.js'

type Pinned = { rows?: string; count?: number; text?: string; length?: number; error?: string }
type Vectors = {
  oecd: {
    dataflows: Record<string, [json: string, markdown: string, detail: string]>
    shortIds: Record<string, string>
    topics: Record<string, Pinned>
    list_dataflows: ({ params: { topic: string | null; subtopic: string | null } } & Pinned)[]
    list_tables: ({ params: { query: string | null; topic: string | null; subtopic: string | null; dataflow_id: string | null } } & Pinned)[]
    errors: { dataflow_id: string; parameters: { error: string }; detail: { error: string } }[]
  }
}
const vectors = (JSON.parse(readFileSync(new URL('./fixtures/commands/unit/vectors.json', import.meta.url), 'utf8')) as Vectors).oecd

function canon(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canon).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canon((value as Record<string, unknown>)[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}
const md5 = (text: string): string => createHash('md5').update(text).digest('hex').slice(0, 12)
const text = (result: Row): string => result as unknown as string

/** The rows of a list command as the vectors pin them (what is undefined is left out already). */
const pinnedRows = (rows: Row[]): { rows: string; count: number } => ({ rows: md5(canon(rows)), count: rows.length })

describe('oecd/get_dataflow_parameters and oecd/get_table_detail', () => {
  const ids = Object.keys(vectors.dataflows)

  it('covers every dataflow of the catalogue', () => {
    expect(ids).toHaveLength(1548)
  })

  it('answers every dataflow\'s parameters as JSON as OpenBB does', async () => {
    const mismatches = []
    for (const id of ids) if (md5(canon(await getDataflowParameters({ dataflow_id: id, output_format: 'json' }))) !== vectors.dataflows[id]![0]) mismatches.push(id)
    expect(mismatches).toEqual([])
  })

  it('answers every dataflow\'s parameters as markdown as OpenBB does', async () => {
    const mismatches = []
    for (const id of ids) if (md5(text(await getDataflowParameters({ dataflow_id: id, output_format: 'markdown' }))) !== vectors.dataflows[id]![1]) mismatches.push(id)
    expect(mismatches).toEqual([])
  })

  it('describes every table as OpenBB does', async () => {
    const mismatches = []
    for (const id of ids) if (md5(text(await getTableDetail({ table_id: id }))) !== vectors.dataflows[id]![2]) mismatches.push(id)
    expect(mismatches).toEqual([])
  }, 60_000)

  it('finds a dataflow by a short id that several dataflows share as OpenBB does', async () => {
    const mismatches = []
    for (const [short, expected] of Object.entries(vectors.shortIds)) if (md5(text(await getTableDetail({ table_id: short }))) !== expected) mismatches.push(short)
    expect(Object.keys(vectors.shortIds).length).toBeGreaterThan(100)
    expect(mismatches).toEqual([])
  }, 60_000)

  it('names a dataflow it does not know as OpenBB does', async () => {
    for (const e of vectors.errors) {
      await expect(getDataflowParameters({ dataflow_id: e.dataflow_id, output_format: 'json' }), e.dataflow_id).rejects.toMatchObject({ message: e.parameters.error })
      await expect(getTableDetail({ table_id: e.dataflow_id }), e.dataflow_id).rejects.toMatchObject({ message: e.detail.error })
    }
  })

  it('refuses an output format the API would refuse', async () => {
    await expect(getDataflowParameters({ dataflow_id: 'DF_CLI', output_format: 'xml' })).rejects.toThrow(/json.*markdown/)
  })
})

describe('oecd/list_topics', () => {
  for (const [query, expected] of Object.entries(vectors.topics)) {
    it(`lists the topics matching ${JSON.stringify(query)} as OpenBB does`, async () => {
      expect(pinnedRows(await listTopics(query ? { query } : {}))).toEqual(expected)
    })
  }
})

/** The parameters a call names: what the generator left out (None) is not sent. */
const sent = (params: Record<string, string | null>): Row => Object.fromEntries(Object.entries(params).filter(([, v]) => v !== null && v !== ''))

describe('oecd/list_dataflows', () => {
  it('lists the dataflows of every topic and subtopic as OpenBB does', async () => {
    const mismatches = []
    for (const { params, rows: expectedRows, count } of vectors.list_dataflows) {
      const rows = await listDataflows(sent(params) as never)
      if (JSON.stringify(pinnedRows(rows)) !== JSON.stringify({ rows: expectedRows, count })) mismatches.push(params)
    }
    expect(vectors.list_dataflows.length).toBeGreaterThan(90)
    expect(mismatches).toEqual([])
  })
})

describe('oecd/list_tables', () => {
  it('lists the tables under many searches and filters as OpenBB does', async () => {
    const mismatches = []
    for (const { params, rows: expectedRows, count } of vectors.list_tables) {
      const rows = await listTables(sent(params) as never)
      if (JSON.stringify(pinnedRows(rows)) !== JSON.stringify({ rows: expectedRows, count })) mismatches.push(params)
    }
    expect(vectors.list_tables.length).toBeGreaterThan(20)
    expect(mismatches).toEqual([])
  })
})
