// GovInfo BILLSTATUS bulk archives: download, parse, and the in-memory index the bill, amendment and member routes
// read. Ported from openbb_government_us/congress/utils/bulk.py and store.py (OpenBB Platform 5.0.0, Apache-2.0);
// modified: OpenBB parses each archive into a SQLite database kept on disk; here an archive is parsed once per
// process (ctx.cache) into an index of list items, amendments and sponsor rows, and a bill's full record is parsed
// again from its XML member only when one bill is asked for.
import { openZip, type ZipArchive, type ZipEntry } from '../lib/zip-entries.js'
import type { NativeCtx } from '../types.js'
import { El, firstItems, firstText, itemDict, parseElement, textAt } from './xml.js'

export const GOVINFO = 'https://www.govinfo.gov'
export const BULKDATA = `${GOVINFO}/bulkdata`
/** The first Congress GovInfo publishes BILLSTATUS archives for. */
export const BILLSTATUS_MIN_CONGRESS = 108
export const BILL_TYPES = ['hr', 's', 'hjres', 'sjres', 'hconres', 'sconres', 'hres', 'sres'] as const

export type Rec = Record<string, any>

const HOUR_MS = 3600 * 1000

export const bulkZipUrl = (collection: string, congress: number, type: string): string => `${BULKDATA}/${collection}/${congress}/${type.toLowerCase()}/${collection}-${congress}-${type.toLowerCase()}.zip`

/** The Congress a calendar year falls in (`year_to_congress`). */
export function yearToCongress(year: number): number {
  if (year < 1935) throw new Error('Year must be 1935 or later.')
  return 74 + Math.floor((year - 1935) / 2)
}

export class BillNotFound extends Error {}

/** `(congress, type, number)` from a bill id or URL (`parse_bill_ref`). */
export function parseBillRef(ref: string): [number, string, number] {
  const m = /\/bill\/(\d+)\/([a-z]+)\/(\d+)/i.exec(ref) ?? /^\/?(\d+)[-/]([a-z]+)[-/](\d+)/i.exec(ref)
  if (!m) throw new Error(`Could not parse a bill reference (congress/type/number) from: ${ref}`)
  return [Number(m[1]), m[2]!.toLowerCase(), Number(m[3])]
}

/** `(congress, type, number)` from an amendment id or URL (`parse_amendment_ref`). */
export function parseAmendmentRef(ref: string): [number, string, string] {
  const m = /\/amendment\/(\d+)\/([a-z]+)\/(\d+)/i.exec(ref) ?? /^\/?(\d+)[-/]([a-z]+)[-/](\d+)/i.exec(ref)
  if (!m) throw new Error(`Could not parse an amendment reference (congress/type/number) from: ${ref}`)
  return [Number(m[1]), m[2]!.toLowerCase(), m[3]!]
}

/** A bulk archive's bytes, downloaded once per process; a failure is reported as OpenBB words it. */
export function downloadBulk(ctx: NativeCtx, url: string): Promise<Uint8Array> {
  return ctx.cache(`congress_gov:bulk:${url}`, HOUR_MS, async () => {
    try {
      const res = await ctx.http.response(url, { timeoutMs: 600_000 })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return new Uint8Array(await res.arrayBuffer())
    } catch (err) {
      throw new Error(`Failed to download data from ${url} -> ${err instanceof Error ? err.message : String(err)}`, { cause: err })
    }
  })
}

// ---- parsing ---------------------------------------------------------------------------------------------------------

function amendmentRecord(am: El): Rec {
  const congress = Number(textAt(am, 'congress') || 0)
  const number = textAt(am, 'number')
  const type = textAt(am, 'type')
  let amendedBill: Rec = {}
  const ab = am.find('amendedBill')
  if (ab) amendedBill = { congress: textAt(ab, 'congress'), type: textAt(ab, 'type'), number: textAt(ab, 'number'), title: textAt(ab, 'title') }
  let amendedAmendment: Rec = {}
  const aa = am.find('amendedAmendment')
  if (aa) amendedAmendment = { congress: textAt(aa, 'congress'), type: textAt(aa, 'type'), number: textAt(aa, 'number') }
  return {
    amendment_id: `${congress}-${type.toLowerCase()}-${number}`,
    congress,
    number,
    type,
    description: textAt(am, 'description'),
    purpose: textAt(am, 'purpose'),
    chamber: textAt(am, 'chamber'),
    updateDate: textAt(am, 'updateDate'),
    proposedDate: textAt(am, 'proposedDate'),
    submittedDate: textAt(am, 'submittedDate'),
    latestAction: { actionDate: textAt(am, 'latestAction/actionDate'), actionTime: textAt(am, 'latestAction/actionTime'), text: textAt(am, 'latestAction/text') },
    sponsors: am.findall('sponsors/item').map(itemDict),
    cosponsors: am.findall('cosponsors/item').map(itemDict),
    actions: am.findall('actions/actions/item').map(itemDict),
    links: am.findall('links/link').map(itemDict),
    amendedBill,
    amendedAmendment,
  }
}

