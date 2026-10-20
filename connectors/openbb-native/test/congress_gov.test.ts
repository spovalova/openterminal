// uscongress/bills and bill_info for Congresses before the 108th come from the Congress.gov API, which needs
// `congress_gov_api_key`; this machine has none, so those parity cases cannot run live. These tests run each distinct
// code path of the port on hand-written API responses (shapes from https://api.congress.gov/) through replayFetch, so
// the request building and the parsing are exercised until live parity is possible.
import { describe, expect, it } from 'vitest'
import { createNativeCtx } from '../src/ctx.js'
import { nativeHandler } from '../src/index.js'
import { replayFetch, type Exchange } from '../src/record.js'
import { MissingCredential, type Row } from '../src/types.js'

const KEY = '{{congress_gov_api_key}}'
const NOW = new Date('2026-10-20T12:00:00Z')
const api = (path: string, query: string, body: unknown): Exchange => ({
  method: 'GET',
  url: `https://api.congress.gov/v3/${path}?format=json&api_key=${KEY}${query}`,
  status: 200,
  headers: [['content-type', 'application/json']],
  encoding: 'utf8',
  body: JSON.stringify(body),
})

async function run(route: string, exchanges: Exchange[], params: Record<string, unknown>, credentials: Record<string, string> = { congress_gov_api_key: KEY }): Promise<Row[]> {
  const handler = nativeHandler(route, 'congress_gov')!
  const out = await handler(params as never, createNativeCtx({ fetch: replayFetch(exchanges), credentials, now: () => NOW }))
  return (Array.isArray(out) ? out : out ? [out] : []) as Row[]
}

const bill = (number: string, title: string, action: string, updated: string): Record<string, unknown> => ({
  congress: 107,
  type: 'HJRES',
  number,
  originChamber: 'House',
  originChamberCode: 'H',
  title,
  updateDate: updated,
  latestAction: { actionDate: action, text: `Action on ${title}` },
})

