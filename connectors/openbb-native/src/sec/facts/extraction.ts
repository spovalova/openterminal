// Row-level value extraction from SEC XBRL facts, provider sec. Ported from
// openbb_sec/utils/statement_schema/_extraction.py (OpenBB Platform 5.0.0, Apache-2.0); modified: dicts keyed by tuples are
// Maps keyed by JSON, entries are identified by object identity, and Decimal restating is exact exponent shifting.
import { FILER_SCALES, NET_POSITIONS, NONNEGATIVE_CONCEPTS, SCALE_SPAN, SCALED_FILING_MIN, WEIGHTED_SHARE_CONCEPTS } from './rules.js'
import { daysBetween, isclose, maxStr, median, minStr, mustDay } from './py.js'
import {
  ALL_FORMS,
  ANNUAL_FORMS,
  ANNUAL_PERIOD_FORMS,
  PRELIMINARY_FORMS,
  SEMI_ANNUAL_FORMS,
  markScaled,
  sourceTag,
  type FactEntry,
  type Facts,
  type Frequency,
  type RowDef,
} from './types.js'

/** Find the best unit data array from a tag's units dict (`_get_unit_data`). */
export function getUnitData(tagData: FactEntry, unitType = 'monetary', currency = 'USD'): FactEntry[] | null {
  const units = (tagData.units ?? {}) as Record<string, FactEntry[]>

  if (unitType === 'shares') {
    if ('shares' in units) return units.shares!
  } else if (unitType === 'per_share') {
    const perShareKey = `${currency}/shares`
    if (perShareKey in units) return units[perShareKey]!
    for (const key of Object.keys(units)) if (key.startsWith(`${currency}/`)) return units[key]!
  } else if (currency in units) {
    return units[currency]!
  }

  const first = Object.values(units)[0]
  return first !== undefined ? first : null
}

const EXPONENTS = FILER_SCALES.map((s) => Math.round(Math.log10(s)))
type Periods = Map<string, FactEntry[]>

/** `Decimal(str(val)) * 10**k`: the value with its decimal exponent shifted, exactly. */
function restated(val: number, k: number): number {
  const [mantissa, exponent] = val.toExponential().split('e')
  return Number(`${mantissa}e${Number(exponent) + k}`)
}

/** True when val is 1,000 or 1,000,000 times other, or other that many times val. */
function scaled(val: number, other: number): boolean {
  return EXPONENTS.some((x) => isclose(val * 10 ** x, other, 1e-3) || isclose(val, other * 10 ** x, 1e-3))
}

type SeriesKey = { ns: string; tag: string; unit: string }

/** {(accession, shares): exponent} for filings whose values are mostly off by a filer scale. */
function filingFactors(groups: { key: SeriesKey; periods: Periods }[]): Map<string, number> {
  const offsets = new Map<string, Map<number, number>>()
  const fkey = (accn: string, shares: boolean) => JSON.stringify([accn, shares])

  for (const { key, periods } of groups) {
    for (const group of periods.values()) {
      const byAccn = new Map<string, number>()
      for (const e of group) byAccn.set(e.accn ?? '', Math.abs(e.val))
      if (byAccn.size < 2) continue

      for (const [accn, val] of byAccn) {
        const other = median([...byAccn].filter(([a]) => a !== accn).map(([, v]) => v))
        let offset = 0
        search: for (const x of EXPONENTS) {
          for (const k of [x, -x]) {
            if (isclose(val * 10 ** k, other, 1e-3)) {
              offset = k
              break search
            }
          }
        }
        const id = fkey(accn, key.unit === 'shares')
        if (!offsets.has(id)) offsets.set(id, new Map())
        const counts = offsets.get(id)!
        counts.set(offset, (counts.get(offset) ?? 0) + 1)
      }
    }
  }

  const factors = new Map<string, number>()
  for (const [filing, counts] of offsets) {
    let offset = 0
    let count = -1
    for (const [o, c] of counts) {
      if (c > count) {
        offset = o
        count = c
      }
    }
    let total = 0
    for (const c of counts.values()) total += c
    if (offset && total >= SCALED_FILING_MIN && count * 2 > total) factors.set(filing, offset)
  }
  return factors
}

