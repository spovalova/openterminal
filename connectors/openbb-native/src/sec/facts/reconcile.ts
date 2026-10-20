// Fiscal-year-end reconciliation of quarterly statements, provider sec: the Q4 column rebuilt from the annual statement.
// Ported from openbb_sec/utils/statement_schema/_imputation.py (OpenBB Platform 5.0.0, Apache-2.0); modified: rows are
// identified by object identity, Decimal subtraction is exact decimal-string arithmetic, and dates are visited in sorted
// order (Python iterates a set).
import { applyHierarchicalArticulation } from './articulation.js'
import { getUnitData } from './extraction.js'
import { enforceIdentities, failing, identity, identityDiagnostics, identityResiduals, identityState, identityTolerance, type Signed } from './identities.js'
import { DIRECT_SOURCE } from './imputation.js'
import { ADDITIVE_PER_SHARE, BALANCE_IDENTITY_LINES, CF_SIGN_KEEP, DILUTED_SHARES, EPS_NUMERATOR, IDENTITIES } from './rules.js'
import { decimalDifference, has, maxStr, mustDay, pyRound, sum } from './py.js'
import { ALL_FORMS, ANNUAL_FORMS, factorOn, newRow, sourceTag, tolerance as tol, type FactEntry, type Facts, type RowResult, type StatementResult } from './types.js'

const stripPrelim = (s: string): string => (s.startsWith('preliminary:') ? s.slice('preliminary:'.length) : s)

