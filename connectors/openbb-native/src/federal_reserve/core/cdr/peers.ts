// ffiec/peer_group_average, peer_group_distribution, state_average and peer_group_bank, provider federal_reserve.
// Ported from openbb_federal_reserve/models/{peer_group_average,peer_group_distribution,state_average,peer_group_bank}.py
// and utils/{peer_groups,peer_group_report,peer_group_distribution,state_average_report}.py (OpenBB Platform 5.0.0,
// Apache-2.0); modified: plain rows instead of pydantic models, a cookie-keeping session over ctx.http instead of a
// curl_cffi session, ctx.cache instead of the on-disk cache.
import type { NativeCtx, NativeHandler, Row } from '../../../types.js'
import { DAY_MS, EmptyDataError, bool, str, unescapeHtml } from '../helpers.js'
import { cleanName, conceptIndex, indentedName } from './concepts.js'
import { fetchGuideConcepts, PERIOD, type Guide } from './guide.js'
import { CdrSession, post, reportCycles, sectionId, type Cycle } from './net.js'
import { STATIC_PEER_GROUPS } from './peer-groups.js'
import { bankRssd, caption as ubprCaption, conceptCode, pyFloat } from './ubpr.js'
import { UBPR_PAGE_DESCRIPTIONS } from './ubpr-pages.js'

const REPORT_URL = 'https://cdr.ffiec.gov/Public/Reports/UbprReport.aspx'
const REFERER = { Referer: 'https://cdr.ffiec.gov/Public/Reports/UbprReport.html' }
const NBSP = '\u00a0'

type Line = Record<string, unknown>
const asLines = (v: unknown): Line[] => (Array.isArray(v) ? (v as Line[]) : [])

function field(text: string, name: string, byName = false): string {
  const re = byName ? new RegExp(`name="${name}"[^>]*value="([^"]*)"`) : new RegExp(`id="${name}"[^>]*value="([^"]*)"`)
  return re.exec(text)?.[1] ?? ''
}

// ---------------------------------------------------------------------------------------------------------------
// Peer-group registry

/** `resolve_peer_group_id`: a peer-group name as the `peergroupid` of the report URLs. */
export async function resolvePeerGroupId(ctx: NativeCtx, name: string, cycleId?: string): Promise<number> {
  const key = (name ?? '').trim().toUpperCase()
  let live: Map<string, number> | undefined
  if (cycleId !== undefined) {
    live = await ctx.cache(`fed:cdr:peer_groups:${cycleId}`, DAY_MS, async () => {
      const raw = asLines(await post(ctx, 'PGSelector', { ReportingCycleID: String(cycleId), MinMembersReqd: '0' }))
      const out = new Map<string, number>()
      for (const row of raw) {
        const n = String(row.peergroupname ?? '').trim()
        const pid = row.peergroupid
        if (n && pid !== undefined && pid !== null && pid !== '') out.set(n, Math.trunc(Number(pid)))
      }
      return out
    })
    // A live registry that comes back empty falls back to the snapshot as a whole.
    if (live.size === 0) live = undefined
  }
  const id = live?.get(key) ?? STATIC_PEER_GROUPS[key]?.[0]
  if (id === undefined) throw new Error(`Unknown peer group '${name}'. Provide a peer-group name (e.g. '1', 'NATIONAL', 'ALCOM').`)
  return id
}

const numberOf = (v: unknown): number | undefined => {
  if (v === null || v === undefined) return undefined
  if (typeof v === 'number') return Number.isNaN(v) ? undefined : v
  const n = pyFloat(String(v))
  return n === undefined || Number.isNaN(n) ? undefined : n
}

const stripTags = (s: string): string => s.replace(/<[^>]+>/g, '')

/** `_caption` of the peer-group reports: leading spaces and NBSPs guarded with a `>`. */
function nbspCaption(raw: string): string {
  const body = raw.replace(/^[ \u00a0]+/, '')
  const indent = raw.length - body.length
  return indent ? `>${NBSP.repeat(indent)}${body}` : body
}

