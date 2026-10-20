// The Congress.gov API path, used for Congresses before the 108th (GovInfo has no BILLSTATUS archives for them) and
// the only part of congress_gov that needs a key. Ported from openbb_government_us/congress/utils/congress_api.py
// (OpenBB Platform 5.0.0, Apache-2.0); modified: plain async functions on ctx.http, no database.
import { MissingCredential, type NativeCtx } from '../types.js'
import { BILLSTATUS_MIN_CONGRESS, type Rec } from './billstatus.js'

const BASE = 'https://api.congress.gov/v3'
/** Congress.gov has bill data back to the 93rd Congress (1973). */
export const API_MIN_CONGRESS = 93
const PAGE_LIMIT = 250
const MAX_PAGES = 400
const SUB_RESOURCES = ['actions', 'amendments', 'committees', 'cosponsors', 'relatedbills', 'subjects', 'summaries', 'text', 'titles'] as const
const FIELDS: Record<(typeof SUB_RESOURCES)[number], string> = { actions: 'actions', amendments: 'amendments', committees: 'committees', cosponsors: 'cosponsors', relatedbills: 'relatedBills', subjects: 'subjects', summaries: 'summaries', text: 'textVersions', titles: 'titles' }

/** The key, or the error OpenBB raises without one. */
export function apiKey(ctx: NativeCtx): string {
  const key = ctx.credential('congress_gov_api_key')
  if (!key) throw new MissingCredential('congress_gov', 'congress_gov_api_key')
  return key
}

