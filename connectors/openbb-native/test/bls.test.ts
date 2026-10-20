// bls/economy/survey/bls_series needs a BLS API key (OpenBB refuses the call without one), which this machine does
// not have, so its parity cases cannot run live. These tests run each code path of the port on hand-written BLS
// responses (shapes from https://www.bls.gov/developers/api_signature_v2.htm) through replayFetch, so the request
// building and the parsing are exercised until live parity is possible.
import { describe, expect, it } from 'vitest'
import { createNativeCtx } from '../src/ctx.js'
import { nativeHandler } from '../src/index.js'
import { replayFetch, type Exchange } from '../src/record.js'
import { MissingCredential, NativeUnsupported, type Row } from '../src/types.js'

const API = 'https://api.bls.gov/publicAPI/v2/timeseries/data/'
const NOW = new Date('2026-10-20T12:00:00Z')

const json = (url: string, requestBody: Record<string, unknown>, body: unknown): Exchange => ({
  method: 'POST',
  url,
  requestBody: JSON.stringify(requestBody),
  status: 200,
  headers: [['content-type', 'application/json']],
  encoding: 'utf8',
  body: JSON.stringify(body),
})
const text = (url: string, body: string): Exchange => ({ method: 'GET', url, status: 200, headers: [['content-type', 'text/plain']], encoding: 'utf8', body })

async function run(exchanges: Exchange[], params: Record<string, unknown>, credentials: Record<string, string> = { bls_api_key: '{{bls_api_key}}' }): Promise<Row[]> {
  const handler = nativeHandler('economy/survey/bls_series', 'bls')!
  return (await handler(params as never, createNativeCtx({ fetch: replayFetch(exchanges), credentials, now: () => NOW }))) as Row[]
}

const CATALOG = { series_title: 'All items in U.S. city average, all urban consumers, not seasonally adjusted' }

