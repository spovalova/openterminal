// uscongress/bills and uscongress/bill_info, provider congress_gov. Ported from
// openbb_government_us/congress/models/{congress_bills,bill_info}.py and utils/bulk.py (OpenBB Platform 5.0.0,
// Apache-2.0); modified: no SQLite store (see billstatus.ts); the SQL of `store.list_bills` is a filter and a sort here.
import { MissingCredential, type NativeCtx, type NativeHandler, type NativeParams, type Row } from '../types.js'
import { BILL_TYPES, BILLSTATUS_MIN_CONGRESS, BillNotFound, billArchive, parseBillRef, readBillRecord, yearToCongress, type BillItem, type Rec } from './billstatus.js'
import { billRecord, fetchBillList, requireCoverage } from './congress-api.js'
import { currentCongress, int, sortByKey, str } from './helpers.js'

/** The bills of one Congress and type: from a bulk archive, or from the Congress.gov API before the 108th. */
async function billIndex(ctx: NativeCtx, congress: number, type: string): Promise<BillItem[]> {
  if (congress >= BILLSTATUS_MIN_CONGRESS) return (await billArchive(ctx, congress, type)).items
  return ctx.cache(`congress_gov:api-bills:${congress}-${type}`, 3600 * 1000, async () => {
    const records = await fetchBillList(ctx, congress, type)
    const byId = new Map<string, BillItem>()
    for (const r of records) {
      const latest = (r.latestAction ?? {}) as Rec
      byId.set(r.bill_id, {
        bill_id: r.bill_id,
        congress: r.congress,
        number: r.number,
        type: r.type,
        title: r.title,
        originChamber: r.originChamber,
        originChamberCode: r.originChamberCode,
        updateDate: String(r.updateDate ?? '').slice(0, 10),
        updateDateIncludingText: r.updateDateIncludingText,
        latestActionDate: latest.actionDate ?? '',
        latestActionText: latest.text ?? '',
        introducedDate: r.introducedDate,
      })
    }
    return [...byId.values()]
  })
}

/** What the bills table lists for a bill (`_bill_list_item`). */
const listItem = (b: BillItem): Rec => ({
  updateDate: b.updateDate || null,
  bill_id: b.bill_id,
  congress: b.congress,
  number: b.number,
  originChamber: b.originChamber,
  originChamberCode: b.originChamberCode,
  type: b.type,
  title: b.title,
  latestAction: { actionDate: b.latestActionDate || null, text: b.latestActionText || null },
  updateDateIncludingText: b.updateDateIncludingText || null,
})

/** The archives of a Congress ingested, then the bills list queried (`list_bills`). */
export async function listBills(ctx: NativeCtx, congress: number, billTypes: string[], o: { startDate?: string; endDate?: string; limit?: number; offset?: number; sortBy: string }): Promise<Rec[]> {
  const source = congress < BILLSTATUS_MIN_CONGRESS ? 'the Congress.gov API' : 'bulk data'
  const results = await Promise.allSettled(billTypes.map((bt) => billIndex(ctx, congress, bt.toLowerCase())))
  const failures = results.flatMap((r, i) => (r.status === 'rejected' ? [{ bt: billTypes[i]!, error: r.reason as unknown }] : []))
  if (failures.length === billTypes.length) {
    const first = failures[0]!.error
    if (first instanceof MissingCredential) throw first
    throw new Error(`Could not load any bill data for Congress ${congress} from ${source}: ${first instanceof Error ? first.message : String(first)}`)
  }
  // The query reads the loaded types in the order SQLite walks an IN list: ascending.
  const loaded = billTypes
    .map((bt, i) => ({ bt: bt.toLowerCase(), result: results[i]! }))
    .filter((x) => x.result.status === 'fulfilled')
    .sort((a, b) => (a.bt < b.bt ? -1 : a.bt > b.bt ? 1 : 0))
  let items = loaded.flatMap((x) => (x.result as PromiseFulfilledResult<BillItem[]>).value)
  if (o.startDate) items = items.filter((b) => b.updateDate !== '' && b.updateDate >= o.startDate!)
  if (o.endDate) items = items.filter((b) => b.updateDate !== '' && b.updateDate <= o.endDate!)
  const sorted = sortByKey(items, (b) => b.latestActionDate || b.updateDate, o.sortBy === 'desc')
  const offset = o.offset ?? 0
  const rows = o.limit === 0 ? sorted.slice(offset) : sorted.slice(offset, offset + (o.limit || 100))
  return rows.map(listItem)
}

