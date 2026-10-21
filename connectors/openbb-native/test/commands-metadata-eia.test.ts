// eia/datasets and eia/facet_options against OpenBB's own router, run on the same catalog and on hand-written API
// answers (test/fixtures/commands/unit/generate.py): every group, every facet that carries its choices, the errors, and
// the API path that needs a key.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createNativeCtx } from '../src/ctx.js'
import { datasets, facetOptions } from '../src/eia/metadata.js'
import { MissingCredential, type Row } from '../src/types.js'

type Pinned = { rows?: string; count?: number; error?: string }
type Vectors = {
  eia: {
    datasets: Record<string, Pinned>
    facets: Record<string, Pinned>
    errors: { group: string; dataset: string | null; facet: string; error: string }[]
    api: { name: string; group: string; dataset: string | null; facet: string; status: number; body: unknown; requests: string[]; results?: Row[]; error?: string }[]
  }
}
const vectors = (JSON.parse(readFileSync(new URL('./fixtures/commands/unit/vectors.json', import.meta.url), 'utf8')) as Vectors).eia

/** Canonical JSON as the generator writes it: keys sorted, no spaces. */
function canon(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canon).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canon((value as Record<string, unknown>)[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}
const md5 = (text: string): string => createHash('md5').update(text).digest('hex').slice(0, 12)

const ctx = (fetchImpl: typeof fetch = async () => new Response('{}'), credentials: Record<string, string> = { eia_api_key: 'TESTKEY' }) => createNativeCtx({ fetch: fetchImpl, credentials, cache: new Map() })

describe('eia/datasets', () => {
  for (const [group, expected] of Object.entries(vectors.datasets)) {
    it(`lists ${group || 'every group'} as OpenBB does`, async () => {
      const rows = await datasets(group ? { group } : {})
      expect(rows).toHaveLength(expected.count!)
      expect(md5(canon(rows))).toBe(expected.rows)
    })
  }
})

describe('eia/facet_options, choices the catalog carries', () => {
  it('answers every facet that has its own choices as OpenBB does', async () => {
    const mismatches: string[] = []
    for (const [key, expected] of Object.entries(vectors.facets)) {
      const [group, dataset, facet] = key.split('/') as [string, string, string]
      const rows = await facetOptions({ group, ...(dataset ? { dataset } : {}), facet }, ctx())
      if (rows.length !== expected.count || md5(canon(rows)) !== expected.rows) mismatches.push(key)
    }
    expect(Object.keys(vectors.facets).length).toBeGreaterThan(700)
    expect(mismatches).toEqual([])
  })

  it('names the same errors for a dataset or filter that does not exist', async () => {
    for (const e of vectors.errors) {
      await expect(facetOptions({ group: e.group, ...(e.dataset ? { dataset: e.dataset } : {}), facet: e.facet }, ctx()), `${e.group}/${e.dataset}/${e.facet}`).rejects.toMatchObject({ message: e.error })
    }
  })
})

describe('eia/facet_options, choices from the API', () => {
  for (const v of vectors.api) {
    it(`reads ${v.name} as OpenBB does`, async () => {
      const requested: string[] = []
      const fetchImpl: typeof fetch = async (input) => {
        requested.push(String(input))
        return new Response(JSON.stringify(v.body), { status: v.status, headers: { 'content-type': 'application/json' } })
      }
      const run = facetOptions({ group: v.group, ...(v.dataset ? { dataset: v.dataset } : {}), facet: v.facet }, ctx(fetchImpl))
      if (v.error !== undefined) await expect(run).rejects.toMatchObject({ message: v.error })
      else expect(await run).toEqual(v.results)
      expect(requested).toEqual(v.requests)
    })
  }

  it('needs the key, and asks nothing without it', async () => {
    const requested: string[] = []
    const fetchImpl: typeof fetch = async (input) => (requested.push(String(input)), new Response('{}'))
    await expect(facetOptions({ group: 'coal', dataset: 'receipts', facet: 'mine' }, ctx(fetchImpl, {}))).rejects.toBeInstanceOf(MissingCredential)
    expect(requested).toEqual([])
    // The choices the catalog carries need no key.
    await expect(facetOptions({ group: 'coal', dataset: 'aggregate_production', facet: 'state_region' }, ctx(fetchImpl, {}))).resolves.toHaveLength(59)
  })
})
