// uscongress/committee_info, committee_documents and search, provider congress_gov. Ported from
// openbb_government_us/congress/models/{congress_committee_info,congress_committee_documents,congress_search}.py and
// utils/{committees,bulk}.py (OpenBB Platform 5.0.0, Apache-2.0); modified: datasets memoised through ctx.cache.
import type { NativeCtx, NativeHandler, NativeParams, Row } from '../types.js'
import type { Rec } from './billstatus.js'
import { currentCongress, int, sortByKey, str } from './helpers.js'
import { unitedstatesData, wssearch, wssearchRecord } from './sources.js'

const HOUR_MS = 3600 * 1000

// ---- committee_info --------------------------------------------------------------------------------------------------------

const CONGRESS_GOV_TO_THOMAS_ID: Record<string, string> = { JJEC: 'JSEC', JHJE: 'JSEC' }

function systemCodeToThomasId(systemCode: string): string {
  const code = systemCode.toUpperCase()
  if (code.endsWith('00')) {
    const base = code.slice(0, -2)
    return CONGRESS_GOV_TO_THOMAS_ID[base] ?? base
  }
  return code
}

/** The committees dataset (`load_committee_structure`); an unreachable source is an empty list. */
function committeeStructure(ctx: NativeCtx): Promise<Rec[]> {
  return ctx.cache('congress_gov:committee_structure', HOUR_MS, async () => {
    try {
      const data = await unitedstatesData<unknown>(ctx, 'committees-current.json')
      return Array.isArray(data) ? (data as Rec[]) : []
    } catch {
      return []
    }
  })
}

async function committeeMembers(ctx: NativeCtx, systemCode: string): Promise<Rec[]> {
  const thomasId = systemCodeToThomasId(systemCode)
  const membership = await ctx.cache('congress_gov:committee_membership', HOUR_MS, async () => {
    try {
      const data = await unitedstatesData<unknown>(ctx, 'committee-membership-current.json')
      return data !== null && typeof data === 'object' && !Array.isArray(data) ? (data as Rec) : null
    } catch {
      return null
    }
  })
  return membership ? ((membership[thomasId] ?? []) as Rec[]) : []
}

async function committeeOverview(ctx: NativeCtx, systemCode: string, chamber: string): Promise<Rec> {
  const structure = await committeeStructure(ctx)
  const thomasId = systemCodeToThomasId(systemCode)
  const parentThomas = thomasId.slice(0, 4)
  const subThomas = thomasId.slice(4)
  const parent = structure.find((c) => c.thomas_id === parentThomas) ?? {}
  const prefix = systemCode.toLowerCase().slice(0, 4)
  const detail: Rec = {
    name: parent.name ?? '',
    chamber,
    type: parent.type ?? chamber,
    website: parent.url ?? '',
    jurisdiction: parent.jurisdiction ?? '',
    is_subcommittee: Boolean(subThomas),
    parent_name: '',
    subcommittees: [],
  }
  if (subThomas) {
    const sub = ((parent.subcommittees ?? []) as Rec[]).find((s) => s.thomas_id === subThomas) ?? {}
    detail.parent_name = parent.name ?? ''
    detail.name = sub.name ? `${parent.name ?? ''} — ${sub.name}` : (parent.name ?? '')
    detail.jurisdiction = sub.jurisdiction ?? detail.jurisdiction
  } else {
    detail.subcommittees = ((parent.subcommittees ?? []) as Rec[]).filter((s) => s.name).map((s) => ({ name: s.name ?? '', systemCode: `${prefix}${s.thomas_id ?? ''}` }))
  }
  if (!detail.name) detail.name = systemCode.toUpperCase()
  return { chamber, system_code: systemCode, detail, members: await committeeMembers(ctx, systemCode) }
}

