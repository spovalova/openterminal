// The Cboe strategy commands (cboe/options/straddle, strangle, spreads) checked against the Python they replace. The
// vectors in fixtures/commands/vectors/cboe.json.gz are trimmed real Cboe chains (some thinned, zeroed, nulled or
// stripped of a side on purpose), the calls made on them and what OpenBB Platform 5.0.0 answered. Each answer came
// from `CboeOptionsChainsFetcher.transform_data` on the chain with `datetime.now` frozen at the call's instant, then
// the route functions of `openbb_cboe.routers.options` (straddle, strangle, spreads) awaited on that data, so the
// pandas maths of `OptionsChainsProperties` runs as it does in the API; an error is recorded as "Type: message".
// helpers.json holds Python's `round(np.float64(x), 4)` for the rounding the maths uses.
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { createNativeCtx } from '../src/ctx.js'
import { npRound, optionsSpreads, optionsStraddle, optionsStrangle } from '../src/cboe/strategies.js'
import type { NativeParams, Row } from '../src/types.js'

type Case = { chain: string; now: string; route: 'straddle' | 'strangle' | 'spreads'; params: NativeParams; expected: { rows: Row[] } | { error: string } }
type Vectors = { chains: Record<string, unknown>; cases: Case[] }
const vectors = JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/commands/vectors/cboe.json.gz', import.meta.url))).toString('utf8')) as Vectors
const helpers = JSON.parse(readFileSync(new URL('./fixtures/commands/vectors/helpers.json', import.meta.url), 'utf8')) as { round: [number, number][] }

const handlers = { straddle: optionsStraddle, strangle: optionsStrangle, spreads: optionsSpreads }

/** Cboe's endpoints as the port asks for them: the symbol directory, empty index directories, and the chain. */
function cboeFetch(chain: unknown): typeof fetch {
  return async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.includes('symboldir')) return new Response(' Stock Symbol, DPM Name, Post/Station,Company Name\nXYZ,x,y,Test Co\n')
    if (url.includes('all_indices')) return new Response('[]')
    if (url.includes('au_indices')) return new Response('{"data":[]}')
    if (url.includes('GlobalIndices')) return new Response('Symbol,Agent Classification,Channel\n')
    if (url.includes('delayed_quotes/options')) return new Response(JSON.stringify(chain))
    return new Response('not found', { status: 404 })
  }
}

/** Rows as they cross the API: JSON, so -0 reads as 0 and a missing value is absent. */
const wire = (rows: unknown): unknown => JSON.parse(JSON.stringify(rows))

describe('cboe strategy commands against OpenBB 5.0.0', () => {
  const names = (c: Case, i: number): string => `#${i} ${c.route} ${c.chain} ${JSON.stringify(c.params)}`
  it.each(vectors.cases.map((c, i) => [names(c, i), c] as const))('%s', async (_name, c) => {
    const ctx = createNativeCtx({ fetch: cboeFetch(vectors.chains[c.chain]), now: () => new Date(c.now), cache: new Map() })
    const answer = handlers[c.route]({ symbol: 'XYZ', ...c.params }, ctx)
    if ('error' in c.expected) {
      // "OpenBBError: No strategies found …" → the message after the exception's class name.
      const message = c.expected.error.slice(c.expected.error.indexOf(': ') + 2)
      await expect(answer).rejects.toThrow(message)
    } else {
      expect(wire(await answer)).toEqual(wire(c.expected.rows))
    }
  })

  it('covers the paths that matter', () => {
    const rows = vectors.cases.filter((c) => 'rows' in c.expected).length
    expect(rows).toBeGreaterThan(80)
    expect(vectors.cases.length - rows).toBeGreaterThan(30)
    for (const route of ['straddle', 'strangle', 'spreads'] as const) {
      expect(vectors.cases.some((c) => c.route === route && 'rows' in c.expected && c.expected.rows.length > 0)).toBe(true)
    }
    // short straddles and strangles, bear spreads
    const all = JSON.stringify(vectors.cases.map((c) => c.expected))
    for (const name of ['Bull Call Spread', 'Bear Call Spread', 'Bull Put Spread', 'Bear Put Spread']) expect(all).toContain(name)
  })
})

describe('numpy rounding', () => {
  it.each(helpers.round)('round(np.float64(%s), 4)', (x, expected) => {
    expect(npRound(x)).toBe(expected)
  })
})
