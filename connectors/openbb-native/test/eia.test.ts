// eia: the routes that need an API key cannot be recorded against OpenBB on a machine without one, so these tests
// run each distinct code path on hand-written upstream responses instead. The expected rows and errors come from
// OpenBB's own Python fetchers run on the same responses (test/fixtures/eia/unit/generate.py), and the replay refuses
// any request the Python code did not make, so URL building and parsing are both pinned. The petroleum status report
// needs no key and is covered by recordings (src/eia/cases.json).
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createNativeCtx } from '../src/ctx.js'
import eia from '../src/eia/index.js'
import { CATALOG, formatPeriod, getDataset, parsePeriod, resolveFacets, snakeCase } from '../src/eia/catalog.js'
import { datasetHandler } from '../src/eia/dataset.js'
import { replayFetch, type Exchange } from '../src/record.js'
import { MissingCredential, type NativeHandler, type NativeParams, type Row } from '../src/types.js'

type Vector = {
  name: string
  route: string
  params: NativeParams
  exchanges: { url: string; status: number; body: string }[]
  rows?: Row[]
  error?: string
  pageSize?: number
  maxAutoRows?: number
}

const vectors = JSON.parse(readFileSync(new URL('./fixtures/eia/unit/vectors.json', import.meta.url), 'utf8')) as Vector[]

const NOW = new Date('2026-10-20T12:00:00Z')

/** A context whose network is the given fetch and whose key is TESTKEY. */
function ctxWith(fetchImpl: typeof fetch, credentials: Record<string, string> = { eia_api_key: 'TESTKEY' }) {
  return createNativeCtx({ fetch: fetchImpl, credentials, now: () => NOW, cache: new Map() })
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('eia, against OpenBB on hand-written upstream responses', () => {
  for (const v of vectors) {
    it(v.name, async () => {
      const exchanges: Exchange[] = v.exchanges.map((e) => ({ method: 'GET', url: e.url, status: e.status, headers: [['content-type', 'application/json']], encoding: 'utf8', body: e.body }))
      const replay = replayFetch(exchanges)
      const requested: string[] = []
      const spy: typeof fetch = async (input, init) => {
        requested.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
        return replay(input, init)
      }
      const handler: NativeHandler = v.pageSize || v.maxAutoRows ? datasetHandler(v.route, { pageSize: v.pageSize ?? 5000, maxAutoRows: v.maxAutoRows ?? 500_000 }) : eia.routes[v.route]!
      const run = handler(v.params, ctxWith(spy))
      if (v.error !== undefined) await expect(run).rejects.toMatchObject({ message: v.error })
      else expect(await run).toEqual(v.rows)
      // The same requests OpenBB made, no more and no fewer.
      expect([...requested].sort()).toEqual(v.exchanges.map((e) => e.url).sort())
    })
  }
})

describe('eia, without a key', () => {
  const routes = Object.entries(eia.routes).filter(([route]) => route !== 'commodity/petroleum_status_report')
  it('names the missing credential before anything else, on every keyed route', async () => {
    expect(routes).toHaveLength(205)
    for (const [route, handler] of routes) {
      const called: string[] = []
      const ctx = ctxWith(async (input) => (called.push(String(input)), json({})), {})
      // A param OpenBB would reject first, to show the key is checked before the params are.
      await expect(handler({ limit: -1 }, ctx), route).rejects.toBeInstanceOf(MissingCredential)
      expect(called, route).toEqual([])
    }
  })
})

describe('eia, request building', () => {
  const page = (rows: unknown[], total: number) => ({ response: { total: String(total), dateFormat: 'YYYY', data: rows } })

  it('pages an unlimited request in 5000 rows and keeps the rows in date order', async () => {
    const urls: string[] = []
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(String(input))
      urls.push(`${url.searchParams.get('offset')}+${url.searchParams.get('length')}`)
      const offset = Number(url.searchParams.get('offset'))
      const length = Number(url.searchParams.get('length'))
      const rows = Array.from({ length: Math.min(length, 12_000 - offset) }, (_, i) => ({ period: String(2000 + ((offset + i) % 50)), stateRegionId: 'WY', production: String(offset + i) }))
      return json(page(rows, 12_000))
    }
    const rows = (await eia.routes['eia/coal/aggregate_production']!({}, ctxWith(fetchImpl))) as Row[]
    expect(urls.sort()).toEqual(['0+5000', '10000+2000', '5000+5000'])
    expect(rows).toHaveLength(12_000)
    expect(rows.map((r) => r.date).slice(0, 3)).toEqual(['2000-01-01', '2000-01-01', '2000-01-01'])
    expect(rows.every((r, i) => i === 0 || String(r.date) >= String(rows[i - 1]!.date))).toBe(true)
  })

  it('drops a page that fails when the others arrive, as OpenBB does, and raises when none does', async () => {
    const fetchImpl = (failing: (offset: number) => boolean): typeof fetch => async (input) => {
      const offset = Number(new URL(String(input)).searchParams.get('offset'))
      if (offset > 0 && failing(offset)) return new Response('upstream broke', { status: 502 })
      const rows = Array.from({ length: 2 }, (_, i) => ({ period: '2020', production: String(offset + i) }))
      return json(page(rows, 6))
    }
    const handler = datasetHandler('eia/coal/aggregate_production', { pageSize: 2 })
    expect(await handler({}, ctxWith(fetchImpl((o) => o === 2)))).toHaveLength(4)
    await expect(handler({}, ctxWith(fetchImpl(() => true)))).rejects.toThrow(/not JSON \(HTTP 502\)/)
  })

  it('accepts lists for the filters and never puts the key in an error', async () => {
    const seen: string[] = []
    const fetchImpl: typeof fetch = async (input) => (seen.push(String(input)), json({ response: { total: '0', data: [] } }))
    const handler = eia.routes['eia/coal/aggregate_production']!
    await expect(handler({ state_region: ['wyoming', 'WV'], coal_rank: ['bituminous'] }, ctxWith(fetchImpl))).rejects.toThrow(/returned no data/)
    expect(decodeURIComponent(seen[0]!)).toContain('facets[coalRankId][]=BIT&facets[stateRegionId][]=WY&facets[stateRegionId][]=WV')
    const failing: typeof fetch = async () => json({ error: { code: 'API_KEY_INVALID', message: 'bad key' } }, 403)
    const err = await handler({}, ctxWith(failing)).catch((e: Error) => e)
    expect(String(err)).toBe('Error: API_KEY_INVALID -> bad key')
    expect(String(err)).not.toContain('TESTKEY')
  })

  it('reads the rest of a long series one page at a time (short-term energy outlook)', async () => {
    const offsets: number[] = []
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input)
      const offset = Number(/offset=(\d+)/.exec(url)![1])
      offsets.push(offset)
      const n = Math.min(5000, 5200 - offset)
      const data = Array.from({ length: n }, (_, i) => ({ period: '2026-01', seriesId: 'COPRPUS', seriesDescription: 'Crude', value: String(offset + i) }))
      return json({ response: { total: '5200', data }, request: { params: { facets: { seriesId: ['COPRPUS'] } } } })
    }
    const rows = (await eia.routes['commodity/short_term_energy_outlook']!({ symbol: 'COPRPUS' }, ctxWith(fetchImpl))) as Row[]
    expect(offsets).toEqual([0, 5000])
    expect(rows).toHaveLength(5200)
    expect(rows[5199]).toMatchObject({ symbol: 'COPRPUS', value: 5199 })
  })
})

