// FFIEC concept metadata: full names, narratives and value units. Ported from openbb_federal_reserve/utils/concepts.py
// and the taxonomy parser of utils/cdr.py (OpenBB Platform 5.0.0, Apache-2.0); modified: ctx.cache instead of the
// on-disk cache.
import { strFromU8, unzipSync } from 'fflate'
import type { NativeCtx } from '../../../types.js'
import { DAY_MS } from '../helpers.js'
import { fetchMdrm, mdrmDefinitions, mdrmDictionary } from './mdrm.js'
import { fetchTaxonomy } from './net.js'

const SMALL_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'by', 'for', 'from', 'in', 'of', 'on', 'or', 'per', 'the', 'to', 'vs', 'with'])
const ACRONYMS = new Set(['TE', 'YTD', 'QTD', 'FTE', 'US', 'USD', 'ROA', 'ROE', 'ROAA', 'ROAE', 'CD', 'ATM', 'ACH', 'HTM', 'AFS', 'IRA', 'TDR', 'OREO', 'HELOC', 'ALLL', 'CECL', 'FHLB', 'GNMA', 'FNMA', 'FHLMC', 'SBA', 'MBS', 'CMBS', 'ABS', 'REIT', 'LIP', 'OBS', 'PD', 'GAAP', 'FDIC', 'OCC', 'PG'])
const RESIDUAL_ABBREVIATIONS: [RegExp, string][] = [
  [/\bLn&Ls\b/gi, 'Loans & Leases'],
  [/\bQtr Ann\b/gi, 'Quarter Annualized'],
  [/\bQtr\b/gi, 'Quarter'],
]

/** `clean_name`: title-case an FFIEC item name into a readable label. */
export function cleanName(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined
  let text = raw.split(/\s+/).filter(Boolean).join(' ')
  text = text.replace(/\s*(?:\/\s*)?(?:as\s+)?(?:a\s+)?(?:percent|%)\s+of\s+(?:average|avg)\.?(?:\s+total)?\s+assets\b.*$/i, '')
  text = text.replace(/\s*\(\$\d*s?\)/g, '')
  text = text.replace(/\s*\(included in .*$/i, '')
  text = text.replace(/\s*\(\d+\)\s*$/, '')
  text = text.replace(/\s*\(\*+\)/g, '').trim().replace(/\.+$/, '').trim()
  let seenFirst = false
  let titled = text.replace(/[A-Za-z0-9]+/g, (word) => {
    const isFirst = !seenFirst
    seenFirst = true
    if (ACRONYMS.has(word.toUpperCase())) return word.toUpperCase()
    if (!isFirst && SMALL_WORDS.has(word.toLowerCase())) return word.toLowerCase()
    return word.slice(0, 1).toUpperCase() + word.slice(1).toLowerCase()
  })
  for (const [pattern, full] of RESIDUAL_ABBREVIATIONS) titled = titled.replace(pattern, full)
  return titled || undefined
}

/** `indented_name`: `label`'s report-indentation prefix (`>` and spaces) put on `name`. */
export function indentedName(label: string | null | undefined, name: string | null | undefined): string | null | undefined {
  if (!name) return label
  const m = /^>[\s\u00a0]*/.exec(label ?? '')
  return (m ? m[0] : '') + name
}

export type Concept = { name: string | undefined; narrative: string | undefined; monetary: boolean; is_text: boolean }

const TYPE_LABELS: Record<string, string> = {
  monetary: 'Monetary',
  nonNegativeMonetary: 'Monetary',
  pure: 'Rate or ratio',
  percent: 'Percentage',
  integer: 'Integer',
  nonNegativeInteger: 'Integer',
  decimal: 'Decimal',
  string: 'Text',
  date: 'Date',
  boolean: 'Boolean',
}

function typeLabel(rawType: string): string | undefined {
  if (rawType in TYPE_LABELS) return TYPE_LABELS[rawType]
  const lower = rawType.toLowerCase()
  if (lower.includes('monetary')) return 'Monetary'
  if (lower.includes('integer')) return 'Integer'
  return rawType || undefined
}

/** `parse_taxonomy`: every concept's data type from a taxonomy ZIP. */
export function parseTaxonomy(content: Uint8Array): { mdrm: string; data_type: string | undefined; period_type: string | undefined; balance: string | undefined }[] {
  const files = unzipSync(content, { filter: (f) => f.name.toLowerCase().endsWith('concepts.xsd') })
  const concepts: { mdrm: string; data_type: string | undefined; period_type: string | undefined; balance: string | undefined }[] = []
  const seen = new Set<string>()
  for (const name of Object.keys(files)) {
    const xml = strFromU8(files[name]!)
    for (const element of xml.matchAll(/<(?:xsd:|xs:)?element\s+([^>]*?)\/?>/g)) {
      const attrs: Record<string, string> = {}
      for (const a of element[1]!.matchAll(/([\w:]+)="([^"]*)"/g)) attrs[a[1]!] = a[2]!
      const code = attrs.name
      if (!code || seen.has(code)) continue
      seen.add(code)
      const rawType = (attrs.type ?? '').split(':').pop()!.replace(/ItemType$/, '')
      concepts.push({ mdrm: code, data_type: typeLabel(rawType), period_type: attrs['xbrli:periodType'], balance: attrs['xbrli:balance'] })
    }
  }
  return concepts
}

const narrative = (text: string | undefined): string | undefined => (!text || text.toLowerCase().includes('pseudo mdrm') ? undefined : text)

/** `concept_index`: `{CODE: {name, narrative, monetary, is_text}}` for a taxonomy product. */
export function conceptIndex(ctx: NativeCtx, product = 'ubpr_ratio_single', formType?: string): Promise<Map<string, Concept>> {
  return ctx.cache(`fed:cdr:concept_index:${product}:${formType ?? ''}`, DAY_MS, async () => {
    const [taxonomy, mdrm] = await Promise.all([fetchTaxonomy(ctx, product, formType), fetchMdrm(ctx)])
    const names = mdrmDictionary(mdrm)
    const definitions = mdrmDefinitions(mdrm)
    const out = new Map<string, Concept>()
    for (const c of parseTaxonomy(taxonomy)) {
      out.set(c.mdrm, { name: cleanName(names.get(c.mdrm)), narrative: narrative(definitions.get(c.mdrm)), monetary: c.data_type === 'Monetary', is_text: c.data_type === 'Text' })
    }
    return out
  })
}
