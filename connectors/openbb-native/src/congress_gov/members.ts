// uscongress/members, member_votes and member_legislation, provider congress_gov. Ported from
// openbb_government_us/congress/models/{congress_members,member_votes,member_legislation}.py and utils/bulk.py (OpenBB
// Platform 5.0.0, Apache-2.0); modified: no SQLite store. The members come from the unitedstates legislators dataset,
// the votes from Voteview, the sponsored bills from the BILLSTATUS archives of each Congress.
import { parseCsvRecords } from '../lib/csv.js'
import type { NativeCtx, NativeHandler, NativeParams, Row } from '../types.js'
import { BILL_TYPES, BILLSTATUS_MIN_CONGRESS, bulkZipUrl, parseBillArchive, type Rec } from './billstatus.js'
import { int, sortByKey, str } from './helpers.js'
import { unitedstatesData } from './sources.js'

const VOTEVIEW = 'https://voteview.com/static/data/out'
const HOUR_MS = 3600 * 1000
const CAST_CODES: Record<string, string> = { '1': 'Yea', '2': 'Yea', '3': 'Yea', '4': 'Nay', '5': 'Nay', '6': 'Nay', '7': 'Present', '8': 'Present', '9': 'Not Voting' }
const BILL_NUMBER_TYPES = new Set(['HR', 'S', 'HRES', 'SRES', 'HJRES', 'SJRES', 'HCONRES', 'SCONRES'])

/** The current members, from legislators-current.json (`load_members`). */
export function loadMembers(ctx: NativeCtx): Promise<Rec[]> {
  return ctx.cache('congress_gov:members', HOUR_MS, async () => {
    try {
      const data = await unitedstatesData<unknown>(ctx, 'legislators-current.json')
      return Array.isArray(data) ? (data as Rec[]) : []
    } catch {
      return []
    }
  })
}

const chamberFromTermType = (t: string): string => ({ rep: 'house', sen: 'senate' })[t] ?? ''

/** A member's list shape (`to_member_list_item`). */
function memberListItem(record: Rec): Rec {
  const terms = (record.terms ?? []) as Rec[]
  const term = terms.length > 0 ? terms[terms.length - 1]! : {}
  const ids = (record.id ?? {}) as Rec
  const name = (record.name ?? {}) as Rec
  return {
    bioguide_id: ids.bioguide ?? '',
    name: name.official_full || `${name.first ?? ''} ${name.last ?? ''}`.trim(),
    chamber: chamberFromTermType(term.type ?? ''),
    party: term.party ?? '',
    state: term.state ?? '',
    district: term.district,
    term_start: term.start,
    term_end: term.end,
    website: term.url || null,
  }
}

async function members(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const items = (await loadMembers(ctx)).map(memberListItem)
  const chamber = str(params.chamber)
  const state = str(params.state)
  const party = str(params.party)
  let out = items
  if (chamber !== undefined) out = out.filter((r) => r.chamber === chamber)
  if (state !== undefined) out = out.filter((r) => String(r.state || '').toUpperCase() === state.toUpperCase())
  if (party !== undefined) out = out.filter((r) => String(r.party || '').toLowerCase() === party.toLowerCase())
  return sortByKey(out, (r) => (r.name as string) || '', false)
}

// ---- helpers shared by the member routes -------------------------------------------------------------------------------

async function loadMemberRecord(ctx: NativeCtx, bioguide: string): Promise<Rec> {
  const record = (await loadMembers(ctx)).find((m) => (m.id as Rec | undefined)?.bioguide === bioguide)
  if (!record) throw new Error(`Member not found in current Congress: ${bioguide}`)
  return record
}

const yearToCongress = (year: number): number => {
  if (year < 1935) throw new Error('Year must be 1935 or later.')
  return 74 + Math.floor((year - 1935) / 2)
}