/** {accession: cover-page share count} for counts within SCALE_SPAN of those filed within a year. */
function coverCounts(facts: Facts): Map<string, number> {
  const filed = new Map<string, [number, number]>()
  const entries: FactEntry[] = facts.dei?.EntityCommonStockSharesOutstanding?.units?.shares ?? []

  for (const entry of entries) {
    if ((entry.val ?? 0) > 0 && entry.accn && entry.filed) {
      const count = Math.max(filed.get(entry.accn)?.[1] ?? 0, entry.val)
      filed.set(entry.accn, [mustDay(entry.filed), count])
    }
  }

  const cover = new Map<string, number>()
  for (const [accn, [date, count]] of filed) {
    const near: number[] = []
    for (const [a, [d, c]] of filed) if (a !== accn && Math.abs(d - date) <= 366) near.push(Math.log10(c))
    if (near.length && Math.abs(Math.log10(count) - median(near)) < SCALE_SPAN) cover.set(accn, count)
  }
  return cover
}

/** Restate each value that differs from another filing's value for its period by a filer scale. */
function settleDisputes(periods: Periods, values: Map<FactEntry, number>): void {
  const value = (e: FactEntry): number => (values.has(e) ? values.get(e)! : e.val)

  const disputed = new Map<string, number>()
  const own = new Map<string, number[]>()

  for (const [period, group] of periods) {
    const vals = group.map((e) => Math.abs(value(e)))
    const top = Math.max(...vals)
    if (vals.some((v) => scaled(v, top))) disputed.set(period, top)
  }

  for (const [period, group] of periods) {
    if (!disputed.has(period)) {
      for (const e of group) {
        const accn = e.accn ?? ''
        if (!own.has(accn)) own.set(accn, [])
        own.get(accn)!.push(Math.log10(Math.abs(value(e))))
      }
    }
  }

  if (disputed.size === 0 || own.size === 0) return

  const center = median([...own.values()].flat())

  for (const [period, top] of disputed) {
    const fits = [0, ...EXPONENTS].filter((x) => Math.abs(Math.log10(top) - x - center) < SCALE_SPAN)
    const right = periods.get(period)!.filter((e) => fits.length === 1 && isclose(Math.abs(value(e)) * 10 ** fits[0]!, top, 1e-3))
    if (right.length === 0) continue

    let earliest = right[0]!
    for (const e of right) if ((e.filed ?? '') < (earliest.filed ?? '')) earliest = e
    const chosen = Math.abs(value(earliest))

    for (const e of periods.get(period)!) {
      const logs = own.get(e.accn ?? '')
      if (scaled(Math.abs(value(e)), chosen) && (logs === undefined || Math.abs(Math.log10(Math.abs(value(e))) - median(logs)) >= SCALE_SPAN)) {
        values.set(e, value(e) > 0 ? chosen : -chosen)
      }
    }
  }
}

/**
 * Facts with dollar values and weighted-average share counts at the filer's scale.
 *
 * A filing whose dollar values (or share counts) for periods other filings report are, for most of them, 1/1,000 or
 * 1/1,000,000 of those values or 1,000 or 1,000,000 times them has all its dollar values (or share counts) restated.
 */
