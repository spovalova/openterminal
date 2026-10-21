// The DTCC routes whose live parity cases are too large to record (FX volatility surfaces, cross-currency swaps, FX
// prints), run offline on trimmed copies of the 2026-10-12 and 2026-10-14 files. fixtures/cftc/offline/dtcc.json.gz holds
// the trimmed files and, for each scenario, the rows openbb_cftc 5.0.0 answers on them with its on-disk store and its
// network stubbed out (the script that built it reads the DTCC files, not the OpenBB API).
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { compareRows } from '../src/compare.js'
import { shapeCase, runNative } from '../src/harness/run.js'

type Scenario = { name: string; route: string; params: Record<string, unknown>; rows: Record<string, unknown>[] }
type Doc = { now: string; manifests: Record<string, unknown[]>; files: Record<string, string>; scenarios: Scenario[] }
const doc = JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/cftc/offline/dtcc.json.gz', import.meta.url))).toString('utf8')) as Doc

const serve: typeof fetch = async (input) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const manifest = /\/ppd\/api\/cumulative\/CFTC\/(\w+)$/.exec(url)
  if (manifest && doc.manifests[manifest[1]!]) return new Response(JSON.stringify(doc.manifests[manifest[1]!]), { headers: { 'content-type': 'application/json' } })
  const file = doc.files[url]
  if (file !== undefined) return new Response(Buffer.from(file, 'base64'))
  throw new Error(`unexpected request: ${url}`)
}

describe('cftc DTCC routes on trimmed files, against the Python on the same files', () => {
  for (const s of doc.scenarios) {
    it(`${s.name} (${s.route})`, async () => {
      const { sent } = shapeCase('cftc', { route: s.route, params: s.params })
      const rows = await runNative('cftc', s.route, sent, { fetch: serve, now: new Date(doc.now), sleep: async () => {} })
      const result = compareRows(s.rows, rows)
      expect(result.problems).toEqual([])
      expect(result.mismatches.slice(0, 5)).toEqual([])
      expect(result.ok).toBe(true)
      expect(rows.length).toBe(s.rows.length)
    })
  }
})