async function bills(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const billType = str(params.bill_type)
  const limit = int(params.limit)
  if (billType !== undefined && !(BILL_TYPES as readonly string[]).includes(billType)) throw new Error(`Invalid bill_type: ${billType}. Must be one of: ${BILL_TYPES.join(', ')}.`)
  if (limit === 0 && billType === undefined) throw new Error("'limit' cannot be set to 0 without 'bill_type' and 'congress'.")
  const startDate = str(params.start_date)
  const endDate = str(params.end_date)
  const sortBy = str(params.sort_by) ?? 'desc'
  let congress = int(params.congress)
  if (congress === undefined) {
    if (startDate) congress = yearToCongress(Number(startDate.slice(0, 4)))
    else if (endDate) congress = yearToCongress(Number(endDate.slice(0, 4)))
    else congress = currentCongress(ctx)
  }
  const data = await listBills(ctx, congress, billType !== undefined ? [billType] : [...BILL_TYPES], { startDate, endDate, limit, offset: int(params.offset), sortBy })

  // transform_data: sorted again by the same key, then renamed to the model's fields.
  const key = (b: Rec): string => (b.latestAction?.actionDate as string | null) || (b.updateDate as string | null) || ''
  return sortByKey(data, key, sortBy === 'desc').map((b) => {
    const out: Row = {
      bill_id: b.bill_id,
      update_date: b.updateDate,
      congress: b.congress,
      bill_number: b.number,
      origin_chamber: b.originChamber,
      origin_chamber_code: b.originChamberCode,
      bill_type: b.type,
      title: b.title,
      update_date_including_text: b.updateDateIncludingText,
    }
    if (b.latestAction) {
      out.latest_action_date = b.latestAction.actionDate
      out.latest_action = b.latestAction.text
    }
    return out
  })
}

// ---- bill_info -------------------------------------------------------------------------------------------------------

/** One bill's full record (`load_bill_record`). */
export async function loadBillRecord(ctx: NativeCtx, ref: string): Promise<Rec> {
  const [congress, type, number] = parseBillRef(ref)
  const id = `${congress}-${type}-${number}`
  if (congress < BILLSTATUS_MIN_CONGRESS) {
    // Opening one bill must not wait on ingesting the Congress's whole list.
    requireCoverage(congress)
    const record = await billRecord(ctx, congress, type, number)
    if (!record) throw new BillNotFound(`Bill not found on Congress.gov: ${congress}/${type}/${number}`)
    return record
  }
  const archive = await billArchive(ctx, congress, type)
  const item = archive.items.find((b) => b.bill_id === id)
  if (!item) throw new BillNotFound(`Bill not found in bulk data: ${congress}/${type}/${number}`)
  return readBillRecord(archive, item)
}

/** Python's str() of an f-string value: None for a missing one. */
const py = (v: unknown): string => (v === undefined || v === null ? 'None' : String(v))

/** Summary HTML as Markdown (`html_to_markdown`). */
function htmlToMarkdown(input: string): string {
  let text = input
  let title = ''
  const paragraphs = [...text.matchAll(/<p[^>]*>(.*?)<\/p>/gis)].map((m) => m[1]!)
  if (paragraphs.length > 0) {
    const strong = /<strong>(.*?)<\/strong>/is.exec(paragraphs[0]!)
    if (strong) {
      title = strong[1]!.trim()
      text = text.replace(`<p><strong>${title}</strong></p>`, '').trimStart()
      if (text.startsWith(title)) text = text.slice(title.length).trimStart()
    }
  }
  const items = (html: string): string[] => [...html.matchAll(/<li[^>]*>(.*?)<\/li>/gis)].map((m) => m[1]!)
  const strip = (s: string): string => s.replace(/<[^>]+>/g, '').trim()
  text = text.replace(/<ul[^>]*>(.*?)<\/ul>/gis, (_m, inner: string) => `\n${items(inner).map((i) => `- ${strip(i)}`).join('\n')}`)
  text = text.replace(/<ol[^>]*>(.*?)<\/ol>/gis, (_m, inner: string) => `\n${items(inner).map((i) => `1. ${strip(i)}`).join('\n')}`)
  text = text.replace(/<[^>]+>/g, '').trim()
  if (title) return `**${title}**\n\n${text.split(title.trim()).join('').trim()}`
  return text
}