export function rescaledFacts(facts: Facts): Facts {
  const series: { key: SeriesKey; entries: FactEntry[] }[] = []
  for (const [ns, nsFacts] of Object.entries(facts)) {
    if (ns === 'dei' || !nsFacts || typeof nsFacts !== 'object') continue
    for (const [tag, tagData] of Object.entries(nsFacts as Record<string, FactEntry>)) {
      for (const [unit, entries] of Object.entries((tagData.units ?? {}) as Record<string, FactEntry[]>)) {
        const upper = unit === unit.toUpperCase() && unit !== unit.toLowerCase()
        if ((unit.length === 3 && upper) || (unit === 'shares' && WEIGHTED_SHARE_CONCEPTS.has(`${ns}:${tag}`))) series.push({ key: { ns, tag, unit }, entries })
      }
    }
  }

  const groups: { key: SeriesKey; periods: Periods }[] = []
  for (const { key, entries } of series) {
    const periods: Periods = new Map()
    for (const entry of entries) {
      if (entry.val && entry.end && ALL_FORMS.has(entry.form)) {
        const pk = JSON.stringify([entry.start ?? null, entry.end])
        if (!periods.has(pk)) periods.set(pk, [])
        periods.get(pk)!.push(entry)
      }
    }
    groups.push({ key, periods })
  }

  const factors = filingFactors(groups)
  const fkey = (accn: unknown, shares: boolean) => JSON.stringify([accn ?? null, shares])
  const values = new Map<FactEntry, number>()
  for (const { key, entries } of series) {
    for (const entry of entries) {
      if (entry.val && factors.has(fkey(entry.accn, key.unit === 'shares'))) values.set(entry, restated(entry.val, factors.get(fkey(entry.accn, key.unit === 'shares'))!))
    }
  }
  const cover = coverCounts(facts)

  for (const { key, entries } of series) {
    if (key.unit !== 'shares') continue
    for (const entry of entries) {
      const count = cover.get(entry.accn ?? '')
      if (!count || !entry.val) continue
      const current = values.has(entry) ? values.get(entry)! : entry.val
      const gap = Math.log10(Math.abs(current)) - Math.log10(count)
      const fits: number[] = []
      for (const x of EXPONENTS) for (const k of [x, -x]) if (Math.abs(gap) >= SCALE_SPAN && Math.abs(gap + k) < SCALE_SPAN) fits.push(k)
      if (fits.length === 1) values.set(entry, restated(current, fits[0]!))
    }
  }

  for (const { periods } of groups) settleDisputes(periods, values)

  const result: Facts = { ...facts }
  const copiedNs = new Set<string>()
  const copiedTags = new Set<string>()

  for (const { key, entries } of series) {
    if (!entries.some((e) => values.has(e))) continue
    const { ns, tag, unit } = key
    if (!copiedNs.has(ns)) {
      result[ns] = { ...facts[ns] }
      copiedNs.add(ns)
    }
    const tk = `${ns}\u0000${tag}`
    if (!copiedTags.has(tk)) {
      result[ns][tag] = { ...facts[ns][tag], units: { ...facts[ns][tag].units } }
      copiedTags.add(tk)
    }
    result[ns][tag].units[unit] = entries.map((e) => (values.has(e) ? { ...e, val: values.get(e) } : e))
  }
  return markScaled(result)
}

type AnnualValue = [start: string, value: number, source: string]

/** {fy_end_date: (fy_start_date, value, xbrl_source)} for annual periods, resolved at the reference filing when a map is given. */
export function getAnnualValues(
  facts: Facts,
  row: RowDef,
  currency = 'USD',
  includePreliminary = false,
  refFiledMap: Record<string, string> | null = null,
): Map<string, AnnualValue> {
  const result = new Map<string, AnnualValue>()
  if (row.period_type !== 'duration') return result

  const tagCandidates: Map<string, Map<string, [string, number]>>[] = []

  for (const xbrlEntry of row.xbrl_tags) {
    const tagData = facts[xbrlEntry.namespace]?.[xbrlEntry.tag]
    if (!tagData) {
      tagCandidates.push(new Map())
      continue
    }
    const unitData = getUnitData(tagData, row.unit, currency)
    if (!unitData || unitData.length === 0) {
      tagCandidates.push(new Map())
      continue
    }

    const entriesByDate = new Map<string, Map<string, [string, number]>>()
    const qualified = `${xbrlEntry.namespace}:${xbrlEntry.tag}`
    const netSide = NET_POSITIONS[qualified]
    const magnitude = NONNEGATIVE_CONCEPTS.has(qualified)
    const allowed = includePreliminary ? new Set([...ANNUAL_PERIOD_FORMS, ...PRELIMINARY_FORMS]) : ANNUAL_PERIOD_FORMS

    for (const entry of unitData) {
      if (!allowed.has(entry.form ?? '')) continue
      const start: string = entry.start ?? ''
      const end: string = entry.end ?? ''
      if (!start || !end || start === end) continue
      const days = daysBetween(end, start)
      if (days === null) continue
      if (!(days >= 300 && days <= 400)) continue
      const val = entry.val
      if (val === null || val === undefined || (val < 0 && netSide !== undefined && netSide === row.balance)) continue
      const filed: string = entry.filed ?? ''
      if (!entriesByDate.has(end)) entriesByDate.set(end, new Map())
      const byFiled = entriesByDate.get(end)!
      if (!byFiled.has(filed)) byFiled.set(filed, [start, magnitude ? Math.abs(val) : val])
    }
    tagCandidates.push(entriesByDate)
  }

  const allDates = new Set<string>()
  for (const tc of tagCandidates) for (const d of tc.keys()) allDates.add(d)

  for (const endDate of [...allDates].sort()) {
    if (refFiledMap !== null) {
      const refFiled = refFiledMap[endDate]
      if (refFiled === undefined) continue

      let found = false
      for (let i = 0; i < tagCandidates.length; i++) {
        const filings = tagCandidates[i]!.get(endDate)
        if (filings && filings.has(refFiled)) {
          const [start, val] = filings.get(refFiled)!
          const e = row.xbrl_tags[i]!
          result.set(endDate, [start, val, `${e.namespace}:${e.tag}`])
          found = true
          break
        }
      }
      if (!found) {
        for (let i = 0; i < tagCandidates.length; i++) {
          const filings = tagCandidates[i]!.get(endDate)
          if (filings && filings.size) {
            const before = [...filings.keys()].filter((f) => f <= refFiled)
            const best = before.length ? maxStr(before) : minStr(filings.keys())
            const [start, val] = filings.get(best)!
            const e = row.xbrl_tags[i]!
            result.set(endDate, [start, val, `${e.namespace}:${e.tag}(fallback)`])
            break
          }
        }
      }
      continue
    }

    let refFiled: string | null = null
    for (const tc of tagCandidates) {
      const filings = tc.get(endDate)
      if (filings && filings.size) {
        const earliest = minStr(filings.keys())
        if (refFiled === null || earliest < refFiled) refFiled = earliest
      }
    }
    if (refFiled === null) continue

    for (let i = 0; i < tagCandidates.length; i++) {
      const filings = tagCandidates[i]!.get(endDate)
      if (filings && filings.has(refFiled)) {
        const [start, val] = filings.get(refFiled)!
        const e = row.xbrl_tags[i]!
        result.set(endDate, [start, val, `${e.namespace}:${e.tag}`])
        break
      }
    }
  }
  return result
}

