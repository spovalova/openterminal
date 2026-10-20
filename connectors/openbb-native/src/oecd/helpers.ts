// OECD helpers: telling which dimension an indicator code belongs to, and which dimension a transformation or unit
// goes in. Ported from openbb_oecd/utils/helpers.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain values
// instead of the metadata singleton, which is the data file.
import { dataflowParameters, dimensionOrder, type Param } from './metadata.js'

/** The text parsing of `available_indicators`: `;` separates phrases, spaces and `+` join terms, `|` inside a term is OR (`_parse_search_query`). */
export function parseSearchQuery(query: string): string[][] {
  if (!query) return []
  const result: string[][] = []
  for (const phrase of query.split(';').map((p) => p.trim()).filter(Boolean)) {
    const words = phrase.replace(/\s*\|\s*/g, '|').replace(/\+/g, ' ')
    const terms = words.split(/\s+/).map((t) => t.trim().toLowerCase()).filter(Boolean)
    if (terms.length > 0) result.push(terms)
  }
  return result
}

/** A text matches a phrase when every term of it (any of its `|` alternatives) is in the text; it matches the query when any phrase does. */
export function matchesQuery(text: string, phrases: string[][]): boolean {
  if (phrases.length === 0) return true
  return phrases.some((andTerms) => andTerms.every((term) => term.split('|').map((t) => t.trim()).filter(Boolean).some((alt) => text.includes(alt))))
}

const EXCLUDE_DIMS = new Set(['FREQUENCY', 'FREQ', 'TIME_PERIOD', 'REF_AREA', 'COUNTERPART_AREA', 'JURISDICTION', 'COUNTRY', 'AREA'])
const INDICATOR_DIMENSION_CANDIDATES = ['MEASURE', 'INDICATOR', 'SUBJECT', 'TRANSACTION', 'ACTIVITY', 'PRODUCT', 'SERIES', 'ITEM', 'ACCOUNTING_ENTRY', 'SECTOR']

function parseCompoundCode(code: string, codeToDimension: Map<string, string>): [[string, string][], string[]] {
  const parts = code.split('_')
  const matched: [string, string][] = []
  const unmatched: string[] = []
  let i = 0
  while (i < parts.length) {
    let found = false
    for (let j = parts.length; j > i; j--) {
      const combined = parts.slice(i, j).join('_')
      const dim = codeToDimension.get(combined)
      if (dim !== undefined && !matched.some((m) => m[0] === dim)) {
        matched.push([dim, combined])
        i = j
        found = true
        break
      }
    }
    if (!found) {
      unmatched.push(parts[i]!)
      i++
    }
  }
  return [matched, unmatched]
}

function buildDimensionLookups(dataflow: string): { codeToDimension: Map<string, string>; codesByDimension: Map<string, Set<string>>; order: string[] } {
  const codeToDimension = new Map<string, string>()
  const codesByDimension = new Map<string, Set<string>>()
  const order: string[] = []
  try {
    for (const [dim, values] of Object.entries(dataflowParameters(dataflow))) {
      if (EXCLUDE_DIMS.has(dim.toUpperCase())) continue
      for (const v of values) {
        if (!v.value) continue
        if (!codesByDimension.has(dim)) codesByDimension.set(dim, new Set())
        codesByDimension.get(dim)!.add(v.value)
        if (!codeToDimension.has(v.value)) codeToDimension.set(v.value, dim)
      }
    }
  } catch {
    // the lookups stay empty
  }
  try {
    const trailing = new Set(['FREQUENCY', 'FREQ', 'TIME_PERIOD', 'TRANSFORMATION', 'UNIT_MEASURE', 'ADJUSTMENT'])
    for (const dim of dimensionOrder(dataflow)) {
      const up = dim.toUpperCase()
      if (dim && !trailing.has(up) && !EXCLUDE_DIMS.has(up) && !up.includes('TRANSFORM')) order.push(dim)
    }
  } catch {
    // no order
  }
  return { codeToDimension, codesByDimension, order }
}