describe('eia, the catalog', () => {
  it('maps every dataset route to a dataset that exists, with vocabularies that resolve', () => {
    const routes = Object.entries(CATALOG.routes)
    expect(routes).toHaveLength(203)
    for (const [route, [group, dataset, release]] of routes) {
      const spec = getDataset(group, dataset ?? release!)
      expect(Object.keys(spec.frequencies).length, route).toBeGreaterThan(0)
      for (const [canonical, facet] of Object.entries(spec.facets)) {
        const index = facet.choices ?? CATALOG.groups[group]!.choices[canonical]
        if (index !== undefined) expect(CATALOG.pool[index], `${route} ${canonical}`).toBeDefined()
      }
    }
  })

  it('turns readable slugs into codes, keeping every code a slug stands for', () => {
    const spec = getDataset('petroleum', 'spot_prices')
    const facets = resolveFacets('petroleum', spec, 'weekly', { region: 'na, los_angeles', product: 'carb_diesel' })
    // The filters in the catalog's order, then the facet that has a single possible value.
    expect([...facets.entries()]).toEqual([
      ['product', ['EPD2DC']],
      ['duoarea', ['YCUOK', 'RGC', 'Y44MB', 'ZEU', 'Y05LA']],
      ['process', ['PF4']],
    ])
  })

  it('formats and parses EIA periods', () => {
    expect(formatPeriod('2020-05-17', 'YYYY')).toBe('2020')
    expect(formatPeriod('2020-05-17', 'YYYY-MM')).toBe('2020-05')
    expect(formatPeriod('2020-05-17', 'YYYY-"Q"Q')).toBe('2020-Q2')
    expect(formatPeriod('2020-05-17', 'YYYY-MM-DD')).toBe('2020-05-17')
    expect(formatPeriod('2020-05-17', 'YYYY-MM-DD"T"HH24TZH')).toBe('2020-05-17T00')
    expect(parsePeriod('2020-Q3', 'YYYY-"Q"Q').iso).toBe('2020-07-01')
    expect(parsePeriod('2020-05', 'YYYY-MM').iso).toBe('2020-05-01')
    expect(parsePeriod('2026-09-28T07', 'YYYY-MM-DD"T"HH24').iso).toBe('2026-09-28T07:00:00')
    expect(parsePeriod('2026-09-28T07-04', 'YYYY-MM-DD"T"HH24TZH').iso).toBe('2026-09-28T07:00:00-04:00')
    expect(parsePeriod('2026-09-28T07+00', 'YYYY-MM-DD"T"HH24TZH').iso).toBe('2026-09-28T07:00:00Z')
    expect(parsePeriod('2026-09-28T07-04', 'YYYY-MM-DD"T"HH24TZH').time).toBe(Date.UTC(2026, 8, 28, 11))
    expect(() => formatPeriod('2020-01-01', 'YYYYMM')).toThrow('Unsupported EIA period format')
    expect(snakeCase('coalRankId')).toBe('coal_rank_id')
    expect(snakeCase('labor-hours-units')).toBe('labor_hours_units')
  })
})
