// ffiec/ubpr, ffiec/executive_summary and ffiec/list_of_banks_peer_group, provider federal_reserve. Ported from
// openbb_federal_reserve/models/{ubpr,executive_summary,list_of_banks_peer_group}.py and
// utils/{ubpr_report,executive_summary_report,ticker}.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows
// instead of pydantic models; a holding-company RSSD or a ticker needs the FFIEC NIC (it answers browsers only), so
// those calls are left to the OpenBB API.
import { unzipSync } from 'fflate'
import { NativeUnsupported, type NativeCtx, type NativeHandler, type NativeParams, type Row } from '../../../types.js'
import { DAY_MS, EmptyDataError, bool, cmp, str } from '../helpers.js'
import { cleanName, conceptIndex, indentedName, type Concept } from './concepts.js'
import { fetchGuideConcepts, PERIOD, type Guide } from './guide.js'
import { UBPR_PAGE_DESCRIPTIONS } from './ubpr-pages.js'
import { fetchBulk, post, reportCycles, sectionId } from './net.js'

type Line = Record<string, unknown>

/** Python's `float(text)`: undefined when the text is not a number. */
export function pyFloat(text: string): number | undefined {
  const t = text.trim()
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return Number(t)
  if (/^[+-]?(inf|infinity)$/i.test(t)) return t.startsWith('-') ? -Infinity : Infinity
  if (/^[+-]?nan$/i.test(t)) return NaN
  return undefined
}

const stripQuotes = (s: string): string => s.trim().replace(/^'+|'+$/g, '')

/** `_cell_parts`: a period cell as its (value, concept code) parts. */
function cellParts(cell: unknown): [number | undefined, string | undefined][] {
  return (cell === null || cell === undefined || cell === '' ? '' : String(cell)).split(', ').map((part) => {
    const fields = part.split(';')
    const value = pyFloat(stripQuotes(fields[0]!))
    const code = fields.length > 1 ? stripQuotes(fields[1]!) : undefined
    return [value, code || undefined]
  })
}

/** `_triplet`: (bank, peer group, percentile) of a period cell. */
function triplet(cell: unknown): [number | undefined, number | undefined, number | undefined] {
  const parts = cellParts(cell)
  const bank = parts[0]?.[0]
  const pg = parts.find(([, code]) => code?.startsWith('UBPS'))?.[0]
  const pct = parts.find(([, code]) => code?.startsWith('UBPK'))?.[0]
  return [bank, pg, pct]
}

function pgCode(line: Line, periodCols: string[]): string | undefined {
  for (const key of periodCols) for (const [, code] of cellParts(line[key])) if (code?.startsWith('UBPS')) return code
  return undefined
}

function sectionHasPg(lines: Line[], periodCols: string[]): boolean {
  return lines.some((line) => periodCols.some((key) => cellParts(line[key]).some(([, code]) => code?.startsWith('UBPS'))))
}

/** `_concept_code`: a line's concept code from a period cell's bank token. */
export function conceptCode(cell: unknown): string | undefined {
  const parts = (cell === null || cell === undefined || cell === '' ? '' : String(cell)).split(', ')
  const bank = parts[0]!.split(';')
  return bank.length > 1 ? stripQuotes(bank[1]!) : undefined
}

/** `_caption`: UBPR markup removed and the leading indentation guarded with a `>`. */
export function caption(raw: string): string {
  const text = raw.replace('#SectionTitle#', '').replace('#Bold#', '').replace('#Italic#', '')
  const body = text.replace(/^ +/, '')
  const indent = text.length - body.length
  return indent ? `>${'\u00a0'.repeat(indent)}${body}` : body
}

/** Date columns `MM_DD_YYYY` as ISO. */
export const isoOf = (k: string): string => `${k.slice(6)}-${k.slice(0, 2)}-${k.slice(3, 5)}`

const asLines = (v: unknown): Line[] => (Array.isArray(v) ? (v as Line[]) : [])