/** The Congresses a member served from the 108th on, newest first (`member_served_congresses`). */
function memberServedCongresses(record: Rec): number[] {
  const out = new Set<number>()
  for (const term of (record.terms ?? []) as Rec[]) {
    const start = String(term.start ?? '').slice(0, 4)
    if (!/^\d+$/.test(start)) continue
    const congress = yearToCongress(Number(start))
    if (congress >= BILLSTATUS_MIN_CONGRESS) out.add(congress)
  }
  return [...out].sort((a, b) => b - a)
}

/** The (Congress, chamber) pairs a member served, newest first (`member_service`). */
function memberService(record: Rec): [number, string][] {
  const seen = new Map<number, string>()
  for (const term of (record.terms ?? []) as Rec[]) {
    const start = String(term.start ?? '').slice(0, 4)
    if (!/^\d+$/.test(start)) continue
    seen.set(yearToCongress(Number(start)), term.type === 'rep' ? 'H' : 'S')
  }
  return [...seen.keys()].sort((a, b) => b - a).map((c) => [c, seen.get(c)!])
}

// ---- member_votes ------------------------------------------------------------------------------------------------------------

/** A Voteview CSV, parsed once per process; a failed download is an empty file. */
function voteviewFile<T>(ctx: NativeCtx, kind: string, congress: number, chamber: string, parse: (rows: Record<string, string>[]) => T, empty: T): Promise<T> {
  return ctx.cache(`congress_gov:voteview:${kind}-${chamber}${congress}`, HOUR_MS, async () => {
    const url = `${VOTEVIEW}/${kind}/${chamber}${congress}_${kind}.csv`
    let text = ''
    try {
      const res = await ctx.http.response(url, { timeoutMs: 120_000 })
      if (res.ok) text = new TextDecoder('utf-8').decode(await res.arrayBuffer())
    } catch {
      return empty
    }
    return text ? parse(parseCsvRecords(text)) : empty
  })
}

const billNumberToId = (billNumber: string, congress: number): string | null => {
  const m = /^([A-Z]+)(\d+)$/.exec((billNumber || '').trim().toUpperCase())
  return m && BILL_NUMBER_TYPES.has(m[1]!) ? `${congress}-${m[1]!.toLowerCase()}-${m[2]}` : null
}

async function memberCongressVotes(ctx: NativeCtx, bioguide: string, congress: number, chamber: string): Promise<Rec[]> {
  const memberIndex = await voteviewFile(ctx, 'members', congress, chamber, (rows) => new Map(rows.flatMap((r) => (r.bioguide_id && r.icpsr ? [[r.bioguide_id, r.icpsr] as const] : []))), new Map<string, string>())
  const icpsr = memberIndex.get(bioguide)
  if (icpsr === undefined) return []
  const rollcalls = await voteviewFile(
    ctx,
    'rollcalls',
    congress,
    chamber,
    (rows) => new Map(rows.map((r) => [r.rollnumber ?? '', { bill_number: r.bill_number ?? '', question: r.vote_question ?? '', result: r.vote_result ?? '', title: r.vote_desc ?? '', date: r.date ?? '' }] as const)),
    new Map<string, Rec>(),
  )
  const votes = await voteviewFile(
    ctx,
    'votes',
    congress,
    chamber,
    (rows) => {
      const index = new Map<string, [string, string][]>()
      for (const r of rows) {
        const key = r.icpsr ?? ''
        if (!index.has(key)) index.set(key, [])
        index.get(key)!.push([r.rollnumber ?? '', r.cast_code ?? ''])
      }
      return index
    },
    new Map<string, [string, string][]>(),
  )
  const out: Rec[] = []
  for (const [rollnumber, castCode] of votes.get(icpsr) ?? []) {
    const position = CAST_CODES[castCode]
    if (position === undefined) continue
    const meta = (rollcalls.get(rollnumber) ?? {}) as Rec
    out.push({
      congress,
      chamber: chamber === 'H' ? 'house' : 'senate',
      rollnumber: Number(rollnumber || 0),
      position,
      bill_id: billNumberToId(meta.bill_number ?? '', congress),
      legislation: meta.bill_number || null,
      title: meta.title || null,
      question: meta.question || null,
      result: meta.result || null,
      date: meta.date || null,
    })
  }
  return out
}

