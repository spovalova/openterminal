// The eligible-assets snapshot is too big to record (1.1 MB compressed), so its parsing and decoding are checked here
// on a small file in the same format: gzip around UTF-16 with a byte order mark, tab separated.
import { gzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { createNativeCtx } from '../src/ctx.js'
import ecb from '../src/ecb/index.js'
import type { NativeCtx, NativeParams, Row } from '../src/types.js'

const header = ['ISIN_CODE', 'HAIRCUT_CATEGORY', 'TYPE', 'REFERENCE_MARKET', 'DENOMINATION', 'ISSUANCE_DATE', 'MATURITY_DATE', 'COUPON_RATE (%)', 'COUPON_DEFINITION', 'ISSUER_NAME', 'ISSUER_RESIDENCE', 'ISSUER_GROUP', 'GUARANTOR_NAME', 'GUARANTOR_RESIDENCE', 'HAIRCUT', 'HAIRCUT_OWN_USE', 'POTENTIALLY_OWN_USABLE_COVERED_BOND', 'CLIMATE_FACTOR']
const rows = [
  ['DE0001102580', 'L1A', 'AT01', 'RMDE01', 'EUR', '15/08/2022 00:00:00', '15/08/2032 00:00:00', '1.7', 'CD4', 'Bundesrepublik Deutschland', 'IRDE', 'IG2', '', '', '0.5', '', '', '1.0'],
  ['XS0000000001', 'L1C', 'AT02', 'RMXX', 'USD', 'not a date', '', 'abc', 'CD2', 'Some Corp', 'IRZZ', 'IG3', 'Parent', 'IRFR', '', '', 'Y', ''],
  ['', 'L1A', 'AT01', '', 'EUR', '', '', '', '', 'No ISIN', '', '', '', '', '', '', '', ''],
]
const file = [header, ...rows].map((r) => r.join('\t')).join('\r\n')

function utf16(text: string): Uint8Array {
  const out = new Uint8Array(2 + text.length * 2)
  out[0] = 0xff
  out[1] = 0xfe
  for (let i = 0; i < text.length; i++) {
    out[2 + i * 2] = text.charCodeAt(i) & 0xff
    out[3 + i * 2] = text.charCodeAt(i) >> 8
  }
  return out
}

const route = ecb.routes['ecb/eligible_assets']!
const handler = async (params: NativeParams, ctx: NativeCtx): Promise<Row[]> => (await route(params, ctx)) as Row[]

/** The snapshot of 2026-10-19 exists; 2026-10-20 does not, so the reader has to look back a day. */
function ctx() {
  const requested: string[] = []
  const fetchStub: typeof fetch = async (input) => {
    const url = String(input)
    requested.push(url)
    return url.endsWith('ea_csv_261019.csv.gz') ? new Response(gzipSync(utf16(file)), { status: 200 }) : new Response('not found', { status: 404 })
  }
  return { ctx: createNativeCtx({ fetch: fetchStub, cache: new Map(), now: () => new Date(2026, 9, 20, 12) }), requested }
}

describe('ecb eligible assets', () => {
  it('looks back to the latest snapshot, decodes the MID codes and skips rows without an ISIN', async () => {
    const { ctx: c, requested } = ctx()
    const out = await handler({}, c)
    expect(requested.map((u) => u.slice(-20))).toEqual(['ea_csv_261020.csv.gz', 'ea_csv_261019.csv.gz'])
    expect(out).toEqual([
      {
        isin: 'DE0001102580',
        haircut_category: 'Category I – central government, EU, central banks',
        asset_type: 'Bond',
        reference_market: 'Germany (01)',
        currency: 'EUR',
        issuance_date: '2022-08-15',
        maturity_date: '2032-08-15',
        coupon_rate: 1.7,
        coupon_definition: 'Fixed',
        issuer_name: 'Bundesrepublik Deutschland',
        issuer_residence: 'Germany',
        issuer_group: 'Central government',
        haircut: 0.5,
        climate_factor: 1,
        snapshot_date: '2026-10-19',
      },
      {
        isin: 'XS0000000001',
        haircut_category: 'Category III – corporate and other issuers',
        asset_type: 'Medium-term note',
        reference_market: 'XX',
        currency: 'USD',
        issuance_date: null,
        coupon_rate: null,
        coupon_definition: 'Variable',
        issuer_name: 'Some Corp',
        issuer_residence: 'IRZZ',
        issuer_group: 'Corporate and other issuers',
        guarantor_name: 'Parent',
        guarantor_residence: 'France',
        covered_bond: 'Y',
        snapshot_date: '2026-10-19',
      },
    ])
  })

  it('filters by label or code, case-insensitively for ISINs and currencies, and limits', async () => {
    const { ctx: c } = ctx()
    expect((await handler({ isin: ['xs0000000001'] }, c)).map((r) => r.isin)).toEqual(['XS0000000001'])
    expect((await handler({ asset_type: 'Bond' }, c)).map((r) => r.isin)).toEqual(['DE0001102580'])
    expect((await handler({ issuer_group: 'Corporate and other issuers', currency: 'usd' }, c)).map((r) => r.isin)).toEqual(['XS0000000001'])
    expect(await handler({ limit: 1 }, c)).toHaveLength(1)
    await expect(handler({ haircut_category: 'Category V – asset-backed securities' }, c)).rejects.toThrow('No eligible assets matched')
  })

  it('fails when a week of snapshots is missing', async () => {
    const c = createNativeCtx({ fetch: async () => new Response('no', { status: 404 }), cache: new Map(), now: () => new Date(2026, 9, 20, 12) })
    await expect(handler({}, c)).rejects.toThrow('No eligible-assets file found near 2026-10-20')
  })
})