/** `fetch_ubpr_section`: one report section as wide rows across reporting periods. */
export async function fetchUbprSection(ctx: NativeCtx, rssdId: string, section: string | undefined, opts: { allPeriods?: boolean; periods?: number; reportTypeId?: number; peerDefinition?: string } = {}): Promise<{ section: string; rows: Row[] }> {
  const reportTypeId = opts.reportTypeId ?? 283
  const [pageId, title] = await sectionId(ctx, section, reportTypeId)
  const allCycles = await reportCycles(ctx)
  const cycles = opts.allPeriods ? allCycles : allCycles.slice(0, opts.periods ?? 5)
  const cycleIds = cycles.map((c) => c.reportingcycleid).join(',')
  const peerDefinition = opts.peerDefinition ?? ''
  const raw = asLines(await ctx.cache(`fed:cdr:ubpr_lines:${reportTypeId}:${rssdId}:${pageId}:${cycleIds}:${peerDefinition}`, DAY_MS, () => post(ctx, 'MyUbprLinesData', { ID_RSSD: String(rssdId), ScheduleID: pageId, ReportingCycleIdList: cycleIds, PeerDefinition: peerDefinition })))
  if (raw.length === 0) return { section: title, rows: [] }

  const index = await conceptIndex(ctx, 'ubpr_ratio_single')
  const periodCols = Object.keys(raw[0]!)
    .filter((k) => PERIOD.test(k))
    .sort((a, b) => cmp(b.slice(6), a.slice(6)) || cmp(b.slice(0, 2), a.slice(0, 2)) || cmp(b.slice(3, 5), a.slice(3, 5)))
  const ordered = [...raw].sort((a, b) => (Number(a.linedisplayorder) || 0) - (Number(b.linedisplayorder) || 0))
  const lineIds = new Map<string, string>()
  for (const line of ordered) {
    for (const key of periodCols) {
      const code = conceptCode(line[key])
      if (code) {
        const lineId = line.lineid
        if (lineId && !lineIds.has(code)) lineIds.set(code, String(lineId))
        break
      }
    }
  }
  const guide = await fetchGuideConcepts(ctx, [...lineIds.keys()], lineIds)
  const hasPg = !opts.allPeriods && sectionHasPg(ordered, periodCols)

  const rows: Row[] = []
  for (const line of ordered) {
    const cap = String(line.linecaption ?? '')
    if (cap === '#BlankLine#') continue
    const isHeader = cap.startsWith('#SectionTitle#') || periodCols.length === 0 || periodCols.every((k) => triplet(line[k])[0] === undefined)
    if (isHeader) {
      rows.push({ label: caption(cap), is_header: true })
      continue
    }
    let code: string | undefined
    for (const key of periodCols) {
      code = conceptCode(line[key])
      if (code) break
    }
    const meta: Partial<Concept> = index.get(code ?? '') ?? {}
    const g: Partial<Guide> = guide.get(code ?? '') ?? {}
    const labelName = cleanName(g.description) ?? meta.name
    const bankMonetary = Boolean(meta.monetary)
    const pgMonetary = Boolean(index.get(pgCode(line, periodCols) ?? '')?.monetary)
    const record: Row = { label: indentedName(caption(cap), labelName), is_header: false }
    const narrative = g.narrative || meta.narrative
    if (narrative) record.narrative = narrative
    for (const key of periodCols) {
      const [rawBank, rawPg, pct] = triplet(line[key])
      let bank = rawBank
      let pg = rawPg
      if (bank !== undefined && bankMonetary) bank *= 1000
      if (pg !== undefined && pgMonetary) pg *= 1000
      const iso = isoOf(key)
      if (opts.allPeriods) record[iso] = bank
      else if (hasPg) {
        record[`${iso} Bank`] = bank
        record[`${iso} PG`] = pg
        record[`${iso} PCT`] = pct
      } else record[iso] = bank
    }
    rows.push(record)
  }
  const isoCols = periodCols.map(isoOf)
  if (rows.length && rows[0]!.is_header && isoCols.every((c) => rows[0]![c] === undefined || rows[0]![c] === null)) {
    const description = UBPR_PAGE_DESCRIPTIONS[title]
    if (description) rows[0]!.narrative = description
  }
  return { section: title, rows }
}

/** `call_report_filers`: the RSSDs that file the latest single-period Call Report. */
export async function callReportFilers(ctx: NativeCtx): Promise<Set<string>> {
  return ctx.cache('fed:cdr:filers', DAY_MS, async () => {
    const latest = await fetchBulk(ctx, 'call_single', undefined, 'xbrl')
    const out = new Set<string>()
    if (latest[0] !== 0x50 || latest[1] !== 0x4b) return out
    unzipSync(latest, {
      filter: (f) => {
        const m = / FI (\d+)\(ID RSSD\)/.exec(f.name)
        if (m) out.add(m[1]!)
        return false
      },
    })
    return out
  })
}