/** {fy_end_date: Q4_value} derived via FY - YTD_9mo (`_get_ytd9_values`). Kept for parity with the Python module. */
export function getYtd9Values(facts: Facts, row: RowDef, currency = 'USD'): Map<string, number> {
  const result = new Map<string, number>()
  if (row.period_type !== 'duration') return result

  const annualEntries = new Map<string, Map<string, [string, number]>>()
  const ytd9Entries = new Map<string, Map<string, number>>()

  for (const xbrlEntry of row.xbrl_tags) {
    const tagData = facts[xbrlEntry.namespace]?.[xbrlEntry.tag]
    if (!tagData) continue
    const unitData = getUnitData(tagData, row.unit, currency)
    if (!unitData || unitData.length === 0) continue

    for (const entry of unitData) {
      const start: string = entry.start ?? ''
      const end: string = entry.end ?? ''
      if (!start || !end || start === end) continue
      const days = daysBetween(end, start)
      if (days === null) continue
      const val = entry.val
      if (val === null || val === undefined) continue
      const filed: string = entry.filed ?? ''

      if (days >= 300 && days <= 400) {
        if (!annualEntries.has(end)) annualEntries.set(end, new Map())
        if (!annualEntries.get(end)!.has(filed)) annualEntries.get(end)!.set(filed, [start, val])
      } else if (days >= 240 && days <= 310) {
        if (!ytd9Entries.has(end)) ytd9Entries.set(end, new Map())
        if (!ytd9Entries.get(end)!.has(filed)) ytd9Entries.get(end)!.set(filed, val)
      }
    }
    if (annualEntries.size || ytd9Entries.size) break
  }

  if (annualEntries.size === 0 || ytd9Entries.size === 0) return result

  for (const [fyEnd, fyFilings] of annualEntries) {
    let ytdEndMatch: string | null = null
    for (const ytdEnd of ytd9Entries.keys()) {
      for (const [fyStart] of fyFilings.values()) {
        if (fyStart < ytdEnd && ytdEnd < fyEnd) {
          ytdEndMatch = ytdEnd
          break
        }
      }
      if (ytdEndMatch) break
    }
    if (!ytdEndMatch) continue

    const ytdFilings = ytd9Entries.get(ytdEndMatch)!
    const common = [...fyFilings.keys()].filter((f) => ytdFilings.has(f))
    let fyVal: number
    let ytdVal: number
    if (common.length) {
      const best = maxStr(common)
      fyVal = fyFilings.get(best)![1]
      ytdVal = ytdFilings.get(best)!
    } else {
      fyVal = fyFilings.get(maxStr(fyFilings.keys()))![1]
      ytdVal = ytdFilings.get(maxStr(ytdFilings.keys()))!
    }
    result.set(fyEnd, fyVal - ytdVal)
  }
  return result
}

