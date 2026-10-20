// uscongress/laws, calendars and mandated_reports, provider congress_gov. Ported from
// openbb_government_us/congress/models/{congress_laws,congress_calendars,congress_mandated_reports}.py and
// utils/bulk.py (OpenBB Platform 5.0.0, Apache-2.0); modified: no SQLite store, results kept per process.
import { openZip } from '../lib/zip-entries.js'
import type { NativeCtx, NativeHandler, NativeParams, Row } from '../types.js'
import { bulkZipUrl, downloadBulk, GOVINFO, type Rec } from './billstatus.js'
import { currentCongress, int, packageUrls, paginate, sortByKey, str } from './helpers.js'
import { parseElement } from './xml.js'

const HOUR_MS = 3600 * 1000

// ---- laws ----------------------------------------------------------------------------------------------------------------

/** An enacted-law record from a USLM `<meta>` element (`_plaw_record`). */
function plawRecord(meta: { children: { tag: string; text: string | null }[] }, pkg: string): Rec {
  const fields: Record<string, string> = {}
  const citations: string[] = []
  for (const child of meta.children) {
    const text = (child.text ?? '').trim()
    if (child.tag === 'citableAs') citations.push(text)
    else if (!(child.tag in fields)) fields[child.tag] = text
  }
  const congress = Number(fields.congress || 0)
  const number = Number(fields.docNumber || 0)
  const fullTitle = fields.title ?? ''
  const title = fullTitle.includes(': ') ? fullTitle.slice(fullTitle.indexOf(': ') + 2) : fullTitle
  return {
    congress,
    law_number: number,
    law_type: fields.publicPrivate ?? '',
    law_id: `${congress}-${number}`,
    package_id: pkg,
    title,
    citation: citations[0] ?? fields.type ?? '',
    statute_citation: citations.length > 1 ? citations[1] : '',
    enacted_date: fields.approvedDate || fields.date || null,
    ...packageUrls(pkg),
  }
}

/** Every law of a Congress and type, from the PLAW bulk archive (`load_plaw`). */
function loadPlaw(ctx: NativeCtx, congress: number, lawType: string): Promise<Rec[]> {
  const lt = lawType.toLowerCase()
  return ctx.cache(`congress_gov:plaw:${congress}-${lt}`, HOUR_MS, async () => {
    const zip = openZip(await downloadBulk(ctx, bulkZipUrl('PLAW', congress, lt)))
    const records: Rec[] = []
    for (const entry of zip.entries) {
      if (!entry.name.toLowerCase().endsWith('.xml')) continue
      const pkg = entry.name.slice(entry.name.lastIndexOf('/') + 1, -4)
      const meta = parseElement(zip.readText(entry)).descendant('meta')
      if (meta) records.push(plawRecord(meta, pkg))
    }
    return records
  })
}

async function laws(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const congress = int(params.congress) ?? currentCongress(ctx)
  const records = await loadPlaw(ctx, congress, str(params.law_type) ?? 'public')
  const sorted = [...records].sort((a, b) => ((a.law_number as number) - (b.law_number as number)) * ((str(params.sort_by) ?? 'desc') === 'desc' ? -1 : 1))
  return paginate(sorted, int(params.limit), int(params.offset)).map((r) => ({ ...r }))
}

// ---- calendars -------------------------------------------------------------------------------------------------------------

const CCAL_CHAMBER_CODE: Record<string, string> = { house: 'h', senate: 's' }

/** The two calendar years a Congress spans (`_congress_years`). */
const congressYears = (congress: number): number[] => {
  const start = 1789 + 2 * (congress - 1)
  return [start, start + 1]
}

const titleCase = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()

/** The calendar editions of a Congress and chamber, from GovInfo's CCAL sitemaps (`load_calendars`). */
function loadCalendars(ctx: NativeCtx, congress: number, chamber: string): Promise<Rec[]> {
  const code = CCAL_CHAMBER_CODE[chamber]!
  return ctx.cache(`congress_gov:ccal:${congress}-${chamber}`, HOUR_MS, async () => {
    const records: Rec[] = []
    const seen = new Set<string>()
    for (const year of congressYears(congress)) {
      const url = `${GOVINFO}/sitemap/CCAL_${year}_sitemap.xml`
      let text: string
      try {
        const res = await ctx.http.response(url)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        text = new TextDecoder('utf-8').decode(await res.arrayBuffer())
      } catch (err) {
        throw new Error(`Failed to download data from ${url} -> ${err instanceof Error ? err.message : String(err)}`, { cause: err })
      }
      for (const m of text.matchAll(/CCAL-(\d+)([hs])cal-(\d{4}-\d{2}-\d{2})/g)) {
        if (Number(m[1]) !== congress || m[2] !== code || seen.has(m[0])) continue
        seen.add(m[0])
        records.push({ package_id: m[0], congress, chamber, calendar_date: m[3], title: `${titleCase(chamber)} Calendar - ${m[3]}`, ...packageUrls(m[0]) })
      }
    }
    return records
  })
}

async function calendars(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const congress = int(params.congress) ?? currentCongress(ctx)
  const chamber = str(params.chamber) ?? 'house'
  const chambers = chamber === 'both' ? ['house', 'senate'] : [chamber]
  const loaded = await Promise.all(chambers.map((c) => loadCalendars(ctx, congress, c)))
  const records = loaded.flat()

  const sorted = sortByKey(records, (r) => r.calendar_date as string, (str(params.sort_by) ?? 'desc') === 'desc')
  const publishdate = str(params.calendar_date)
  if (publishdate === 'mostrecent') return sorted.slice(0, 1).map((r) => ({ ...r }))
  if (publishdate) return sorted.filter((r) => r.calendar_date === publishdate).map((r) => ({ ...r }))
  return paginate(sorted, int(params.limit), int(params.offset)).map((r) => ({ ...r }))
}

// ---- mandated reports --------------------------------------------------------------------------------------------------------

const MAX_PAGESIZE = 1000

async function mandatedReports(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const congress = int(params.congress) ?? currentCongress(ctx)
  const limit = int(params.limit)
  const pagesize = Math.min(limit || 100, MAX_PAGESIZE)
  const offset = int(params.offset) ?? 0
  const url = `${GOVINFO}/link/cmr/tableOfReports?congress=${congress}&link-type=json&pagesize=${pagesize}&offset=${offset}`
  const response = await ctx.http.json<unknown>(url)
  const resultSet = response !== null && typeof response === 'object' && !Array.isArray(response) ? (((response as Rec).resultSet ?? []) as Rec[]) : []
  const records = resultSet.map((item) => {
    const pkg = (item.packageId as string | undefined) ?? ''
    return {
      package_id: pkg,
      title: item.title ?? '',
      submitting_agency: item.submittingAgency ?? '',
      publication_date: item.publicationDate || null,
      date_submitted_to_congress: item.dateSubmittedToCongress || null,
      date_required: item.dateRequiredToBeSubmittedToGPO || null,
      is_on_time: item.isOnTime === 'true',
      pdf: item.pdfLink || (pkg ? packageUrls(pkg).pdf : ''),
      details_link: item.detailsLink ?? '',
      mods_link: item.modsLink ?? '',
    }
  })
  return sortByKey(records, (r) => (r.publication_date as string | null) || '', true)
}

export const documentRoutes: Record<string, NativeHandler> = {
  'uscongress/laws': laws,
  'uscongress/calendars': calendars,
  'uscongress/mandated_reports': mandatedReports,
}