/**
 * `resolve_rssd_to_bank` for an RSSD that files the Call Report. A holding company has none: OpenBB then walks the
 * FFIEC NIC's ownership data, which answers browsers only, so such a call is left to the API.
 */
export async function bankRssd(ctx: NativeCtx, params: NativeParams): Promise<string> {
  const rssd = str(params, 'rssd_id')
  if (!rssd) {
    if (str(params, 'symbol')) throw new NativeUnsupported('a ticker resolves through the FFIEC NIC, which answers browsers only')
    throw new Error('Provide a `symbol` or `rssd_id` to identify the bank.')
  }
  if (!(await callReportFilers(ctx)).has(rssd)) throw new NativeUnsupported(`RSSD ${rssd} does not file the Call Report; its lead bank comes from the FFIEC NIC, which answers browsers only`)
  return rssd
}

const noBankReport = (rssd: string, report: string): Error => new Error(`No ${report} data for RSSD ${rssd}. ${report} covers institutions that file the FFIEC Call Report (commercial banks and savings institutions); bank holding companies and non-bank entities have none. Supply a subsidiary bank's RSSD, or use FR Y-9C (financial_statements) for a holding company.`)

const STRUCTURAL = new Set(['label', 'is_header', 'narrative'])

export const ubpr: NativeHandler = async (params, ctx) => {
  const rssd = await bankRssd(ctx, params)
  const result = await fetchUbprSection(ctx, rssd, str(params, 'section') ?? 'Summary Ratios', { allPeriods: bool(params, 'all_periods', false) })
  if (result.rows.length === 0) throw new EmptyDataError()
  if (!result.rows.some((row) => Object.entries(row).some(([k, v]) => !STRUCTURAL.has(k) && v !== undefined && v !== null))) throw noBankReport(rssd, 'UBPR')
  return result.rows
}

// ---------------------------------------------------------------------------------------------------------------
// Executive Summary Report

const ESR_REPORT_TYPE_ID = 367

type EsrSection = { sectionid: string; displayorder?: string }

const numberOf = (cell: unknown): number | undefined => (cell === null || cell === undefined || cell === '' ? undefined : pyFloat(String(cell)))

export const executiveSummary: NativeHandler = async (params, ctx) => {
  const rssd = await bankRssd(ctx, params)
  const allPeriods = bool(params, 'all_periods', false)
  const sections = asLines(await ctx.cache('fed:cdr:esr_sections', DAY_MS, () => post(ctx, 'ReportPageSections', { ReportTypeID: ESR_REPORT_TYPE_ID }))).filter((r) => r.sectionid) as unknown as EsrSection[]
  if (sections.length === 0) throw new EmptyDataError()
  const index = await conceptIndex(ctx, 'ubpr_ratio_single')
  const allCycles = await reportCycles(ctx)
  const cycles = allPeriods ? allCycles : allCycles.slice(0, 5)
  const isoKeys = cycles.map((c) => `${c.enddateformatted.slice(6)}-${c.enddateformatted.slice(0, 2)}-${c.enddateformatted.slice(3, 5)}`)
  const keys = isoKeys.map((iso) => `${iso.slice(5, 7)}_${iso.slice(8, 10)}_${iso.slice(0, 4)}`)
  const isoOfKey = new Map(keys.map((k, i) => [k, isoKeys[i]!]))

  type EsrRow = Row & { _concept?: string; _caption?: string; _meta_name?: string; _lineid?: string }
  const rows: EsrRow[] = []
  for (const section of [...sections].sort((a, b) => (Number(a.displayorder) || 0) - (Number(b.displayorder) || 0))) {
    const raw = asLines(await ctx.cache(`fed:cdr:esr_section:${rssd}:${section.sectionid}`, DAY_MS, () => post(ctx, 'ReportSectionData', { ID_RSSD: String(rssd), SectionID: section.sectionid, ShowConfidential: 0 })))
    for (const line of [...raw].sort((a, b) => (Number(a.displayorder) || 0) - (Number(b.displayorder) || 0))) {
      const cap = String(line.linecaption ?? '')
      if (cap === '#BlankLine#') continue
      const isHeader = cap.startsWith('#SectionTitle#') || keys.every((k) => numberOf(line[k]) === undefined)
      const code = String(line.conceptname ?? '')
      const meta = index.get(code)
      const captionLabel = caption(cap)
      const record: EsrRow = { label: captionLabel, is_header: isHeader }
      if (!isHeader) {
        record._concept = code
        record._caption = captionLabel
        record._meta_name = meta?.name
        record._lineid = String(line.lineid ?? '')
        const scale = meta?.monetary ? 1000 : 1
        for (const k of keys) {
          const v = numberOf(line[k])
          record[isoOfKey.get(k)!] = v === undefined ? null : v * scale
        }
      }
      rows.push(record)
    }
  }
  const esrLines = new Map<string, string>()
  for (const r of rows) if (r._concept && r._lineid) esrLines.set(r._concept, r._lineid)
  const guide = esrLines.size ? await fetchGuideConcepts(ctx, [...esrLines.keys()], esrLines) : new Map<string, Guide>()
  const out: Row[] = rows.map((r) => {
    const { _concept: code, _caption: captionLabel, _meta_name: metaName, _lineid: _l, ...row } = r
    if (code === undefined) return row
    const entry: Partial<Guide> = guide.get(code) ?? {}
    row.label = indentedName(captionLabel, cleanName(entry.description) ?? metaName)
    const narrative = entry.narrative || index.get(code)?.narrative
    if (narrative) row.narrative = narrative
    return row
  })
  if (out.length === 0) throw new EmptyDataError()
  if (!out.some((row) => Object.entries(row).some(([k, v]) => !STRUCTURAL.has(k) && v !== undefined && v !== null))) throw noBankReport(rssd, 'Executive Summary')
  return out
}