describe('bls economy/survey/bls_series', () => {
  it('needs a key, as OpenBB does', async () => {
    await expect(run([], { symbol: ['CUUR0000SA0'] }, {})).rejects.toBeInstanceOf(MissingCredential)
  })

  it('posts the query, reads values, calculations, annual averages and footnotes, and sorts by date', async () => {
    const request = { seriesid: ['CUUR0000SA0', 'CUSR0000SA0'], startyear: 2023, endyear: 2023, catalog: true, calculations: true, annualaverage: true, registrationkey: '{{bls_api_key}}' }
    const response = {
      status: 'REQUEST_SUCCEEDED',
      message: [],
      Results: {
        series: [
          {
            seriesID: 'CUUR0000SA0',
            catalog: CATALOG,
            data: [
              { year: '2023', period: 'M12', latest: 'true', value: '306.746', footnotes: [{ code: 'P', text: 'Preliminary' }], calculations: { net_changes: { '1': '-0.1', '3': '1.0', '6': '', '12': '9.0' }, pct_changes: { '1': '0.0', '3': '0.3', '6': '0.7', '12': '3.4' } } },
              { year: '2023', period: 'M13', latest: 'false', value: '304.702', footnotes: [{}] },
              { year: '2023', period: 'M01', value: '-', footnotes: [{}] },
            ],
          },
          { seriesID: 'CUSR0000SA0', data: [{ year: '2023', period: 'M06', value: '303.841', latest: 'false', footnotes: [] }] },
        ],
      },
    }
    const rows = await run([json(API, request, response)], { symbol: ['cuur0000sa0', 'CUSR0000SA0'], start_date: '2023-01-01', end_date: '2023-12-31', annual_average: true })
    expect(rows).toEqual([
      { symbol: 'CUUR0000SA0', title: CATALOG.series_title, date: '2023-01-01', value: null, latest: false },
      { symbol: 'CUSR0000SA0', date: '2023-06-01', value: 303.841, latest: false },
      { symbol: 'CUUR0000SA0', title: CATALOG.series_title, date: '2023-12-01', value: 306.746, latest: true, footnotes: 'Preliminary', change_1M: -0.1, change_3M: 1, change_6M: null, change_12M: 9, change_percent_1M: 0, change_percent_3M: 0.3 / 100, change_percent_6M: 0.7 / 100, change_percent_12M: 3.4 / 100 },
      { symbol: 'CUUR0000SA0', title: `${CATALOG.series_title} (Annual Average)`, date: '2023-12-31', value: 304.702, latest: false },
    ])
  })

  it('leaves out request options that are off, and maps the quarterly and semiannual periods', async () => {
    const request = { seriesid: ['PRS85006092'], startyear: 2024, endyear: 2024, catalog: true, registrationkey: '{{bls_api_key}}' }
    const response = { Results: { series: [{ seriesID: 'PRS85006092', data: ['Q01', 'Q02', 'Q03', 'Q04', 'Q05', 'S01', 'S02', 'S03', 'A01'].map((period) => ({ year: '2024', period, value: '1.5', latest: 'false' })) }] } }
    const rows = await run([json(API, request, response)], { symbol: 'PRS85006092', start_date: '2024-01-01', end_date: '2024-12-31', calculations: false })
    expect(rows.map((r) => [r.date, r.value])).toEqual([
      ['2024-01-01', 1.5],
      ['2024-01-01', 1.5],
      ['2024-01-01', 1.5],
      ['2024-04-01', 1.5],
      ['2024-07-01', 1.5],
      ['2024-07-01', 1.5],
      ['2024-10-01', 1.5],
      ['2024-12-31', 1.5],
      ['2024-12-31', 1.5],
    ])
  })

  it('starts at the series first year from BLS\'s series file, and splits long spans into 20-year requests', async () => {
    const series = 'series_id        \tseasonal\tbegin_year\tbegin_period\tend_year\tend_period\nCUUR0000SA0     \tU\t1990\tM01\t2026\tM09\nCUUR0000SA1     \tU\t2015\tM01\t2026\tM09\n'
    const file = text('https://download.bls.gov/pub/time.series/cu/cu.series', series)
    const ex = (start: number, end: number, value: string): Exchange =>
      json(API, { seriesid: ['CUUR0000SA0'], startyear: start, endyear: end, catalog: true, calculations: true, registrationkey: '{{bls_api_key}}' }, { Results: { series: [{ seriesID: 'CUUR0000SA0', data: [{ year: String(end), period: 'M01', value, latest: 'false' }] }] } })
    const rows = await run([file, ex(1990, 2009, '1'), ex(2010, 2026, '2')], { symbol: 'CUUR0000SA0', category: 'cpi' })
    expect(rows.map((r) => [r.date, r.value])).toEqual([
      ['2009-01-01', 1],
      ['2026-01-01', 2],
    ])
  })

  it('falls back to a 20-year window for a symbol outside the category, and refuses huge listings', async () => {
    const response = { Results: { series: [{ seriesID: 'LNS14000000', data: [{ year: '2026', period: 'M01', value: '4.1', latest: 'false' }] }] } }
    // 52 weeks x 20 before 2026-10-20 falls in 2006: one request for 2006-2025 and one for 2026.
    const request = (start: number, end: number) => ({ seriesid: ['LNS14000000'], startyear: start, endyear: end, catalog: true, calculations: true, registrationkey: '{{bls_api_key}}' })
    const ok = await run([json(API, request(2006, 2025), response), json(API, request(2026, 2026), { Results: { series: [] } })], { symbol: 'LNS14000000', category: 'cpi' })
    expect(ok).toHaveLength(1)
    await expect(run([], { symbol: 'LNS14000000', category: 'lfs' })).rejects.toBeInstanceOf(NativeUnsupported)
  })

  it('reports BLS\'s messages when nothing comes back', async () => {
    const request = { seriesid: ['XXXX'], startyear: 2024, endyear: 2024, catalog: true, calculations: true, registrationkey: '{{bls_api_key}}' }
    const response = { status: 'REQUEST_NOT_PROCESSED', message: ['Series does not exist for Series XXXX'], Results: {} }
    await expect(run([json(API, request, response)], { symbol: 'XXXX', start_date: '2024-01-01', end_date: '2024-12-31' })).rejects.toThrow(/Series does not exist/)
  })
})