/** Extract values for a single schema row across all periods. Returns `[values_by_date, sources_by_date]`. */
export function extractRowValues(
  facts: Facts,
  row: RowDef,
  frequency: Frequency = 'annual',
  currency = 'USD',
  refFiledMap: Record<string, string> | null = null,
  crossTargets: Record<string, number> | null = null,
  statement = '',
  includePreliminary = false,
  annualRefMap: Record<string, string> | null = null,
): [Record<string, number>, Record<string, string>] {
  const periodType = row.period_type
  const valuesByDate: Record<string, number> = {}
  const sourcesByDate: Record<string, string> = {}
  const baseForms = frequency === 'annual' ? ANNUAL_PERIOD_FORMS : ALL_FORMS
  const allowedForms = includePreliminary ? new Set([...baseForms, ...PRELIMINARY_FORMS]) : baseForms
  const tagCandidates: Map<string, Map<string, number>>[] = []
  const collectYtd = frequency === 'quarterly' && periodType === 'duration' && row.unit !== 'shares'
  const ytdTagCandidates: Map<string, Map<string, [string, number]>>[] = []

  for (const xbrlEntry of row.xbrl_tags) {
    const tagData = facts[xbrlEntry.namespace]?.[xbrlEntry.tag]
    if (!tagData) {
      tagCandidates.push(new Map())
      if (collectYtd) ytdTagCandidates.push(new Map())
      continue
    }
    const unitData = getUnitData(tagData, row.unit, currency)
    if (!unitData || unitData.length === 0) {
      tagCandidates.push(new Map())
      if (collectYtd) ytdTagCandidates.push(new Map())
      continue
    }

    const entriesByDate = new Map<string, Map<string, number>>()
    const durByDate = new Map<string, Map<string, number>>()
    const ytdEntriesByDate = new Map<string, Map<string, [string, number]>>()
    const qualified = `${xbrlEntry.namespace}:${xbrlEntry.tag}`
    const netSide = NET_POSITIONS[qualified]
    const magnitude = NONNEGATIVE_CONCEPTS.has(qualified)

    for (const entry of unitData) {
      const form: string = entry.form ?? ''
      if (!allowedForms.has(form)) continue
      const endDate: string = entry.end ?? ''
      if (!endDate) continue

      let days = 0
      if (periodType === 'duration') {
        const startDate: string = entry.start ?? ''
        if (!startDate || startDate === endDate) continue
        const d = daysBetween(endDate, startDate)
        if (d === null) continue
        days = d

        if (frequency === 'annual') {
          if (!(days >= 300 && days <= 400)) continue
        } else if (SEMI_ANNUAL_FORMS.has(form)) {
          if (!((days >= 60 && days <= 135) || (days >= 150 && days <= 200) || (days >= 240 && days <= 310))) continue
        } else if (ANNUAL_FORMS.has(form) && row.unit === 'monetary') {
          continue
        } else if (!(days >= 60 && days <= 135)) {
          if (collectYtd && days >= 136 && days <= 310) {
            let ytdVal = entry.val
            if (ytdVal !== null && ytdVal !== undefined && magnitude) ytdVal = Math.abs(ytdVal)
            if (ytdVal !== null && ytdVal !== undefined && !(ytdVal < 0 && netSide !== undefined && netSide === row.balance)) {
              const filed: string = entry.filed ?? ''
              if (!ytdEntriesByDate.has(endDate)) ytdEntriesByDate.set(endDate, new Map())
              if (!ytdEntriesByDate.get(endDate)!.has(filed)) ytdEntriesByDate.get(endDate)!.set(filed, [startDate, ytdVal])
            }
          }
          continue
        }
      } else if ((entry.start ?? endDate) !== endDate) {
        continue
      }

      let val = entry.val
      if (val === null || val === undefined || (val < 0 && netSide !== undefined && netSide === row.balance)) continue
      if (magnitude) val = Math.abs(val)

      const filed: string = entry.filed ?? ''
      if (!entriesByDate.has(endDate)) {
        entriesByDate.set(endDate, new Map())
        durByDate.set(endDate, new Map())
      }
      const byFiled = entriesByDate.get(endDate)!
      const durs = durByDate.get(endDate)!
      if (!byFiled.has(filed) || days < (durs.get(filed) ?? 9999)) {
        byFiled.set(filed, val)
        durs.set(filed, days)
      }
    }

    tagCandidates.push(entriesByDate)
    if (collectYtd) ytdTagCandidates.push(ytdEntriesByDate)
  }

  const allDates = new Set<string>()
  const rankByDate: Record<string, number> = {}
  const nTags = row.xbrl_tags.length
  for (const tc of tagCandidates) for (const d of tc.keys()) allDates.add(d)

  for (const endDate of [...allDates].sort()) {
    let refFiled: string | null | undefined
    if (refFiledMap !== null) {
      refFiled = refFiledMap[endDate]
    } else {
      refFiled = null
      for (const tc of tagCandidates) {
        const filings = tc.get(endDate)
        if (filings && filings.size) {
          const earliest = minStr(filings.keys())
          if (refFiled === null || earliest < refFiled) refFiled = earliest
        }
      }
    }
    if (refFiled === null || refFiled === undefined) continue

    let matchedIdentity = false
    if (crossTargets && endDate in crossTargets) {
      const targetVal = crossTargets[endDate]!
      for (let i = 0; i < tagCandidates.length; i++) {
        const filings = tagCandidates[i]!.get(endDate)
        if (!filings || filings.size === 0) continue
        for (const val of filings.values()) {
          if (isclose(val, targetVal, 1e-5, 1.0)) {
            valuesByDate[endDate] = val
            rankByDate[endDate] = i
            const e = row.xbrl_tags[i]!
            sourcesByDate[endDate] = `${e.namespace}:${e.tag}(identity_lock:${statement})`
            matchedIdentity = true
            break
          }
        }
        if (matchedIdentity) break
      }
    }
    if (matchedIdentity) continue

    let resolved = false
    for (let i = 0; i < tagCandidates.length; i++) {
      const filings = tagCandidates[i]!.get(endDate)
      if (filings && filings.has(refFiled)) {
        valuesByDate[endDate] = filings.get(refFiled)!
        rankByDate[endDate] = i
        const e = row.xbrl_tags[i]!
        sourcesByDate[endDate] = `${e.namespace}:${e.tag}`
        resolved = true
        break
      }
    }
    if (!resolved) {
      for (let i = 0; i < tagCandidates.length; i++) {
        const filings = tagCandidates[i]!.get(endDate)
        if (filings && filings.size) {
          const before = [...filings.keys()].filter((f) => f <= refFiled!)
          const best = before.length ? maxStr(before) : minStr(filings.keys())
          valuesByDate[endDate] = filings.get(best)!
          rankByDate[endDate] = nTags + i
          const e = row.xbrl_tags[i]!
          sourcesByDate[endDate] = `${e.namespace}:${e.tag}(fallback)`
          break
        }
      }
    }
  }

  const nineMonths = new Map<string, [string, number, string]>()

  const conceptAnnual = (concept: string | null, fyEnd: string): AnnualValue | undefined => {
    const chain = row.xbrl_tags.filter((x) => `${x.namespace}:${x.tag}` === concept)
    return getAnnualValues(facts, { ...row, xbrl_tags: chain }, currency, includePreliminary, annualRefMap).get(fyEnd)
  }

  if (frequency === 'quarterly' && periodType === 'duration') {
    const annualVals = getAnnualValues(facts, row, currency, includePreliminary, annualRefMap)

    if (collectYtd && ytdTagCandidates.length) {
      const ytdResolved = new Map<string, [string, number, string]>()
      const ytdRank: Record<string, number> = {}
      const ytdAllDates = new Set<string>()
      for (const ytc of ytdTagCandidates) for (const d of ytc.keys()) ytdAllDates.add(d)

      for (const endDate of [...ytdAllDates].sort()) {
        let ref: string | null | undefined
        if (refFiledMap !== null) {
          ref = refFiledMap[endDate]
        } else {
          ref = null
          for (const ytc of ytdTagCandidates) {
            const fdata = ytc.get(endDate)
            if (fdata && fdata.size) {
              const earliest = minStr(fdata.keys())
              if (ref === null || earliest < ref) ref = earliest
            }
          }
        }
        if (ref === null || ref === undefined) continue

        let chosen = ytdTagCandidates.findIndex((ytc) => ytc.get(endDate)?.has(ref!))
        if (chosen < 0) chosen = ytdTagCandidates.findIndex((ytc) => (ytc.get(endDate)?.size ?? 0) > 0)
        if (chosen < 0) throw new Error('StopIteration')

        const fdata = ytdTagCandidates[chosen]!.get(endDate)!
        let startD: string
        let val: number
        if (fdata.has(ref)) {
          ;[startD, val] = fdata.get(ref)!
          ytdRank[endDate] = chosen
        } else {
          const before = [...fdata.keys()].filter((f) => f <= ref!)
          const best = before.length ? maxStr(before) : minStr(fdata.keys())
          ;[startD, val] = fdata.get(best)!
          ytdRank[endDate] = nTags + chosen
        }
        const e = row.xbrl_tags[chosen]!
        ytdResolved.set(endDate, [startD, val, `${e.namespace}:${e.tag}`])
      }

      if (ytdResolved.size) {
        const byFyStart = new Map<string, [string, number, string][]>()
        for (const [endD, [startD, val, src]] of ytdResolved) {
          if (!byFyStart.has(startD)) byFyStart.set(startD, [])
          byFyStart.get(startD)!.push([endD, val, src])
        }

        const fyBoundaries = new Map<string, string>()
        for (const [fyEnd, [fyStart]] of annualVals) fyBoundaries.set(fyStart, fyEnd)

        for (const [fyStart, ytdList] of byFyStart) {
          ytdList.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1] || (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0)))
          const ytdMap = new Map<string, [number, string]>()
          for (const [d, v, s] of ytdList) ytdMap.set(d, [v, s])
          const fyEnd = fyBoundaries.get(fyStart)

          let fyQDates: string[]
          if (fyEnd) {
            fyQDates = Object.keys(valuesByDate).filter((d) => fyStart < d && d < fyEnd).sort()
          } else {
            const latestYtd = ytdList[ytdList.length - 1]![0]
            fyQDates = Object.keys(valuesByDate).filter((d) => fyStart < d && d <= latestYtd).sort()
          }

          const allQDates = [...new Set([...fyQDates, ...ytdMap.keys()])].sort()

          let prevCum = 0
          let prevTag: number | null = null
          let prevEnd = fyStart
          let contiguous: boolean = true

          for (const [d, v, s] of ytdList) {
            const span = mustDay(d) - mustDay(fyStart)
            if (span >= 240 && span <= 310) nineMonths.set(fyStart, [d, v, s])
          }

          for (const d of allQDates) {
            const hasYtd = ytdMap.has(d)
            const adjacent: boolean = contiguous && mustDay(d) - mustDay(prevEnd) <= 135
            const hasStandalone = d in valuesByDate && !(hasYtd && ytdRank[d]! < (d in rankByDate ? rankByDate[d]! : -1) && prevTag === ytdRank[d]! % nTags)

            if (!hasStandalone && hasYtd && adjacent) {
              const [ytdVal, ytdSrc] = ytdMap.get(d)!
              valuesByDate[d] = ytdVal - prevCum
              sourcesByDate[d] = `ytd_derived(${ytdSrc})`
            }

            if (hasYtd) {
              prevCum = ytdMap.get(d)![0]
              prevTag = ytdRank[d]! % nTags
              contiguous = true
            } else if (hasStandalone) {
              prevCum += valuesByDate[d]!
              prevTag = d in rankByDate ? rankByDate[d]! % nTags : -1
              contiguous = adjacent
            }
            prevEnd = d
          }
        }
      }
    }

    if (row.unit === 'monetary') {
      for (const [fyEnd, [fyStart, fyVal, fyXbrlSrc]] of annualVals) {
        let qSum = 0
        let qCount = 0
        for (const [qEnd, qVal] of Object.entries(valuesByDate)) {
          if (fyStart < qEnd && qEnd < fyEnd) {
            qSum += qVal
            qCount += 1
          }
        }
        if (qCount === 3) {
          const qSrcs = Object.keys(valuesByDate)
            .sort()
            .filter((qEnd) => fyStart < qEnd && qEnd < fyEnd)
            .map((qEnd) => sourcesByDate[qEnd] ?? '')
          const qTags = new Set(qSrcs.map(sourceTag))
          let baseVal = fyVal
          let baseSrc = fyXbrlSrc

          if (qTags.size === 1 && !qTags.has(null) && !(qTags.size === 1 && qTags.has(sourceTag(fyXbrlSrc)))) {
            const own = conceptAnnual([...qTags][0]!, fyEnd)
            if (own !== undefined) {
              baseVal = own[1]
              baseSrc = own[2]
            }
          }

          const qLabels = qSrcs.map((s, i) => `Q${i + 1}[${s}]`).join('+')
          valuesByDate[fyEnd] = baseVal - qSum
          sourcesByDate[fyEnd] = `Q4: FY[${baseSrc}] − (${qLabels})`
        } else if (nineMonths.has(fyStart) && fyStart < nineMonths.get(fyStart)![0] && nineMonths.get(fyStart)![0] < fyEnd) {
          const [, nineVal, nineSrc] = nineMonths.get(fyStart)!
          const base = sourceTag(fyXbrlSrc) === nineSrc ? ([fyStart, fyVal, fyXbrlSrc] as AnnualValue) : conceptAnnual(nineSrc, fyEnd)
          if (base !== undefined) {
            valuesByDate[fyEnd] = base[1] - nineVal
            sourcesByDate[fyEnd] = `Q4: FY[${base[2]}] − 9M[${nineSrc}]`
          }
        } else if (qCount === 1) {
          const interimDate = Object.keys(valuesByDate).find((qEnd) => fyStart < qEnd && qEnd < fyEnd)!
          const fyDays = mustDay(fyEnd) - mustDay(fyStart)
          const interimDays = mustDay(interimDate) - mustDay(fyStart)
          if (Math.abs(interimDays - fyDays / 2) <= 45) {
            const h1Src = sourcesByDate[interimDate] ?? ''
            valuesByDate[fyEnd] = fyVal - qSum
            sourcesByDate[fyEnd] = `H2: FY[${fyXbrlSrc}] − H1[${h1Src}]`
          }
        }
      }
    }
  }

  return [valuesByDate, sourcesByDate]
}