describe('congress_gov before the 108th Congress', () => {
  it('needs a key, as OpenBB does', async () => {
    await expect(run('uscongress/bills', [], { congress: 107, bill_type: 'hjres' }, {})).rejects.toBeInstanceOf(MissingCredential)
    await expect(run('uscongress/bill_info', [], { bill_id: '107-hjres-1' }, {})).rejects.toBeInstanceOf(MissingCredential)
  })

  it('lists a Congress and type from the API, paged, filtered by update date and sorted', async () => {
    const page1 = Array.from({ length: 250 }, (_v, i) => bill(String(i + 1), `Bill ${i + 1}`, '2001-03-01', '2019-05-02T10:00:00Z'))
    const page2 = [bill('251', 'Late bill', '2002-07-04', '2020-01-15T00:00:00Z'), bill('252', 'No action', '', '2020-02-01T00:00:00Z')]
    const rows = await run(
      'uscongress/bills',
      [
        api('bill/107/hjres', '&offset=0&limit=250', { bills: page1, pagination: { count: 252, next: 'https://api.congress.gov/next' } }),
        api('bill/107/hjres', '&offset=250&limit=250', { bills: page2, pagination: { count: 252 } }),
      ],
      { congress: 107, bill_type: 'hjres', start_date: '2020-01-01', limit: 10 },
    )
    // Sorted on the latest action date, else the update date: the bill without an action comes first.
    expect(rows.map((r) => [r.bill_id, r.update_date, r.latest_action_date ?? null, r.bill_type, r.bill_number])).toEqual([
      ['107-hjres-252', '2020-02-01', null, 'HJRES', 252],
      ['107-hjres-251', '2020-01-15', '2002-07-04', 'HJRES', 251],
    ])
    expect(rows[1]).toMatchObject({ congress: 107, origin_chamber: 'House', origin_chamber_code: 'H', title: 'Late bill', latest_action: 'Action on Late bill' })
  })

  it('folds a bill from the detail document and its nine sub-collections', async () => {
    const base = 'bill/107/hjres/1'
    const sub = (resource: string, body: unknown): Exchange => api(`${base}/${resource}`, '&offset=0&limit=250', body)
    const rows = await run(
      'uscongress/bill_info',
      [
        api(base, '', { bill: { congress: 107, type: 'HJRES', number: '1', originChamber: 'House', originChamberCode: 'H', title: 'Test joint resolution', introducedDate: '2001-01-03', updateDate: '2019-05-02T10:00:00Z', latestAction: { actionDate: '2001-02-01', text: 'Referred' }, policyArea: { name: 'Law' }, sponsors: [{ fullName: 'Rep. Test [D-XX-1]', bioguideId: 'T000001' }] } }),
        sub('actions', { actions: [{ actionDate: '2001-02-01', text: 'Referred to committee', type: 'IntroReferral' }], pagination: { count: 1 } }),
        sub('amendments', { amendments: [], pagination: { count: 0 } }),
        sub('committees', { committees: [{ systemCode: 'hsju00', name: 'Judiciary Committee', chamber: 'House', type: 'Standing', activities: [{ name: 'Referred to', date: '2001-02-01' }] }], pagination: { count: 1 } }),
        sub('cosponsors', { cosponsors: [{ fullName: 'Rep. Other [R-YY-2]', isOriginalCosponsor: true, sponsorshipDate: '2001-01-03' }], pagination: { count: 1 } }),
        sub('relatedbills', { relatedBills: [{ congress: 106, type: 'HJRES', number: 9, title: 'Earlier' }], pagination: { count: 1 } }),
        sub('subjects', { subjects: { legislativeSubjects: [{ name: 'Courts', updateDate: '2001-02-02' }], policyArea: { name: 'Law' } }, pagination: { count: 1 } }),
        sub('summaries', { summaries: [{ text: '<p><strong>Summary</strong></p><p>Does a thing.</p>', actionDate: '2001-01-03' }], pagination: { count: 1 } }),
        sub('text', { textVersions: [{ type: 'Introduced in House', date: '2001-01-03T05:00:00Z', formats: [{ url: 'https://www.congress.gov/107/bills/hjres1/BILLS-107hjres1ih.htm', type: 'Formatted Text' }] }], pagination: { count: 1 } }),
        sub('titles', { titles: [{ title: 'Test joint resolution', titleType: 'Official Title as Introduced' }], pagination: { count: 1 } }),
      ],
      { bill_id: '107-hjres-1' },
    )
    expect(rows).toHaveLength(1)
    const raw = rows[0]!.raw_data as Record<string, unknown>
    expect(raw).toMatchObject({
      bill_id: '107-hjres-1',
      congress: 107,
      number: 1,
      type: 'HJRES',
      policyArea: { name: 'Law' },
      cosponsors: [{ fullName: 'Rep. Other [R-YY-2]', isOriginalCosponsor: true, sponsorshipDate: '2001-01-03' }],
      subjects: [{ name: 'Courts', updateDate: '2001-02-02' }],
      titles: [{ title: 'Test joint resolution', titleType: 'Official Title as Introduced', type: 'Official Title as Introduced' }],
      textVersions: [{ type: 'Introduced in House', date: '2001-01-03T05:00:00Z', formats: [{ url: 'https://www.congress.gov/107/bills/hjres1/BILLS-107hjres1ih.htm' }] }],
      _detailed: true,
    })
    const md = rows[0]!.markdown_content as string
    expect(md).toContain('## Test joint resolution')
    expect(md).toContain('- **Policy Area**: Law')
    expect(md).toContain('**Summary**\n\nDoes a thing.')
    expect(md).toContain('  - **Rep. Other [R-YY-2] (Original Cosponsor)** (2001-01-03)')
    expect(md).toContain('- **Judiciary Committee - House (Standing)**\n  - Referred to (2001-02-01)')
  })

  it('refuses a Congress before the API\'s coverage', async () => {
    await expect(run('uscongress/bill_info', [api('bill/92/hr/1', '', {})], { bill_id: '92-hr-1' })).rejects.toThrow(/predates structured bill data/)
  })
})
