// imf/list_dataflows, imf/get_dataflow_dimensions and imf/list_tables against OpenBB's own router, run on the same
// metadata (test/fixtures/commands/unit/generate.py): every dataflow's dimensions as JSON and as markdown, the
// catalogue as JSON and as markdown, and the curated tables.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { getDataflowDimensions, listDataflows, listTables } from '../src/imf/dataflows.js'
import type { Row } from '../src/types.js'

type Pinned = { object?: string; keys?: number; text?: string; length?: number; error?: string }
type Vectors = {
  imf: {
    dimensions: Record<string, Pinned>
    markdown: Record<string, Pinned>
    list_dataflows: Pinned
    list_dataflows_markdown: Pinned
    list_tables: Row[]
    errors: { dataflow_id: string; error: string }[]
  }
}
const vectors = (JSON.parse(readFileSync(new URL('./fixtures/commands/unit/vectors.json', import.meta.url), 'utf8')) as Vectors).imf

function canon(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canon).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canon((value as Record<string, unknown>)[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}
const md5 = (text: string): string => createHash('md5').update(text).digest('hex').slice(0, 12)

describe('imf/get_dataflow_dimensions', () => {
  it('answers every dataflow as JSON as OpenBB does', async () => {
    const mismatches: string[] = []
    for (const [dataflow, expected] of Object.entries(vectors.dimensions)) {
      const result = await getDataflowDimensions({ dataflow_id: dataflow, output_format: 'json' })
      if (Object.keys(result).length !== expected.keys || md5(canon(result)) !== expected.object) mismatches.push(dataflow)
    }
    expect(Object.keys(vectors.dimensions)).toHaveLength(103)
    expect(mismatches).toEqual([])
  })

  it('answers every dataflow as markdown as OpenBB does', async () => {
    const mismatches: string[] = []
    for (const [dataflow, expected] of Object.entries(vectors.markdown)) {
      const text = (await getDataflowDimensions({ dataflow_id: dataflow, output_format: 'markdown' })) as unknown as string
      if (text.length !== expected.length || md5(text) !== expected.text) mismatches.push(dataflow)
    }
    expect(mismatches).toEqual([])
  })

  it('names a dataflow it does not know as OpenBB does', async () => {
    for (const e of vectors.errors) await expect(getDataflowDimensions({ dataflow_id: e.dataflow_id, output_format: 'json' })).rejects.toMatchObject({ message: e.error })
  })
})

describe('imf/list_dataflows', () => {
  it('lists the catalogue as OpenBB does', async () => {
    const result = await listDataflows({ output_format: 'json' })
    expect(Object.keys(result)).toHaveLength(vectors.list_dataflows.keys!)
    expect(md5(canon(result))).toBe(vectors.list_dataflows.object)
  })

  it('describes the catalogue in markdown as OpenBB does', async () => {
    const text = (await listDataflows({ output_format: 'markdown' })) as unknown as string
    expect(text).toHaveLength(vectors.list_dataflows_markdown.length!)
    expect(md5(text)).toBe(vectors.list_dataflows_markdown.text)
  })

  it('hands out a copy, so a caller cannot change the catalogue', async () => {
    const first = (await listDataflows({ output_format: 'json' })) as Record<string, { name: string }>
    first.CPI!.name = 'changed'
    expect(((await listDataflows({ output_format: 'json' })) as Record<string, { name: string }>).CPI!.name).toBe('Consumer Price Index (CPI)')
  })
})

describe('imf/list_tables', () => {
  it('lists the curated presentation tables as OpenBB does', async () => {
    expect(await listTables()).toEqual(vectors.list_tables)
  })
})
