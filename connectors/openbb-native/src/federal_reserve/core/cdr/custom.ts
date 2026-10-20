// ffiec/custom_peer_group, provider federal_reserve. Ported from openbb_federal_reserve/models/custom_peer_group.py and
// utils/custom_peer_group.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models, a
// cookie-keeping session over ctx.http instead of a curl_cffi session, ctx.cache instead of the on-disk cache.
import type { NativeCtx, NativeHandler, Row } from '../../../types.js'
import { DAY_MS, EmptyDataError, bool, str, unescapeHtml } from '../helpers.js'
import { cleanName, conceptIndex, indentedName } from './concepts.js'
import { fetchGuideConcepts, type Guide } from './guide.js'
import { CdrSession, reportCycles, type Cycle } from './net.js'
import { bankRssd } from './ubpr.js'
import { UBPR_PAGE_DESCRIPTIONS } from './ubpr-pages.js'
import { UBPR_SECTIONS } from './ubpr-sections.js'

const REPORT_URL = 'https://cdr.ffiec.gov/Public/Reports/UbprReport.aspx'
const MANAGE_URL = 'https://cdr.ffiec.gov/public/ManageFacsimiles.aspx'
const REPORT_TYPE_ID = 288
const VALUE_COL = /^\d{4}-\d{2}-\d{2}(?: .+)?$/
const RENDER_CAP = 5
const NAME_ACRONYMS = new Set(['NA', 'FSB', 'USA', 'US', 'FA', 'SSB'])
const NAME_SMALL_WORDS = new Set(['of', 'and', 'the', 'for'])
const NAME_FIXUPS: Record<string, string> = { Jpmorgan: 'JPMorgan' }

function field(name: string, html: string): string {
  return new RegExp(`id="${name}"[^>]*value="([^"]*)"`).exec(html)?.[1] ?? ''
}

/** `_bank_name`: an all-caps FFIEC institution name as readable text. */
function bankName(raw: string): string {
  const text = raw.split(/\s+/).filter(Boolean).join(' ')
  let seenFirst = false
  return text.replace(/[A-Za-z]+/g, (word) => {
    const isFirst = !seenFirst
    seenFirst = true
    if (NAME_ACRONYMS.has(word.toUpperCase())) return word.toUpperCase()
    if (!isFirst && NAME_SMALL_WORDS.has(word.toLowerCase())) return word.toLowerCase()
    const capitalized = word.slice(0, 1).toUpperCase() + word.slice(1).toLowerCase()
    return NAME_FIXUPS[capitalized] ?? capitalized
  })
}

function extractBankName(html: string, rssd: string): string {
  const start = html.indexOf('id="headerTable"')
  if (start >= 0) {
    const m = /<td[^>]*colspan="2"[^>]*>([^<]*;[^<]*)<\/td>/.exec(html.slice(start))
    if (m) {
      const name = unescapeHtml(m[1]!).split(';')[0]!.trim()
      if (name) return bankName(name)
    }
  }
  return rssd
}

const graphKey = (date: string): string => {
  const [m, d, y] = date.split('/')
  return `${Number(m)}/${Number(d)}/${y}`
}
const isoOfDate = (date: string): string => `${date.slice(6)}-${date.slice(0, 2)}-${date.slice(3, 5)}`

/** `_caption`: leading spaces guarded with a `>` and NBSP fill. */
function caption(raw: string): string {
  const body = raw.replace(/^ +/, '')
  const indent = raw.length - body.length
  return indent ? `>${'\u00a0'.repeat(indent)}${body}` : body
}

const label = (cell: string): string => caption(unescapeHtml(cell.replace(/<[^>]+>/g, '')).replace(/\u00a0/g, ' ').replace(/\s+$/, ''))