const dateKey = (d: string): number => {
  const [m, day, y] = d.split('/')
  return Number(y) * 10000 + Number(m) * 100 + Number(day)
}
const isoDate = (d: string): string => {
  const [m, day, y] = d.split('/')
  return `${y}-${m!.padStart(2, '0')}-${day!.padStart(2, '0')}`
}

function rectangular(rows: Row[], keys: string[]): Row[] {
  return rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k, v]) => !(keys.includes(k) && v === undefined))))
}

// ---------------------------------------------------------------------------------------------------------------
// Peer group average report (report type 284)

const PGA_REPORT_TYPE_ID = 284
const TOC_RE = /__doPostBack\(&#39;(rptTOC\$rptTOC\$ctl\d+\$lbItem)&#39;,&#39;&#39;\)">([^<]+)<\/a>/g

function toc(page: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of page.matchAll(TOC_RE)) out.set(unescapeHtml(m[2]!).trim(), m[1]!)
  return out
}

type Parsed = [string, string | undefined, Map<string, number | undefined>]

function parseRows(page: string): Parsed[] {
  const rows: Parsed[] = []
  for (const m of page.matchAll(/<tr>(.*?)<\/tr>/gs)) {
    const row = m[1]!
    const labelMatch = /<td class="UbprReportDataRow"[^>]*>(.*?)<\/td>/s.exec(row)
    if (!labelMatch) continue
    const label = unescapeHtml(stripTags(labelMatch[1]!))
    const descriptor = /data-graph_descriptor="([^"]*)"/.exec(row)
    const codeMatch = descriptor ? /"conceptname":"([^"]*)"/.exec(unescapeHtml(descriptor[1]!)) : null
    const graph = /data-graph_set="([^"]*)"/.exec(row)
    const series = new Map<string, number | undefined>()
    if (graph?.[1]) for (const point of JSON.parse(unescapeHtml(graph[1])) as { category: string; value?: unknown }[]) series.set(point.category, numberOf(point.value))
    rows.push([label, codeMatch?.[1], series])
  }
  return rows
}

async function fetchSectionBatch(ctx: NativeCtx, peergroupid: number, section: string, cycleIds: string): Promise<{ parsed: Parsed[]; title: string }> {
  return ctx.cache(`fed:cdr:pga_lines:${peergroupid}:${section.toLowerCase()}:${cycleIds}`, DAY_MS, async () => {
    const session = new CdrSession(ctx)
    const url = `${REPORT_URL}?rptCycleIds=${cycleIds}&rptid=${PGA_REPORT_TYPE_ID}&peergroupid=${peergroupid}&isTest=False`
    const shell = await session.text(url, { headers: REFERER, timeoutMs: 90_000 })
    const titles = toc(shell)
    const target = [...titles].find(([title]) => title.toLowerCase() === section.trim().toLowerCase())?.[1]
    if (!target) throw new Error(`Unknown report section '${section}'. Available: ${[...titles.keys()].filter((t) => t.toLowerCase() !== 'cover page').join(', ')}.`)
    const form = { __EVENTTARGET: target, __EVENTARGUMENT: '', __LASTFOCUS: '', __VIEWSTATE: field(shell, '__VIEWSTATE', true), __VIEWSTATEGENERATOR: field(shell, '__VIEWSTATEGENERATOR', true) }
    const page = await session.text(url, { method: 'POST', form, headers: REFERER, timeoutMs: 120_000 })
    const descriptor = /data-report_descriptor="([^"]+)"/.exec(page)
    const parsedDescriptor = descriptor ? (JSON.parse(unescapeHtml(descriptor[1]!)) as { PageNumber?: string }) : {}
    return { title: parsedDescriptor.PageNumber || section, parsed: parseRows(page) }
  })
}

