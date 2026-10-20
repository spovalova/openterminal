// federal_reserve/fed_data, provider federal_reserve. Ported from openbb_federal_reserve/models/fed_data.py and
// utils/{ddp,sdmx}.py (OpenBB Platform 5.0.0, Apache-2.0); modified: fast-xml-parser instead of defusedxml, the
// connector's ctx.cache instead of the on-disk cache, one pass over the SDMX tree.
import { parseXml } from '../../lib/xml.js'
import type { NativeCtx, NativeParams, Row } from '../../types.js'
import { DAY_MS, EmptyDataError, request, str, unescapeHtml } from './helpers.js'

const CHOOSE_URL = 'https://www.federalreserve.gov/datadownload/Choose.aspx'
const OUTPUT_URL = 'https://www.federalreserve.gov/datadownload/Output.aspx'
const STRUCTURE_URL = (rel: string) => `https://www.federalreserve.gov/datadownload/Output/${rel}/Metadata/${rel}_struct.xml`

/** DDP release code → [code used in URLs, title, public name]. */
const RELEASES: Record<string, [string, string, string]> = {
  H6: ['H6', 'Money Stock Measures', 'H.6'],
  H8: ['H8', 'Assets and Liabilities of Commercial Banks in the United States', 'H.8'],
  H10: ['H10', 'Foreign Exchange Rates', 'H.10'],
  H15: ['H15', 'Selected Interest Rates', 'H.15'],
  H41: ['H41', 'Factors Affecting Reserve Balances', 'H.4.1'],
  G17: ['G17', 'Industrial Production and Capacity Utilization', 'G.17'],
  G19: ['G19', 'Consumer Credit', 'G.19'],
  G20: ['G20', 'Finance Companies', 'G.20'],
  Z1: ['Z1', 'Financial Accounts of the United States', 'Z.1'],
  CP: ['CP', 'Commercial Paper', 'CP'],
  CHGDEL: ['CHGDEL', 'Charge-Off and Delinquency Rates on Loans and Leases', 'CHGDEL'],
  DSR: ['DSR', 'Household Debt Service and Financial Obligations Ratios', 'DSR'],
  SLOOS: ['SLOOS', 'Senior Loan Officer Opinion Survey on Bank Lending Practices', 'SLOOS'],
  SCOOS: ['scoos', 'Senior Credit Officer Opinion Survey on Dealer Financing', 'SCOOS'],
}
const DATASET_CHOICES = Object.values(RELEASES).map((r) => r[2])

const normalizeRelease = (value: string): string => value.replace(/\./g, '').replace(/ /g, '').trim().toUpperCase()

