// Imputation of statement rows, provider sec: multi-pass derivation and sign resolution (hierarchical articulation is in
// articulation.ts, the verification stage in verify.ts). Ported from openbb_sec/utils/statement_schema/_imputation.py
// (OpenBB Platform 5.0.0, Apache-2.0); modified: dates are visited in sorted order (Python iterates a set), rows are
// identified by object identity, and dicts are plain records.
import { applyHierarchicalArticulation } from './articulation.js'
import { detectReportingCurrency } from './detection.js'
import { getUnitData } from './extraction.js'
import { BS_IMPUTE, CF_IMPUTE, CF_SIGN_KEEP, IS_IMPUTE, IS_IMPUTE_COMMON, MAX_IMPUTE_PASSES, NONNEGATIVE_LINES, SINGLE_STEP, type Rule } from './rules.js'
import { has, mustDay } from './py.js'
import { verifyIdentities } from './verify.js'
import { tolerance, type CompanyType, type Facts, type Frequency, type RowResult, type StatementName, type ValidationWarning } from './types.js'

/** Build a human-readable source string for an imputation rule. */
export function formatImputeSource(prefix: string, sources: [string, number][]): string {
  const parts: string[] = []
  sources.forEach(([srcTag, sign], i) => {
    if (i === 0) parts.push(`${sign < 0 ? '-' : ''}${srcTag}`)
    else parts.push(`${sign > 0 ? '+' : '-'} ${srcTag}`)
  })
  return `${prefix}: ${parts.join(' ')}`
}

export const sortedDates = (dates: Iterable<string>): string[] => [...dates].sort()

/**
 * Run up to MAX_IMPUTE_PASSES imputation passes over all rules.
 *
 * A reported costs total that is revenue less pretax income is no input at its date, and a balance or gross line derived
 * as zero holds no value. Returns true if any value was derived across all passes.
 */
export function runImputationPasses(rows: RowResult[], rules: Rule[], tagIdx: Record<string, number>, filingDates: Set<string>): boolean {
  let anyChanged = false
  const parentOf: Record<string, string | null> = {}
  for (const r of rows) parentOf[r.tag] = r.parent
  const rowOrNull = (t: string): RowResult | null => (has(tagIdx, t) ? rows[tagIdx[t]!]! : null)
  const revenue = rowOrNull(SINGLE_STEP[0])
  const costs = rowOrNull(SINGLE_STEP[1])
  const pretax = rowOrNull(SINGLE_STEP[2])
  const dates = sortedDates(filingDates)

  const pretaxOn = (date: string): number | null => {
    if (pretax !== null && pretax.values[date] !== undefined) return pretax.values[date]!
    for (const [target, sources] of rules) {
      const values = sources.map(([t]) => (has(tagIdx, t) ? rows[tagIdx[t]!]!.values[date] : undefined))
      if (target === SINGLE_STEP[2] && !sources.some(([t]) => SINGLE_STEP.slice(0, 2).includes(t)) && values.every((v) => v !== undefined)) {
        let total = 0
        values.forEach((v, i) => (total += (v ?? 0) * sources[i]![1]))
        return total
      }
    }
    return null
  }

  const singleStep = new Set<string>()
  if (revenue !== null && costs !== null) {
    for (const date of dates) {
      if (revenue.values[date] === undefined || costs.values[date] === undefined) continue
      const p = pretaxOn(date)
      if (p === null) continue
      const costsSource = costs.sources[date] ?? ''
      if (['imputed', 'corrected', 'identity-enforced'].some((s) => costsSource.startsWith(s))) continue
      if (Math.abs(revenue.values[date]! - costs.values[date]! - p) <= tolerance(revenue.values[date], costs.values[date])) singleStep.add(date)
    }
  }

  const isAncestor = (anc: string, tag: string): boolean => {
    const seen = new Set<string>()
    let p = parentOf[tag]
    while (p && !seen.has(p)) {
      if (p === anc) return true
      seen.add(p)
      p = parentOf[p]
    }
    return false
  }

  for (let pass = 0; pass < MAX_IMPUTE_PASSES; pass++) {
    let changed = false
    for (const [targetTag, sources] of rules) {
      if (!has(tagIdx, targetTag)) continue
      const targetRow = rows[tagIdx[targetTag]!]!

      for (const date of dates) {
        if (targetRow.values[date] !== undefined) continue

        let val = 0
        let allPresent = true
        for (const [srcTag, sign] of sources) {
          if (!has(tagIdx, srcTag)) {
            allPresent = false
            break
          }
          const srcRow = rows[tagIdx[srcTag]!]!
          const srcVal = srcRow.values[date]
          if (srcVal === undefined || (srcTag === SINGLE_STEP[1] && singleStep.has(date)) || ((srcRow.sources[date] ?? '').startsWith('imputed-rollup') && isAncestor(srcTag, targetTag))) {
            allPresent = false
            break
          }
          val += srcVal * sign
        }

        if (allPresent && !(val === 0 && NONNEGATIVE_LINES.has(targetTag))) {
          targetRow.values[date] = val
          targetRow.sources[date] = formatImputeSource('imputed', sources)
          changed = true
        }
      }
    }
    if (!changed) break
    anyChanged = true
  }
  return anyChanged
}