export const peerGroupAverage: NativeHandler = async (params, ctx) => {
  const peerGroup = str(params, 'peer_group') ?? '1'
  const section = str(params, 'section') ?? 'Summary Ratios'
  const allPeriods = bool(params, 'all_periods', false)
  const allCycles = await reportCycles(ctx)
  const peergroupid = await resolvePeerGroupId(ctx, peerGroup, allCycles[0]?.reportingcycleid)

  const cycles = allPeriods ? allCycles : allCycles.slice(0, 5)
  const ids = cycles.map((c) => c.reportingcycleid)
  const batchIds: string[] = []
  for (let i = 0; i < ids.length; i += 5) batchIds.push(ids.slice(i, i + 5).join(','))
  const batches = await Promise.all(batchIds.map((b) => fetchSectionBatch(ctx, peergroupid, section, b)))

  // _merge_batches: one line list, the series of repeated (label, code) lines combined.
  const order: string[] = []
  const merged = new Map<string, { label: string; code: string | undefined; series: Map<string, number | undefined> }>()
  for (const batch of batches) {
    for (const [label, code, series] of batch.parsed) {
      const key = JSON.stringify([label, code ?? null])
      let entry = merged.get(key)
      if (!entry) {
        entry = { label, code, series: new Map() }
        merged.set(key, entry)
        order.push(key)
      }
      for (const [k, v] of series) entry.series.set(k, v)
    }
  }
  const parsed = order.map((k) => merged.get(k)!)
  const seen = new Set<string>()
  let periodCols: string[] = []
  for (const { series } of parsed) for (const col of [...series.keys()].sort((a, b) => dateKey(b) - dateKey(a))) {
      if (seen.has(col)) continue
      seen.add(col)
      periodCols.push(col)
    }
  periodCols = periodCols.sort((a, b) => dateKey(b) - dateKey(a))
  if (!allPeriods) periodCols = periodCols.slice(0, 5)
  const iso = new Map(periodCols.map((c) => [c, isoDate(c)]))

  const index = await conceptIndex(ctx, 'ubpr_ratio_single')
  const guide = await fetchGuideConcepts(ctx, [...new Set(parsed.map((p) => p.code).filter((c): c is string => Boolean(c)))])
  const rows: Row[] = []
  for (const { label, code, series } of parsed) {
    if (!label.trim()) continue
    const isHeader = series.size === 0 || periodCols.every((c) => series.get(c) === undefined)
    const cap = nbspCaption(label)
    if (isHeader) {
      rows.push({ label: cap, is_header: true })
      continue
    }
    const meta = index.get(code ?? '')
    const g: Partial<Guide> = guide.get(code ?? '') ?? {}
    const record: Row = { label: indentedName(cap, cleanName(g.description) ?? meta?.name), is_header: false }
    const narrative = g.narrative || meta?.narrative
    if (narrative) record.narrative = narrative
    for (const c of periodCols) {
      const v = series.get(c)
      record[iso.get(c)!] = v === undefined ? null : v * (meta?.monetary ? 1000 : 1)
    }
    rows.push(record)
  }
  for (const row of rows) {
    if (row.is_header && periodCols.every((c) => row[iso.get(c)!] === undefined || row[iso.get(c)!] === null)) {
      const description = UBPR_PAGE_DESCRIPTIONS[section]
      if (description) row.narrative = description
      break
    }
  }
  if (rows.length === 0) throw new EmptyDataError()
  return rows
}

// ---------------------------------------------------------------------------------------------------------------
// Peer group distribution report (report type 285)

const DIST_RPTID = 285
const PERCENTILE_COLUMNS = ['1ST', '5TH', '10TH', '20TH', '25TH', '50TH', '75TH', '80TH', '90TH', '95TH', '99TH', 'TRIMMED AVERAGE']
const PEER_GROUP_COLUMN = 'PEER GROUP'
const MEMO_CONCEPTS: Record<string, string> = { 'Average Total Assets': 'UBPRD659', 'Net Income': 'UBPR4340' }
const MAP_RSSD = '112837'

/** `_text` of the distribution grid: tags stripped, a few entities decoded, newlines as spaces, ends trimmed of spaces and tabs. */
function gridText(cell: string): string {
  const body = stripTags(cell).replace(/&nbsp;/g, NBSP).replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
  return body.replace(/\r/g, ' ').replace(/\n/g, ' ').replace(/^[ \t]+|[ \t]+$/g, '')
}

