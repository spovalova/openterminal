// fred: every route but the releases calendar needs an API key, so these tests cannot be recorded against OpenBB on a
// machine without one. Each distinct code path runs on hand-written upstream responses instead. The expected rows
// and errors come from OpenBB's own Python fetchers run on the same responses (test/fixtures/fred/unit/generate.py),
// and the replay refuses any request the Python code did not make, so URL building and parsing are both pinned. The
// releases calendar needs no key and is covered by recordings (src/fred/cases.json).
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createNativeCtx } from '../src/ctx.js'
import fred from '../src/fred/index.js'
import { buildUrl, fredGet, joinDates, observationDates, parseDate, redact } from '../src/fred/helpers.js'
import { replayFetch, type Exchange } from '../src/record.js'
import { MissingCredential, type NativeParams, type Row } from '../src/types.js'

type Vector = {
  name: string
  route: string
  params: NativeParams
  exchanges: { url: string; status: number; body: string }[]
  rows?: Row[]
  error?: string
  unordered?: boolean
}

const vectors = JSON.parse(readFileSync(new URL('./fixtures/fred/unit/vectors.json', import.meta.url), 'utf8')) as Vector[]

// The clock the Python run used for the defaults it computes (generate.py).
const NOW = new Date('2026-10-20T12:00:00Z')