export const DIRECT_SOURCE = /^(us-gaap|ifrs-full|srt|dei):([A-Za-z0-9_]+)(?:\((?:fallback|identity_lock:[a-z_]+)\))?$/

/** {end: [(filed, days, value)]} for a tag's facts; instants have zero days. */
function tagFacts(facts: Facts, namespace: string, tag: string, row: RowResult, currency: string): Record<string, [string, number, number][]> {
  const tagData = facts[namespace]?.[tag]
  const entries = tagData ? getUnitData(tagData, row.unit, currency) : null
  const byEnd: Record<string, [string, number, number][]> = {}

  for (const entry of entries ?? []) {
    const { val, end, start } = entry
    if (val === null || val === undefined || !end) continue
    const days = start ? mustDay(end) - mustDay(start) : 0
    if (!has(byEnd, end)) byEnd[end] = []
    byEnd[end]!.push([entry.filed ?? '', days, val])
  }
  return byEnd
}

/**
 * Take another filing's opposite-signed fact for the one child whose sign alone breaks its parent. A parent without a
 * value is derived by the first rule whose inputs all have values.
 */
function resolveSignFlips(rows: RowResult[], filingDates: Set<string>, facts: Facts, frequency: Frequency, negated: Set<string>, rules: Rule[]): void {
  const currency = detectReportingCurrency(facts)
  const tagToRow: Record<string, RowResult> = {}
  for (const r of rows) tagToRow[r.tag] = r
  const childrenByParent: Record<string, RowResult[]> = {}
  const grouped = new Map<string, Record<string, [string, number, number][]>>()
  const [low, high] = frequency === 'annual' ? [300, 400] : [60, 135]

  for (const row of rows) {
    if (row.parent !== null && has(tagToRow, row.parent) && (row.factor === '+' || row.factor === '-')) {
      if (!has(childrenByParent, row.parent)) childrenByParent[row.parent] = []
      childrenByParent[row.parent]!.push(row)
    }
  }

  /** The opposite-signed value another filing reports for a child's direct fact. */
  const opposite = (child: RowResult, date: string): number | null => {
    const value = child.values[date]
    const match = DIRECT_SOURCE.exec(child.sources[date] ?? '')
    if (!value || match === null) return null

    if (frequency === 'quarterly') {
      for (const [d, s] of Object.entries(child.sources)) {
        if (s.startsWith('ytd_derived(')) {
          const gap = mustDay(d) - mustDay(date)
          if (gap > 0 && gap < 280) return null
        }
      }
    }

    const key = `${match[1]}\u0000${match[2]}`
    if (!grouped.has(key)) grouped.set(key, tagFacts(facts, match[1]!, match[2]!, child, currency))

    const raw = negated.has(child.tag) ? -value : value
    const same = (grouped.get(key)![date] ?? []).filter(([, days, v]) => (child.period_type === 'duration' ? low <= days && days <= high : days === 0) && Math.abs(Math.abs(v) - Math.abs(raw)) <= 0.005 * Math.abs(raw)).map(([filed, , v]) => [filed, v] as [string, number])
    const flipped = same.filter(([, v]) => v > 0 !== raw > 0)
    if (flipped.length === 0 || same.every(([, v]) => v === raw)) return null

    // max(flipped): the greatest (filed, value) pair.
    let best = flipped[0]!
    for (const f of flipped) if (f[0] > best[0] || (f[0] === best[0] && f[1] > best[1])) best = f
    return negated.has(child.tag) ? -best[1] : best[1]
  }

  const parentValue = (parent: RowResult, date: string): number | null => {
    if (parent.values[date] !== undefined) return parent.values[date]!
    for (const [target, sources] of rules) {
      const inputs = sources.map(([tag, s]) => [tagToRow[tag], s] as const)
      if (target === parent.tag && inputs.every(([r]) => r !== undefined && r.values[date] !== undefined)) {
        let total = 0
        for (const [r, s] of inputs) if (r !== undefined) total += r.values[date]! * s
        return total
      }
    }
    return null
  }

  for (const [parentTag, children] of Object.entries(childrenByParent)) {
    const parent = tagToRow[parentTag]!

    for (const date of sortedDates(filingDates)) {
      const pVal = parentValue(parent, date)
      const present = children.filter((c) => c.values[date] !== undefined).map((c) => [c, c.values[date]!] as const)
      if (pVal === null || present.length === 0) continue

      let childrenSum = 0
      for (const [c, v] of present) childrenSum += c.factor === '+' ? v : -v
      const diff = pVal - childrenSum
      const tol = tolerance(pVal, childrenSum)
      if (Math.abs(diff) <= tol) continue

      const fixes: [RowResult, number][] = []
      for (const [child, value] of present) {
        const alt = opposite(child, date)
        const sign = child.factor === '+' ? 1 : -1
        if (alt !== null && Math.abs(diff + (value - alt) * sign) <= tol) fixes.push([child, alt])
      }

      if (fixes.length === 1) {
        const [child, alt] = fixes[0]!
        child.values[date] = alt
        child.sources[date] = `${child.sources[date]}(sign-resolved)`
      }
    }
  }
}