async function memberVotes(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const bioguide = str(params.bioguide_id)
  if (!bioguide) throw new Error('A bioguide id is required.')
  const limit = int(params.limit) ?? 25
  const congress = int(params.congress)
  const record = await loadMemberRecord(ctx, bioguide)
  let service = memberService(record)
  if (congress !== undefined) service = service.filter(([c]) => c === congress)
  if (service.length === 0) return []

  let votes: Rec[] = []
  for (const [c, chamber] of service) {
    const group = await memberCongressVotes(ctx, bioguide, c, chamber)
    votes = votes.concat(group.filter((v) => v.bill_id))
    if (votes.length >= limit) break
  }
  votes.sort((a, b) => {
    const da = (a.date as string | null) || ''
    const db = (b.date as string | null) || ''
    if (da !== db) return da < db ? 1 : -1
    return ((b.rollnumber as number) || 0) - ((a.rollnumber as number) || 0)
  })
  return votes.slice(0, limit)
}

// ---- member_legislation --------------------------------------------------------------------------------------------------------

type LegIndex = { rows: { bioguide: string; billId: string; role: string }[]; meta: Map<string, { title: string; introduced: string; latestDate: string; latest: string }> }

/** The sponsor rows and headline fields of one archive, without keeping the archive (`_ingest_legislation`). */
function legislationIndex(ctx: NativeCtx, congress: number, type: string): Promise<LegIndex> {
  return ctx.cache(`congress_gov:legislation:${congress}-${type}`, HOUR_MS, async () => {
    const url = bulkZipUrl('BILLSTATUS', congress, type)
    let bytes: Uint8Array
    try {
      const res = await ctx.http.response(url, { timeoutMs: 600_000 })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      bytes = new Uint8Array(await res.arrayBuffer())
    } catch (err) {
      throw new Error(`Failed to download data from ${url} -> ${err instanceof Error ? err.message : String(err)}`)
    }
    const archive = parseBillArchive(bytes)
    const meta: LegIndex['meta'] = new Map()
    for (const b of archive.items) meta.set(b.bill_id, { title: b.title, introduced: b.introducedDate, latestDate: b.latestActionDate, latest: b.latestActionText })
    return { rows: archive.legislation, meta }
  })
}

async function memberLegislation(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const bioguide = str(params.bioguide_id)
  if (!bioguide) throw new Error('A bioguide id is required.')
  const congress = int(params.congress)
  const congresses = congress !== undefined ? [congress] : memberServedCongresses(await loadMemberRecord(ctx, bioguide))
  const found: { billId: string; congress: number; role: string; title: string; introduced: string; latestDate: string; latest: string }[] = []
  for (const c of congresses) {
    // A Congress is read from the archives of all eight bill types; one that cannot be read is skipped, as OpenBB's warmup does.
    const indexes = await Promise.all(BILL_TYPES.map((bt) => legislationIndex(ctx, c, bt).catch(() => null)))
    for (const index of indexes) {
      if (!index) continue
      for (const row of index.rows) {
        if (row.bioguide !== bioguide) continue
        const m = index.meta.get(row.billId)
        found.push({ billId: row.billId, congress: c, role: row.role, title: m?.title ?? '', introduced: m?.introduced ?? '', latestDate: m?.latestDate ?? '', latest: m?.latest ?? '' })
      }
    }
  }
  return sortByKey(found, (r) => r.introduced, true).map((r) => ({
    bill_id: r.billId,
    congress: r.congress,
    role: r.role,
    title: r.title || null,
    introduced_date: r.introduced || null,
    latest_action_date: r.latestDate || null,
    latest_action: r.latest || null,
  }))
}

export const memberRoutes: Record<string, NativeHandler> = {
  'uscongress/members': members,
  'uscongress/member_votes': memberVotes,
  'uscongress/member_legislation': memberLegislation,
}
