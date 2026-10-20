// uscongress/amendments and uscongress/amendment_info, provider congress_gov. Ported from
// openbb_government_us/congress/models/{congress_amendments,amendment_info}.py and utils/bulk.py (OpenBB Platform
// 5.0.0, Apache-2.0); modified: no SQLite store. Amendments live inside the BILLSTATUS files of their bills, so
// every bill type's archive of the Congress is read.
import type { NativeCtx, NativeHandler, NativeParams, Row } from '../types.js'
import { BILL_TYPES, billArchive, parseAmendmentRef, type Rec } from './billstatus.js'
import { currentCongress, int, paginate, sortByKey, str } from './helpers.js'

const AMENDMENT_TYPES = ['hamdt', 'samdt']

/** Every amendment of a Congress, optionally of one type (`load_amendments`). */
async function loadAmendments(ctx: NativeCtx, congress: number, amendmentType?: string): Promise<Rec[]> {
  const archives = await Promise.all(BILL_TYPES.map((bt) => billArchive(ctx, congress, bt)))
  // INSERT OR REPLACE by amendment id: a later copy replaces the earlier one.
  const byId = new Map<string, Rec>()
  for (const a of archives) {
    for (const am of a.amendments) {
      byId.delete(am.amendment_id)
      byId.set(am.amendment_id, am)
    }
  }
  const all = [...byId.values()]
  return amendmentType === undefined ? all : all.filter((r) => String(r.type ?? '').toLowerCase() === amendmentType.toLowerCase())
}

/** The slim list shape of an amendment record (`to_amendment_list_item`). */
const listItem = (r: Rec): Rec => ({
  amendment_id: r.amendment_id,
  congress: r.congress,
  number: r.number,
  type: r.type,
  description: r.description || null,
  purpose: r.purpose || null,
  updateDate: String(r.updateDate ?? '').slice(0, 10) || null,
  submittedDate: r.submittedDate,
  latestAction: r.latestAction || {},
  sponsors: r.sponsors || [],
  amendedBill: r.amendedBill || {},
  amendedAmendment: r.amendedAmendment || {},
})

const NULL_TOKENS = new Set(['', '-', '--', '---', '----', 'n/a', 'na', 'null', 'none', 'nan'])
const nullToken = (v: unknown): boolean => typeof v === 'string' && NULL_TOKENS.has(v.trim().toLowerCase())

async function amendments(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const amendmentType = str(params.amendment_type)
  const limit = int(params.limit)
  if (amendmentType !== undefined && !AMENDMENT_TYPES.includes(amendmentType)) throw new Error(`Invalid amendment_type: ${amendmentType}. Must be one of: ${AMENDMENT_TYPES.join(', ')}.`)
  if (limit === 0 && amendmentType === undefined) throw new Error("'limit' cannot be set to 0 without 'amendment_type'.")
  const sortBy = str(params.sort_by) ?? 'desc'
  const startDate = str(params.start_date)
  const endDate = str(params.end_date)
  const congress = int(params.congress) ?? currentCongress(ctx)
  const records = await loadAmendments(ctx, congress, amendmentType)

  // filter_amendments
  let items = records.map(listItem)
  const updated = (r: Rec): string => String(r.updateDate ?? '').slice(0, 10)
  if (startDate) items = items.filter((r) => updated(r) && updated(r) >= startDate)
  if (endDate) items = items.filter((r) => updated(r) && updated(r) <= endDate)
  items = sortByKey(items, (r) => (r.latestAction?.actionDate as string | undefined) || (r.updateDate as string | null) || '', sortBy === 'desc')
  const data = paginate(items, limit, int(params.offset))

  // transform_data
  const key = (r: Rec): string => String((r.submittedDate as string | undefined) || (r.latestAction?.actionDate as string | undefined) || (r.updateDate as string | null) || '').slice(0, 10)
  return sortByKey(data, key, sortBy === 'desc').map((a) => {
    const out: Rec = { amendment_id: a.amendment_id, congress: a.congress, number: a.number, amendment_type: a.type, description: a.description, purpose: a.purpose }
    const latest = a.latestAction as Rec
    if (latest && Object.keys(latest).length > 0) {
      out.latest_action_date = latest.actionDate || null
      out.latest_action_time = latest.actionTime || null
      out.latest_action = latest.text || null
    }
    const amendedBill = (a.amendedBill ?? {}) as Rec
    if (Object.keys(amendedBill).length > 0) {
      out.amended_bill = `${amendedBill.type ?? ''} ${amendedBill.number ?? ''}`.trim() || null
      out.amended_bill_title = amendedBill.title || null
    }
    const amendedAmendment = (a.amendedAmendment ?? {}) as Rec
    if (Object.keys(amendedAmendment).length > 0 && !out.amended_bill) out.amended_bill = `Amdt. ${amendedAmendment.type ?? ''} ${amendedAmendment.number ?? ''}`.trim() || null
    const sponsors = (a.sponsors ?? []) as Rec[]
    if (sponsors.length > 0) out.sponsor = sponsors[0]!.fullName || null
    if (a.submittedDate) out.submitted_date = String(a.submittedDate).slice(0, 10)
    out.update_date = a.updateDate ? String(a.updateDate).slice(0, 10) : null
    // NullTokenMixin: placeholder strings are no value.
    return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, nullToken(v) ? null : v]))
  })
}