/** A `<bill>` element as the API-shaped record dict, or null without a type or number (`_billstatus_record`). */
export function billstatusRecord(bill: El): Rec | null {
  const congress = Number(firstText(bill, 'congress') || 0)
  const numberText = firstText(bill, 'number', 'billNumber')
  const type = firstText(bill, 'type', 'billType')
  if (!type || !/^\d+$/.test(numberText)) return null
  const number = Number(numberText)

  const titles = bill.findall('titles/item').map(itemDict)
  for (const t of titles) if (!('type' in t)) t.type = t.titleType ?? ''
  const cosponsors = bill.findall('cosponsors/item').map(itemDict) as Rec[]
  for (const c of cosponsors) c.isOriginalCosponsor = c.isOriginalCosponsor === 'True'
  const summaries: Rec[] = firstItems(bill, 'summaries/summary', 'summaries/billSummaries/item').map((s) => ({
    versionCode: textAt(s, 'versionCode'),
    actionDate: textAt(s, 'actionDate'),
    actionDesc: textAt(s, 'actionDesc'),
    updateDate: textAt(s, 'updateDate'),
    text: textAt(s, 'text'),
  }))

  return {
    congress,
    number,
    type,
    bill_id: `${congress}-${type.toLowerCase()}-${number}`,
    originChamber: textAt(bill, 'originChamber'),
    originChamberCode: textAt(bill, 'originChamberCode'),
    title: textAt(bill, 'title'),
    introducedDate: textAt(bill, 'introducedDate'),
    updateDate: textAt(bill, 'updateDate'),
    updateDateIncludingText: textAt(bill, 'updateDateIncludingText'),
    latestAction: { actionDate: textAt(bill, 'latestAction/actionDate'), text: textAt(bill, 'latestAction/text') },
    policyArea: { name: firstText(bill, 'policyArea/name', 'subjects/billSubjects/policyArea/name') },
    sponsors: bill.findall('sponsors/item').map(itemDict),
    cosponsors,
    actions: bill.findall('actions/item').map(itemDict),
    committees: firstItems(bill, 'committees/item', 'committees/billCommittees/item').map(itemDict),
    relatedBills: bill.findall('relatedBills/item').map(itemDict),
    subjects: firstItems(bill, 'subjects/legislativeSubjects/item', 'subjects/billSubjects/legislativeSubjects/item').map(itemDict),
    titles,
    summaries,
    textVersions: bill.findall('textVersions/item').map((item) => ({
      type: textAt(item, 'type'),
      date: textAt(item, 'date'),
      formats: item.findall('formats/item').map((fmt) => ({ url: textAt(fmt, 'url') })),
    })),
    amendments: firstItems(bill, 'amendments/amendment', 'amendments/billAmendments/amendment').map(amendmentRecord),
  }
}

/** The `<bill>` of one BILLSTATUS XML member. */
function parseBillMember(xml: string): Rec | null {
  const bill = parseElement(xml).find('bill')
  return bill ? billstatusRecord(bill) : null
}

/** What the bill list shows of a record (the `bills` table columns). */
export type BillItem = {
  bill_id: string
  congress: number
  number: number
  type: string
  title: string
  originChamber: string
  originChamberCode: string
  /** `updateDate[:10]` */
  updateDate: string
  updateDateIncludingText: string
  latestActionDate: string
  latestActionText: string
  introducedDate: string
  /** The archive member, absent for a bill listed by the Congress.gov API. */
  entry?: ZipEntry
}

export type LegRow = { bioguide: string; billId: string; role: string }

export type BillArchive = {
  zip: ZipArchive
  items: BillItem[]
  /** Amendments of every bill in the archive, a later copy of an id replacing the earlier one. */
  amendments: Rec[]
  legislation: LegRow[]
}

/** Parse a BILLSTATUS ZIP (`parse_billstatus` + `ingest_bills`). */
export function parseBillArchive(bytes: Uint8Array): BillArchive {
  const zip = openZip(bytes)
  const byId = new Map<string, BillItem>()
  const amendments = new Map<string, Rec>()
  const legislation: LegRow[] = []
  for (const entry of zip.entries) {
    if (!entry.name.toLowerCase().endsWith('.xml')) continue
    const record = parseBillMember(zip.readText(entry))
    if (record === null) continue
    const latest = (record.latestAction ?? {}) as Rec
    byId.set(record.bill_id, {
      bill_id: record.bill_id,
      congress: record.congress,
      number: record.number,
      type: record.type,
      title: record.title,
      originChamber: record.originChamber,
      originChamberCode: record.originChamberCode,
      updateDate: String(record.updateDate ?? '').slice(0, 10),
      updateDateIncludingText: record.updateDateIncludingText,
      latestActionDate: latest.actionDate ?? '',
      latestActionText: latest.text ?? '',
      introducedDate: record.introducedDate,
      entry,
    })
    for (const am of record.amendments as Rec[]) {
      // INSERT OR REPLACE: a repeated amendment id moves to the end.
      amendments.delete(am.amendment_id)
      amendments.set(am.amendment_id, am)
    }
    const sponsor = (record.sponsors as Rec[]).find((s) => s.bioguideId)?.bioguideId as string | undefined
    if (sponsor) legislation.push({ bioguide: sponsor, billId: record.bill_id, role: 'Sponsor' })
    for (const c of record.cosponsors as Rec[]) if (c.bioguideId && c.bioguideId !== sponsor) legislation.push({ bioguide: c.bioguideId, billId: record.bill_id, role: 'Cosponsor' })
  }
  return { zip, items: [...byId.values()], amendments: [...amendments.values()], legislation }
}

/** One congress/type archive, downloaded and parsed once per process (`ensure_billstatus`). */
export function billArchive(ctx: NativeCtx, congress: number, type: string): Promise<BillArchive> {
  const bt = type.toLowerCase()
  return ctx.cache(`congress_gov:billstatus:${congress}-${bt}`, HOUR_MS, async () => parseBillArchive(await downloadBulk(ctx, bulkZipUrl('BILLSTATUS', congress, bt))))
}

/** A bill's full record, parsed from its XML member. */
export function readBillRecord(archive: BillArchive, item: BillItem): Rec {
  if (!item.entry) throw new BillNotFound(`Bill not found in bulk data: ${item.bill_id}`)
  const record = parseBillMember(archive.zip.readText(item.entry))
  if (!record) throw new BillNotFound(`Bill not found in bulk data: ${item.bill_id}`)
  return record
}
