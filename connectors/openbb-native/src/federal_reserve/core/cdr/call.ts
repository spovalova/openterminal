// ffiec/call_report and ffiec/call_report_sectioned, provider federal_reserve. Ported from
// openbb_federal_reserve/models/{call_report,call_report_router}.py and the XBRL parts of utils/cdr.py (OpenBB Platform
// 5.0.0, Apache-2.0); modified: fast-xml-parser instead of ElementTree, plain rows instead of pydantic models, ctx.cache
// instead of the on-disk cache. A ticker, or an RSSD that does not file the Call Report itself (a holding company),
// needs the FFIEC NIC (it answers browsers only), so those calls are left to the OpenBB API.
import { strFromU8, unzipSync } from 'fflate'
import { parseCsv } from '../../../lib/csv.js'
import { parseXml } from '../../../lib/xml.js'
import { NativeUnsupported, type NativeCtx, type NativeHandler, type NativeParams, type Row } from '../../../types.js'
import { DAY_MS, EmptyDataError, bool, cmp, str } from '../helpers.js'
import { conceptIndex, indentedName } from './concepts.js'
import { fetchMdrm, mdrmDictionary } from './mdrm.js'
import { fetchBulk, fetchTaxonomy, listPeriods } from './net.js'
import { CALL_PAGE_DESCRIPTIONS } from './call-pages.js'
import { callReportFilers } from './ubpr.js'

const NBSP = '\u00a0'
const UNIT_LABELS: Record<string, string> = { USD: 'USD (thousands)', PURE: 'Rate or ratio', NONMONETARY: 'Non-monetary' }

const toNumber = (v: unknown): number | undefined => {
  const t = String(v ?? '').replace(/,/g, '').trim()
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return undefined
  return Number(t)
}
const toInt = (v: unknown): number | undefined => (/^[+-]?\d+$/.test(String(v ?? '').trim()) ? Number(String(v).trim()) : undefined)

type Item = { mdrm: string; value: string; unit: string | undefined; decimals: string | undefined; period: string; period_type: 'instant' | 'duration' }
type Parsed = { name: string | undefined; date: string | undefined; form_type: string | undefined; items: Item[] }

/** The archive's member names, in archive order. */
function memberNames(zip: Uint8Array): string[] {
  const names: string[] = []
  unzipSync(zip, {
    filter: (f) => {
      names.push(f.name)
      return false
    },
  })
  return names
}

function memberText(zip: Uint8Array, name: string): string {
  return strFromU8(unzipSync(zip, { filter: (f) => f.name === name })[name]!)
}

/** The tab-delimited POR roster of a bulk archive: its header and rows. */
function porRoster(zip: Uint8Array, names: string[]): { header: string[]; rows: string[][] } | undefined {
  const member = names.find((n) => n.includes('POR'))
  if (!member) return undefined
  const [header = [], ...rows] = parseCsv(memberText(zip, member), '\t')
  return { header: header.map((c) => c.replace(/^"|"$/g, '')), rows }
}

type XmlNode = Record<string, unknown>
const tagOf = (n: XmlNode): string | undefined => Object.keys(n).find((k) => k !== ':@' && k !== '#text')
const attrsOf = (n: XmlNode): Record<string, string> => (n[':@'] ?? {}) as Record<string, string>
const childrenOf = (n: XmlNode): XmlNode[] => {
  const t = tagOf(n)
  return t && Array.isArray(n[t]) ? (n[t] as XmlNode[]) : []
}
const textOf = (n: XmlNode): string => childrenOf(n).map((c) => (typeof c['#text'] === 'string' || typeof c['#text'] === 'number' ? String(c['#text']) : '')).join('')

