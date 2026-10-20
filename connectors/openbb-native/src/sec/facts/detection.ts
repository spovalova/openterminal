// Company type detection, filing-date resolution and fiscal metadata, provider sec. Ported from
// openbb_sec/utils/statement_schema/_detection.py (OpenBB Platform 5.0.0, Apache-2.0); modified: dates are day numbers,
// counters are Maps, and the clock (`datetime.now().year`) is a parameter the caller takes from ctx.now().
import { addDays, dateParts, dayNum, dayString, daysBetween, mustDay, pyRound, maxStr } from './py.js'
import {
  ALL_FORMS,
  ANNUAL_FORMS,
  ANNUAL_PERIOD_FORMS,
  PRELIMINARY_FORMS,
  QUARTERLY_FORMS,
  SEMI_ANNUAL_FORMS,
  SUPERSEDED_SUFFIX,
  markPreliminary,
  type CompanyType,
  type FactEntry,
  type Facts,
  type Frequency,
} from './types.js'

export type DetectionSignals = {
  insuranceIsSignals: string[]
  insuranceBsSignals: string[]
  financialSignals: string[]
  minFinancialSignals: number
  industrialSignals: string[]
  diversifiedSignals: string[]
  revenueMeasures: string[]
  insuranceMeasures: string[]
  financialMeasures: string[]
  minInsuranceShare: number
  minFinancialShare: number
}

/** The units of a tag as `[unit, entries]`. */
function unitsOf(tagData: FactEntry): [string, FactEntry[]][] {
  return Object.entries((tagData.units ?? {}) as Record<string, FactEntry[]>)
}

/** Classify a company as industrial, financial, diversified, or insurance. */
export function detectType(facts: Facts, sig: DetectionSignals, nowYear: number): CompanyType {
  const companyTags = new Set<string>()
  for (const nsData of Object.values(facts)) if (nsData && typeof nsData === 'object') for (const k of Object.keys(nsData)) companyTags.add(k)

  const hasCogs = sig.industrialSignals.some((s) => companyTags.has(s) && hasRecentData(facts, s, nowYear))
  const [revenue, shares] = latestAnnualShares(facts, sig.revenueMeasures, { insurance: sig.insuranceMeasures, financial: sig.financialMeasures })
  const insuranceShare = shares.insurance ?? null
  const financialShare = shares.financial ?? null
  const insIs = sig.insuranceIsSignals.filter((s) => companyTags.has(s)).length
  const insBs = sig.insuranceBsSignals.filter((s) => companyTags.has(s)).length
  const insTotal = insIs + insBs
  const isInsurance = insIs >= 1 && insTotal >= 2 && (revenue === null || (insuranceShare !== null && insuranceShare >= sig.minInsuranceShare))
  const finCount = sig.financialSignals.filter((s) => companyTags.has(s)).length
  const isFinancial = finCount >= sig.minFinancialSignals && ((revenue === null && !hasCogs) || (financialShare !== null && financialShare >= sig.minFinancialShare))

  if (isInsurance && isFinancial) return insTotal > finCount ? 'insurance' : 'financial'
  if (isInsurance) return 'insurance'
  if (isFinancial) return 'financial'
  if (hasCogs) return 'industrial'
  if (sig.diversifiedSignals.some((s) => companyTags.has(s))) return 'diversified'
  return 'industrial'
}