const trimBlank = (s: string): string => s.replace(/^[\u00a0 ]+|[\u00a0 ]+$/g, '')

function gridNumber(text: string): number | undefined {
  const n = pyFloat(trimBlank(text.replace(/,/g, '')))
  return n === undefined || Number.isNaN(n) ? undefined : n
}

function distributionGrid(html: string): Row[] {
  const m = /<table[^>]*id="tableReportData"[^>]*>(.*?)<\/table>/s.exec(html)
  if (!m) return []
  const rows = [...m[1]!.matchAll(/<tr\b[^>]*>(.*?)<\/tr>/gs)].map((r) => [...r[1]!.matchAll(/<t[dh]\b[^>]*>(.*?)<\/t[dh]>/gs)].map((c) => gridText(c[1]!))).filter((r) => r.length > 0)
  if (rows.length === 0) return []
  const header = rows[0]!
  const columns = new Map<string, number>()
  header.forEach((name, i) => {
    if (PERCENTILE_COLUMNS.includes(name)) columns.set(name, i)
  })
  const records: Row[] = []
  for (const cells of rows.slice(1)) {
    const label = cells[0] ?? ''
    if (!trimBlank(label)) continue
    const values = new Map<string, number | undefined>()
    for (const [name, i] of columns) if (i < cells.length) values.set(name, gridNumber(cells[i]!))
    const isHeader = [...values.values()].every((v) => v === undefined)
    const populated = [...values].filter(([, v]) => v !== undefined).map(([n]) => n)
    const record: Row = { label: nbspCaption(label), is_header: isHeader }
    if (populated.length === 1 && populated[0] === '1ST') record[PEER_GROUP_COLUMN] = values.get('1ST')
    else if (!isHeader) for (const [n, v] of values) record[n] = v ?? null
    records.push(record)
  }
  return records
}

