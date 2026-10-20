// IMF helpers. Ported from openbb_imf/utils/helpers.py and the unit parsing in utils/table_presentation.py
// (OpenBB Platform 5.0.0, Apache-2.0); modified: plain values instead of the metadata singleton, which is the data file.
import { dataflowParameters, getDataflow, requireDataflow, type Param } from './metadata.js'
import { isoDate } from '../lib/sdmx.js'

// --- text

/** Python's ordering of two strings: by code point. */
export const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** `Armenia, Republic of` → `armenia`, `Euro Area (EA)` → `euro_area` (`normalize_country_label`). */
export function normalizeCountryLabel(label: string): string {
  let prev: string | undefined
  while (prev !== label) {
    prev = label
    label = label.replace(/\s*\([^()]*\)/g, '')
  }
  return label.split(',')[0]!.trim().replace(/-/g, '_').replace(/ /g, '_').toLowerCase()
}

/** Python's `str.title()`: the first letter of every run of letters upper case, the rest lower case. */
export function pyTitle(s: string): string {
  let out = ''
  let inWord = false
  for (const ch of s) {
    const cased = ch.toLowerCase() !== ch.toUpperCase()
    if (cased) {
      out += inWord ? ch.toLowerCase() : ch.toUpperCase()
      inWord = true
    } else {
      out += ch
      inWord = false
    }
  }
  return out
}

const lastDay = (year: number, month: number): number => new Date(Date.UTC(year, month, 0)).getUTCDate()

/** IMF TIME_PERIODs as the date the period ends: `2026-M02` → `2026-02-28`, `2026-Q1` → `2026-03-31`, `2026` → `2026-12-31`. */
export function parseTimePeriod(period: string): string {
  if (!period) return period
  const intOf = (s: string): number => (/^\s*[+-]?\d+\s*$/.test(s) ? Number(s) : NaN)
  if (period.includes('-M')) {
    const parts = period.split('-M')
    if (parts.length === 2) {
      const year = intOf(parts[0]!)
      const month = intOf(parts[1]!)
      if (!Number.isNaN(year) && !Number.isNaN(month) && month >= 1 && month <= 12) return isoDate(year, month, lastDay(year, month)) ?? period
    }
    return period
  }
  if (period.includes('-Q')) {
    const parts = period.split('-Q')
    if (parts.length === 2) {
      const year = intOf(parts[0]!)
      const quarter = intOf(parts[1]!)
      if (!Number.isNaN(year) && !Number.isNaN(quarter)) {
        const month = ({ 1: 3, 2: 6, 3: 9, 4: 12 } as Record<number, number>)[quarter] ?? 12
        return isoDate(year, month, lastDay(year, month)) ?? period
      }
    }
    return period
  }
  if (period.length === 4 && /^\d{4}$/.test(period)) return isoDate(Number(period), 12, 31) ?? period
  return period
}

// --- units in labels

const LABEL_UNIT_KEYWORDS = ['dollar', 'Dollar', 'USD', 'Euro', 'euro', 'Yen', 'yen', 'Percent', 'percent', '%', 'Millions', 'Billions', 'Thousands', 'Units', 'Per capita', 'per capita', 'Index', 'index', 'Domestic currency', 'National currency', 'currency', 'SDR']

/** The unit an indicator label ends with: `… (US dollar)` or `…, Percent` (`extract_unit_from_label`). */
export function extractUnitFromLabel(label: string): string | undefined {
  if (!label) return undefined
  if (label.endsWith(')')) {
    const parenStart = label.lastIndexOf(' (')
    if (parenStart > 0) {
      const suffix = label.slice(parenStart + 2, -1)
      if (LABEL_UNIT_KEYWORDS.some((kw) => suffix.includes(kw))) return suffix
    }
  }
  const at = label.lastIndexOf(', ')
  if (at >= 0) {
    const last = label.slice(at + 2)
    const lower = last.toLowerCase()
    if (lower.includes(' per ')) return last
    if (['dollar', 'percent', 'index', 'ratio', 'currency', 'capita', 'cent'].some((kw) => lower.includes(kw))) return last
  }
  return undefined
}