/** Revenue and each measure group's share of it in the latest annual filing that reports revenue. */
function latestAnnualShares(facts: Facts, revenueMeasures: string[], measureGroups: Record<string, string[]>): [number | null, Record<string, number | null>] {
  let latest: [string, string, string, string] | null = null
  const revenueValues = new Map<string, number>()
  const keyOf = (accn: string, end: string, unit: string) => JSON.stringify([accn, end, unit])

  for (const nsData of Object.values(facts)) {
    if (!nsData || typeof nsData !== 'object') continue
    for (const tag of revenueMeasures) {
      for (const [unit, entries] of unitsOf(nsData[tag] ?? {})) {
        for (const entry of entries) {
          const start: string = entry.start ?? ''
          const end: string = entry.end ?? ''
          if (!ANNUAL_FORMS.has(entry.form ?? '') || !start || !end) continue
          const days = daysBetween(end, start)
          if (days === null) throw new Error(`time data does not match format '%Y-%m-%d': ${start} ${end}`)
          if (!(days >= 300 && days <= 400)) continue
          const accn: string = entry.accn ?? ''
          const key = keyOf(accn, end, unit)
          const val = entry.val
          if (val === null || val === undefined) continue
          if (!revenueValues.has(key) || Math.abs(val) > Math.abs(revenueValues.get(key)!)) revenueValues.set(key, val)
          const candidate: [string, string, string, string] = [entry.filed ?? '', accn, end, unit]
          if (latest === null || tupleGreater(candidate.slice(0, 3), latest.slice(0, 3))) latest = candidate
        }
      }
    }
  }

  const empty: Record<string, number | null> = Object.fromEntries(Object.keys(measureGroups).map((g) => [g, null]))
  if (latest === null) return [null, empty]
  const [, accn, end, unit] = latest
  const revenue = revenueValues.get(keyOf(accn, end, unit))
  if (!revenue) return [null, empty]

  const shares: Record<string, number | null> = {}
  for (const [group, tags] of Object.entries(measureGroups)) {
    const found: number[] = []
    for (const nsData of Object.values(facts)) {
      if (!nsData || typeof nsData !== 'object') continue
      for (const tag of tags) {
        for (const entry of (nsData[tag]?.units?.[unit] ?? []) as FactEntry[]) {
          const start: string = entry.start ?? ''
          if (entry.accn === accn && entry.end === end && start) {
            const days = daysBetween(end, start)
            if (days !== null && days >= 300 && days <= 400 && entry.val !== null && entry.val !== undefined) found.push(entry.val)
          }
        }
      }
    }
    shares[group] = found.length ? Math.max(...found) / revenue : null
  }
  return [revenue, shares]
}

function tupleGreater(a: string[], b: string[]): boolean {
  for (let i = 0; i < a.length; i++) {
    if (a[i]! > b[i]!) return true
    if (a[i]! < b[i]!) return false
  }
  return false
}

/** Check if a tag has data from a recent annual filing. */
function hasRecentData(facts: Facts, tag: string, nowYear: number, maxAgeYears = 5): boolean {
  const cutoffYear = nowYear - maxAgeYears
  for (const nsData of Object.values(facts)) {
    if (!nsData || typeof nsData !== 'object' || !(tag in nsData)) continue
    for (const [, entries] of unitsOf(nsData[tag])) {
      for (const entry of entries) {
        if (ANNUAL_FORMS.has(entry.form ?? '')) {
          const end: string = entry.end ?? ''
          if (end && parseInt(end.slice(0, 4), 10) >= cutoffYear) return true
        }
      }
    }
  }
  return false
}

/** Days from `dt` to the nearest month-day anchor in the adjacent years. */
function anchorDistance(dayNumber: number, year: number, month: number, day: number): number {
  const distances: number[] = []
  for (const y of [year - 1, year, year + 1]) {
    const anchor = dayNum(`${y}-${month}-${day}`) ?? mustDay(`${y}-${month}-${Math.min(day, 28)}`)
    distances.push(Math.abs(dayNumber - anchor))
  }
  return Math.min(...distances)
}

/** Drop interim ends within 7 days of a fiscal-year end or of a better-supported interim end. */
function collapseNearDates(dates: Set<string>, anchors: Set<string>, weights: Map<string, number>): Set<string> {
  const anchorDts = [...anchors].map(mustDay)
  const kept: [string, number][] = []
  const weight = (d: string) => weights.get(d) ?? 0

  for (const date of [...dates].sort()) {
    const dt = mustDay(date)
    if (anchorDts.some((a) => Math.abs(dt - a) <= 7)) continue
    if (kept.length && dt - kept[kept.length - 1]![1] <= 7) {
      if (weight(date) > weight(kept[kept.length - 1]![0])) kept[kept.length - 1] = [date, dt]
      continue
    }
    kept.push([date, dt])
  }
  return new Set(kept.map(([d]) => d))
}

