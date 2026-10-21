// The Deribit strategy commands (straddle, strangle, spreads, optimizer) checked against the Python they replace. The
// vectors in fixtures/commands/vectors/deribit.json.gz are trimmed Deribit REST snapshots (book summary, instruments,
// combos, combo book, index; BTC and ETH settle in the coin, SOL_USDC is linear; some quotes zeroed or nulled on
// purpose), the calls made on them and what OpenBB Platform 5.0.0 answered. Each answer came from the route functions
// of `openbb_deribit.routers.options` awaited with `openbb_deribit.utils.client.request` serving the snapshot and
// `datetime.now` frozen at the call's instant, so chain.py, strategies.py, optimizer.py and legs.py ran as in the API.
// helpers.json holds Python's `sum()` of floats and `math.erf`.
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { createNativeCtx } from '../src/ctx.js'
import { erf } from '../src/deribit/erf.js'
import { classify, optionsOptimizer, pySum } from '../src/deribit/optimizer.js'
import { optionsSpreads, optionsStraddle, optionsStrangle } from '../src/deribit/strategies.js'
import type { NativeParams, Row } from '../src/types.js'

type Snapshot = Record<'summary' | 'instruments' | 'combos' | 'combo_summary' | 'index', unknown>
type Case = { snapshot: string; root: string; now: string; route: 'straddle' | 'strangle' | 'spreads' | 'optimizer'; params: NativeParams; expected: { rows: Row[] } | { error: string } }
type Vectors = { snapshots: Record<string, Snapshot>; cases: Case[] }
const vectors = JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/commands/vectors/deribit.json.gz', import.meta.url))).toString('utf8')) as Vectors
const helpers = JSON.parse(readFileSync(new URL('./fixtures/commands/vectors/helpers.json', import.meta.url), 'utf8')) as { sum: [number[], number][]; erf: [number, number][] }

const handlers = { straddle: optionsStraddle, strangle: optionsStrangle, spreads: optionsSpreads, optimizer: optionsOptimizer }

/** The public methods a chain load asks for, answered from the snapshot. */
function deribitFetch(snapshot: Snapshot): typeof fetch {
  return async (input) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const method = url.pathname.split('/').pop()
    const body =
      method === 'get_book_summary_by_currency' ? (url.searchParams.get('kind') === 'option_combo' ? snapshot.combo_summary : snapshot.summary)
      : method === 'get_instruments' ? snapshot.instruments
      : method === 'get_combos' ? snapshot.combos
      : method === 'get_index_price' ? snapshot.index
      : undefined
    if (body === undefined) return new Response('not found', { status: 404 })
    return new Response(JSON.stringify(body))
  }
}

const wire = (rows: unknown): unknown => JSON.parse(JSON.stringify(rows))

/** Same number to a few units in the last place (the optimizer's calendars use Math.exp, which can round differently from the C library's). */
function expectClose(actual: unknown, expected: unknown, path = 'rows'): void {
  if (typeof expected === 'number' && typeof actual === 'number') {
    const tolerance = 1e-13 * Math.max(Math.abs(expected), Math.abs(actual), 1e-300)
    expect(Math.abs(actual - expected), `${path}: ${actual} vs ${expected}`).toBeLessThanOrEqual(tolerance)
  } else if (Array.isArray(expected) && Array.isArray(actual)) {
    expect(actual.length, `${path} length`).toBe(expected.length)
    expected.forEach((e, i) => expectClose(actual[i], e, `${path}[${i}]`))
  } else if (expected !== null && typeof expected === 'object') {
    expect(Object.keys(actual as object).sort(), `${path} keys`).toEqual(Object.keys(expected).sort())
    for (const [k, e] of Object.entries(expected)) expectClose((actual as Record<string, unknown>)[k], e, `${path}.${k}`)
  } else {
    expect(actual, path).toEqual(expected)
  }
}