// ---------------------------------------------------------------------------------------------------------------
// List of banks in a peer group

const LIST_OF_BANKS_FIELDS: Record<string, string> = {
  rssd9001: 'rssd_id',
  rssd9050: 'fdic_cert',
  ubpr9346: 'charter_class',
  rssd9017: 'name',
  rssd9130: 'city',
  rssd9200: 'state',
  statename: 'state_name',
  ubprd218: 'offices',
  ubprd659: 'average_assets',
  ubpr4340: 'net_income',
  latitude: 'latitude',
  longitude: 'longitude',
}
const NUMERIC_FIELDS = new Set(['offices', 'average_assets', 'net_income', 'latitude', 'longitude'])

export const listOfBanksPeerGroup: NativeHandler = async (params, ctx) => {
  const peerGroup = str(params, 'peer_group') ?? '1'
  if (!peerGroup.trim()) throw new Error('Provide a `peer_group` to identify the peer group.')
  const cycles = await reportCycles(ctx)
  if (cycles.length === 0) throw new EmptyDataError('The reporting-cycle list could not be retrieved.')
  const date = str(params, 'date')
  const cycle = cycles.find((c) => c.enddateformatted === date) ?? cycles[0]!
  const raw = await ctx.cache(`fed:cdr:list_of_banks:${peerGroup}:${cycle.reportingcycleid}`, DAY_MS, () => post(ctx, 'LlistOfBanks', { ReportingCycleID: String(cycle.reportingcycleid), PeerGroupName: String(peerGroup), MaxRows: 0 }))
  const rows: Row[] = []
  for (const record of asLines(raw)) {
    const row: Row = {}
    for (const [source, name] of Object.entries(LIST_OF_BANKS_FIELDS)) {
      let value: unknown = record[source]
      if (typeof value === 'string') value = value.trim()
      if (NUMERIC_FIELDS.has(name)) {
        const n = typeof value === 'number' ? value : value === undefined || value === null ? undefined : pyFloat(String(value).trim())
        value = n === undefined || Number.isNaN(n) ? undefined : n
      }
      // `value or None`: a missing, empty or zero value is left out.
      if (value) row[name] = value
    }
    rows.push(row)
  }
  if (rows.length === 0) throw new EmptyDataError()
  for (const row of rows) for (const field of ['average_assets', 'net_income']) if (typeof row[field] === 'number') row[field] = (row[field] as number) * 1000
  const assets = (r: Row): number | undefined => (typeof r.average_assets === 'number' ? r.average_assets : undefined)
  return rows.sort((a, b) => Number(assets(a) === undefined) - Number(assets(b) === undefined) || -(assets(a) ?? 0) - -(assets(b) ?? 0))
}