/** A release's named data tables, scraped from `Choose.aspx` once (cached). */
async function releasePackages(ctx: NativeCtx, release: string): Promise<{ package: string; name: string }[]> {
  const code = normalizeRelease(release)
  const entry = RELEASES[code]
  if (!entry) return []
  return ctx.cache(`fed:ddp:packages:${code}`, DAY_MS, async () => {
    const text = unescapeHtml(await ctx.http.text(`${CHOOSE_URL}?rel=${entry[0]}`, request({ timeoutMs: 30_000 })))
    const out: { package: string; name: string }[] = []
    const seen = new Set<string>()
    for (const m of text.matchAll(/series=([0-9a-f]{16,})[^"]*"[^>]*>(?:\s*<label[^>]*>)?\s*([^[<]+?)\s*\[/g)) {
      if (!seen.has(m[1]!)) {
        seen.add(m[1]!)
        out.push({ package: m[1]!, name: m[2]!.trim() })
      }
    }
    return out
  })
}

async function resolveDataset(ctx: NativeCtx, release: string, table?: string): Promise<[string, string]> {
  const code = normalizeRelease(release)
  if (!RELEASES[code]) throw new Error(`Unknown release '${release}'. One of: ${DATASET_CHOICES.join(', ')}.`)
  const packages = await releasePackages(ctx, code)
  if (packages.length === 0) throw new Error(`No data tables found for release '${release}'.`)
  if (!table) return [code, packages[0]!.package]
  const lower = table.toLowerCase()
  const exact = packages.filter((p) => p.name.toLowerCase() === lower)
  const partial = packages.filter((p) => p.name.toLowerCase().includes(lower))
  const chosen = exact.length ? exact : partial
  if (chosen.length === 0) throw new Error(`No table matching '${table}' in release ${code}. Available: ${packages.map((p) => `'${p.name}'`).join(', ')}.`)
  return [code, chosen[0]!.package]
}

function buildUrl(release: string, pkg: string, startDate?: string, endDate?: string, lastObs?: number): string {
  let start = startDate
  let end = endDate
  if (start && !end) end = '2099-12-31'
  else if (end && !start) start = '1900-01-01'
  const fmt = (v: string): string => {
    const [y, m, d] = v.split('-')
    return `${m}/${d}/${y}`
  }
  const q = new URLSearchParams({ rel: release, series: pkg })
  if (lastObs) q.set('lastobs', String(lastObs))
  if (start) q.set('from', fmt(start))
  if (end) q.set('to', fmt(end))
  q.set('filetype', 'sdmx')
  q.set('label', 'include')
  q.set('layout', 'seriescolumn')
  return `${OUTPUT_URL}?${q.toString()}`
}

type Node = Record<string, unknown>
const asList = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v])

/** Every descendant object of a parsed tree stored under `name`, in tree order. */
function descendants(node: unknown, name: string, out: Node[] = []): Node[] {
  if (Array.isArray(node)) {
    for (const n of node) descendants(n, name, out)
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Node)) {
      if (k === name) for (const item of asList(v)) out.push(typeof item === 'object' && item !== null ? (item as Node) : { '#text': item })
      descendants(v, name, out)
    }
  }
  return out
}

const textOf = (v: unknown): string => {
  if (v === undefined || v === null) return ''
  if (typeof v === 'object') return textOf((v as Node)['#text'])
  return String(v)
}

/** `parse_structure`: each dimension's codelist labels, keyed by lower-cased concept. */
function parseStructure(xml: string): Record<string, Record<string, string>> {
  if (!xml.trim()) return {}
  let root: Node
  try {
    root = parseXml(xml.replace(/^\ufeff/, ''))
  } catch {
    return {}
  }
  const codelists: Record<string, Record<string, string>> = {}
  for (const list of descendants(root, 'CodeList')) {
    const codes: Record<string, string> = {}
    for (const code of asList(list.Code as Node | Node[] | undefined)) {
      const value = code['@_value']
      if (value !== undefined) codes[String(value)] = textOf(code.Description).trim()
    }
    const id = list['@_id']
    if (id) codelists[String(id)] = codes
  }
  const concepts: Record<string, Record<string, string>> = {}
  for (const name of ['Dimension', 'Attribute']) {
    for (const el of descendants(root, name)) {
      const concept = el['@_concept']
      const codelist = el['@_codelist']
      if (concept && codelist && codelists[String(codelist)]) concepts[String(concept).toLowerCase()] = codelists[String(codelist)]!
    }
  }
  return concepts
}

const MISSING_VALUES = new Set(['-9999', '-99999', '-9999.99', '-99999.99'])
const NON_DIMENSION_ATTRS = new Set(['SERIES_NAME', 'FREQ', 'UNIT', 'UNIT_MULT', 'CURRENCY'])
const PURE_SEASONAL = new Set(['SA', 'SAAR', 'NSA'])
const NO_SCALE_MULTIPLIERS = new Set(['', '1', '1.0', 'One', 'Units', 'Not Applicable'])
const NON_SCALABLE_KEYWORDS = ['percent', 'index', 'rate', 'ratio', 'basis point']
const COUNT_LABELS = new Set(['number', 'count', 'units', 'unit'])

function seasonalFlag(code: string): boolean | undefined {
  if (/^NSA($|_)/.test(code)) return false
  if (/^SAAR$/.test(code) || /^SA($|_)/.test(code)) return true
  return undefined
}