describe('deribit strategy commands against OpenBB 5.0.0', () => {
  const names = (c: Case, i: number): string => `#${i} ${c.route} ${c.snapshot} ${JSON.stringify(c.params)}`
  it.each(vectors.cases.map((c, i) => [names(c, i), c] as const))('%s', async (_name, c) => {
    const ctx = createNativeCtx({ fetch: deribitFetch(vectors.snapshots[c.snapshot]!), now: () => new Date(c.now), cache: new Map() })
    const answer = handlers[c.route]({ symbol: c.root, ...c.params }, ctx)
    if ('error' in c.expected) {
      const message = c.expected.error.slice(c.expected.error.indexOf(': ') + 2)
      await expect(answer).rejects.toThrow(message)
      return
    }
    const rows = wire(await answer)
    // The straddles, strangles and spreads are plain arithmetic on the quotes: the very same doubles.
    if (c.route === 'optimizer') expectClose(rows, wire(c.expected.rows))
    else expect(rows).toEqual(wire(c.expected.rows))
  })

  it('covers every route, the coin-settled and the linear underlyings, and a missing index', () => {
    for (const route of ['straddle', 'strangle', 'spreads', 'optimizer'] as const) {
      expect(vectors.cases.some((c) => c.route === route && 'rows' in c.expected && c.expected.rows.length > 0), route).toBe(true)
    }
    for (const root of ['BTC', 'ETH', 'SOL_USDC']) expect(vectors.cases.some((c) => c.root === root)).toBe(true)
    expect(vectors.cases.some((c) => c.snapshot === 'btc-no_index' && 'rows' in c.expected && c.expected.rows.length === 0)).toBe(true)
    const strategies = new Set(vectors.cases.flatMap((c) => ('rows' in c.expected ? c.expected.rows.map((r) => r.strategy) : [])))
    for (const name of ['Long Call Butterfly', 'Iron Condor', 'Short Call Calendar', 'Long Put Diagonal', 'Bearish Risk Reversal', 'Bull Call Spread']) expect(strategies.has(name), name).toBe(true)
  })
})

describe('combo codes', () => {
  const leg = (strike: number, type: 'call' | 'put', quantity: number, dte = 5) => ({ symbol: `X-${strike}-${type[0]}`, expiration: '2026-12-25', strike, option_type: type, quantity, size: 1, price: 1, dte, implied_volatility: 0.5 })
  it.each([
    ['a long call', [leg(100, 'call', 1)], ['C', 1]],
    ['a bull call spread', [leg(100, 'call', 1), leg(110, 'call', -1)], ['CS', 1]],
    ['a put backspread', [leg(100, 'put', 2), leg(110, 'put', -1)], ['PSR12', -1]],
    ['a straddle', [leg(100, 'call', -1), leg(100, 'put', -1)], ['STRD', -1]],
    ['a risk reversal', [leg(90, 'put', 1), leg(110, 'call', -1)], ['RR', 1]],
    ['a call butterfly', [leg(100, 'call', 1), leg(110, 'call', -2), leg(120, 'call', 1)], ['CBUT', 1]],
    ['an uneven butterfly, which is no combo', [leg(100, 'call', 1), leg(110, 'call', -2), leg(125, 'call', 1)], ['', 1]],
    ['an iron condor', [leg(90, 'put', 1), leg(95, 'put', -1), leg(105, 'call', -1), leg(110, 'call', 1)], ['ICOND', 1]],
    ['an iron butterfly', [leg(90, 'put', 1), leg(100, 'put', -1), leg(100, 'call', -1), leg(110, 'call', 1)], ['IBUT', 1]],
    ['a call calendar', [leg(100, 'call', -1, 5), leg(100, 'call', 1, 35)], ['CCAL', 1]],
    ['a put diagonal', [leg(100, 'put', -1, 5), leg(95, 'put', 1, 35)], ['PDIAG', 1]],
  ] as const)('%s', (_name, legs, expected) => {
    expect(classify([...legs])).toEqual(expected)
  })
})

describe('Python helpers', () => {
  it.each(helpers.sum.map((s, i) => [i, ...s] as const))('sum #%s (Neumaier compensated)', (_i, values, expected) => {
    expect(Object.is(pySum(values), expected) || pySum(values) === expected).toBe(true)
  })

  it.each(helpers.erf)('math.erf(%s)', (x, expected) => {
    const actual = erf(x)
    const a = Math.abs(x)
    // Exact where the C library's polynomials are all that is evaluated; a unit in the last place where Math.exp comes in.
    if (a < 1.25 || a >= 2.857142857142857) expect(actual).toBe(expected)
    else expect(Math.abs(actual - expected)).toBeLessThanOrEqual(2.3e-16 * Math.abs(expected))
  })
})