/** `parse_xbrl_instance`: one bank's XBRL instance out of a bulk ZIP. */
export function parseXbrlInstance(zip: Uint8Array, rssd: string): Parsed {
  const target = rssd.trim()
  const names = memberNames(zip)
  const por = porRoster(zip, names)
  let name: string | undefined
  if (por) {
    const nameIndex = por.header.indexOf('Financial Institution Name')
    if (nameIndex >= 0) for (const row of por.rows) if (row[0]?.replace(/^"|"$/g, '') === target && nameIndex < row.length) {
      name = row[nameIndex]!.trim()
      break
    }
  }
  const re = new RegExp(`(?<!\\d)${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\d)`)
  const member = names.find((m) => /\.xbrl(\.xml)?$/i.test(m) && re.test(m))
  if (!member) return { name, date: undefined, form_type: undefined, items: [] }
  const raw = memberText(zip, member)
  const formType = /report(0\d\d)/.exec(raw)?.[1]
  const doc = parseXml(raw, { preserveOrder: true }) as unknown as XmlNode[]
  const root = doc.find((n) => tagOf(n) !== '?xml' && tagOf(n) !== undefined && !tagOf(n)!.startsWith('?'))
  const nodes = root ? childrenOf(root) : []

  const contexts = new Map<string, [string, 'instant' | 'duration']>()
  const units = new Map<string, string>()
  for (const n of nodes) {
    const tag = tagOf(n)
    if (tag === 'context') {
      const period = childrenOf(n).find((c) => tagOf(c) === 'period')
      if (!period) continue
      const instant = childrenOf(period).find((c) => tagOf(c) === 'instant')
      const end = childrenOf(period).find((c) => tagOf(c) === 'endDate')
      const id = attrsOf(n)['@_id'] ?? ''
      if (instant && textOf(instant)) contexts.set(id, [textOf(instant), 'instant'])
      else if (end && textOf(end)) contexts.set(id, [textOf(end), 'duration'])
    } else if (tag === 'unit') {
      const measure = childrenOf(n).find((c) => tagOf(c) === 'measure')
      if (measure && textOf(measure)) units.set(attrsOf(n)['@_id'] ?? '', textOf(measure).split(':').pop()!.toUpperCase())
    }
  }
  const items: Item[] = []
  for (const n of nodes) {
    const attrs = attrsOf(n)
    const ref = attrs['@_contextRef']
    if (!ref || !contexts.has(ref)) continue
    const [period, periodType] = contexts.get(ref)!
    const unit = units.get(attrs['@_unitRef'] ?? '')
    items.push({ mdrm: tagOf(n)!, value: textOf(n).trim(), unit: unit === undefined ? undefined : (UNIT_LABELS[unit] ?? unit), decimals: attrs['@_decimals'], period, period_type: periodType })
  }
  const date = items.reduce<string | undefined>((m, i) => (m === undefined || i.period > m ? i.period : m), undefined)
  return { name, date, form_type: formType, items }
}

/** `resolve_fdic_cert`: the RSSD of an FDIC certificate number, from the POR roster. */
function resolveFdicCert(zip: Uint8Array, cert: string): string | undefined {
  const por = porRoster(zip, memberNames(zip))
  if (!por) return undefined
  const index = por.header.indexOf('FDIC Certificate Number')
  if (index < 0) return undefined
  for (const row of por.rows) if (index < row.length && row[index]!.trim() === cert.trim()) return row[0]!.replace(/^"|"$/g, '').trim()
  return undefined
}

// ---------------------------------------------------------------------------------------------------------------
// The report's line-item hierarchy, from the XBRL taxonomy

export type Placement = { order: number; section: string | undefined; parent: string | undefined; label: string | undefined; level: number; section_order?: number }