/** Net change in cash from consecutive period-end cash balances where no net change is reported. */
function netChangeFromBalances(rows: RowResult[], filingDates: Set<string>, frequency: Frequency): void {
  const byTag: Record<string, RowResult> = {}
  for (const r of rows) byTag[r.tag] = r
  const ncc = byTag.net_change_in_cash
  const eop = byTag.cash_at_end_of_period
  if (ncc === undefined || eop === undefined) return

  const [low, high] = frequency === 'annual' ? [330, 400] : [80, 200]
  const dates = sortedDates(filingDates)
  const strip = (s: string) => (s.endsWith('(fallback)') ? s.slice(0, -'(fallback)'.length) : s)

  for (let i = 1; i < dates.length; i++) {
    const prev = dates[i - 1]!
    const date = dates[i]!
    const end = eop.values[date]
    const start = eop.values[prev]
    if (ncc.values[date] !== undefined || end === undefined || start === undefined || strip(eop.sources[date] ?? '') !== strip(eop.sources[prev] ?? '')) continue

    const days = mustDay(date) - mustDay(prev)
    if (days >= low && days <= high) {
      ncc.values[date] = end - start
      ncc.sources[date] = `imputed: cash_at_end_of_period - cash_at_end_of_period(${prev})`
    }
  }
}