/** The reference filing date per end_date across all rows. */
export function computeRefFilings(
  facts: Facts,
  rowsDef: RowDef[],
  frequency: Frequency,
  currency: string,
  includePreliminary = false,
  pitMode = false,
): Record<string, string> {
  const baseForms = frequency === 'annual' ? ANNUAL_PERIOD_FORMS : ALL_FORMS
  const allowedForms = includePreliminary ? new Set([...baseForms, ...PRELIMINARY_FORMS]) : baseForms
  const refMap: Record<string, string> = {}

  for (const rowDef of rowsDef) {
    const periodType = rowDef.period_type
    for (const xbrlEntry of rowDef.xbrl_tags) {
      const tagData = facts[xbrlEntry.namespace]?.[xbrlEntry.tag]
      if (!tagData) continue
      const unitData = getUnitData(tagData, rowDef.unit, currency)
      if (!unitData || unitData.length === 0) continue

      for (const entry of unitData) {
        const form: string = entry.form ?? ''
        if (!allowedForms.has(form)) continue
        const endDate: string = entry.end ?? ''
        if (!endDate) continue

        if (periodType === 'duration') {
          const startDate: string = entry.start ?? ''
          if (!startDate || startDate === endDate) continue
          const days = daysBetween(endDate, startDate)
          if (days === null) continue

          if (frequency === 'annual') {
            if (!(days >= 300 && days <= 400)) continue
          } else if (SEMI_ANNUAL_FORMS.has(form)) {
            if (!((days >= 60 && days <= 135) || (days >= 150 && days <= 200) || (days >= 240 && days <= 310))) continue
          } else if ((ANNUAL_FORMS.has(form) && rowDef.unit === 'monetary') || !(days >= 60 && days <= 135)) {
            continue
          }
        } else if ((entry.start ?? endDate) !== endDate) {
          continue
        }

        const filed: string = entry.filed ?? ''
        if (!filed) continue

        if (!pitMode) {
          const gap = daysBetween(filed, endDate)
          if (gap === null) continue
          if (gap > 450) continue
        }

        if (!(endDate in refMap) || (pitMode && filed < refMap[endDate]!) || (!pitMode && filed > refMap[endDate]!)) refMap[endDate] = filed
      }
    }
  }
  return refMap
}