function cleanCaption(caption: string): string {
  let c = caption.replace(/^#[^#]*#/, '')
  c = c.replace(/\s*\(Form Type - \d+\)\s*$/, '')
  c = c.replace(/\s*--\s*Page\s+\w+\s*$/, '')
  c = c.replace(/\s*\$\s*$/, '')
  return c.split(/\s+/).filter(Boolean).join(' ')
}

const isColumn = (caption: string | undefined): boolean => {
  if (!caption) return false
  const collapsed = caption.replace(/ /g, '').toLowerCase()
  return collapsed.startsWith('column') || collapsed === 'dummycolumn'
}

function linkbaseRoot(xml: string): XmlNode[] {
  const doc = parseXml(xml, { preserveOrder: true }) as unknown as XmlNode[]
  const root = doc.find((n) => {
    const t = tagOf(n)
    return t !== undefined && !t.startsWith('?') && !t.startsWith('!')
  })
  return root ? childrenOf(root) : []
}

function buildPresentation(zip: Uint8Array): Map<string, Placement> {
  const names = memberNames(zip)
  const presentation = names.find((m) => /(presentation\.xml|-pres\.xml)$/i.test(m))
  const label = names.find((m) => /(label\.xml|-cap\.xml)$/i.test(m))
  const best = new Map<string, Placement>()
  if (!presentation || !label) return best

  // Captions: each locator's label through the label arcs.
  const labels = new Map<string, string>()
  for (const link of linkbaseRoot(memberText(zip, label))) {
    const locators = new Map<string, string>()
    const arcs = new Map<string, string>()
    const text = new Map<string, string>()
    for (const el of childrenOf(link)) {
      const tag = tagOf(el)
      const a = attrsOf(el)
      if (tag === 'loc') locators.set(a['@_label'] ?? '', (a['@_href'] ?? '').split('#').pop()!)
      else if (tag === 'labelArc') arcs.set(a['@_from'] ?? '', a['@_to'] ?? '')
      else if (tag === 'label') text.set(a['@_label'] ?? '', textOf(el).trim())
    }
    for (const [locatorLabel, concept] of locators) {
      const target = arcs.get(locatorLabel)
      if (target && text.get(target)) labels.set(concept, cleanCaption(text.get(target)!))
    }
  }

  let counter = 0
  const descend = (node: string, chain: string[], children: Map<string, [number, string][]>): void => {
    const caption = labels.get(node)
    const updated = !caption || isColumn(caption) ? chain : [...chain, caption]
    const code = node.includes('_') ? node.split('_').slice(1).join('_') : ''
    if (!children.has(node) && /^[A-Z0-9]+$/.test(code)) {
      const section = updated[0]
      const parent = updated.length >= 3 ? updated[updated.length - 2] : undefined
      const placement: Placement = { order: counter, section, parent: parent !== section ? parent : undefined, label: updated[updated.length - 1], level: Math.max(updated.length - 1, 0) }
      counter++
      const current = best.get(code)
      if (!current || placement.level > current.level) best.set(code, placement)
    }
    for (const [, child] of [...(children.get(node) ?? [])].sort((a, b) => a[0] - b[0] || cmp(a[1], b[1]))) descend(child, updated, children)
  }
  for (const link of linkbaseRoot(memberText(zip, presentation))) {
    const locators = new Map<string, string>()
    const children = new Map<string, [number, string][]>()
    for (const el of childrenOf(link)) {
      const tag = tagOf(el)
      const a = attrsOf(el)
      if (tag === 'loc') locators.set(a['@_label'] ?? '', (a['@_href'] ?? '').split('#').pop()!)
      else if (tag === 'presentationArc') {
        const parent = locators.get(a['@_from'] ?? '') ?? a['@_from'] ?? ''
        const child = locators.get(a['@_to'] ?? '') ?? a['@_to'] ?? ''
        children.set(parent, [...(children.get(parent) ?? []), [Number(a['@_order'] ?? '0'), child]])
      }
    }
    const nested = new Set([...children.values()].flatMap((arcs) => arcs.map(([, c]) => c)))
    for (const node of [...children.keys()].filter((n) => !nested.has(n)).sort(cmp)) descend(node, [], children)
  }

  // Rank the sections by their first line item and the items within each section.
  const grouped = new Map<string | undefined, string[]>()
  for (const [code, p] of best) grouped.set(p.section, [...(grouped.get(p.section) ?? []), code])
  const minOrder = (s: string | undefined) => Math.min(...grouped.get(s)!.map((c) => best.get(c)!.order))
  const sections = [...grouped.keys()].sort((a, b) => minOrder(a) - minOrder(b))
  const ranks = new Map<string, number>()
  sections.forEach((section, i) => {
    const codes = [...grouped.get(section)!].sort((a, b) => best.get(a)!.order - best.get(b)!.order)
    codes.forEach((code, rank) => ranks.set(code, rank + 1))
    for (const code of codes) best.get(code)!.section_order = i + 1
  })
  for (const [code, rank] of ranks) best.get(code)!.order = rank
  return best
}

function presentationMap(ctx: NativeCtx, formType: string | undefined): Promise<Map<string, Placement>> {
  return ctx.cache(`fed:cdr:presentation:call_single:${formType ?? ''}`, DAY_MS, async () => buildPresentation(await fetchTaxonomy(ctx, 'call_single', formType)))
}

// ---------------------------------------------------------------------------------------------------------------

/** The bank to report on: the RSSD itself when it files the Call Report; a ticker or a holding company needs the NIC. */
async function bankFor(ctx: NativeCtx, params: NativeParams, latest: Uint8Array): Promise<string> {
  const rssd = str(params, 'rssd_id')
  const symbol = str(params, 'symbol')
  const cert = str(params, 'fdic_cert')
  if (!rssd && !cert && !symbol) throw new Error('Provide a `symbol`, `rssd_id`, or `fdic_cert` to identify the bank.')
  if (!rssd && symbol) throw new NativeUnsupported('a ticker resolves through the FFIEC NIC, which answers browsers only')
  if (!rssd && cert) {
    const resolved = resolveFdicCert(latest, cert)
    if (!resolved) throw new Error(`Could not resolve FDIC certificate '${cert}'.`)
    return resolved
  }
  if (!(await callReportFilers(ctx)).has(rssd!)) throw new NativeUnsupported(`RSSD ${rssd} does not file the Call Report; its lead bank comes from the FFIEC NIC, which answers browsers only`)
  return rssd!
}

export const callReport: NativeHandler = async (params, ctx) => {
  const date = str(params, 'date')
  const period = date ? `${date.slice(5, 7)}/${date.slice(8, 10)}/${date.slice(0, 4)}` : undefined
  const content = await fetchBulk(ctx, 'call_single', period, 'xbrl')
  if (content[0] !== 0x50 || content[1] !== 0x4b) throw new EmptyDataError()
  const rssd = await bankFor(ctx, params, content)
  const parsed = parseXbrlInstance(content, rssd)
  let items = parsed.items
  const periodType = str(params, 'period_type')
  if (periodType) items = items.filter((i) => i.period_type === periodType.trim().toLowerCase())
  if (items.length === 0) throw new EmptyDataError()

  const asOf = items.reduce<string | undefined>((m, i) => (m === undefined || i.period > m ? i.period : m), undefined)
  const hierarchy = await presentationMap(ctx, parsed.form_type)
  let scheduleCount = 0
  for (const node of hierarchy.values()) scheduleCount = Math.max(scheduleCount, node.section_order ?? 0)
  const dictionary = mdrmDictionary(await fetchMdrm(ctx), asOf, 'R')

  type Out = Row & { _section?: number | undefined }
  const rows: Out[] = []
  const unmapped: Out[] = []
  for (const item of items) {
    const code = item.mdrm.toUpperCase()
    const node = hierarchy.get(code)
    if (node?.section && node.section.includes('Demographic')) continue
    const row: Out = { date: item.period, rssd_id: rssd, ...(parsed.name ? { name: parsed.name } : {}), mdrm: item.mdrm }
    if (item.unit !== undefined) row.unit = item.unit
    if (item.period_type) row.period_type = item.period_type
    if (node?.section) row.section = node.section
    if (node?.parent) row.parent = node.parent
    if (node?.level !== undefined) row.level = node.level
    const label = node?.label || dictionary.get(code)
    if (label) row.label = label
    const value = toNumber(item.value)
    if (value !== undefined) row.value = value
    const decimals = toInt(item.decimals)
    if (decimals !== undefined) row.decimals = decimals
    if (node) row.order = node.order
    row._section = node?.section_order
    rows.push(row)
    if (row._section === undefined) unmapped.push(row)
  }
  unmapped.sort((a, b) => cmp(String(a.mdrm), String(b.mdrm)))
  unmapped.forEach((row, i) => {
    row.section = 'Supplemental Information'
    delete row.parent
    row.level = 1
    row.order = i + 1
    row._section = scheduleCount + 1
  })
  rows.sort((a, b) => (a._section! - b._section!) || ((a.order as number) - (b.order as number)))
  return rows.map(({ _section, ...row }) => row)
}

// ---------------------------------------------------------------------------------------------------------------

const sectionMatches = (section: string, candidate: string | undefined): boolean => {
  if (!candidate) return false
  const norm = (t: string) => t.replace(/-/g, ' ').split(/\s+/).filter(Boolean).join(' ').toLowerCase()
  return norm(section) === norm(candidate)
}

export const callReportSectioned: NativeHandler = async (params, ctx) => {
  const section = str(params, 'section') ?? 'Schedule RC - Balance Sheet'
  const allPeriods = bool(params, 'all_periods', false)
  if (allPeriods) throw new NativeUnsupported('all_periods downloads every quarterly Call Report archive (about 4 GB)')
  const latest = await fetchBulk(ctx, 'call_single', undefined, 'xbrl')
  if (latest[0] !== 0x50 || latest[1] !== 0x4b) throw new EmptyDataError()
  const rssd = await bankFor(ctx, params, latest)
  const available = await listPeriods(ctx, 'call_single')
  const periods = available.slice(0, 5).map((r) => r.date)

  const facts = new Map<string, Map<string, string>>()
  let formType: string | undefined
  let name: string | undefined
  const isos: string[] = []
  for (const period of periods) {
    const content = period === periods[0] ? latest : await fetchBulk(ctx, 'call_single', period)
    const parsed = parseXbrlInstance(content, rssd)
    formType ??= parsed.form_type
    name ??= parsed.name
    let iso: string | undefined
    for (const item of parsed.items) {
      iso = item.period
      const byDate = facts.get(item.mdrm) ?? new Map<string, string>()
      byDate.set(iso, item.value)
      facts.set(item.mdrm, byDate)
    }
    if (iso && !isos.includes(iso)) isos.push(iso)
  }
  if (facts.size === 0 || !formType) throw new EmptyDataError()
  isos.sort((a, b) => cmp(b, a))
  const hierarchy = await presentationMap(ctx, formType)
  const codes = [...facts.keys()].filter((code) => sectionMatches(section, hierarchy.get(code.toUpperCase())?.section))
  if (codes.length === 0) throw new EmptyDataError(`No data was found for the '${section}' schedule.`)
  codes.sort((a, b) => (hierarchy.get(a.toUpperCase())?.order ?? 0) - (hierarchy.get(b.toUpperCase())?.order ?? 0))
  const index = await conceptIndex(ctx, 'call_single', formType)
  const rows: Row[] = [{ label: section, is_header: true }]
  for (const code of codes) {
    const meta = index.get(code.toUpperCase())
    if (meta?.is_text) continue
    const node = hierarchy.get(code.toUpperCase())!
    const level = node.level || 1
    const indent = NBSP.repeat(2 * Math.max(level - 1, 0))
    const base = node.label || code
    const label = indent ? `>${indent}${base}` : base
    const row: Row = { label: indentedName(label, meta?.name), is_header: false }
    if (meta?.narrative) row.narrative = meta.narrative
    for (const iso of isos) {
      const v = toNumber(facts.get(code)!.get(iso))
      if (v !== undefined) row[iso] = v
    }
    rows.push(row)
  }
  if (rows.length === 1) throw new EmptyDataError(`No data was found for the '${section}' schedule.`)
  if (!rows[0]!.narrative) {
    const description = CALL_PAGE_DESCRIPTIONS[section]
    if (description) rows[0]!.narrative = description
  }
  return rows
}