async function renderSection(session: CdrSession, rssd: string, cycleIds: string, sectionIndex: number): Promise<string> {
  const url = `${REPORT_URL}?rptid=${REPORT_TYPE_ID}&idrssd=${rssd}&rptCycleIds=${cycleIds}&title=Custom Peer Group&usetrimmed=0`
  const page = await session.text(url, { timeoutMs: 120_000 })
  const target = `rptTOC$rptTOC$ctl${String(sectionIndex + 2).padStart(2, '0')}$lbItem`
  const form = { __EVENTTARGET: target, __EVENTARGUMENT: '', __VIEWSTATE: field('__VIEWSTATE', page), __VIEWSTATEGENERATOR: field('__VIEWSTATEGENERATOR', page), __EVENTVALIDATION: field('__EVENTVALIDATION', page) }
  return session.text(url, { method: 'POST', form, timeoutMs: 120_000 })
}

type Parsed = Row & { concept?: string | undefined }

function parseGrid(html: string, periodKeys: string[], iso: Map<string, string>, name: string): Parsed[] {
  const start = html.indexOf('id="tableReportData"')
  if (start < 0) return []
  const rows: Parsed[] = []
  for (const block of html.slice(start).split('<tr')) {
    const labelMatch = /class="UbprReportDataRow[^"]*"[^>]*>(.*?)<\/td>/s.exec(block)
    const cell = labelMatch ? labelMatch[1]! : ''
    const text = labelMatch ? label(cell) : ''
    const graph = /data-graph_set="([^"]*)"/.exec(block)
    if (!graph) {
      if (text) rows.push({ label: caption(text), is_header: true })
      continue
    }
    const series = JSON.parse(unescapeHtml(graph[1]!)) as { category: string; name: string; value: unknown }[]
    const byPeriod = new Map<string, Map<string, unknown>>()
    for (const item of series) {
      const m = byPeriod.get(item.category) ?? new Map<string, unknown>()
      m.set(item.name, item.value)
      byPeriod.set(item.category, m)
    }
    const record: Parsed = { label: caption(text), is_header: false, concept: /[?&]Concept=([A-Za-z0-9]+)/.exec(cell)?.[1] }
    let hasValue = false
    for (const key of periodKeys) {
      const raw = byPeriod.get(key)?.get('BANK')
      const n = raw === undefined || raw === null ? undefined : Number(String(raw).trim())
      const number = n === undefined || String(raw).trim() === '' || !Number.isFinite(n) ? undefined : n
      record[`${iso.get(key)} ${name}`] = number ?? null
      hasValue = hasValue || number !== undefined
    }
    record.is_header = !hasValue
    rows.push(record)
  }
  return rows
}

function mergeBatches(batches: Parsed[][]): Parsed[] {
  if (batches.length === 0) return []
  const base: Parsed[] = batches[0]!.map((r) => ({ ...r }))
  for (const batch of batches.slice(1)) {
    batch.forEach((row, index) => {
      if (index >= base.length) {
        base.push({ ...row })
        return
      }
      for (const [k, v] of Object.entries(row)) if (/^\d{4}-\d{2}-\d{2}/.test(k)) base[index]![k] = v
    })
  }
  for (const row of base) if ('concept' in row) row.is_header = !Object.entries(row).some(([k, v]) => /^\d{4}-\d{2}-\d{2}/.test(k) && v !== null && v !== undefined)
  return base
}

async function enrich(ctx: NativeCtx, rows: Parsed[]): Promise<Row[]> {
  const index = await conceptIndex(ctx, 'ubpr_ratio_single')
  const guide = await fetchGuideConcepts(ctx, [...new Set(rows.filter((r) => !r.is_header && r.concept).map((r) => r.concept!))])
  const out: Row[] = []
  for (const row of rows) {
    const { concept, ...rest } = row
    if (rest.is_header) {
      out.push(rest)
      continue
    }
    const code = concept ?? ''
    const meta = index.get(code)
    const g: Partial<Guide> = guide.get(code) ?? {}
    rest.label = indentedName(String(rest.label), cleanName(g.description) ?? meta?.name)
    const narrative = g.narrative || meta?.narrative
    if (narrative) rest.narrative = narrative
    if (meta?.monetary) for (const k of Object.keys(rest)) if (VALUE_COL.test(k) && typeof rest[k] === 'number') rest[k] = (rest[k] as number) * 1000
    out.push(rest)
  }
  return out
}