/** Which dimension(s) each indicator code belongs to, compound codes such as `CPI_CP01_N` split into theirs (`detect_indicator_dimensions`). */
export function detectIndicatorDimensions(dataflow: string, indicatorCodes: string[]): Record<string, string[]> {
  const dimensionCodes: Record<string, string[]> = {}
  const add = (dim: string, code: string): void => {
    ;(dimensionCodes[dim] ??= []).push(code)
  }
  const { codeToDimension, codesByDimension, order } = buildDimensionLookups(dataflow)
  const primary = INDICATOR_DIMENSION_CANDIDATES.find((c) => codesByDimension.has(c)) ?? [...codesByDimension.keys()][0] ?? 'INDICATOR'
  const invalid: [string, string[]][] = []
  for (const code of indicatorCodes) {
    if (code === '*') add(primary, code)
    else if (codeToDimension.has(code)) add(codeToDimension.get(code)!, code)
    else {
      const [matched, unmatched] = parseCompoundCode(code, codeToDimension)
      if (matched.length > 0 && unmatched.length === 0) {
        for (const [dim, part] of matched) if (!(dimensionCodes[dim] ?? []).includes(part)) add(dim, part)
      } else invalid.push([code, unmatched])
    }
  }
  if (invalid.length > 0) {
    const countryDims = new Set(['COUNTRY', 'REF_AREA'])
    const errorParts: string[] = []
    for (const [code, unmatched] of invalid) {
      if (unmatched.length === 0) {
        errorParts.push(`'${code}'`)
        continue
      }
      const parts = code.split('_')
      const segments: [string, string | undefined][] = []
      let i = 0
      while (i < parts.length) {
        let found = false
        for (let j = parts.length; j > i; j--) {
          const combined = parts.slice(i, j).join('_')
          if (codeToDimension.has(combined)) {
            segments.push([combined, codeToDimension.get(combined)])
            i = j
            found = true
            break
          }
        }
        if (!found) {
          segments.push([parts[i]!, undefined])
          i++
        }
      }
      const hasCountry = segments.some(([, dim]) => dim !== undefined && countryDims.has(dim))
      const effective = hasCountry ? order : order.filter((d) => !countryDims.has(d))
      let firstIdx: number | undefined
      let firstPos: number | undefined
      for (const [idx, [, dim]] of segments.entries()) {
        if (dim !== undefined && effective.includes(dim)) {
          firstIdx = idx
          firstPos = effective.indexOf(dim)
          break
        }
      }
      const segmentErrors: string[] = []
      for (const [idx, [seg, dim]] of segments.entries()) {
        if (dim !== undefined) continue
        const expected = firstIdx !== undefined && firstPos !== undefined ? firstPos - (firstIdx - idx) : idx
        if (expected >= 0 && expected < effective.length) {
          const expectedDim = effective[expected]!
          const sample = [...(codesByDimension.get(expectedDim) ?? [])].sort().slice(0, 5)
          segmentErrors.push(`'${seg}' is invalid for ${expectedDim} (valid: ${sample.join(', ')})`)
        } else segmentErrors.push(`'${seg}' is unrecognized`)
      }
      errorParts.push(`'${code}': ${segmentErrors.join('; ')}`)
    }
    throw new Error(`Invalid indicator code(s) for dataflow '${dataflow}': ${errorParts.join('; ')}. Use \`obb.economy.available_indicators(provider='oecd', dataflows='${dataflow}')\` to see all valid codes.`)
  }
  return dimensionCodes
}

export type TransformDetection = { transformDim?: string; unitDim?: string; transformLookup: Record<string, string>; unitLookup: Record<string, string> }

/** The transformation and unit dimensions of a dataflow and the friendly names for their codes (`detect_transform_dimension`). */
export function detectTransformDimension(dataflow: string): TransformDetection {
  const out: TransformDetection = { transformLookup: Object.create(null) as Record<string, string>, unitLookup: Object.create(null) as Record<string, string> }
  let params: Record<string, Param[]>
  try {
    params = dataflowParameters(dataflow)
  } catch {
    return out
  }
  const t = out.transformLookup
  const u = out.unitLookup
  for (const [dim, values] of Object.entries(params)) {
    const dimUpper = dim.toUpperCase()
    if (dimUpper.includes('TRANSFORM') || dimUpper === 'ADJUSTMENT') {
      out.transformDim = dim
      for (const v of values) {
        const code = v.value
        const label = v.label.toLowerCase()
        const isSimple = !code.startsWith('SRP_') && !code.startsWith('WGT') && !code.startsWith('SA_')
        if ((label === 'index' || (label.includes('index') && !label.includes('change') && !label.includes('percent'))) && (!('index' in t) || isSimple)) t.index = code
        if ((label.includes('year-over-year') || label.includes('yoy') || label.includes('year ago')) && (!('yoy' in t) || isSimple)) t.yoy = code
        if ((label.includes('period-over-period') || (label.includes('period') && label.includes('change') && !label.includes('year'))) && (!('period' in t) || isSimple)) t.period = code
        if ((label.includes('percent of gdp') || label.includes('% of gdp')) && (!('percent_gdp' in t) || isSimple)) t.percent_gdp = code
        if ((label.includes('domestic currency') || label === 'currency') && (!('currency' in t) || isSimple)) t.currency = code
        t[code.toLowerCase()] = code
      }
    } else if (dimUpper === 'UNIT_MEASURE' || dimUpper === 'UNIT') {
      out.unitDim = dim
      for (const v of values) {
        const code = v.value
        const label = v.label.toLowerCase()
        if (label.includes('us dollar') || label === 'usd') u.usd = code
        if (label.includes('euro') || label === 'eur') u.eur = code
        if (label === 'index' || label.includes('index')) u.index = code
        if (label.includes('local') || label.includes('national') || label.includes('domestic')) u.local = code
        if (label.includes('percent') || label.includes('%')) u.percent = code
        u[code.toLowerCase()] = code
      }
    }
  }
  return out
}