/** The bill's Markdown page (`CongressBillInfoFetcher.transform_data`). */
export function billMarkdown(data: Rec): string {
  const latest = (data.latestAction ?? {}) as Rec
  let md = `## ${py(data.title)}

- **Congress**: ${py(data.congress)}
- **Bill Number**: ${py(data.number)}
- **Type**: ${py(data.type)}
- **Chamber**: ${py(data.originChamber)}
- **Introduced**: ${py(data.introducedDate)}
- **Last Updated**: ${data.updateDate === undefined ? '{}' : py(data.updateDate)}
- **Last Action**: ${py(latest.actionDate)} - ${latest.text ?? ''}
`
  const policyArea = ((data.policyArea ?? {}) as Rec).name ?? ''
  if (policyArea) md += `\n- **Policy Area**: ${policyArea}`

  const related = (data.relatedBills ?? []) as Rec[]
  if (related.length > 0) {
    md += '\n\n### Related Bills\n\n'
    for (const bill of related) {
      md += `\n- **${bill.congress ?? ''} ${bill.type ?? ''} ${bill.number ?? ''}: ${bill.title ?? ''}**\n`
      const la = bill.latestAction as Rec | undefined
      if (la && Object.keys(la).length > 0) md += `  - **Last Action**: ${la.actionDate ?? ''} - ${la.text ?? ''}\n`
      for (const rel of (bill.relationshipDetails ?? []) as Rec[]) {
        md += `\n  - **Relationship**: ${rel.type ?? ''}\n`
        md += `    - **Identified By**: ${rel.identifiedBy ?? ''}\n`
      }
    }
  }
  const summaries = (data.summaries ?? []) as Rec[]
  if (summaries.length > 0) {
    md += '\n\n### Summaries\n\n'
    for (const s of summaries) md += `\n${htmlToMarkdown(s.text ?? '')}\n\n`
  }
  const subjects = (data.subjects ?? []) as Rec[]
  if (subjects.length > 0) {
    md += '\n\n### Subjects\n\n'
    for (const s of subjects) md += `\n  - **${s.name ?? ''}** (${s.updateDate ?? ''})`
  }
  const sponsors = (data.sponsors ?? []) as Rec[]
  if (sponsors.length > 0) {
    md += '\n\n### Sponsors\n\n'
    for (const s of sponsors) md += `\n  - **${s.fullName ?? ''}**`
  }
  const cosponsors = (data.cosponsors ?? []) as Rec[]
  if (cosponsors.length > 0) {
    md += '\n\n### Cosponsors\n\n'
    for (const c of cosponsors) {
      let name = String(c.fullName ?? '')
      if (c.isOriginalCosponsor) name += ' (Original Cosponsor)'
      md += `\n  - **${name}** (${c.sponsorshipDate ?? ''})`
    }
  }
  const titles = (data.titles ?? []) as Rec[]
  if (titles.length > 0) {
    md += '\n\n### Titles\n\n'
    for (const t of titles) {
      md += `\n- **${t.title ?? ''}**\n`
      if (t.type) md += `  - **Type**: ${t.type}\n`
      if (t.chamberName) md += `  - **Chamber**: ${t.chamberName}\n`
      if (t.billTextVersionName) md += `  - **Bill Text Version**: ${t.billTextVersionName}\n`
      md += `  - **Last Updated**: ${t.updateDate ?? ''}\n`
    }
  }
  const committees = (data.committees ?? []) as Rec[]
  if (committees.length > 0) {
    md += '\n\n### Committees\n\n'
    for (const c of committees) {
      if (c.chamber) md += `- **${c.name ?? ''} - ${c.chamber} (${py(c.type)})**\n`
      else md += `- **${c.name ?? ''}**\n`
      for (const a of (c.activities ?? []) as Rec[]) md += `  - ${a.name ?? ''} (${a.date ?? ''})\n`
      const subs = (c.subcommittees ?? []) as Rec[]
      if (subs.length > 0) {
        md += '  - **Subcommittees**:\n'
        for (const sub of subs) {
          md += `    - **${sub.name ?? ''}**\n`
          for (const a of (sub.activities ?? []) as Rec[]) md += `      - ${a.name ?? ''} (${a.date ?? ''})\n`
        }
      }
    }
  }
  const actions = (data.actions ?? []) as Rec[]
  if (actions.length > 0) {
    md += '\n\n### Actions\n\n'
    for (const a of actions) {
      md += `\n- **${a.actionDate ?? ''}**: (${a.type ?? ''})`
      md += `\n  - ${a.text ?? ''}`
    }
  }
  return md
}

async function billInfo(params: NativeParams, ctx: NativeCtx): Promise<Row> {
  const billId = str(params.bill_id)
  if (!billId) throw new Error('A bill id is required, e.g. 119-hr-29.')
  const data = await loadBillRecord(ctx, billId)
  return { markdown_content: billMarkdown(data), raw_data: data }
}

export const billRoutes: Record<string, NativeHandler> = {
  'uscongress/bills': bills,
  'uscongress/bill_info': billInfo,
}