export const customPeerGroup: NativeHandler = async (params, ctx) => {
  const rssd = await bankRssd(ctx, params)
  const peers = str(params, 'peers')
  if (!peers) throw new Error('Provide `peers` as a comma-separated list of RSSD ids.')
  const section = str(params, 'section') ?? 'Summary Ratios'
  const allPeriods = bool(params, 'all_periods', false)

  const sectionIndex = UBPR_SECTIONS.findIndex((n) => n.toLowerCase() === (section || UBPR_SECTIONS[0]!).trim().toLowerCase())
  if (sectionIndex < 0) throw new Error(`Unknown report section '${section}'.`)
  const allCycles = await reportCycles(ctx)
  const cycles = allPeriods ? allCycles : allCycles.slice(0, 5)
  const cycleIds = cycles.map((c) => c.reportingcycleid).join(',')
  const periodKeys = cycles.map((c) => graphKey(c.enddateformatted))
  const iso = new Map(cycles.map((c) => [graphKey(c.enddateformatted), isoOfDate(c.enddateformatted)]))
  const cleaned = peers.split(',').map((p) => p.trim()).filter(Boolean).join(',')

  const rows = await ctx.cache(`fed:cdr:cpg_lines:${rssd}:${cleaned}:${sectionIndex}:${cycleIds}:${allPeriods}`, DAY_MS, async () => {
    const session = new CdrSession(ctx)
    await session.text(MANAGE_URL, { timeoutMs: 60_000 })
    await session.router('CpgSearchBanks', { ReportingCycleID: cycles[0]!.reportingcycleid, FIList: cleaned })
    await session.router('SetSessionData', { SessionData: cleaned, SourceObject: '__UbprReportCustomIDRSSDs' })
    if (!allPeriods) {
      const html = await renderSection(session, rssd, cycleIds, sectionIndex)
      return enrich(ctx, parseGrid(html, periodKeys, iso, extractBankName(html, rssd)))
    }
    const batches: Parsed[][] = []
    let name = rssd
    for (let start = 0; start < cycles.length; start += RENDER_CAP) {
      const chunk: Cycle[] = cycles.slice(start, start + RENDER_CAP)
      const html = await renderSection(session, rssd, chunk.map((c) => c.reportingcycleid).join(','), sectionIndex)
      if (start === 0) name = extractBankName(html, rssd)
      batches.push(parseGrid(html, chunk.map((c) => graphKey(c.enddateformatted)), iso, name))
    }
    return enrich(ctx, mergeBatches(batches))
  })

  const sectionName = UBPR_SECTIONS[sectionIndex]!
  const out = rows.map((r) => ({ ...r }))
  if (out.length && out[0]!.is_header && !Object.entries(out[0]!).some(([k, v]) => VALUE_COL.test(k) && v !== null && v !== undefined)) {
    const description = UBPR_PAGE_DESCRIPTIONS[sectionName]
    if (description) out[0]!.narrative = description
  }
  if (out.length === 0) throw new EmptyDataError()
  const structural = new Set(['label', 'is_header', 'narrative'])
  if (!out.some((row) => Object.entries(row).some(([k, v]) => !structural.has(k) && v !== undefined && v !== null))) {
    throw new Error(`No UBPR data for RSSD ${rssd}. UBPR covers institutions that file the FFIEC Call Report (commercial banks and savings institutions); bank holding companies and non-bank entities have none. Supply a subsidiary bank's RSSD, or use FR Y-9C (financial_statements) for a holding company.`)
  }
  return out
}