/** Determine canonical period-end dates from facts filed after the period ends. */
export function getFilingDates(facts: Facts, frequency: Frequency = 'annual', includePreliminary = false): Set<string> {
  let filingDates = new Set<string>()
  const preliminaryCandidates = new Set<string>()
  const weights = new Map<string, number>()
  const bump = (end: string) => weights.set(end, (weights.get(end) ?? 0) + 1)

  for (const nsFacts of Object.values(facts)) {
    for (const tagData of Object.values(nsFacts as Record<string, FactEntry>)) {
      for (const [, entries] of unitsOf(tagData)) {
        for (const entry of entries) {
          const form: string = entry.form ?? ''
          const start: string = entry.start ?? ''
          const end: string = entry.end ?? ''
          if (!start || !end || start === end || (entry.filed ?? '') <= end) continue
          const days = daysBetween(end, start)
          if (days === null) continue

          if (frequency === 'annual') {
            if (ANNUAL_PERIOD_FORMS.has(form) && days >= 300 && days <= 400) {
              filingDates.add(end)
              bump(end)
            } else if (includePreliminary && PRELIMINARY_FORMS.has(form) && days >= 300 && days <= 400) {
              preliminaryCandidates.add(end)
            }
          } else {
            if (QUARTERLY_FORMS.has(form) && days >= 60 && days <= 135) {
              filingDates.add(end)
              bump(end)
            }
            if (SEMI_ANNUAL_FORMS.has(form) && ((days >= 60 && days <= 135) || (days >= 150 && days <= 200) || (days >= 240 && days <= 310))) {
              filingDates.add(end)
              bump(end)
            }
            if (includePreliminary && PRELIMINARY_FORMS.has(form) && days >= 60 && days <= 135) preliminaryCandidates.add(end)
          }
        }
      }
    }
  }

  if (includePreliminary) for (const d of preliminaryCandidates) filingDates.add(d)

  if (frequency !== 'annual' && filingDates.size > 0) {
    const canonicalAnnual = getFilingDates(facts, 'annual', includePreliminary)
    let interimDates = new Set([...filingDates].filter((d) => !canonicalAnnual.has(d)))

    // Discontinuity guard: if interim reporting has lapsed (the most recent interim period lags the most recent annual
    // period by more than ~15 months) the quarterly series would be sparse and stale.
    if (interimDates.size && canonicalAnnual.size) {
      const latestAnnual = mustDay(maxStr(canonicalAnnual))
      const latestInterim = mustDay(maxStr(interimDates))
      if (latestAnnual - latestInterim > 460) return new Set()
    }

    interimDates = collapseNearDates(interimDates, canonicalAnnual, weights)
    filingDates = new Set([...interimDates, ...[...filingDates].filter((d) => canonicalAnnual.has(d))])

    // Fold a fiscal year-end into the quarterly series only when that fiscal year actually has at least one interim period.
    const sortedAnnual = [...canonicalAnnual].sort()
    sortedAnnual.forEach((annualEnd, i) => {
      const fyStart = i ? sortedAnnual[i - 1]! : ''
      if ([...interimDates].some((qd) => fyStart < qd && qd < annualEnd)) filingDates.add(annualEnd)
    })
  }

  if (frequency === 'annual' && filingDates.size > 3) {
    const parsed = [...filingDates].sort().map((d) => ({ d, n: mustDay(d), ...dateParts(d) }))
    const monthDay = (p: { month: number; day: number }): [number, number] => [p.month, p.day]
    const cmpPair = (a: [number, number], b: [number, number]) => a[0] - b[0] || a[1] - b[1]
    const anchorKeys = new Map<string, [number, number]>()
    for (const p of parsed) anchorKeys.set(`${p.month}-${p.day}`, monthDay(p))
    const anchors = [...anchorKeys.values()].sort(cmpPair)
    const weight = (d: string) => weights.get(d) ?? 0
    const support = new Map<string, [number, number]>()
    for (const md of anchors) {
      support.set(
        `${md[0]}-${md[1]}`,
        [
          parsed.filter((p) => anchorDistance(p.n, p.year, md[0], md[1]) <= 7).reduce((s, p) => s + weight(p.d), 0),
          parsed.filter((p) => p.month === md[0] && p.day === md[1]).reduce((s, p) => s + weight(p.d), 0),
        ],
      )
    }
    let dom = anchors[0]!
    for (const md of anchors) {
      const a = support.get(`${md[0]}-${md[1]}`)!
      const b = support.get(`${dom[0]}-${dom[1]}`)!
      if (a[0] > b[0] || (a[0] === b[0] && a[1] > b[1])) dom = md
    }
    const [domM, domD] = dom
    const canonicalPairs = parsed.filter((p) => anchorDistance(p.n, p.year, domM, domD) <= 7)

    if (canonicalPairs.length >= Math.max(3, parsed.length * 0.4)) {
      const canonical = new Set(canonicalPairs.map((p) => p.d))
      const canonicalDts = canonicalPairs.map((p) => p.n)
      const nonCanonical = parsed.filter((p) => !canonical.has(p.d))

      const clusters: (typeof parsed)[] = []
      for (const p of [...canonicalPairs].sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0))) {
        const last = clusters[clusters.length - 1]
        if (last && p.n - last[last.length - 1]!.n <= 10) last.push(p)
        else clusters.push([p])
      }

      const filtered = new Set<string>()
      for (const cluster of clusters) {
        let best = cluster[0]!
        const keyOf = (p: (typeof parsed)[number]): [number, number] => [weight(p.d), p.month === domM && p.day === domD ? 1 : 0]
        for (const p of cluster) {
          const a = keyOf(p)
          const b = keyOf(best)
          if (a[0] > b[0] || (a[0] === b[0] && a[1] > b[1])) best = p
        }
        filtered.add(best.d)
      }

      for (const p of nonCanonical) {
        const hasNearby = canonicalDts.some((ct) => Math.abs(p.n - ct) <= 200)
        if (!hasNearby) filtered.add(p.d)
      }
      filingDates = filtered
    }
  }

  let assetsForms: ReadonlySet<string> = frequency === 'quarterly' ? ALL_FORMS : ANNUAL_PERIOD_FORMS
  if (includePreliminary) assetsForms = new Set([...assetsForms, ...PRELIMINARY_FORMS])

  while (filingDates.size > 1) {
    const earliest = [...filingDates].reduce((a, b) => (b < a ? b : a))
    let hasAssets = false
    for (const nsFacts of Object.values(facts)) {
      const assetsData = (nsFacts as Record<string, FactEntry>).Assets ?? {}
      for (const [, entries] of unitsOf(assetsData)) {
        for (const entry of entries) {
          if (assetsForms.has(entry.form ?? '') && entry.end === earliest && !entry.start) {
            hasAssets = true
            break
          }
        }
        if (hasAssets) break
      }
      if (hasAssets) break
    }
    if (!hasAssets) filingDates.delete(earliest)
    else break
  }

  return filingDates
}