/** A combined unit string as `[unit, scale]` (`parse_unit_and_scale`). */
export function parseUnitAndScale(unitString: string | undefined): [string | undefined, string | undefined] {
  if (!unitString) return [undefined, undefined]
  for (const pattern of ['Percent of ', 'Ratio of ', 'Index of ', 'Number of ']) {
    if (unitString.startsWith(pattern)) return [pattern.replace(' of ', '').trim(), `of ${pyTitle(unitString.slice(pattern.length).trim())}`]
  }
  const lower = unitString.toLowerCase()
  const perIdx = lower.indexOf(' per ')
  if (perIdx >= 0) {
    if (perIdx > 0) return [unitString.slice(0, perIdx).trim(), pyTitle(unitString.slice(perIdx + 1).trim())]
  }
  for (const prefix of ['Per capita, ', 'Percent, ', 'Millions, ', 'Billions, ', 'Thousands, ', 'Mean, ']) {
    if (unitString.startsWith(prefix)) return [unitString.slice(prefix.length), prefix.replace(/[, ]+$/, '')]
  }
  for (const suffix of [', Millions', ', Billions', ', Thousands', ', Per capita']) {
    if (unitString.endsWith(suffix)) return [unitString.slice(0, -suffix.length), suffix.replace(/^[, ]+/, '')]
  }
  const keywords = ['Percent', 'US dollar', 'US Dollar', 'Index', 'Ratio', 'SDR', 'EUR', 'Domestic currency', 'National currency', 'Euro']
  const lastComma = unitString.lastIndexOf(', ')
  if (lastComma > 0) {
    const potentialUnit = unitString.slice(lastComma + 2)
    if (keywords.includes(potentialUnit)) return [potentialUnit, unitString.slice(0, lastComma)]
  }
  if (['Per capita', 'Millions', 'Billions', 'Thousands'].includes(unitString)) return [undefined, unitString]
  return [unitString, undefined]
}

// --- search

const STOP_WORDS = new Set(['of', 'the', 'a', 'an', 'is', 'are', 'in', 'on', 'for', 'with', 'and', 'or'])
const PUNCTUATION = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'
const stripPunctuation = (s: string): string => {
  let a = 0
  let b = s.length
  while (a < b && PUNCTUATION.includes(s[a]!)) a++
  while (b > a && PUNCTUATION.includes(s[b - 1]!)) b--
  return s.slice(a, b)
}

/** A search string as OR-groups of AND-terms: `|` separates groups, spaces and `+` join terms, quotes keep a phrase (`parse_search_query`). */
export function parseSearchQuery(query: string): string[][] {
  const orGroups: string[][] = []
  for (const orPartRaw of query.split('|')) {
    const orPart = orPartRaw.trim()
    if (!orPart) continue
    const andGroup: string[] = []
    let inQuote = false
    let current = ''
    const flush = (): void => {
      if (current) {
        const term = stripPunctuation(current.toLowerCase())
        if (term && !STOP_WORDS.has(term)) andGroup.push(term)
        current = ''
      }
    }
    for (const ch of `${orPart} `) {
      if (ch === '"') {
        if (inQuote) {
          if (current) {
            andGroup.push(current.toLowerCase())
            current = ''
          }
          inQuote = false
        } else {
          flush()
          inQuote = true
        }
      } else if ((ch === '+' || /\s/.test(ch)) && !inQuote) flush()
      else current += ch
    }
    if (andGroup.length > 0) orGroups.push(andGroup)
  }
  return orGroups
}

// --- indicator codes

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
      if (dim !== undefined) {
        if (!matched.some((m) => m[0] === dim)) {
          matched.push([dim, combined])
          i = j
          found = true
          break
        }
      }
    }
    if (!found) {
      unmatched.push(parts[i]!)
      i++
    }
  }
  return [matched, unmatched]
}