function scaleWord(unitMult: string | undefined, labels: Record<string, string>): string | undefined {
  if (!unitMult) return undefined
  let key = unitMult
  const asFloat = Number(unitMult)
  if (unitMult.trim() !== '' && Number.isFinite(asFloat) && asFloat === Math.trunc(asFloat)) key = String(Math.trunc(asFloat))
  const word = labels[key] ?? labels[unitMult] ?? ''
  if (!word || NO_SCALE_MULTIPLIERS.has(word)) return undefined
  return word
}

function currencyNoun(label: string | undefined): string | undefined {
  if (!label || label === 'Not Applicable') return undefined
  const name = (label.split('/').pop() ?? '').split('(')[0]!.trim()
  if (!name) return undefined
  if (name.endsWith('Dollar')) return 'Dollars'
  const words = name.split(/\s+/)
  const last = words[words.length - 1]!
  words[words.length - 1] = last.endsWith('s') ? last : `${last}s`
  return words.join(' ')
}

function unitLabel(unit: string | undefined, currency: string | undefined, scale: string | undefined, codelists: Record<string, Record<string, string>>): string | undefined {
  const unitLabels = codelists.unit ?? {}
  const currencyLabels = codelists.currency ?? {}
  const resolved = unit ? (unitLabels[unit] ?? unit) : undefined
  if (resolved && resolved.toLowerCase().startsWith('currency')) {
    const noun = currencyNoun(currency === undefined ? undefined : (currencyLabels[currency] ?? currency)) ?? 'Dollars'
    const base = /base\s*=?\s*(\d{4})/i.exec(resolved)
    const suffix = base ? ` (${base[1]} base)` : ''
    return `${scale ? `${scale} of ${noun}` : noun}${suffix}`
  }
  if (!resolved) return scale || undefined
  const lowered = resolved.toLowerCase()
  if (NON_SCALABLE_KEYWORDS.some((k) => lowered.includes(k))) return resolved
  if (!scale) return resolved
  if (COUNT_LABELS.has(lowered)) return scale
  return `${scale} of ${resolved}`
}

type Observation = { date: string | undefined; value: number | undefined }
type Series = { series_id: string; title: string; frequency?: string; unit?: string; unit_multiplier?: string; currency?: string; dimensions: [string, string][]; observations: Observation[] }

/** `parse_series`: every `Series` element with its metadata and observations. */
function parseSeries(xml: string): Series[] {
  if (!xml.trim()) return []
  const out: Series[] = []
  for (const el of descendants(parseXml(xml.replace(/^\ufeff/, '')), 'Series')) {
    const seriesId = el['@_SERIES_NAME']
    if (!seriesId) continue
    const annotations: Record<string, string> = {}
    for (const a of descendants(el, 'Annotation')) {
      const type = textOf(a.AnnotationType).trim()
      if (type) annotations[type.toLowerCase().replace(/ /g, '_')] = textOf(a.AnnotationText).trim()
    }
    const attr = (name: string): string | undefined => (el[`@_${name}`] === undefined ? undefined : String(el[`@_${name}`]))
    const observations = asList(el.Obs as Node | Node[] | undefined).map((o): Observation => {
      const raw = o['@_OBS_VALUE'] === undefined ? undefined : String(o['@_OBS_VALUE'])
      const status = o['@_OBS_STATUS'] === undefined ? '' : String(o['@_OBS_STATUS'])
      let value: number | undefined
      if (raw !== undefined && status !== 'ND' && !MISSING_VALUES.has(raw)) {
        const n = Number(raw)
        value = raw.trim() !== '' && Number.isFinite(n) ? n : undefined
      }
      return { date: o['@_TIME_PERIOD'] === undefined ? undefined : String(o['@_TIME_PERIOD']), value }
    })
    out.push({
      series_id: String(seriesId),
      title: annotations.short_description || String(seriesId),
      ...(attr('FREQ') !== undefined ? { frequency: attr('FREQ')! } : {}),
      ...(attr('UNIT') !== undefined ? { unit: attr('UNIT')! } : {}),
      ...(attr('UNIT_MULT') !== undefined ? { unit_multiplier: attr('UNIT_MULT')! } : {}),
      ...(attr('CURRENCY') !== undefined ? { currency: attr('CURRENCY')! } : {}),
      dimensions: Object.entries(el)
        .filter(([k]) => k.startsWith('@_') && !NON_DIMENSION_ATTRS.has(k.slice(2)))
        .map(([k, v]) => [k.slice(2).toLowerCase(), String(v)] as [string, string]),
      observations,
    })
  }
  return out
}