/** Calendar year of the day 45 days before a fiscal year end. */
function referenceYear(date: string): number {
  return dateParts(addDays(date, -45)).year
}

/** Fiscal year per annual period end from the original annual filing that reports it after it ends. */
export function annualFiscalYears(facts: Facts, annualDates: Set<string>): Record<string, number> {
  const periodEnd = new Map<string, string>()
  const first = new Map<string, [string, string, number]>()

  for (const [namespace, nsFacts] of Object.entries(facts)) {
    if (namespace === 'dei' || !nsFacts || typeof nsFacts !== 'object') continue
    for (const tagData of Object.values(nsFacts as Record<string, FactEntry>)) {
      for (const [, entries] of unitsOf(tagData)) {
        for (const entry of entries) {
          const start: string = entry.start ?? ''
          const end: string = entry.end ?? ''
          const filed: string = entry.filed ?? ''
          if (!ANNUAL_FORMS.has(entry.form ?? '') || !start || !end || filed <= end) continue
          const days = daysBetween(end, start)
          if (days === null) continue
          if (!(days >= 300 && days <= 400)) continue

          const filing: string = entry.accn || filed
          if (end > (periodEnd.get(filing) ?? '')) periodEnd.set(filing, end)
          const fy = entry.fy
          if (annualDates.has(end) && fy !== null && fy !== undefined) {
            const prev = first.get(end)
            if (!prev || filed < prev[0] || (filed === prev[0] && filing < prev[1])) first.set(end, [filed, filing, fy])
          }
        }
      }
    }
  }

  const years: Record<string, number> = {}
  for (const [end, [, filing, fy]] of first) years[end] = fy - pyRound((mustDay(periodEnd.get(filing)!) - mustDay(end)) / 365.25)

  const offsets = new Map<number, number>()
  for (const [end, year] of Object.entries(years)) {
    const k = year - referenceYear(end)
    offsets.set(k, (offsets.get(k) ?? 0) + 1)
  }
  let offset = 0
  if (offsets.size) {
    const keys = [...offsets.keys()].sort((a, b) => a - b)
    offset = keys[0]!
    for (const k of keys) if (offsets.get(k)! > offsets.get(offset)!) offset = k
  }
  const ordered = [...annualDates].sort()
  for (const end of ordered) if (!(end in years)) years[end] = referenceYear(end) + offset

  ordered.forEach((end, i) => {
    const expected = referenceYear(end) + offset
    if (years[end] === expected) return
    if ((i > 0 && years[ordered[i - 1]!]! >= years[end]!) || (i + 1 < ordered.length && years[ordered[i + 1]!]! <= years[end]!)) years[end] = expected
  })
  return years
}