function buildDimensionLookups(dataflow: string): { codeToDimension: Map<string, string>; codesByDimension: Map<string, Set<string>>; dimensionOrder: string[] } {
  const codeToDimension = new Map<string, string>()
  const codesByDimension = new Map<string, Set<string>>()
  const dimensionOrder: string[] = []
  try {
    const exclude = new Set(['FREQUENCY', 'TIME_PERIOD', 'COUNTRY', 'REF_AREA'])
    for (const [dim, values] of Object.entries(dataflowParameters(dataflow))) {
      if (exclude.has(dim)) continue
      for (const v of values) {
        if (!v.value) continue
        if (!codesByDimension.has(dim)) codesByDimension.set(dim, new Set())
        codesByDimension.get(dim)!.add(v.value)
        if (!codeToDimension.has(v.value)) codeToDimension.set(v.value, dim)
      }
    }
  } catch {
    // continue with the indicator-only lookup when the parameters are unavailable
  }
  const df = getDataflow(dataflow)
  if (df) {
    const trailing = new Set(['FREQUENCY', 'TIME_PERIOD', 'TYPE_OF_TRANSFORMATION', 'TRANSFORMATION'])
    for (const dim of df.dims) if (dim && !trailing.has(dim.toUpperCase()) && !dim.toUpperCase().includes('TRANSFORM')) dimensionOrder.push(dim)
  }
  return { codeToDimension, codesByDimension, dimensionOrder }
}

/** Which dimension each indicator code belongs to, compound codes such as `S13_G1_G23_T` split into theirs (`detect_indicator_dimensions`). */
export function detectIndicatorDimensions(dataflow: string, indicatorCodes: string[]): Record<string, string[]> {
  const dimensionCodes: Record<string, string[]> = {}
  const add = (dim: string, code: string): void => {
    ;(dimensionCodes[dim] ??= []).push(code)
  }
  const { codeToDimension, codesByDimension, dimensionOrder } = buildDimensionLookups(dataflow)
  const invalid: [string, string[]][] = []
  for (const code of indicatorCodes) {
    if (code === '*') {
      if (codesByDimension.has('INDICATOR')) add('INDICATOR', code)
      else if (codeToDimension.size > 0) add(codeToDimension.values().next().value as string, code)
      else add('INDICATOR', code)
    } else if (codeToDimension.has(code)) add(codeToDimension.get(code)!, code)
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
      const effective = hasCountry ? dimensionOrder : dimensionOrder.filter((d) => !countryDims.has(d))
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
    throw new Error(`Invalid indicator code(s) for dataflow '${dataflow}': ${errorParts.join('; ')}. Use \`obb.economy.available_indicators(provider='imf', dataflows='${dataflow}')\` to see all valid codes.`)
  }
  return dimensionCodes
}

export type TransformDetection = { transformDim?: string; unitDim?: string; transformLookup: Record<string, string>; unitLookup: Record<string, string> }

/** The transformation and unit dimensions of a dataflow and the friendly names for their codes (`detect_transform_dimension`). */
export function detectTransformDimension(dataflow: string): TransformDetection {
  const out: TransformDetection = { transformLookup: {}, unitLookup: {} }
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
    if (dimUpper.includes('TRANSFORM')) {
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
    } else if (dimUpper === 'UNIT') {
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

/** Dimension codes in an error message as the parameter names callers use (`translate_error_message`). */
export function translateErrorMessage(message: string): string {
  const dimToParam: Record<string, string> = {
    COUNTRY: 'country',
    REF_AREA: 'country',
    JURISDICTION: 'country',
    COUNTERPART_AREA: 'counterpart_country',
    FREQUENCY: 'frequency',
    INDICATOR: 'indicator',
    CLASSIFICATION: 'indicator',
    SERIES: 'indicator',
    ITEM: 'indicator',
    SECTOR: 'sector',
    BOP_ACCOUNTING_ENTRY: 'accounting_entry',
    ACCOUNTING_ENTRY: 'accounting_entry',
    TYPE_OF_TRANSFORMATION: 'transform',
    PRICE_TYPE: 'price_type',
    S_ADJUSTMENT: 'seasonal_adjustment',
    UNIT_MEASURE: 'unit',
    UNIT_MULT: 'unit_multiplier',
    TIME_PERIOD: 'time_period',
  }
  let out = message
  for (const [code, name] of Object.entries(dimToParam)) {
    out = out.split(`'${code}'`).join(`'${name}'`).split(`"${code}"`).join(`"${name}"`).split(`dimension '${code}'`).join(`'${name}' parameter`).split(`${code} codes`).join(`${name} codes`)
  }
  for (const [api, user] of Object.entries({ "'A'": "'annual'", "'Q'": "'quarter'", "'M'": "'month'", '"A"': '"annual"', '"Q"': '"quarter"', '"M"': '"month"' })) out = out.split(api).join(user)
  return out
}

export { requireDataflow }