// ---- amendment_info ----------------------------------------------------------------------------------------------------

async function loadAmendmentRecord(ctx: NativeCtx, ref: string): Promise<Rec> {
  const [congress, type, number] = parseAmendmentRef(ref)
  const records = await loadAmendments(ctx, congress)
  const record = records.find((r) => r.amendment_id === `${congress}-${type}-${number}`)
  if (!record) throw new Error(`Amendment not found in bulk data: ${congress}/${type}/${number}`)
  return record
}

export function amendmentMarkdown(data: Rec): string {
  const number = data.number ?? ''
  const type = data.type ?? ''
  const congress = data.congress ?? ''
  const description = data.description ?? ''
  const purpose = data.purpose ?? ''
  const header = description || purpose || `Amendment ${congress} ${type} ${number}`
  let md = `# ${header}\n\n`
  if (purpose && purpose !== description) md += `> ${purpose}\n\n`
  md += `- **Congress**: ${congress}\n`
  md += `- **Number**: ${number}\n`
  md += `- **Type**: ${type}\n`
  md += `- **Chamber**: ${data.chamber ?? ''}\n`
  const submittedAt = data.submittedDate || data.proposedDate
  if (submittedAt) md += `- **Submitted**: ${submittedAt}\n`
  md += `- **Last Updated**: ${data.updateDate ?? ''}\n`
  const latest = data.latestAction as Rec | undefined
  if (latest && Object.keys(latest).length > 0 && (latest.actionDate || latest.text)) md += `- **Latest Action**: ${latest.actionDate ?? ''} - ${latest.text ?? ''}\n`
  const amendedBill = data.amendedBill as Rec | undefined
  if (amendedBill && Object.keys(amendedBill).length > 0) md += `\n### Amended Bill\n\n- **${amendedBill.congress ?? ''} ${amendedBill.type ?? ''} ${amendedBill.number ?? ''}**: ${amendedBill.title ?? ''}\n`
  const amendedAmendment = data.amendedAmendment as Rec | undefined
  if (amendedAmendment && Object.keys(amendedAmendment).length > 0) md += `\n### Amends Amendment\n\n- **${amendedAmendment.congress ?? ''} ${amendedAmendment.type ?? ''} ${amendedAmendment.number ?? ''}**\n`
  const sponsors = (data.sponsors ?? []) as Rec[]
  if (sponsors.length > 0) {
    md += '\n### Sponsors\n\n'
    for (const s of sponsors) {
      md += `- **${s.fullName ?? ''}**`
      if (s.party) md += ` (${s.party})`
      md += '\n'
    }
  }
  const cosponsors = data.cosponsors as Rec[] | Rec | undefined
  if (Array.isArray(cosponsors) && cosponsors.length > 0) {
    md += '\n### Cosponsors\n\n'
    for (const c of cosponsors) {
      md += `- **${c.fullName ?? ''}**`
      if (c.party) md += ` (${c.party})`
      md += '\n'
    }
  } else if (cosponsors && !Array.isArray(cosponsors) && cosponsors.count) md += `\n### Cosponsors\n\n- **Count**: ${cosponsors.count}\n`
  const textVersions = data.textVersions as Rec[] | undefined
  if (Array.isArray(textVersions) && textVersions.length > 0) {
    md += '\n### Text Versions\n\n'
    for (const v of textVersions) {
      md += `- **${v.type ?? ''}** (${v.date ?? ''})\n`
      for (const f of (v.formats ?? []) as Rec[]) md += `  - [${f.type ?? ''}](${f.url ?? ''})\n`
    }
  }
  const actions = data.actions as Rec[] | undefined
  if (Array.isArray(actions) && actions.length > 0) {
    md += '\n### Actions\n\n'
    for (const a of actions) {
      md += `\n- **${a.actionDate ?? ''}**: (${a.type ?? ''})`
      md += `\n  - ${a.text ?? ''}`
    }
  }
  return md
}

async function amendmentInfo(params: NativeParams, ctx: NativeCtx): Promise<Row> {
  const id = str(params.amendment_id)
  if (!id) throw new Error('An amendment id is required, e.g. 119-hamdt-2.')
  const data = await loadAmendmentRecord(ctx, id)
  return { markdown_content: amendmentMarkdown(data), raw_data: data }
}

export const amendmentRoutes: Record<string, NativeHandler> = {
  'uscongress/amendments': amendments,
  'uscongress/amendment_info': amendmentInfo,
}