function bisectLeft(arr: string[], x: string): number {
  let lo = 0
  let hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (arr[mid]! < x) lo = mid + 1
    else hi = mid
  }
  return lo
}

function bisectRight(arr: string[], x: string): number {
  let lo = 0
  let hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (x < arr[mid]!) hi = mid
    else lo = mid + 1
  }
  return lo
}

/** Fiscal year and quarter number (1-4) of a period end on the fiscal-year-end grid. */
function fiscalPosition(date: string, ends: string[], years: Record<string, number>): [number, number] {
  const dt = mustDay(date)
  const index = Math.min(bisectLeft(ends, date), ends.length - 1)
  let fye = mustDay(ends[index]!)
  let fiscalYear = years[ends[index]!]!

  while (fye - dt >= 355) {
    fye -= 365
    fiscalYear -= 1
  }
  while (dt - fye > 10) {
    fye += 365
    fiscalYear += 1
  }

  const fyeDate = dayString(fye)
  const position = bisectLeft(ends, fyeDate)
  let prev = fye - 365

  if (position < ends.length && ends[position] === fyeDate && position > 0) {
    const candidate = mustDay(ends[position - 1]!)
    if (fye - candidate >= 330 && fye - candidate <= 400) prev = candidate
  }
  return [fiscalYear, Math.min(4, Math.max(1, pyRound((dt - prev) / 91.31)))]
}

/** Build fiscal year and period labels for each period-end date. */
export function getFiscalMeta(facts: Facts, frequency: Frequency, filingDates: Set<string>): Record<string, { fiscal_year: number; fiscal_period: string }> {
  if (filingDates.size === 0) return {}

  const annualDates = getFilingDates(facts, 'annual')
  const grid = frequency === 'annual' ? new Set([...annualDates, ...filingDates]) : annualDates
  let years = annualFiscalYears(facts, grid)

  if (frequency === 'annual') {
    const out: Record<string, { fiscal_year: number; fiscal_period: string }> = {}
    for (const date of filingDates) out[date] = { fiscal_year: years[date]!, fiscal_period: 'FY' }
    return out
  }

  if (Object.keys(years).length === 0) {
    const ys = [...filingDates].map((d) => parseInt(d.slice(0, 4), 10))
    const firstYear = Math.min(...ys)
    const lastYear = Math.max(...ys)
    years = {}
    for (let y = firstYear - 1; y < lastYear + 2; y++) years[`${y}-12-31`] = y
  }

  const quarterlyDates = new Set<string>()
  const semiDates = new Set<string>()

  for (const nsFacts of Object.values(facts)) {
    for (const tagData of Object.values(nsFacts as Record<string, FactEntry>)) {
      for (const [, entries] of unitsOf(tagData)) {
        for (const entry of entries) {
          const end: string = entry.end ?? ''
          const form: string = entry.form ?? ''
          if (!filingDates.has(end) || !entry.filed) continue
          if (QUARTERLY_FORMS.has(form)) quarterlyDates.add(end)
          else if (SEMI_ANNUAL_FORMS.has(form) && entry.start) {
            const days = mustDay(end) - mustDay(entry.start)
            if ((days >= 60 && days <= 135) || (days >= 240 && days <= 310)) quarterlyDates.add(end)
            else if (days >= 150 && days <= 200) semiDates.add(end)
          }
        }
      }
    }
  }

  let endPeriod = 'Q4'
  if (quarterlyDates.size === 0 && semiDates.size > 0) {
    const nonAnnual = [...filingDates].filter((d) => !annualDates.has(d))
    endPeriod = nonAnnual.length > annualDates.size ? 'Q4' : 'H2'
  }

  const ends = Object.keys(years).sort()
  const result: Record<string, { fiscal_year: number; fiscal_period: string }> = {}
  for (const date of filingDates) {
    const [fiscalYear, quarter] = fiscalPosition(date, ends, years)
    let period: string
    if (quarter === 4) period = endPeriod
    else if (semiDates.has(date) && !quarterlyDates.has(date)) period = 'H1'
    else period = `Q${quarter}`
    result[date] = { fiscal_year: fiscalYear, fiscal_period: period }
  }
  return result
}