/** Apply imputation rules to derive missing values, then validate. */
export function impute(
  rows: RowResult[],
  statement: StatementName,
  companyType: CompanyType,
  filingDates: Set<string>,
  facts: Facts | null = null,
  frequency: Frequency = 'annual',
): [RowResult[], ValidationWarning[]] {
  let rules: Rule[]
  if (statement === 'income_statement') rules = [...(IS_IMPUTE[companyType] ?? []), ...IS_IMPUTE_COMMON]
  else if (statement === 'balance_sheet') rules = BS_IMPUTE
  else if (statement === 'cash_flow') rules = CF_IMPUTE
  else return [rows, []]

  if (rules.length === 0) return [rows, []]

  const indexOf = (): Record<string, number> => {
    const idx: Record<string, number> = {}
    rows.forEach((r, i) => (idx[r.tag] = i))
    return idx
  }
  let tagIdx = indexOf()
  const dates = sortedDates(filingDates)
  const at = (tag: string): RowResult | undefined => (has(tagIdx, tag) ? rows[tagIdx[tag]!] : undefined)

  if (statement === 'income_statement') {
    const ptx = at('total_pretax_income')
    const beq = at('income_before_equity_method')
    const eqm = at('equity_method_investments')
    const nic = at('net_income_continuing')
    const tax = at('income_tax_expense')

    if (ptx !== undefined) {
      for (const d of dates) {
        const s = ptx.sources[d] ?? ''
        if (!s.includes('EquityMethodInvestments')) continue
        if (beq !== undefined && !has(beq.values, d)) {
          beq.values[d] = ptx.values[d]!
          beq.sources[d] = s
        }
        const niV = nic?.values[d]
        const txV = tax?.values[d]
        const niSrc = nic ? (nic.sources[d] ?? '') : ''

        if (niV !== undefined && txV !== undefined && Math.abs(ptx.values[d]! - niV - txV) <= tolerance(ptx.values[d], niV, txV)) continue
        if (niSrc.includes('ProfitLoss') && !niSrc.includes('FromContinuing')) {
          delete ptx.values[d]
          delete ptx.sources[d]
          continue
        }

        const eqv = eqm?.values[d]
        if (eqv !== undefined && eqv !== 0) {
          ptx.values[d]! += eqv
          ptx.sources[d] = 'corrected: income_before_equity_method + equity_method_investments'
        } else {
          delete ptx.values[d]
          delete ptx.sources[d]
        }
      }
    }
  }

  if (statement === 'income_statement') {
    const nic = at('net_income_continuing')
    const disc = at('net_income_discontinued')
    const tax = at('income_tax_expense')

    if (nic !== undefined && disc !== undefined) {
      for (const d of dates) {
        const s = nic.sources[d] ?? ''
        if (!s.includes('ProfitLoss')) continue
        if (s.includes('ProfitLossFrom') || s.includes('ProfitLossBefore')) continue
        if (tax !== undefined) {
          const taxSrc = tax.sources[d] ?? ''
          if (taxSrc && !taxSrc.includes('ContinuingOperations')) continue
        }
        const dv = disc.values[d]
        if (dv !== undefined && dv !== 0) {
          nic.values[d]! -= dv
          nic.sources[d] = s + '(disc-adjusted)'
        }
      }
    }
  }

  if (statement === 'cash_flow') netChangeFromBalances(rows, filingDates, frequency)

  if (facts !== null) {
    const negated = new Set(rows.filter((r) => statement === 'cash_flow' && r.balance === 'credit' && r.factor !== '0' && !CF_SIGN_KEEP.has(r.tag)).map((r) => r.tag))
    resolveSignFlips(rows, filingDates, facts, frequency, negated, rules)
  }

  applyHierarchicalArticulation(rows, filingDates)
  tagIdx = indexOf()

  runImputationPasses(rows, rules, tagIdx, filingDates)

  if (statement === 'income_statement') {
    const gp = at('total_gross_profit')
    const rev = at('total_revenue')
    const cogs = at('total_cost_of_revenue')

    if (gp !== undefined && rev !== undefined && cogs !== undefined) {
      let gpCorrected = false
      for (const date of dates) {
        const gpSrc = gp.sources[date] ?? ''
        const cogsVal = cogs.values[date]
        const revVal = rev.values[date]
        if (gpSrc.includes('imputed-rollup') && cogsVal !== undefined && cogsVal !== 0 && revVal !== undefined) {
          gp.values[date] = revVal - cogsVal
          gp.sources[date] = 'imputed: total_revenue - total_cost_of_revenue'
          gpCorrected = true
        }
      }
      if (gpCorrected) runImputationPasses(rows, rules, tagIdx, filingDates)
    }
  }

  if (statement === 'income_statement') {
    const cogs = at('total_cost_of_revenue')
    const ce = at('costs_and_expenses')
    const opex = at('total_operating_expenses')
    const opinc = at('total_operating_income')
    const rev = at('total_revenue')

    if (cogs && ce && opex && opinc && rev) {
      let cogsCorrected = false
      for (const date of dates) {
        const cogsVal = cogs.values[date]
        const ceVal = ce.values[date]
        const opexVal = opex.values[date]
        const opincVal = opinc.values[date]
        const revVal = rev.values[date]
        const cogsSrc = cogs.sources[date] ?? ''

        if (
          cogsVal !== undefined &&
          ceVal !== undefined &&
          opexVal !== undefined &&
          opincVal !== undefined &&
          revVal !== undefined &&
          !cogsSrc.includes('imputed') &&
          !(opex.sources[date] ?? '').includes('imputed') &&
          Math.abs(ceVal - (revVal - opincVal)) <= tolerance(ceVal, revVal, opincVal) &&
          cogsVal + opexVal < ceVal * 0.95
        ) {
          cogs.values[date] = ceVal - opexVal
          cogs.sources[date] = 'corrected: costs_and_expenses - total_operating_expenses'
          cogsCorrected = true
        }
      }

      if (cogsCorrected) {
        const gp2 = at('total_gross_profit')
        if (gp2 !== undefined) {
          for (const date of dates) {
            const revV = rev.values[date]
            const cogsV = cogs.values[date]
            if (revV !== undefined && cogsV !== undefined) {
              gp2.values[date] = revV - cogsV
              gp2.sources[date] = 'imputed: total_revenue - total_cost_of_revenue'
            }
          }
        }
        runImputationPasses(rows, rules, tagIdx, filingDates)
      }
    }
  }

  if (statement === 'income_statement') {
    const cogs = at('total_cost_of_revenue')
    const gp = at('total_gross_profit')
    const rev = at('total_revenue')

    if (cogs && gp && rev) {
      let gpCorrected = false
      for (const date of dates) {
        const gpVal = gp.values[date]
        const revVal = rev.values[date]
        const cogsVal = cogs.values[date]
        const gpSrc = gp.sources[date] ?? ''
        if (gpVal !== undefined && revVal !== undefined && cogsVal !== undefined && !gpSrc.includes('imputed') && Math.abs(revVal - cogsVal - gpVal) > tolerance(revVal - cogsVal, gpVal)) {
          cogs.values[date] = revVal - gpVal
          cogs.sources[date] = 'corrected: total_revenue - total_gross_profit'
          gpCorrected = true
        }
      }
      if (gpCorrected) runImputationPasses(rows, rules, tagIdx, filingDates)
    }
  }

  if (statement === 'income_statement') {
    const opex = at('total_operating_expenses')
    const gp = at('total_gross_profit')
    const opinc = at('total_operating_income')

    if (opex && gp && opinc) {
      let cleared = false
      for (const date of dates) {
        const opexVal = opex.values[date]
        const gpVal = gp.values[date]
        const opincVal = opinc.values[date]
        if (opexVal === undefined || gpVal === undefined || opincVal === undefined) continue

        if (opexVal > gpVal || (Math.abs(gpVal - opexVal - opincVal) > tolerance(gpVal - opexVal, opincVal) && !(opinc.sources[date] ?? '').includes('imputed'))) {
          opex.values[date] = gpVal - opincVal
          opex.sources[date] = 'corrected: total_gross_profit - total_operating_income'
          cleared = true
        }
      }
      if (cleared) runImputationPasses(rows, rules, tagIdx, filingDates)
    }
  }

  if (statement === 'balance_sheet') {
    const enci = at('total_equity_and_noncontrolling_interests')
    const ep = at('total_equity')
    const nci = at('noncontrolling_interests')
    const le = at('total_liabilities_and_equity')
    const l = at('total_liabilities')
    const rnci = at('temporary_equity')

    if (enci && ep && nci && le && l) {
      for (const date of dates) {
        const enciV = enci.values[date]
        const epV = ep.values[date]
        const nciV = nci.values[date] ?? 0
        const leV = le.values[date]
        const lV = l.values[date]
        const rnciV = rnci ? (rnci.values[date] ?? 0) : 0
        const rnciReported = rnci && (rnci.sources[date] ?? '').startsWith('imputed-plug') ? 0 : rnciV

        if (enciV === undefined || epV === undefined || leV === undefined || lV === undefined) continue

        if (Math.abs(enciV - epV - nciV) <= tolerance(enciV, epV, nciV) || (rnciV && Math.abs(nciV - rnciV) <= tolerance(nciV, rnciV))) continue

        const circular = (l.sources[date] ?? '').includes('total_equity_and_noncontrolling_interests')

        if (!circular && Math.abs(lV + epV + nciV + rnciReported - leV) <= tolerance(leV, lV, epV, nciV, rnciReported)) {
          enci.values[date] = epV + nciV
          enci.sources[date] = 'corrected: total_equity + noncontrolling_interests'
          delete nci.date_factors[date]
          continue
        }

        if (Math.abs(lV + enciV + rnciV - leV) > tolerance(leV, lV, enciV, rnciV)) continue

        if (circular && (enci.sources[date] ?? '').endsWith('(fallback)') && !(ep.sources[date] ?? '').endsWith('(fallback)')) {
          enci.values[date] = epV + nciV
          enci.sources[date] = 'corrected: total_equity + noncontrolling_interests'
          delete nci.date_factors[date]
          continue
        }

        ep.values[date] = enciV - nciV
        ep.sources[date] = 'reconciled: total_equity_and_noncontrolling_interests - noncontrolling_interests'
        delete nci.date_factors[date]
      }
    }
  }

  applyHierarchicalArticulation(rows, filingDates)
  tagIdx = indexOf()

  const diagnostics = verifyIdentities(rows, statement, filingDates, facts, tagIdx)

  return [rows, diagnostics]
}