export const peerGroupDistribution: NativeHandler = async (params, ctx) => {
  const peerGroup = str(params, 'peer_group') ?? '1'
  const section = str(params, 'section') ?? 'Summary Ratios'
  const period = str(params, 'period')
  const key = peerGroup.trim().toUpperCase()
  if (!(key in STATIC_PEER_GROUPS)) throw new Error(`Unknown peer group '${peerGroup}'.`)
  const cycles = await reportCycles(ctx)
  if (cycles.length === 0) throw new Error('The reporting-cycle list could not be retrieved.')
  let cycleId: string | undefined
  if (period) {
    const [y, mo, d] = period.split('-')
    cycleId = cycles.find((c) => c.enddateformatted === `${mo}/${d}/${y}`)?.reportingcycleid
  }
  const target: Cycle = cycles.find((c) => c.reportingcycleid === String(cycleId)) ?? cycles[0]!
  const peergroupid = await resolvePeerGroupId(ctx, key, target.reportingcycleid)
  const ordered = [target, ...cycles.filter((c) => c !== target).slice(0, 4)]
  const cycleIds = ordered.map((c) => c.reportingcycleid).join(',')

  const result = await ctx.cache(`fed:cdr:pg_distribution:${peergroupid}:${section}:${cycleIds}`, DAY_MS, async () => {
    const session = new CdrSession(ctx)
    const url = `${REPORT_URL}?rptCycleIds=${cycleIds}&rptid=${DIST_RPTID}&peergroupid=${peergroupid}&isTest=False`
    const shell = await session.text(url, { headers: REFERER, timeoutMs: 90_000 })
    const entries = [...shell.matchAll(/__doPostBack\(&#39;(rptTOC\$rptTOC\$ctl\d+\$lbItem)&#39;[^>]*>([^<]*)<\/a>/g)].map((m) => [m[1]!, gridText(m[2]!)] as const)
    const wanted = section.trim().toLowerCase()
    const hit = entries.find(([, title]) => title.toLowerCase() === wanted)
    if (!hit) throw new Error(`Unknown report section '${section}'.`)
    const form = { __EVENTTARGET: hit[0], __EVENTARGUMENT: '', __LASTFOCUS: '', __VIEWSTATE: field(shell, '__VIEWSTATE'), __VIEWSTATEGENERATOR: field(shell, '__VIEWSTATEGENERATOR'), __EVENTVALIDATION: field(shell, '__EVENTVALIDATION') }
    const rendered = await session.text(url, { method: 'POST', form, headers: REFERER, timeoutMs: 120_000 })
    const title = hit[1]

    // _concept_map: the section's line captions keyed to their concept codes, from a reference bank's report.
    const [pageId] = await sectionId(ctx, title, 283)
    const codes = new Map<string, string>()
    for (const line of asLines(await post(ctx, 'MyUbprLinesData', { ID_RSSD: MAP_RSSD, ScheduleID: pageId, ReportingCycleIdList: cycleIds, PeerDefinition: '' }))) {
      const cap = String(line.linecaption ?? '')
      if (cap.startsWith('#')) continue
      let code: string | undefined
      for (const k of Object.keys(line).filter((x) => PERIOD.test(x))) {
        code = conceptCode(line[k])
        if (code) break
      }
      const text = cap.trim()
      if (code && !codes.has(text)) codes.set(text, code)
    }

    const index = await conceptIndex(ctx, 'ubpr_ratio_single')
    const rows = distributionGrid(rendered)
    const rowConcept = (row: Row): string => {
      const text = String(row.label).replace(/^>?[\s\u00a0]*/, '')
      if (PEER_GROUP_COLUMN in row && text in MEMO_CONCEPTS) return MEMO_CONCEPTS[text]!
      return codes.get(text) ?? ''
    }
    const concepts = [...new Set(rows.filter((r) => !r.is_header).map(rowConcept).filter(Boolean))].sort()
    const guide = await fetchGuideConcepts(ctx, concepts)
    for (const row of rows) {
      if (row.is_header) continue
      const code = rowConcept(row)
      const meta = index.get(code)
      const g: Partial<Guide> = guide.get(code) ?? {}
      row.label = indentedName(String(row.label), cleanName(g.description) ?? meta?.name)
      const narrative = g.narrative || meta?.narrative
      if (narrative) row.narrative = narrative
      if (meta?.monetary) for (const c of [...PERCENTILE_COLUMNS, PEER_GROUP_COLUMN]) if (typeof row[c] === 'number') row[c] = (row[c] as number) * 1000
    }
    const head = rows[0]
    if (head?.is_header && ![...PERCENTILE_COLUMNS, PEER_GROUP_COLUMN].some((c) => head[c] !== undefined && head[c] !== null)) {
      const description = UBPR_PAGE_DESCRIPTIONS[title]
      if (description) head.narrative = description
    }
    return rows
  })
  if (result.length === 0) throw new EmptyDataError()
  return result.map((r) => ({ ...r }))
}

// ---------------------------------------------------------------------------------------------------------------
// State average report (report type 286)

const STATE_RPTID = 286
const STATES: Record<string, [number, string]> = {
  AL: [236, 'Alabama'], AK: [237, 'Alaska'], AS: [238, 'American Samoa'], AZ: [239, 'Arizona'], AR: [240, 'Arkansas'], CA: [241, 'California'], CO: [242, 'Colorado'], CT: [243, 'Connecticut'], DE: [244, 'Delaware'], DC: [245, 'District of Columbia'],
  FL: [246, 'Florida'], GA: [247, 'Georgia'], GU: [248, 'Guam'], HI: [249, 'Hawaii'], ID: [250, 'Idaho'], IL: [251, 'Illinois'], IN: [252, 'Indiana'], IA: [253, 'Iowa'], KS: [254, 'Kansas'], KY: [255, 'Kentucky'], LA: [256, 'Louisiana'], ME: [257, 'Maine'],
  MD: [258, 'Maryland'], MA: [259, 'Massachusetts'], MI: [260, 'Michigan'], FM: [261, 'Micronesia'], MN: [262, 'Minnesota'], MS: [263, 'Mississippi'], MO: [264, 'Missouri'], MT: [265, 'Montana'], NE: [266, 'Nebraska'], NV: [267, 'Nevada'],
  NH: [268, 'New Hampshire'], NJ: [269, 'New Jersey'], NM: [270, 'New Mexico'], NY: [271, 'New York'], NC: [272, 'North Carolina'], ND: [273, 'North Dakota'], OH: [274, 'Ohio'], OK: [275, 'Oklahoma'], OR: [276, 'Oregon'], PA: [277, 'Pennsylvania'],
  PR: [278, 'Puerto Rico'], RI: [279, 'Rhode Island'], SC: [280, 'South Carolina'], SD: [281, 'South Dakota'], TN: [282, 'Tennessee'], TX: [283, 'Texas'], UT: [284, 'Utah'], VT: [285, 'Vermont'], VI: [286, 'Virgin Islands'], VA: [287, 'Virginia'],
  WA: [288, 'Washington'], WV: [289, 'West Virginia'], WI: [290, 'Wisconsin'], WY: [291, 'Wyoming'],
}
const GROUP_SUFFIX: Record<string, string> = { commercial: 'COM', savings: 'SVG' }

/** `_parse_grid` of the State Average report. */
function stateGrid(html: string): { dates: string[]; rows: { label: string; values: string[]; concept: string | undefined }[] } {
  const anchor = html.indexOf('UbprReportDateRow')
  if (anchor < 0) return { dates: [], rows: [] }
  const grid = html.slice(Math.max(0, anchor - 400)).split('<script')[0]!
  let dates: string[] = []
  const rows: { label: string; values: string[]; concept: string | undefined }[] = []
  for (const m of grid.matchAll(/<tr>(.*?)<\/tr>/gs)) {
    const block = m[1]!
    const descriptor = /data-graph_descriptor="([^"]*)"/.exec(block)
    const nameMatch = descriptor ? /&quot;conceptname&quot;:&quot;([^&]*)&quot;/.exec(descriptor[1]!) : null
    const concept = nameMatch ? nameMatch[1]!.trim() || undefined : undefined
    const stripped = block.replace(/\sdata-[\w-]+="[^"]*"/g, '')
    const cells = [...stripped.matchAll(/<td[^>]*>(.*?)<\/td>/gs)].map((c) => unescapeHtml(stripTags(c[1]!)).replace(/\s+/g, ' ').replace(/\s+$/, '')).map((c) => c.replace(/\u00a0/g, ' '))
    const present = cells.filter((c) => c.trim())
    if (present.length === 0) continue
    if (dates.length === 0 && /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(present[0]!)) {
      dates = present.map(isoDate)
      continue
    }
    rows.push({ label: cells[0]!.replace(/\s+$/, ''), values: cells.slice(1).filter((c) => c.trim()), concept })
  }
  return { dates, rows }
}

export const stateAverage: NativeHandler = async (params, ctx) => {
  const state = str(params, 'state') ?? 'SD'
  const groupType = str(params, 'group_type') ?? 'commercial'
  const section = str(params, 'section') ?? 'Summary Ratios'
  const allPeriods = bool(params, 'all_periods', false)

  const sections = await ctx.cache(`fed:cdr:sections:${STATE_RPTID}`, DAY_MS, async () => asLines(await post(ctx, 'UbprReportPagesList', { ReportTypeID: STATE_RPTID })).filter((r) => r.pageid) as unknown as { pageid: string; pagetitle: string }[])
  if (!sections.some((s) => s.pagetitle === section)) throw new Error(`Unknown report section '${section}'.`)
  const code = state.trim().toUpperCase()
  if (!(code in STATES)) throw new Error(`Unknown state '${state}'.`)
  const allCycles = await reportCycles(ctx)
  const pgId = await resolvePeerGroupId(ctx, `${code}${GROUP_SUFFIX[groupType]}`, allCycles[0]?.reportingcycleid)
  const windows: Cycle[][] = []
  if (allPeriods) for (let i = 0; i < allCycles.length; i += 5) windows.push(allCycles.slice(i, i + 5))
  else windows.push(allCycles.slice(0, 5))

  const parsedWindows: ReturnType<typeof stateGrid>[] = []
  for (const window of windows) {
    const cycleIds = window.map((c) => c.reportingcycleid).join(',')
    parsedWindows.push(
      await ctx.cache(`fed:cdr:state_average_lines:${pgId}:${section}:${cycleIds}`, DAY_MS, async () => {
        const session = new CdrSession(ctx)
        const url = `${REPORT_URL}?rptCycleIds=${cycleIds}&rptid=${STATE_RPTID}&peergroupid=${pgId}&isTest=False`
        const page = await session.text(url, { timeoutMs: 90_000 })
        const targets = new Map<string, string>()
        for (const m of page.matchAll(/__doPostBack\(&#39;(rptTOC\$rptTOC\$ctl\d+\$lbItem)&#39;[^>]*>([^<]+)<\/a>/g)) if (!targets.has(m[2]!.trim())) targets.set(m[2]!.trim(), m[1]!)
        const target = targets.get(section)
        ctx.log(`state_average ${url}: shell ${page.length} bytes, sections ${[...targets.keys()].join('|')}`)
        if (!target) return { dates: [], rows: [] }
        const form = { __EVENTTARGET: target, __EVENTARGUMENT: '', __VIEWSTATE: field(page, '__VIEWSTATE'), __VIEWSTATEGENERATOR: field(page, '__VIEWSTATEGENERATOR') }
        const rendered = await session.text(url, { method: 'POST', form, headers: { Accept: '*/*', ...REFERER }, timeoutMs: 120_000 })
        ctx.log(`state_average rendered ${rendered.length} bytes`)
        return stateGrid(rendered)
      }),
    )
  }
  const index = await conceptIndex(ctx, 'ubpr_ratio_single')
  const concepts = new Set<string>()
  for (const p of parsedWindows) for (const line of p.rows) if (line.values.length && line.concept) concepts.add(line.concept)
  const guide = await fetchGuideConcepts(ctx, [...concepts])

  const byLabel = new Map<string, Row>()
  const rows: Row[] = []
  for (const p of parsedWindows) {
    for (const line of p.rows) {
      const isHeader = line.values.length === 0
      const body = line.label.replace(/^ +/, '')
      const indent = line.label.length - body.length
      const cap = indent ? `>${NBSP.repeat(indent)}${body}` : body
      const meta = index.get(line.concept ?? '')
      const g: Partial<Guide> = guide.get(line.concept ?? '') ?? {}
      const label = String(isHeader ? cap : indentedName(cap, cleanName(g.description) ?? meta?.name))
      let record = byLabel.get(label)
      if (!record) {
        record = { label, is_header: isHeader }
        const narrative = isHeader ? undefined : g.narrative || meta?.narrative
        if (narrative) record.narrative = narrative
        byLabel.set(label, record)
        rows.push(record)
      }
      if (!isHeader) {
        const scale = meta?.monetary ? 1000 : 1
        p.dates.forEach((date, position) => {
          const value = position < line.values.length ? gridNumber(line.values[position]!) : undefined
          record![date] = value === undefined ? null : value * scale
        })
      }
    }
  }
  for (const row of rows) {
    if (row.is_header && !Object.entries(row).some(([k, v]) => !['label', 'is_header', 'narrative'].includes(k) && v !== undefined && v !== null)) {
      const description = UBPR_PAGE_DESCRIPTIONS[section]
      if (description) row.narrative = description
      break
    }
  }
  if (rows.length === 0) throw new EmptyDataError()
  return rectangular(rows, [])
}

// ---------------------------------------------------------------------------------------------------------------
// Peer group bank report

const PGB_REPORT_TYPE_ID = 283
const MONETARY_DATATYPES = new Set(['9', '155'])

export const peerGroupBank: NativeHandler = async (params, ctx) => {
  const rssd = await bankRssd(ctx, params)
  const section = str(params, 'section') ?? 'Summary Ratios'
  const [pageId, title] = await sectionId(ctx, section, PGB_REPORT_TYPE_ID)
  const cycles = await reportCycles(ctx)
  if (cycles.length === 0) throw new Error('The reporting-cycle list could not be retrieved.')
  const cycle = cycles[0]!
  const cycleId = cycle.reportingcycleid
  const endDate = cycle.enddateformatted
  const isoDateText = `${endDate.slice(6)}-${endDate.slice(0, 2)}-${endDate.slice(3, 5)}`

  const attributes = asLines(await ctx.cache(`fed:cdr:pgb_attributes:${rssd}:${cycleId}`, DAY_MS, () => post(ctx, 'FiAttributes', { ID_RSSD: String(rssd), ReportingCycleID: cycleId, supplemental: '' })))
  if (attributes.length === 0) throw new Error(`No FFIEC peer group is assigned to RSSD '${rssd}' for the period.`)
  const peerGroupName = String(attributes[0]!.peergroupname || '')
  const roster = await ctx.cache(`fed:cdr:pgb_roster:${peerGroupName}:${cycleId}`, DAY_MS, async () => asLines(await post(ctx, 'LlistOfBanks', { ReportingCycleID: cycleId, PeerGroupName: peerGroupName, MaxRows: 0 })).filter((r) => r.rssd9001).map((r) => ({ rssd: String(r.rssd9001).trim(), name: String(r.rssd9017).trim() })))
  if (roster.length === 0) throw new EmptyDataError()
  const names = new Map(roster.map((b) => [b.rssd, b.name]))
  const fiList = roster.map((b) => b.rssd).join(',')
  const sections = asLines(await post(ctx, 'MBReportPageSections', { ScheduleID: pageId }))
  const sectionIds = sections.filter((r) => String(r.sectionid || '0') !== '0').map((r) => String(r.sectionid))
  const raw = await ctx.cache(`fed:cdr:pgb_lines:${rssd}:${pageId}:${cycleId}:${peerGroupName}`, DAY_MS, async () => {
    const out: Line[] = []
    for (const sectionIdValue of sectionIds) out.push(...asLines(await post(ctx, 'MBReportSectionData', { SectionID: sectionIdValue, FIList: fiList, ListIsCert: false, ReportingPeriodEndDate: isoDateText, ShowConfidential: 0, ID_RSSD: String(rssd) })))
    return out
  })
  if (raw.length === 0) throw new EmptyDataError()

  const bankCols = Object.keys(raw[0]!).filter((k) => k.includes('_') && /^\d\d/.test(k))
  const headers = new Map(bankCols.map((k) => {
    const id = k.slice(k.indexOf('_') + 1)
    return [k, `${names.get(id) ?? 'Bank'} (${id})`] as const
  }))
  const index = await conceptIndex(ctx, 'ubpr_ratio_single')
  const concepts = [...new Set(raw.map((l) => String(l.conceptname || '')).filter(Boolean))].sort()
  const guide = await fetchGuideConcepts(ctx, concepts)
  const rows: Row[] = []
  for (const line of raw) {
    const cap = String(line.linecaption ?? '')
    if (cap === '#BlankLine#') continue
    const hasValue = bankCols.some((k) => line[k] !== '' && line[k] !== null && line[k] !== undefined)
    const isHeader = cap.startsWith('#SectionTitle#') || !hasValue
    const code = String(line.conceptname || '')
    const meta = index.get(code)
    const record: Row = { label: ubprCaption(cap), is_header: isHeader }
    if (!isHeader) {
      const g: Partial<Guide> = guide.get(code) ?? {}
      record.label = indentedName(String(record.label), cleanName(g.description) ?? meta?.name)
      const narrative = g.narrative || meta?.narrative
      if (narrative) record.narrative = narrative
      const scale = MONETARY_DATATYPES.has(String(line.datatypeid || '')) ? 1000 : 1
      for (const k of bankCols) {
        const n = line[k] === null || line[k] === undefined ? undefined : numberOf(line[k])
        record[headers.get(k)!] = n === undefined ? null : n * scale
      }
    }
    rows.push(record)
  }
  if (rows.length && rows[0]!.is_header) {
    const description = UBPR_PAGE_DESCRIPTIONS[title]
    if (description) rows[0]!.narrative = description
  }
  return rows
}