const titleCase = (s: string): string => s.toLowerCase().replace(/(^|[^a-z])([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase())

function committeeMarkdown(data: Rec): string {
  const systemCode = data.system_code ?? ''
  const detail = (data.detail ?? {}) as Rec
  const members = (data.members ?? []) as Rec[]
  const name = detail.name || String(systemCode).toUpperCase()
  let md = `# ${name}\n\n## Overview\n\n| Field | Value |\n|---|---|\n`
  const metaRows: [string, string][] = [
    ['Chamber', titleCase(detail.chamber ?? '')],
    ['Type', detail.type ?? ''],
    ['System Code', `\`${systemCode}\``],
  ]
  if (detail.is_subcommittee && detail.parent_name) metaRows.push(['Parent Committee', detail.parent_name])
  if (detail.website) metaRows.push(['Website', `[${detail.website}](${detail.website})`])
  for (const [label, val] of metaRows) md += `| ${label} | ${val} |\n`
  if (detail.jurisdiction) md += `\n## Jurisdiction\n\n${detail.jurisdiction}\n`
  const subs = (detail.subcommittees ?? []) as Rec[]
  if (subs.length > 0) {
    md += `\n## Subcommittees (${subs.length})\n\n`
    for (const sub of subs) if (sub.name) md += `- **${sub.name}** (\`${sub.systemCode ?? ''}\`)\n`
  }
  if (members.length > 0) {
    const chair = members.filter((m) => ['chair', 'chairman', 'chairwoman', 'chairperson'].includes(String(m.title ?? '').toLowerCase()))
    const ranking = members.filter((m) => String(m.title ?? '').toLowerCase().includes('ranking'))
    const rest = members.filter((m) => !chair.includes(m) && !ranking.includes(m))
    md += `\n## Members (${members.length})\n\n| Name | Party | Title |\n|---|---|---|\n`
    for (const m of [...chair, ...ranking, ...rest]) md += `| ${m.name ?? 'Unknown'} | ${m.party ?? ''} | ${m.title || 'Member'} |\n`
  } else md += '\n*Member data not available for this committee.*\n'
  return md
}

async function committeeInfo(params: NativeParams, ctx: NativeCtx): Promise<Row> {
  const chamber = str(params.chamber) ?? 'senate'
  const systemCode = (str(params.subcommittee) ?? str(params.committee) ?? 'ssaf00').toLowerCase()
  const data = await committeeOverview(ctx, systemCode, chamber.toLowerCase())
  return { markdown_content: committeeMarkdown(data), raw_data: data }
}

// ---- committee_documents ---------------------------------------------------------------------------------------------------

const DOC_TYPE_COLLECTION: Record<string, string> = { report: 'CRPT', publication: 'CPRT', meeting: 'CHRG', legislation: 'BILLS' }

async function committeeDocuments(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const systemCode = (str(params.subcommittee) ?? str(params.committee) ?? 'ssaf00').toLowerCase()
  const congress = int(params.congress) ?? currentCongress(ctx)
  const docType = str(params.doc_type) ?? 'all'
  const limit = int(params.limit) ?? 250
  const offset = int(params.offset) ?? 0
  const docTypes = docType === 'all' ? Object.keys(DOC_TYPE_COLLECTION) : [docType]
  const groups = await Promise.all(
    docTypes.map(async (dt) => {
      const query = `committee:"${systemCode}" AND collection:${DOC_TYPE_COLLECTION[dt]} AND congress:${congress}`
      const response = await wssearch(ctx, query, { offset, pagesize: limit })
      return ((response.resultSet ?? []) as Rec[]).map((item) => wssearchRecord(item, dt, congress))
    }),
  )
  const results: Rec[] = []
  const seen = new Set<string>()
  for (const group of groups) {
    for (const record of group) {
      if (seen.has(record.package_id)) continue
      seen.add(record.package_id)
      results.push(record)
    }
  }
  return sortByKey(results, (r) => (r.date as string | null) || '', true)
}

// ---- search ----------------------------------------------------------------------------------------------------------------

const CONGRESSIONAL_COLLECTIONS = ['BILLS', 'CRPT', 'CHRG', 'CPRT', 'CREC', 'CCAL', 'CMR', 'PLAW']

async function search(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const query = str(params.query)
  if (!query) throw new Error('A search query is required.')
  const parts = [query]
  const collection = str(params.collection)
  parts.push(collection ? `collection:${collection}` : `(${CONGRESSIONAL_COLLECTIONS.map((c) => `collection:${c}`).join(' OR ')})`)
  const congress = int(params.congress)
  if (congress !== undefined) parts.push(`congress:${congress}`)
  const startDate = str(params.start_date)
  const endDate = str(params.end_date)
  if (startDate || endDate) parts.push(`publishdate:range(${startDate ?? '1789-01-01'},${endDate ?? ctx.now().toISOString().slice(0, 10)})`)
  const response = await wssearch(ctx, parts.join(' AND '), { offset: int(params.offset) ?? 0, pagesize: int(params.limit) || 20 })
  const records = ((response.resultSet ?? []) as Rec[]).map((item) => {
    const fieldMap = (item.fieldMap ?? {}) as Rec
    const packageId = (fieldMap.packageid as string | undefined) ?? ''
    const base = wssearchRecord(item, '', 0)
    const m = /^[A-Z]+-(\d+)/.exec(packageId)
    return { title: base.title, collection: fieldMap.collectionCode ?? '', date: base.date, congress: m ? Number(m[1]) : null, citation: base.citation, package_id: packageId, doc_url: base.doc_url }
  })
  return sortByKey(records, (r) => (r.date as string | null) || '', true)
}

export const committeeRoutes: Record<string, NativeHandler> = {
  'uscongress/committee_info': committeeInfo,
  'uscongress/committee_documents': committeeDocuments,
  'uscongress/search': search,
}