/** `to_rows`: flatten parsed series into long-format observation rows. */
function toRows(series: Series[], codelists: Record<string, Record<string, string>>): Row[] {
  const freqLabels = codelists.freq ?? {}
  const unitMultLabels = codelists.unit_mult ?? {}
  const rows: Row[] = []
  for (const entry of series) {
    const dimensions: Row = {}
    let seasonallyAdjusted: boolean | undefined
    for (const [dimension, code] of entry.dimensions) {
      if (seasonallyAdjusted === undefined) seasonallyAdjusted = seasonalFlag(code)
      const labels = codelists[dimension] ?? {}
      const keys = Object.keys(labels)
      if (keys.length > 0 && keys.every((k) => PURE_SEASONAL.has(k))) continue
      dimensions[dimension] = labels[code] ?? code
    }
    if (seasonallyAdjusted !== undefined) dimensions.seasonally_adjusted = seasonallyAdjusted
    const scale = scaleWord(entry.unit_multiplier, unitMultLabels)
    const unit = unitLabel(entry.unit, entry.currency, scale, codelists)
    for (const obs of entry.observations) {
      rows.push({
        ...(obs.date !== undefined ? { date: obs.date } : {}),
        series_id: entry.series_id,
        ...(obs.value !== undefined ? { value: obs.value } : {}),
        title: entry.title,
        ...(entry.frequency !== undefined ? { frequency: freqLabels[entry.frequency] ?? entry.frequency } : {}),
        ...(unit !== undefined ? { unit } : {}),
        ...(scale !== undefined ? { unit_multiplier: scale } : {}),
        ...dimensions,
      })
    }
  }
  return rows
}

async function fetchDataset(ctx: NativeCtx, release: string, pkg: string, startDate?: string, endDate?: string, limit?: number): Promise<Row[]> {
  const xml = await ctx.http.text(buildUrl(release, pkg, startDate, endDate, limit), request({ timeoutMs: 60_000 }))
  const structure = await ctx.cache(`fed:ddp:structure:${release}`, DAY_MS, async () => {
    const res = await ctx.http.response(STRUCTURE_URL(release), request({ timeoutMs: 30_000 }))
    return res.status === 200 ? parseStructure(await res.text()) : {}
  })
  return toRows(parseSeries(xml), structure)
}

export async function fedData(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const dataset = str(params, 'dataset')
  if (!dataset) throw new Error('dataset is required')
  const table = str(params, 'table')
  const series = str(params, 'series')
  const sa = params.seasonally_adjusted === undefined || params.seasonally_adjusted === '' ? undefined : params.seasonally_adjusted === true || params.seasonally_adjusted === 'true'
  const limit = params.limit === undefined ? 1 : Number(params.limit)
  const [release, pkg] = await resolveDataset(ctx, dataset, table)

  let rows = await fetchDataset(ctx, release, pkg, str(params, 'start_date'), str(params, 'end_date'), series ? undefined : limit || undefined)
  if (series) {
    const wanted = new Set(series.split(',').map((s) => s.trim()).filter(Boolean))
    rows = rows.filter((r) => wanted.has(String(r.series_id)))
  }
  if (sa !== undefined) rows = rows.filter((r) => r.seasonally_adjusted === sa)
  if (rows.length === 0) throw new EmptyDataError('The request was returned empty.')
  return rows.sort((a, b) => cmp(String(a.date), String(b.date)) || cmp(String(a.series_id), String(b.series_id)))
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