/**
 * Facts in which an 8-K entry keeps its form only while no regular filing had reported its period when it was filed.
 * Outside pit_mode an 8-K entry is also superseded once any regular filing reports its period.
 */
export function preliminaryView(facts: Facts, pitMode = false): Facts {
  const regular: [string, string][] = []
  const reported = new Set<string>()

  for (const [namespace, nsFacts] of Object.entries(facts)) {
    if (namespace === 'dei' || !nsFacts || typeof nsFacts !== 'object') continue
    for (const tagData of Object.values(nsFacts as Record<string, FactEntry>)) {
      for (const [, entries] of unitsOf(tagData)) {
        for (const entry of entries) {
          const end: string = entry.end ?? ''
          const filed: string = entry.filed ?? ''
          if (ALL_FORMS.has(entry.form ?? '') && end && filed > end) {
            regular.push([filed, end])
            reported.add(end)
          }
        }
      }
    }
  }

  regular.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
  const filedDates = regular.map(([filed]) => filed)
  const latest: string[] = []
  for (const [, end] of regular) latest.push(latest.length ? (end > latest[latest.length - 1]! ? end : latest[latest.length - 1]!) : end)

  const view: Facts = {}

  for (const [namespace, nsFacts] of Object.entries(facts)) {
    if (!nsFacts || typeof nsFacts !== 'object') {
      view[namespace] = nsFacts
      continue
    }
    const viewNs: Record<string, FactEntry> = {}
    for (const [tag, tagData] of Object.entries(nsFacts as Record<string, FactEntry>)) {
      const units = (tagData.units ?? {}) as Record<string, FactEntry[]>
      if (!Object.values(units).some((entries) => entries.some((e) => PRELIMINARY_FORMS.has(e.form ?? '')))) {
        viewNs[tag] = tagData
        continue
      }
      const viewUnits: Record<string, FactEntry[]> = {}
      for (const [unit, entries] of Object.entries(units)) {
        viewUnits[unit] = entries.map((entry) => {
          const form: string = entry.form ?? ''
          if (!PRELIMINARY_FORMS.has(form)) return entry
          const end: string = entry.end ?? ''
          const filed: string = entry.filed ?? ''
          const index = bisectRight(filedDates, filed)
          const known = index ? latest[index - 1]! : ''
          if (!(end && filed > end && end > known && (pitMode || !reported.has(end)))) return { ...entry, form: form + SUPERSEDED_SUFFIX }
          return entry
        })
      }
      viewNs[tag] = { ...tagData, units: viewUnits }
    }
    view[namespace] = viewNs
  }
  return markPreliminary(view, pitMode)
}

/** Detect the reporting currency from the SEC facts data. */
export function detectReportingCurrency(facts: Facts): string {
  const counts = new Map<string, number>()
  for (const nsFacts of Object.values(facts)) {
    for (const tagData of Object.values(nsFacts as Record<string, FactEntry>)) {
      for (const unitKey of Object.keys(tagData.units ?? {})) {
        if (unitKey === 'shares' || unitKey === 'pure' || unitKey.includes('/')) continue
        if (/^[A-Z]{3}$/.test(unitKey)) counts.set(unitKey, (counts.get(unitKey) ?? 0) + 1)
      }
    }
  }
  if (counts.size === 0) return 'USD'
  let best: string | undefined
  for (const [k, v] of counts) if (best === undefined || v > counts.get(best)!) best = k
  return best!
}

/** The prior quarter-end date string for a given period end. */
export function priorPeriodEnd(date: string): string | null {
  if (dayNum(date) === null) return null
  const { year: y, month } = dateParts(date)
  switch (month) {
    case 3:
      return `${y - 1}-12-31`
    case 6:
      return `${y}-03-31`
    case 9:
      return `${y}-06-30`
    case 12:
      return `${y}-09-30`
    case 1:
      return `${y - 1}-10-31`
    case 4:
      return `${y}-01-31`
    default:
      return null
  }
}