async function get(ctx: NativeCtx, path: string, key: string, params: Record<string, string | number> = {}): Promise<Rec> {
  let data: unknown
  try {
    data = await ctx.http.json(`${BASE}/${path.replace(/^\/+/, '')}`, { query: { format: 'json', api_key: key, ...params }, timeoutMs: 30_000 })
  } catch (err) {
    throw new Error(`Congress.gov API request failed -> ${path}: ${err instanceof Error ? err.message : String(err)}`, { cause: err })
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error(`Unexpected Congress.gov API response for ${path}: ${JSON.stringify(data)}`)
  if ((data as Rec).error) throw new Error(`Congress.gov API error for ${path}: ${String((data as Rec).error)}`)
  return data as Rec
}

/** Every record of a collection, page by page (`_paged`). */
async function paged(ctx: NativeCtx, path: string, key: string, field: string): Promise<Rec[]> {
  const items: Rec[] = []
  let offset = 0
  let total: number | null = null
  for (let i = 0; i < MAX_PAGES; i++) {
    const data = await get(ctx, path, key, { offset, limit: PAGE_LIMIT })
    const pagination = (data.pagination ?? {}) as Rec
    if (total === null && Number.isInteger(pagination.count)) total = pagination.count
    const page = data[field] ?? []
    // `subjects` nests its lists under the field rather than listing them.
    if (page !== null && typeof page === 'object' && !Array.isArray(page)) return [page as Rec]
    items.push(...(page as Rec[]))
    if ((page as Rec[]).length === 0 || (page as Rec[]).length < PAGE_LIMIT || !pagination.next) break
    if (total !== null && items.length >= total) break
    offset += (page as Rec[]).length
  }
  return items
}

const latestAction = (payload: Rec): Rec => ({ actionDate: (payload.latestAction as Rec | undefined)?.actionDate || '', text: (payload.latestAction as Rec | undefined)?.text || '' })
const billId = (congress: number, type: unknown, number: unknown): string => `${congress}-${String(type).toLowerCase()}-${number}`

export function requireCoverage(congress: number): void {
  if (congress < API_MIN_CONGRESS) throw new Error(`Congress ${congress} predates structured bill data. GovInfo bulk archives start at the ${BILLSTATUS_MIN_CONGRESS}th Congress and the Congress.gov API reaches back to the ${API_MIN_CONGRESS}rd (1973).`)
}

/** A list entry as the slim record the bulk path would store (`slim_record`). */
function slimRecord(payload: Rec): Rec {
  const congress = Number(payload.congress || 0)
  const type = payload.type || ''
  const number = payload.number || ''
  return {
    congress,
    number: /^\d+$/.test(String(number)) ? Number(number) : 0,
    type,
    bill_id: billId(congress, type, number),
    originChamber: payload.originChamber || '',
    originChamberCode: payload.originChamberCode || '',
    title: payload.title || '',
    introducedDate: payload.introducedDate || '',
    updateDate: payload.updateDate || '',
    updateDateIncludingText: payload.updateDateIncludingText || '',
    latestAction: latestAction(payload),
    policyArea: { name: '' },
    sponsors: [],
    cosponsors: [],
    actions: [],
    committees: [],
    relatedBills: [],
    subjects: [],
    titles: [],
    summaries: [],
    textVersions: [],
    amendments: [],
    _detailed: false,
  }
}

/** Every bill of a Congress and type, from the API's list endpoint (`fetch_bill_list`). */
export async function fetchBillList(ctx: NativeCtx, congress: number, billType: string): Promise<Rec[]> {
  const key = apiKey(ctx)
  requireCoverage(congress)
  const path = `bill/${congress}/${billType.toLowerCase()}`
  const entries: Rec[] = []
  let offset = 0
  let total: number | null = null
  for (let i = 0; i < MAX_PAGES; i++) {
    const data = await get(ctx, path, key, { offset, limit: PAGE_LIMIT })
    const pagination = (data.pagination ?? {}) as Rec
    if (total === null && Number.isInteger(pagination.count)) total = pagination.count
    const page = (data.bills ?? []) as Rec[]
    entries.push(...page)
    if (page.length === 0 || page.length < PAGE_LIMIT || !pagination.next) break
    if (total !== null && entries.length >= total) break
    offset += page.length
  }
  return entries.map(slimRecord)
}

/** One bill's full record, folded together from the detail document and its sub-collections (`bill_record`). */
export async function billRecord(ctx: NativeCtx, congress: number, billType: string, number: number): Promise<Rec | null> {
  const key = apiKey(ctx)
  requireCoverage(congress)
  const bt = billType.toLowerCase()
  const base = `bill/${congress}/${bt}/${number}`
  const detail = await get(ctx, base, key)
  const bill = detail.bill as Rec | undefined
  if (!bill) return null

  const parts: Record<string, Rec[]> = {}
  await Promise.all(
    SUB_RESOURCES.map(async (resource) => {
      try {
        parts[resource] = await paged(ctx, `${base}/${resource}`, key, FIELDS[resource])
      } catch {
        parts[resource] = []
      }
    }),
  )

  const subjectsPayload = (parts.subjects?.[0] ?? {}) as Rec
  const legislativeSubjects = subjectsPayload.legislativeSubjects ?? []
  const policyArea = (bill.policyArea as Rec | undefined)?.name || (subjectsPayload.policyArea as Rec | undefined)?.name
  const titles = (parts.titles ?? []).map((title) => {
    const entry = { ...title }
    if (!('type' in entry)) entry.type = entry.titleType || ''
    return entry
  })

  return {
    congress: Number(bill.congress || congress),
    number: Number(bill.number || number),
    type: bill.type || billType.toUpperCase(),
    bill_id: billId(congress, bt, number),
    originChamber: bill.originChamber || '',
    originChamberCode: bill.originChamberCode || '',
    title: bill.title || '',
    introducedDate: bill.introducedDate || '',
    updateDate: bill.updateDate || '',
    updateDateIncludingText: bill.updateDateIncludingText || '',
    latestAction: latestAction(bill),
    policyArea: { name: policyArea || '' },
    sponsors: bill.sponsors || [],
    cosponsors: (parts.cosponsors ?? []).map((c) => ({ ...c, isOriginalCosponsor: Boolean(c.isOriginalCosponsor) })),
    actions: parts.actions ?? [],
    committees: (parts.committees ?? []).map((c) => ({ systemCode: c.systemCode || '', name: c.name || '', chamber: c.chamber || '', type: c.type || '', activities: c.activities || [], subcommittees: c.subcommittees || [] })),
    relatedBills: parts.relatedbills ?? [],
    subjects: legislativeSubjects,
    titles,
    summaries: parts.summaries ?? [],
    textVersions: (parts.text ?? []).map((v) => ({ type: v.type || '', date: v.date || '', formats: ((v.formats ?? []) as Rec[]).filter((f) => f.url).map((f) => ({ url: f.url || '' })) })),
    amendments: parts.amendments ?? [],
    _detailed: true,
  }
}