/** The components of a rollup source, or null for any other source. */
function rollupParts(source: string): Set<string> | null {
  source = stripPrelim(source)
  if (!source.startsWith('imputed-rollup')) return null
  const body = source.slice(source.indexOf(':') + 1)
  return new Set([...body.matchAll(/([a-z][a-z0-9_]*)\(/g)].map((m) => m[1]!))
}

/** The (tag, sign) terms of an imputation source formula. */
export function formulaTerms(source: string): Signed {
  const terms: Signed = []
  let sign = 1
  for (const term of source.slice(source.indexOf(':') + 1).split(/\s+/).filter(Boolean)) {
    if (term === '+' || term === '-') {
      sign = term === '+' ? 1 : -1
    } else {
      terms.push([term.replace(/^-+/, ''), term.startsWith('-') ? -sign : sign])
      sign = 1
    }
  }
  return terms
}

/** The length of a duration fact in days. */
const daysOf = (entry: FactEntry): number => mustDay(entry.end) - mustDay(entry.start)

const lastBy = <T>(items: T[], key: (item: T) => string): T => {
  let best = items[0] as T
  for (const item of items) if (key(item) > key(best)) best = item
  return best
}

/**
 * A Q4 on the quarters' filing basis from the concept's nine-month and annual facts: FY less the latest nine-month value
 * filed with the annual value when the quarters do not sum to it; otherwise the fiscal year as filed before a
 * restatement, when a nine-month value filed before it equals the quarters.
 */
function consistentQ4(row: RowResult, fySource: string, window: string[], fyEnd: string, fyValue: number, facts: Facts, currency: string, negate: boolean): [number, string] | null {
  const match = DIRECT_SOURCE.exec(fySource)
  if (match === null) return null

  const tagData = facts[match[1]!]?.[match[2]!]
  const entries = (tagData ? (getUnitData(tagData, row.unit, currency) ?? []) : []).filter((e) => e.val !== null && e.val !== undefined && e.start && e.end)
  const sign = negate ? -1 : 1
  const quarters = window.map((d) => row.values[d]!)
  const qSum = sum(quarters)
  const annual = entries.filter((e) => e.end === fyEnd && ANNUAL_FORMS.has(e.form) && daysOf(e) >= 300 && daysOf(e) <= 400)
  const ref = annual.filter((e) => Math.abs(sign * e.val - fyValue) <= tol(fyValue))
  if (ref.length === 0) return null

  const start = ref[0]!.start
  const refFiled = maxStr(ref.map((e) => e.filed ?? ''))
  const nine = entries.filter((e) => !ANNUAL_FORMS.has(e.form) && e.start === start && e.end === window[2])
  const filedNine = nine.filter((e) => (e.filed ?? '') <= refFiled)

  if (filedNine.length) {
    const c9 = sign * lastBy(filedNine, (e) => e.filed ?? '').val
    if (Math.abs(c9 - qSum) > identityTolerance([c9, ...quarters], 4)) return [fyValue - c9, `Q4: FY[${fySource}] − 9M[${match[1]}:${match[2]}]`]
  }

  const tQ = maxStr(['', ...entries.filter((e) => window.includes(e.end) && !ANNUAL_FORMS.has(e.form)).map((e) => e.filed ?? '')])
  const prior = annual.filter((e) => (e.filed ?? '') <= tQ)
  if (prior.length === 0) return null

  const last = lastBy(prior, (e) => e.filed ?? '')
  const fyPrior = sign * last.val

  if (Math.abs(fyPrior - fyValue) > tol(fyPrior, fyValue) && nine.some((e) => (e.filed ?? '') <= (last.filed ?? '') && Math.abs(sign * e.val - qSum) <= identityTolerance([sign * e.val, ...quarters], 4))) {
    const labels = window.map((d, i) => `Q${i + 1}[${row.sources[d] ?? ''}]`).join('+')
    return [fyPrior - qSum, `Q4: FY[${match[1]}:${match[2]}(filed ${last.filed ?? ''})] − (${labels})`]
  }
  return null
}

/** The three-month values filed for a row's concepts ending at a date. */
function quarterFacts(row: RowResult, concepts: Set<string | null>, end: string, facts: Facts | null, currency: string, negate: boolean): Set<number> {
  const found = new Set<number>()
  for (const concept of concepts) {
    const match = DIRECT_SOURCE.exec(concept ?? '')
    if (facts === null || match === null) continue
    const tagData = facts[match[1]!]?.[match[2]!]
    for (const e of tagData ? (getUnitData(tagData, row.unit, currency) ?? []) : []) {
      if (e.end === end && e.start && e.val !== null && e.val !== undefined && ALL_FORMS.has(e.form) && daysOf(e) >= 60 && daysOf(e) <= 135) found.add((negate ? -1 : 1) * e.val)
    }
  }
  return found
}

/** Whether the annual value differs from the fiscal year as filed by the quarters' last filing. */
function restatedFy(row: RowResult, fySource: string, window: string[], fyEnd: string, fyValue: number, facts: Facts, currency: string, negate: boolean): boolean {
  const match = DIRECT_SOURCE.exec(fySource)
  if (match === null) return false

  const tagData = facts[match[1]!]?.[match[2]!]
  const entries = (tagData ? (getUnitData(tagData, row.unit, currency) ?? []) : []).filter((e) => e.val !== null && e.val !== undefined && e.start && e.end)
  const tQ = maxStr(['', ...entries.filter((e) => window.includes(e.end) && !ANNUAL_FORMS.has(e.form)).map((e) => e.filed ?? '')])
  const prior = entries.filter((e) => e.end === fyEnd && ANNUAL_FORMS.has(e.form) && daysOf(e) >= 300 && daysOf(e) <= 400 && (e.filed ?? '') <= tQ)
  if (prior.length === 0) return false

  const last = lastBy(prior, (e) => e.filed ?? '')
  return Math.abs((negate ? -1 : 1) * last.val - fyValue) > tol(fyValue)
}

/**
 * Derive the Q4 share counts, dividends per share and EPS the filings do not report. A weighted average share count is
 * the day-weighted average of its quarters, dividends per share add across quarters, and EPS is Q4 net income to common
 * over the Q4 share count; a loss quarter's diluted shares are its basic shares.
 */
function q4PerShare(rows: RowResult[], annualRows: Map<string, RowResult>, window: string[], fyStart: string, fyEnd: string): void {
  const byTag = new Map(rows.map((r) => [r.tag, r] as const))
  const ends = [fyStart, ...window, fyEnd].map(mustDay)
  const spans = ends.slice(1).map((b, i) => b - ends[i]!)
  const derived = new Set<string>()

  for (const row of rows) {
    const aRow = annualRows.get(row.tag)
    const aVal = aRow?.values[fyEnd]
    const quarters = window.map((d) => row.values[d])

    if (aRow === undefined || aVal === undefined || row.values[fyEnd] !== undefined || quarters.some((q) => q === undefined) || !['shares', 'per_share'].includes(row.unit) || (row.unit === 'per_share' && !ADDITIVE_PER_SHARE.has(row.tag))) continue

    let value: number
    if (row.unit === 'shares') {
      let weighted = 0
      quarters.forEach((q, i) => (weighted += (q ?? 0) * spans[i]!))
      value = (aVal * sum(spans) - weighted) / spans[3]!
    } else {
      value = decimalDifference(aVal, quarters as number[])
    }

    if (value < 0 || (row.unit === 'shares' && value === 0)) continue

    const labels = window.map((d, i) => `Q${i + 1}[${row.sources[d] ?? ''}]`).join('+')
    row.values[fyEnd] = row.unit === 'shares' ? pyRound(value) : value
    row.sources[fyEnd] = `Q4: FY[${aRow.sources[fyEnd] ?? ''}] − (${labels})` + (row.unit === 'shares' ? ', day-weighted' : '')
    derived.add(row.tag)
  }

  const numerator = byTag.get(EPS_NUMERATOR)
  const income = numerator?.values[fyEnd]

  for (const [diluted, basic] of Object.entries(DILUTED_SHARES)) {
    const dRow = byTag.get(diluted)
    const bRow = byTag.get(basic)
    if (income !== undefined && income < 0 && dRow !== undefined && bRow !== undefined && bRow.values[fyEnd] !== undefined && (derived.has(diluted) || dRow.values[fyEnd] === undefined) && window.some((d) => dRow.values[d] !== undefined)) {
      dRow.values[fyEnd] = bRow.values[fyEnd]!
      dRow.sources[fyEnd] = `Q4: ${basic} (antidilutive loss)`
    }
  }

  for (const row of rows) {
    const shares = rows.find((r) => r.parent === row.tag && r.factor === '/')
    if (row.unit !== 'per_share' || ADDITIVE_PER_SHARE.has(row.tag) || row.values[fyEnd] !== undefined || !window.some((d) => row.values[d] !== undefined) || shares === undefined || income === undefined) continue

    const count = shares.values[fyEnd]
    if (count === undefined || count <= 0) continue
    row.values[fyEnd] = pyRound(income / count, 2)
    row.sources[fyEnd] = `Q4: ${EPS_NUMERATOR} ÷ ${shares.tag}`
  }
}

/**
 * Rebuild each fiscal-year-end column of a quarterly statement from the annual statement.
 *
 * Balance-sheet rows and instant rows take the annual value, for the lines the interim quarters report. Monetary
 * duration rows take FY minus the three interim quarters of the fiscal year, and otherwise keep FY minus the nine-month
 * value derived at extraction; H2 values and balancing plugs are cleared, and plugs are re-articulated. Share counts,
 * dividends per share and EPS the filings do not report for Q4 are derived from the annual and interim values.
 */
export function reconcileFiscalYearEnds(quarterly: StatementResult, annual: StatementResult, schemaTags: Set<string>, facts: Facts | null = null, currency = 'USD'): void {
  const annualRows = new Map(annual.rows.map((r) => [r.tag, r] as const))
  const quarterlyRows = new Map(quarterly.rows.map((r) => [r.tag, r] as const))
  const quarterlyDates = [...quarterly.dates].sort()
  const annualDateSet = new Set(annual.dates)
  const common = [...quarterly.dates].filter((d) => annualDateSet.has(d)).sort()
  const balanceSheet = quarterly.statement === 'balance_sheet'
  const copiedTags = [...new Set([...annual.rows.filter((r) => balanceSheet || r.period_type === 'instant').map((r) => r.tag), ...quarterly.rows.filter((r) => balanceSheet || r.period_type === 'instant').map((r) => r.tag)])].sort()
  const windows: Record<string, string[]> = {}
  const allowance: Record<string, Record<string, number>> = {}
  const restated = new Map<string, Set<string>>()
  const trusted = new Map<string, Set<string>>()

  for (const fyEnd of common) {
    for (const tag of copiedTags) {
      if (tag === 'cash_at_beginning_of_period') continue

      const aRow = annualRows.get(tag)
      const aVal = aRow?.values[fyEnd]
      let qRow = quarterlyRows.get(tag)

      if (aRow === undefined || aVal === undefined) {
        if (qRow !== undefined) {
          delete qRow.values[fyEnd]
          delete qRow.sources[fyEnd]
          delete qRow.date_factors[fyEnd]
        }
        continue
      }

      if (qRow === undefined) {
        qRow = newRow({ tag: aRow.tag, label: aRow.label, description: aRow.description, parent: aRow.parent, sequence: aRow.sequence, factor: aRow.factor, balance: aRow.balance, unit: aRow.unit, period_type: aRow.period_type })
        quarterly.rows.push(qRow)
        quarterlyRows.set(tag, qRow)
      }

      qRow.values[fyEnd] = aVal
      qRow.sources[fyEnd] = aRow.sources[fyEnd] ?? ''
      if (has(aRow.date_factors, fyEnd)) qRow.date_factors[fyEnd] = aRow.date_factors[fyEnd]!
      else delete qRow.date_factors[fyEnd]
    }

    const endDt = mustDay(fyEnd)
    const window = quarterlyDates.filter((d) => {
      const gap = endDt - mustDay(d)
      return gap > 0 && gap < 355
    })
    windows[fyEnd] = window

    if (quarterly.rows.some((r) => window.some((d) => r.values[d] !== undefined))) {
      for (const row of quarterly.rows) {
        if (copiedTags.includes(row.tag) && row.tag !== 'cash_at_beginning_of_period' && !BALANCE_IDENTITY_LINES.has(row.tag) && window.every((d) => row.values[d] === undefined)) {
          delete row.values[fyEnd]
          delete row.sources[fyEnd]
          delete row.date_factors[fyEnd]
        }
      }

      for (const row of quarterly.rows) {
        const parent = quarterlyRows.get(row.parent ?? '')
        const source = row.sources[fyEnd] ?? ''
        if ((source.startsWith('imputed-plug') || source.startsWith('imputed-zero-plug')) && (parent === undefined || parent.values[fyEnd] === undefined)) {
          delete row.values[fyEnd]
          delete row.sources[fyEnd]
          delete row.date_factors[fyEnd]
        }
      }
    }

    const inherited: Record<string, number> = { ...identityResiduals(annual.rows, quarterly.statement, fyEnd) }
    if (!balanceSheet) {
      for (const d of window) {
        for (const [target, residual] of Object.entries(identityResiduals(quarterly.rows, quarterly.statement, d))) inherited[target] = Math.abs(inherited[target] ?? 0) + Math.abs(residual)
      }
    }
    allowance[fyEnd] = Object.fromEntries(Object.entries(inherited).map(([t, r]) => [t, Math.abs(r)]))

    if (balanceSheet || window.length !== 3) continue

    const cleared = new Set<RowResult>()
    const repaired = new Set<string>()
    const candidates: [RowResult, [number, string]][] = []
    let brokenFixed = false

    for (const row of quarterly.rows) {
      if (row.period_type !== 'duration') continue

      const aRow = annualRows.get(row.tag)
      const aVal = aRow?.values[fyEnd]
      const aSource = aRow ? (aRow.sources[fyEnd] ?? '') : ''
      const quarterSources = window.filter((d) => has(row.sources, d)).map((d) => row.sources[d]!)

      if ((row.sources[fyEnd] ?? '').includes('imputed-plug') || (quarterSources.length > 0 && quarterSources.every((s) => s.includes('imputed-plug')))) cleared.add(row)

      if (['imputed-plug', 'H2:'].some((key) => (row.sources[fyEnd] ?? '').includes(key))) {
        delete row.values[fyEnd]
        delete row.sources[fyEnd]
      }

      if (!schemaTags.has(row.tag) || aSource.includes('imputed-plug')) continue

      const present = window.filter((d) => row.values[d] !== undefined)
      if (row.unit !== 'monetary' || aVal === undefined || present.length !== 3) continue

      const parts = present.map((d) => rollupParts(row.sources[d] ?? ''))
      const annualParts = new Set(annual.rows.filter((c) => c.parent === row.tag && c.values[fyEnd] !== undefined && ['+', '-'].includes(factorOn(c, fyEnd))).map((c) => c.tag))
      const qParts = new Set<string>()
      for (const part of parts) if (part !== null) for (const t of part) qParts.add(t)
      const reportedParts = new Set(annual.rows.filter((c) => annualParts.has(c.tag) && !(c.sources[fyEnd] ?? '').includes('imputed-plug')).map((c) => c.tag))

      if (!parts.includes(null) && ([...annualParts].some((t) => !qParts.has(t)) || [...qParts].every((t) => reportedParts.has(t)) || rollupParts(aSource) !== null)) {
        if (!(row.sources[fyEnd] ?? '').startsWith('imputed-rollup')) {
          delete row.values[fyEnd]
          delete row.sources[fyEnd]
        }
        continue
      }

      const qTags = new Set(present.map((d) => sourceTag(row.sources[d] ?? '')))
      const current = stripPrelim(row.sources[fyEnd] ?? '')
      const negate = quarterly.statement === 'cash_flow' && row.balance === 'credit' && row.factor !== '0' && !CF_SIGN_KEEP.has(row.tag)
      const aTag = sourceTag(aSource)
      const qTagsEqualA = qTags.size === 1 && qTags.has(aTag)
      const onlyTag = qTags.size === 1 ? ([...qTags][0] ?? null) : null

      if (qTags.size === 1 && !qTags.has(null) && !qTagsEqualA) {
        const stripped = current.startsWith('Q4: FY[') ? current.slice('Q4: FY['.length) : current
        if (sourceTag(stripped) === onlyTag) {
          const q4 = row.values[fyEnd]
          if (facts !== null && q4 !== undefined && restatedFy(row, onlyTag ?? '', present, fyEnd, q4 + sum(present.map((d) => row.values[d]!)), facts, currency, negate)) {
            if (!restated.has(fyEnd)) restated.set(fyEnd, new Set())
            restated.get(fyEnd)!.add(row.tag)
          }
          continue
        }
      }

      const labels = present.map((d) => `Q${window.indexOf(d) + 1}[${row.sources[d] ?? ''}]`).join('+')
      row.values[fyEnd] = aVal - sum(present.map((d) => row.values[d]!))
      row.sources[fyEnd] = `Q4: FY[${aSource}] − (${labels})`
      const quarters = present.map((d) => row.values[d]!)
      const tolerance = tol(aVal, ...quarters)

      if (facts !== null && restatedFy(row, qTags.size === 1 && !qTags.has(null) ? (onlyTag ?? '') : aSource, present, fyEnd, aVal, facts, currency, negate)) {
        if (!restated.has(fyEnd)) restated.set(fyEnd, new Set())
        restated.get(fyEnd)!.add(row.tag)
      }

      if (facts !== null && qTags.size === 1 && !qTags.has(null)) {
        const fixed = consistentQ4(row, qTagsEqualA ? aSource : (onlyTag ?? ''), present, fyEnd, aVal, facts, currency, negate)
        if (fixed !== null) {
          candidates.push([row, fixed])
          const q4v = row.values[fyEnd]!
          brokenFixed = brokenFixed || (((quarters.every((v) => v > tolerance) && q4v < -tolerance) || (quarters.every((v) => v < -tolerance) && q4v > tolerance)) && fixed[0] * quarters[0]! > 0)
        }
      }
    }

    if (candidates.length && !brokenFixed) {
      const before = failing(quarterly.rows, quarterly.statement, fyEnd, allowance[fyEnd]!)
      const kept = candidates.map(([row]): [RowResult, [number, string]] => [row, [row.values[fyEnd]!, row.sources[fyEnd]!]])
      for (const [row, [value, source]] of candidates) {
        row.values[fyEnd] = value
        row.sources[fyEnd] = source
      }
      const after = failing(quarterly.rows, quarterly.statement, fyEnd, allowance[fyEnd]!)
      brokenFixed = after.size < before.size && [...after].every((t) => before.has(t))
      if (!brokenFixed) {
        for (const [row, [value, source]] of kept) {
          row.values[fyEnd] = value
          row.sources[fyEnd] = source
        }
      }
    }

    if (brokenFixed) {
      for (const [row, [value, source]] of candidates) {
        row.values[fyEnd] = value
        row.sources[fyEnd] = source
        repaired.add(row.tag)
      }
    }

    while (repaired.size) {
      const derived = new Set<string>()

      for (const row of quarterly.rows) {
        const aRow = annualRows.get(row.tag)
        const aSource = aRow ? (aRow.sources[fyEnd] ?? '') : ''
        if (repaired.has(row.tag) || !aSource.startsWith('imputed: ')) continue

        const terms = formulaTerms(aSource)
        const inputs = terms.map(([tag, s]) => [quarterlyRows.get(tag), s] as const)
        if (terms.some(([t]) => repaired.has(t)) && inputs.every(([r]) => r !== undefined && r.values[fyEnd] !== undefined)) {
          let total = 0
          for (const [r, s] of inputs) if (r !== undefined) total += r.values[fyEnd]! * s
          row.values[fyEnd] = total
          row.sources[fyEnd] = aSource
          derived.add(row.tag)
        }
      }

      if (derived.size === 0) break
      for (const t of derived) repaired.add(t)
    }

    trusted.set(fyEnd, new Set(repaired))
    const imputed = new Map<string, string>()
    for (const row of quarterly.rows) {
      if (repaired.has(row.tag)) continue
      const formulas = new Set(window.map((d) => stripPrelim(row.sources[d] ?? '')))
      if (formulas.size === 1) {
        const formula = [...formulas][0]!
        if (formula.startsWith('imputed: ')) imputed.set(row.tag, formula)
      }
    }

    for (const [tag, formula] of imputed) {
      const terms = new Set(formulaTerms(formula).map(([t]) => t))
      if ([...(restated.get(fyEnd) ?? [])].some((t) => terms.has(t))) restated.get(fyEnd)!.add(tag)
    }

    for (let n = 0; n < imputed.size; n++) {
      let changed = false
      for (const [tag, formula] of imputed) {
        const inputs = formulaTerms(formula).map(([term, s]) => [quarterlyRows.get(term), s] as const)
        const row = quarterlyRows.get(tag)!
        if (inputs.every(([r]) => r !== undefined && r.values[fyEnd] !== undefined)) {
          let value = 0
          for (const [r, s] of inputs) if (r !== undefined) value += r.values[fyEnd]! * s
          if (value !== row.values[fyEnd]) {
            row.values[fyEnd] = value
            row.sources[fyEnd] = formula
            changed = true
          }
        }
      }
      if (!changed) break
    }

    const rows = [...quarterly.rows]
    const existing = new Set(rows)
    applyHierarchicalArticulation(rows, [fyEnd], cleared)
    const added = rows.filter((r) => !existing.has(r))

    if (added.length) {
      quarterly.rows.push(...added)
      quarterly.rows.sort((a, b) => Number(a.sequence) - Number(b.sequence))
      for (const r of added) quarterlyRows.set(r.tag, r)
    }

    const priorDates = [...new Set([...quarterlyDates, ...annual.dates])].sort().filter((d) => d < window[0]!)
    if (priorDates.length) {
      const gap = mustDay(window[0]!) - mustDay(priorDates[priorDates.length - 1]!)
      if (gap >= 60 && gap <= 135) q4PerShare(quarterly.rows, annualRows, window, priorDates[priorDates.length - 1]!, fyEnd)
    }

    for (const row of quarterly.rows) {
      if (row.period_type === 'duration' && row.values[fyEnd] !== undefined && window.every((d) => row.values[d] === undefined) && DIRECT_SOURCE.exec(row.sources[fyEnd] ?? '') === null) {
        delete row.values[fyEnd]
        delete row.sources[fyEnd]
        delete row.date_factors[fyEnd]
      }
    }

    const bop = quarterlyRows.get('cash_at_beginning_of_period')
    const ncc = quarterlyRows.get('net_change_in_cash')
    const eop = quarterlyRows.get('cash_at_end_of_period')
    if (bop === undefined || ncc === undefined || eop === undefined) continue

    const bopVal = bop.values[fyEnd]
    const nccVal = ncc.values[fyEnd]
    const eopVal = eop.values[fyEnd]
    if (bopVal !== undefined && nccVal !== undefined && eopVal !== undefined && Math.abs(bopVal + nccVal - eopVal) > tol(eopVal, bopVal, nccVal)) {
      bop.values[fyEnd] = eopVal - nccVal
      bop.sources[fyEnd] = 'identity-enforced: cash_at_end_of_period - net_change_in_cash'
    }
  }

  const fourthQuarterDerived = (row: RowResult, date: string): boolean => {
    const value = row.values[date]
    const aRow = annualRows.get(row.tag)
    const aVal = aRow?.values[date]
    if (value === undefined || aVal === undefined) return true

    if (balanceSheet || row.period_type === 'instant') return value !== aVal
    if (trusted.get(date)?.has(row.tag)) return false

    const concepts = new Set<string | null>(windows[date]!.map((d) => sourceTag(row.sources[d] ?? '')))
    concepts.add(aRow ? sourceTag(aRow.sources[date] ?? '') : null)
    const filed = quarterFacts(row, concepts, date, facts, currency, quarterly.statement === 'cash_flow' && row.balance === 'credit' && row.factor !== '0' && !CF_SIGN_KEEP.has(row.tag))

    if (filed.size) return [...filed].every((v) => Math.abs(value - v) > tol(value, v))

    const quarters = windows[date]!.map((d) => row.values[d])
    return quarters.length !== 3 || quarters.some((q) => q === undefined) || Math.abs(aVal - sum(quarters.map((q) => q ?? 0)) - value) > 1 || (restated.get(date)?.has(row.tag) ?? false)
  }

  enforceIdentities(quarterly.rows, quarterly.statement, Object.keys(windows), null, currency, { derived: fourthQuarterDerived, frequency: 'quarterly', allowance })

  for (const [fyEnd, tags] of restated) {
    const byTag = new Map(quarterly.rows.map((r) => [r.tag, r] as const))
    const children = new Map<string, RowResult[]>()
    for (const r of quarterly.rows) {
      if (r.parent) {
        if (!children.has(r.parent)) children.set(r.parent, [])
        children.get(r.parent)!.push(r)
      }
    }

    for (const [target, terms] of IDENTITIES[quarterly.statement] ?? []) {
      const signed = identity(target, terms, byTag, children, fyEnd)
      if (signed === null) continue
      const [lhs, rhs, t] = identityState(target, signed, byTag, fyEnd)
      if (Math.abs(lhs - rhs) > t) {
        const targets = new Set([target, ...signed.map(([tag]) => tag)])
        for (const tag of tags) {
          if (targets.has(tag)) {
            const row = byTag.get(tag)!
            delete row.values[fyEnd]
            delete row.sources[fyEnd]
            delete row.date_factors[fyEnd]
          }
        }
      }
    }
  }

  quarterly.diagnostics = identityDiagnostics(quarterly.rows, quarterly.statement, quarterly.dates)

  for (const date of quarterly.preliminary_dates) {
    for (const row of quarterly.rows) {
      const source = row.sources[date]
      if (source !== undefined && !source.startsWith('preliminary:')) row.sources[date] = `preliminary:${source}`
    }
  }
}