/** A context whose network is the given fetch and whose key is TESTKEY. */
function ctxWith(fetchImpl: typeof fetch, credentials: Record<string, string> = { fred_api_key: 'TESTKEY' }) {
  return createNativeCtx({ fetch: fetchImpl, credentials, now: () => NOW, cache: new Map() })
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const canonical = (rows: Row[]) => rows.map((r) => JSON.stringify(Object.fromEntries(Object.entries(r).sort(([a], [b]) => (a < b ? -1 : 1))))).sort()

describe('fred, against OpenBB on hand-written upstream responses', () => {
  for (const v of vectors) {
    it(v.name, async () => {
      const exchanges: Exchange[] = v.exchanges.map((e) => ({ method: 'GET', url: e.url, status: e.status, headers: [['content-type', 'application/json']], encoding: 'utf8', body: e.body }))
      const replay = replayFetch(exchanges)
      const requested = new Set<string>()
      const spy: typeof fetch = async (input, init) => {
        requested.add(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
        return replay(input, init)
      }
      const run = fred.routes[v.route]!(v.params, ctxWith(spy))
      if (v.error !== undefined) {
        // OpenBB's own parameter validation (pydantic) words its errors its own way; the route descriptors repeat that
        // validation before a handler is called, so the handler only has to refuse too.
        if (/^\d+ validation errors? for /.test(v.error)) await expect(run).rejects.toBeInstanceOf(Error)
        else await expect(run).rejects.toMatchObject({ message: v.error })
      }
      else {
        const rows = (await run) as Row[]
        // Rows that tie on what a sort looks at come out in an order that is Python's own; they are compared as sets.
        if (v.unordered) expect(canonical(rows)).toEqual(canonical(v.rows!))
        else expect(rows).toEqual(v.rows)
      }
      // The same requests OpenBB made (a repeated one is answered from the cache here), no more and no fewer.
      expect([...requested].sort()).toEqual([...new Set(v.exchanges.map((e) => e.url))].sort())
    })
  }
})

describe('fred, without a key', () => {
  it('names the missing credential before anything else, on every route that needs one', async () => {
    const routes = Object.entries(fred.routes).filter(([route]) => route !== 'economy/calendar')
    expect(routes).toHaveLength(35)
    for (const [route, handler] of routes) {
      const called: string[] = []
      const ctx = ctxWith(async (input) => (called.push(String(input)), json({})), {})
      await expect(handler({ limit: -1 }, ctx), route).rejects.toBeInstanceOf(MissingCredential)
      expect(called, route).toEqual([])
    }
  })
})

describe('fred, defaults that depend on the clock', () => {
  const capture = () => {
    const urls: string[] = []
    const fetchImpl: typeof fetch = async (input) => {
      urls.push(String(input))
      return json({ pager: '', ptic: 0, observations: [], seriess: [{}] })
    }
    return { urls, fetchImpl }
  }

  it('reads three years of commodity prices up to today when no dates are given', async () => {
    const { urls, fetchImpl } = capture()
    await expect(fred.routes['commodity/price/spot']!({ commodity: 'wti' }, ctxWith(fetchImpl))).rejects.toThrow('no data')
    expect(urls[0]).toContain('observation_start=2023-10-24&observation_end=2026-10-20')
  })

  it('asks the calendar for yesterday through tomorrow, a day at a time, or as one range for a release', async () => {
    const { urls, fetchImpl } = capture()
    await expect(fred.routes['economy/calendar']!({}, ctxWith(fetchImpl))).rejects.toThrow('returned no data')
    expect(urls.map((u) => /vs=([^&]+)&ve=([^&]+)/.exec(u)!.slice(1).join(' to ')).sort()).toEqual(['2026-10-19 to 2026-10-19', '2026-10-20 to 2026-10-20', '2026-10-21 to 2026-10-21'])
    urls.length = 0
    await expect(fred.routes['economy/calendar']!({ release_id: 10 }, ctxWith(fetchImpl))).rejects.toThrow('returned no data')
    expect(urls).toEqual(['https://fred.stlouisfed.org/releases/calendar?po=1&ptic=0&vs=2026-10-19T12:00:00&ve=2026-10-21T12:00:00&rid=10'])
    urls.length = 0
    await expect(fred.routes['economy/calendar']!({ start_date: '2026-10-14' }, ctxWith(fetchImpl))).rejects.toThrow('returned no data')
    expect(urls).toHaveLength(8)
  })

  it('needs no key for the calendar', async () => {
    const { fetchImpl } = capture()
    await expect(fred.routes['economy/calendar']!({ start_date: '2026-10-14', end_date: '2026-10-14' }, ctxWith(fetchImpl, {}))).rejects.not.toBeInstanceOf(MissingCredential)
  })
})

describe('fred, request building', () => {
  it('builds URLs the way Python does, with the key and the file type last', () => {
    expect(buildUrl('series/observations', 'K', { series_id: 'DGS10', observation_start: null, limit: 5, frequency: 'm' })).toBe('https://api.stlouisfed.org/fred/series/observations?series_id=DGS10&limit=5&frequency=m&api_key=K&file_type=json')
    expect(buildUrl('regional/data', 'K', { units: 'Dollars per Hour', flag: true }, 'https://api.stlouisfed.org/geofred')).toBe('https://api.stlouisfed.org/geofred/regional/data?units=Dollars+per+Hour&flag=True&api_key=K&file_type=json')
    expect(redact('https://x/y?series_id=A&api_key=SECRET&file_type=json')).toBe('https://x/y?series_id=A&api_key=__redacted__&file_type=json')
  })

  it('reads dates as pandas does', () => {
    expect(joinDates('2024-03-15,2024-06-30')).toBe('2024-03-15,2024-06-30')
    expect(joinDates(['2024-03-15', '03/16/2024'])).toBe('2024-03-15,2024-03-16')
    expect(joinDates(undefined)).toBeUndefined()
    expect(() => joinDates('2024-02-31')).toThrow('Invalid date: 2024-02-31')
    expect(observationDates('2024-03-15,2024-03-20,2024-05-02')).toEqual(['2024-03-01', '2024-05-01'])
    expect(observationDates(undefined)).toEqual([undefined])
    expect(parseDate('Sep-30-2025')).toBe('2025-09-30')
  })

  it('caches an answer by its URL without the key, serves a copy, and does not keep an empty one', async () => {
    let calls = 0
    const ctx = ctxWith(async () => (calls++, json({ observations: [{ date: '2020-01-01', value: '1' }] })))
    const a = await fredGet(ctx, 'https://api.stlouisfed.org/fred/series/observations?series_id=A&api_key=ONE&file_type=json')
    a.observations.length = 0
    const b = await fredGet(ctx, 'https://api.stlouisfed.org/fred/series/observations?series_id=A&api_key=TWO&file_type=json')
    expect(b.observations).toHaveLength(1)
    expect(calls).toBe(1)
    await fredGet(ctx, 'https://api.stlouisfed.org/fred/series/observations?series_id=A&api_key=ONE&file_type=json', { useCache: false })
    expect(calls).toBe(2)
    let empties = 0
    const emptyCtx = ctxWith(async () => (empties++, json({})))
    await fredGet(emptyCtx, 'https://api.stlouisfed.org/fred/series?series_id=Z&api_key=K&file_type=json')
    await fredGet(emptyCtx, 'https://api.stlouisfed.org/fred/series?series_id=Z&api_key=K&file_type=json')
    expect(empties).toBe(2)
  })

  it('retries a 429 with the delay the server names, then gives up with a plain message', async () => {
    let calls = 0
    const throttled = new Response('', { status: 429, headers: { 'retry-after': '0' } })
    const ctx = ctxWith(async () => (++calls < 3 ? throttled.clone() : json({ seriess: [{ id: 'A' }] })))
    const answer = await fredGet(ctx, 'https://api.stlouisfed.org/fred/series?series_id=A&api_key=K&file_type=json')
    expect(answer.seriess[0].id).toBe('A')
    expect(calls).toBe(3)
    const always = ctxWith(async () => throttled.clone())
    await expect(fredGet(always, 'https://api.stlouisfed.org/fred/series?series_id=B&api_key=K&file_type=json')).rejects.toThrow('FRED API rate limit exceeded (HTTP 429)')
  }, 30_000)
})
