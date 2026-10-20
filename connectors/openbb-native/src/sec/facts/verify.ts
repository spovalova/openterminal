// Verification of the statement identities after imputation, provider sec: each verify rule is checked per period and
// the term the evidence points to is changed, or a warning is kept. Ported from the verification stage of `impute` in
// openbb_sec/utils/statement_schema/_imputation.py (OpenBB Platform 5.0.0, Apache-2.0); modified: dates are visited in
// sorted order (Python iterates a set), and the stage is its own function.
import { applyHierarchicalArticulation } from './articulation.js'
import { detectReportingCurrency, priorPeriodEnd } from './detection.js'
import { BS_VERIFY, CF_VERIFY, IS_VERIFY, NONNEGATIVE_LINES, type Rule } from './rules.js'
import { has, daysBetween, sum } from './py.js'
import { tolerance, type FactEntry, type Facts, type RowResult, type StatementName, type ValidationWarning } from './types.js'

/** Build a human-readable source string for an imputation rule. */
function formatImputeSource(prefix: string, sources: [string, number][]): string {
  const parts: string[] = []
  sources.forEach(([srcTag, sign], i) => {
    if (i === 0) parts.push(`${sign < 0 ? '-' : ''}${srcTag}`)
    else parts.push(`${sign > 0 ? '+' : '-'} ${srcTag}`)
  })
  return `${prefix}: ${parts.join(' ')}`
}

const NCI_VALID_FORMS = ['10-K', '10-K/A', '10-Q', '10-Q/A', '20-F', '20-F/A', '40-F', '40-F/A', '6-K', '6-K/A']
const SRC_SOFT_MARKERS = ['imputed-rollup', 'imputed-plug', '(fallback)']
const TGT_SOFT_MARKERS = [...SRC_SOFT_MARKERS, 'imputed:']
const isTargetSoft = (src: string): boolean => TGT_SOFT_MARKERS.some((m) => src.includes(m))
const isSourceSoft = (src: string): boolean => SRC_SOFT_MARKERS.some((m) => src.includes(m))

/** `ns.get(tag, {}).get("units", {}).get(unit, [])`. */
const entriesOf = (ns: Record<string, any> | undefined, tag: string, unit: string): FactEntry[] => ns?.[tag]?.units?.[unit] ?? []

const inRange = (days: number, ranges: [number, number][]): boolean => ranges.some(([a, b]) => a <= days && days <= b)
const QUARTER_OR_YEAR: [number, number][] = [
  [60, 135],
  [300, 400],
]

const DISC_FX_TAGS = [
  'EffectOfExchangeRateOnCashAndCashEquivalentsDiscontinuedOperations',
  'EffectOfExchangeRateOnCashCashEquivalentsRestrictedCashAndRestrictedCashEquivalentsDisposalGroupIncludingDiscontinuedOperations',
]

/**
 * Check each verify rule at each date and enforce it by changing the term the evidence points to; returns the
 * diagnostics for identities that stay broken. Rows are changed in place.
 */
export function verifyIdentities(rows: RowResult[], statement: StatementName, filingDates: Set<string>, facts: Facts | null, tagIdx: Record<string, number>): ValidationWarning[] {
  let verifyRules: Rule[]
  if (statement === 'income_statement') verifyRules = IS_VERIFY
  else if (statement === 'balance_sheet') verifyRules = BS_VERIFY
  else if (statement === 'cash_flow') verifyRules = CF_VERIFY
  else verifyRules = []

  const diagnostics: ValidationWarning[] = []
  const verifiedPairs = new Set<string>()
  const pairKey = (tag: string, date: string) => `${tag}\u0000${date}`
  const pendingDiagnostics = new Map<string, ValidationWarning>()
  const dates = [...filingDates].sort()
  const rowOf = (tag: string): RowResult | undefined => (has(tagIdx, tag) ? rows[tagIdx[tag]!] : undefined)

  for (const [targetTag, sources] of verifyRules) {
    const targetRow = rowOf(targetTag)
    if (targetRow === undefined) continue

    for (const date of dates) {
      if (verifiedPairs.has(pairKey(targetTag, date))) continue
      if (!has(targetRow.values, date)) continue

      let ncIncludesFx: boolean | null = true
      let cfScopeMismatch = false

      if (targetTag === 'net_change_in_cash') {
        const ncSrc = targetRow.sources[date] ?? ''
        const hasFxInRule = sources.some(([s]) => s === 'effect_of_exchange_rate_changes')
        if (ncSrc.includes('ExcludingExchangeRateEffect')) ncIncludesFx = false
        else if (ncSrc.includes('IncludingExchangeRateEffect')) ncIncludesFx = true
        else ncIncludesFx = null

        if (ncIncludesFx !== null) {
          if (!hasFxInRule && ncIncludesFx) continue
          if (hasFxInRule && !ncIncludesFx) continue
        }

        for (const [srcTag] of sources) {
          if (srcTag === 'effect_of_exchange_rate_changes' || srcTag === 'other_net_changes_in_cash') continue
          const srcRow = rowOf(srcTag)
          if (srcRow !== undefined && (srcRow.sources[date] ?? '').includes('ContinuingOperations')) {
            cfScopeMismatch = true
            break
          }
        }
      }

      if ((targetTag === 'total_pretax_income' || targetTag === 'net_income_continuing') && statement === 'income_statement') {
        const nicRow = rowOf('net_income_continuing')
        const taxRow = rowOf('income_tax_expense')
        if (nicRow !== undefined && taxRow !== undefined) {
          const nicSrc = nicRow.sources[date] ?? ''
          const taxSrc = taxRow.sources[date] ?? ''
          if (nicSrc.includes('(disc-adjusted)') && !taxSrc.includes('ContinuingOperations')) {
            const ptxRow = rowOf('total_pretax_income')
            if (ptxRow !== undefined) {
              const pv = ptxRow.values[date]
              const nv = nicRow.values[date]
              const tv = taxRow.values[date]
              if (pv !== undefined && nv !== undefined && tv !== undefined && Math.abs(pv - nv - tv) > tolerance(pv, nv, tv)) {
                verifiedPairs.add(pairKey('total_pretax_income', date))
                verifiedPairs.add(pairKey('net_income_continuing', date))
                continue
              }
            }
          }
        }
      }

      let val = 0
      let allPresent = true
      for (const [srcTag, sign] of sources) {
        const srcRow = rowOf(srcTag)
        if (srcRow === undefined) {
          allPresent = false
          break
        }
        const srcVal = srcRow.values[date]
        if (srcVal === undefined) {
          allPresent = false
          break
        }
        val += srcVal * sign
      }
      if (!allPresent) continue

      const diff = Math.abs(val - targetRow.values[date]!)
      const tol = tolerance(val, targetRow.values[date])
      if (diff <= tol) {
        verifiedPairs.add(pairKey(targetTag, date))
        continue
      }

      if (statement === 'income_statement' && (targetTag === 'total_pretax_income' || targetTag === 'net_income_continuing')) {
        const ptx = rows[tagIdx.total_pretax_income!]!
        const nic = rows[tagIdx.net_income_continuing!]!
        const tax = rows[tagIdx.income_tax_expense!]!
        const pv = ptx.values[date]!
        const nv = nic.values[date]!
        const tv = tax.values[date]!
        const parts = ['income_tax_current', 'income_tax_deferred'].filter((t) => has(tagIdx, t)).map((t) => rows[tagIdx[t]!]!)
        const hardParts = parts.filter((p) => p.values[date] !== undefined && !(p.sources[date] ?? '').startsWith('imputed'))

        if (
          !isTargetSoft(ptx.sources[date] ?? '') &&
          !isTargetSoft(nic.sources[date] ?? '') &&
          Math.abs(pv - nv + tv) <= tolerance(pv, nv, tv) &&
          !(hardParts.length === 2 && Math.abs(sum(hardParts.map((p) => p.values[date]!)) - tv) <= tolerance(tv))
        ) {
          tax.values[date] = -tv
          tax.sources[date] = 'corrected: total_pretax_income - net_income_continuing'

          if (parts.length === 2 && hardParts.length === 1) {
            const peer = hardParts[0]!
            const part = peer === parts[0] ? parts[1]! : parts[0]!
            if ((part.sources[date] ?? '').startsWith('imputed')) {
              part.values[date] = -tv - peer.values[date]!
              part.sources[date] = `imputed: income_tax_expense - ${peer.tag}`
            }
          }
          verifiedPairs.add(pairKey('total_pretax_income', date))
          verifiedPairs.add(pairKey('net_income_continuing', date))
          continue
        }
      }

      if (targetTag === 'total_assets' && statement === 'balance_sheet' && sources.length === 1 && sources[0]![0] === 'total_liabilities_and_equity') {
        const leRow = rowOf('total_liabilities_and_equity')
        if (leRow !== undefined) {
          const leVal = leRow.values[date]
          if (leVal !== undefined && leVal < 0 && Math.abs(targetRow.values[date]! + leVal) <= tolerance(targetRow.values[date], leVal)) {
            leRow.values[date] = -leVal
            leRow.sources[date] = (leRow.sources[date] ?? '') + ' (sign-corrected)'
            verifiedPairs.add(pairKey(targetTag, date))
            continue
          }
        }
      }

      if (statement === 'income_statement' && (targetTag === 'total_pretax_income' || targetTag === 'net_income_continuing') && facts !== null) {
        const nicRow = rowOf('net_income_continuing')

        if (nicRow !== undefined) {
          const nicIdx = tagIdx.net_income_continuing!
          const nicSrc = nicRow.sources[date] ?? ''

          const pickEntries = (rawEntries: FactEntry[], targetDate: string): [string, number][] => {
            const candidates = new Map<string, number>()
            for (const e of rawEntries) {
              if (e.end !== targetDate || !NCI_VALID_FORMS.includes(e.form) || !('start' in e)) continue
              const d = daysBetween(targetDate, e.start)
              if (d === null) continue
              if (!((d >= 60 && d <= 135) || (d >= 150 && d <= 200) || (d >= 300 && d <= 400))) continue
              const f = e.filed ?? ''
              if (!candidates.has(f)) candidates.set(f, e.val)
            }
            return [...candidates.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
          }

          const tryNciSwap = (altVal: number, altTagLabel: string): boolean => {
            const taxIdx = tagIdx.income_tax_expense
            const ptxIdx = tagIdx.total_pretax_income
            if (taxIdx === undefined || ptxIdx === undefined) return false
            const tv = rows[taxIdx]!.values[date]
            const pv = rows[ptxIdx]!.values[date]
            if (tv === undefined || pv === undefined) return false
            if (Math.abs(pv - altVal - tv) <= tolerance(pv, altVal, tv)) {
              rows[nicIdx]!.values[date] = altVal
              rows[nicIdx]!.sources[date] = altTagLabel
              verifiedPairs.add(pairKey('total_pretax_income', date))
              verifiedPairs.add(pairKey('net_income_continuing', date))
              return true
            }
            return false
          }

          const us = facts['us-gaap']
          if (nicSrc.includes('ProfitLoss') && !nicSrc.includes('ProfitLossFrom')) {
            for (const [, val2] of pickEntries(entriesOf(us, 'NetIncomeLoss', 'USD'), date)) {
              if (tryNciSwap(val2, 'us-gaap:NetIncomeLoss(NCI-corrected)')) break
            }
          } else if (nicSrc.includes('NetIncomeLoss')) {
            const ptxIdx = tagIdx.total_pretax_income
            const ptxSrc = ptxIdx !== undefined ? (rows[ptxIdx]!.sources[date] ?? '') : ''
            if (ptxSrc.includes('NoncontrollingInterest')) {
              for (const [, val2] of pickEntries(entriesOf(us, 'ProfitLoss', 'USD'), date)) {
                if (tryNciSwap(val2, 'us-gaap:ProfitLoss(NCI-corrected)')) break
              }
            }
          }

          if (!verifiedPairs.has(pairKey(targetTag, date))) {
            const nicSrcQ4 = rows[nicIdx]!.sources[date] ?? ''
            if (nicSrcQ4.includes('Q4:')) {
              for (const altTag of ['NetIncomeLoss', 'ProfitLoss']) {
                const altRaw = entriesOf(us, altTag, 'USD')
                let fyVal: number | null = null
                let fyBestFiled: string | null = null
                let fyStartDate: string | null = null

                for (const e of altRaw) {
                  if (e.end !== date || !('start' in e) || !NCI_VALID_FORMS.includes(e.form)) continue
                  const days = daysBetween(date, e.start)
                  if (days === null) continue
                  if (days >= 300 && days <= 400) {
                    const ef = e.filed ?? ''
                    if (fyBestFiled === null || ef < fyBestFiled) {
                      fyBestFiled = ef
                      fyVal = e.val
                      fyStartDate = e.start
                    }
                  }
                }
                if (fyVal === null || fyStartDate === null) continue

                const qByEnd = new Map<string, [string, number]>()
                for (const e of altRaw) {
                  if (!('start' in e) || !NCI_VALID_FORMS.includes(e.form)) continue
                  const qd = daysBetween(e.end, e.start)
                  if (qd === null) continue
                  if (!(qd >= 60 && qd <= 135)) continue
                  const eEnd: string = e.end
                  if (!(fyStartDate <= eEnd && eEnd < date)) continue
                  const ef = e.filed ?? ''
                  if (!qByEnd.has(eEnd) || ef < qByEnd.get(eEnd)![0]) qByEnd.set(eEnd, [ef, e.val])
                }

                if (qByEnd.size === 3) {
                  const q4Alt = fyVal - sum([...qByEnd.values()].map(([, v]) => v))
                  if (tryNciSwap(q4Alt, `us-gaap:${altTag}(Q4-NCI-corrected)`)) break
                }
              }
            }
          }

          if (verifiedPairs.has(pairKey(targetTag, date))) continue
        }
      }

      if (statement === 'income_statement' && (targetTag === 'total_pretax_income' || targetTag === 'net_income_continuing') && !verifiedPairs.has(pairKey(targetTag, date))) {
        const scopeFormula = formatImputeSource('', sources).replace(/^[: ]+/, '')
        targetRow.values[date] = val
        targetRow.sources[date] = `scope-aligned: ${scopeFormula}`
        verifiedPairs.add(pairKey('total_pretax_income', date))
        verifiedPairs.add(pairKey('net_income_continuing', date))
        continue
      }

      if (targetTag === 'net_change_in_cash') {
        const discRow = rowOf('net_cash_from_discontinued_operations')
        const discVal = discRow?.values[date]
        let discFx = 0.0

        if (discVal !== undefined && facts !== null) {
          const us = facts['us-gaap']
          outer: for (const dft of DISC_FX_TAGS) {
            for (const e of entriesOf(us, dft, 'USD')) {
              if (e.end === date && 'start' in e) {
                const days = daysBetween(date, e.start)
                if (days === null) continue
                if (inRange(days, QUARTER_OR_YEAR)) {
                  discFx = e.val
                  break
                }
              }
            }
            if (discFx !== 0.0) break outer
          }
        }

        if (discVal !== undefined) {
          let adjDiff = Math.abs(val + discVal + discFx - targetRow.values[date]!)
          if (adjDiff <= tolerance(val, discVal, discFx, targetRow.values[date])) {
            verifiedPairs.add(pairKey(targetTag, date))
            continue
          }
          if (discFx !== 0.0) {
            adjDiff = Math.abs(val + discVal - targetRow.values[date]!)
            if (adjDiff <= tolerance(val, discVal, targetRow.values[date])) {
              verifiedPairs.add(pairKey(targetTag, date))
              continue
            }
          }
        }

        const DISC_INDIVIDUAL_TAGS = [
          'CashProvidedByUsedInOperatingActivitiesDiscontinuedOperations',
          'CashProvidedByUsedInInvestingActivitiesDiscontinuedOperations',
          'CashProvidedByUsedInFinancingActivitiesDiscontinuedOperations',
        ]
        if (facts !== null && !verifiedPairs.has(pairKey(targetTag, date))) {
          const us = facts['us-gaap']
          for (const dit of DISC_INDIVIDUAL_TAGS) {
            for (const e of entriesOf(us, dit, 'USD')) {
              if (e.end === date && 'start' in e) {
                const days = daysBetween(date, e.start)
                if (days === null) continue
                if (inRange(days, QUARTER_OR_YEAR) && Math.abs(val + e.val - targetRow.values[date]!) <= tolerance(val, e.val, targetRow.values[date])) {
                  verifiedPairs.add(pairKey(targetTag, date))
                  break
                }
              }
            }
            if (verifiedPairs.has(pairKey(targetTag, date))) break
          }
          if (verifiedPairs.has(pairKey(targetTag, date))) continue
        }

        if (discVal === undefined && facts !== null) {
          const DISC_OPS_TAGS = [
            'CashProvidedByUsedInOperatingActivitiesDiscontinuedOperations',
            'CashProvidedByUsedInInvestingActivitiesDiscontinuedOperations',
            'CashProvidedByUsedInFinancingActivitiesDiscontinuedOperations',
            'NetCashProvidedByUsedInDiscontinuedOperations',
          ]
          const DISC_OPS_IFRS = [
            'CashFlowsFromUsedInOperatingActivitiesDiscontinuedOperations',
            'CashFlowsFromUsedInInvestingActivitiesDiscontinuedOperations',
            'CashFlowsFromUsedInFinancingActivitiesDiscontinuedOperations',
          ]
          const ccy = detectReportingCurrency(facts)
          let discSum = 0.0
          let discFound = false
          let nsLast: Record<string, any> | undefined
          let unitLast = 'USD'

          for (const [nsKey, tags, unit] of [
            ['us-gaap', DISC_OPS_TAGS, 'USD'],
            ['ifrs-full', DISC_OPS_IFRS, ccy],
          ] as [string, string[], string][]) {
            const ns = facts[nsKey]
            nsLast = ns
            unitLast = unit
            for (const dt of tags) {
              for (const e of entriesOf(ns, dt, unit)) {
                if (e.end === date && 'start' in e) {
                  const days = daysBetween(date, e.start)
                  if (days === null) continue
                  if (inRange(days, QUARTER_OR_YEAR)) {
                    discSum += e.val
                    discFound = true
                    break
                  }
                }
              }
            }
            if (discFound) break
          }

          if (discFound) {
            let discFxFb1 = 0.0
            for (const dft of DISC_FX_TAGS) {
              for (const e of entriesOf(nsLast, dft, unitLast)) {
                if (e.end === date && 'start' in e) {
                  const days = daysBetween(date, e.start)
                  if (days === null) continue
                  if (inRange(days, QUARTER_OR_YEAR)) {
                    discFxFb1 = e.val
                    break
                  }
                }
              }
              if (discFxFb1 !== 0.0) break
            }

            const adjDiff = Math.abs(val + discSum + discFxFb1 - targetRow.values[date]!)
            if (adjDiff <= tolerance(val, discSum, discFxFb1, targetRow.values[date])) {
              verifiedPairs.add(pairKey(targetTag, date))
              continue
            }
          }
        }

        if (discVal === undefined && facts !== null) {
          const disposalTags = [
            'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalentsPeriodIncreaseDecreaseIncludingExchangeRateEffectDisposalGroupIncludingDiscontinuedOperations',
            'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalentsPeriodIncreaseDecreaseExcludingExchangeRateEffectDisposalGroupIncludingDiscontinuedOperations',
            'CashAndCashEquivalentsPeriodIncreaseDecreaseDisposalGroupIncludingDiscontinuedOperations',
          ]
          const us = facts['us-gaap']

          for (const dt of disposalTags) {
            let broke = false
            for (const e of entriesOf(us, dt, 'USD')) {
              if (e.end === date && ['10-K', '10-Q', '20-F', '40-F'].includes(e.form) && 'start' in e) {
                const days = daysBetween(date, e.start)
                if (days === null) continue
                if (inRange(days, QUARTER_OR_YEAR)) {
                  const disposalNc = e.val
                  const derivedDisc = targetRow.values[date]! - disposalNc
                  const adjDiff = Math.abs(val + derivedDisc - targetRow.values[date]!)
                  if (adjDiff <= tolerance(val, derivedDisc, targetRow.values[date])) {
                    verifiedPairs.add(pairKey(targetTag, date))
                    broke = true
                    break
                  }
                }
              }
            }
            if (!broke) continue
            break
          }
          if (verifiedPairs.has(pairKey(targetTag, date))) continue
        }

        if (facts !== null && discVal === undefined && !verifiedPairs.has(pairKey(targetTag, date))) {
          const DISP_CASH_TAGS = ['DisposalGroupIncludingDiscontinuedOperationCashAndCashEquivalents', 'DisposalGroupIncludingDiscontinuedOperationCash']
          const us = facts['us-gaap']
          let dispEnd: number | null = null

          for (const dct of DISP_CASH_TAGS) {
            for (const e of entriesOf(us, dct, 'USD')) {
              if (e.end === date && !('start' in e)) {
                dispEnd = e.val
                break
              }
            }
            if (dispEnd !== null) break
          }

          if (dispEnd !== null) {
            let dispStart = 0.0
            const prior = priorPeriodEnd(date)
            if (prior) {
              for (const dct of DISP_CASH_TAGS) {
                for (const e of entriesOf(us, dct, 'USD')) {
                  if (e.end === prior && !('start' in e)) {
                    dispStart = e.val
                    break
                  }
                }
                if (dispStart !== 0.0) break
              }
            }
            const dispDelta = dispEnd - dispStart
            if (Math.abs(dispDelta) > 0) {
              const adjDiff = Math.abs(val - dispDelta - targetRow.values[date]!)
              if (adjDiff <= tolerance(val, dispDelta, targetRow.values[date])) {
                verifiedPairs.add(pairKey(targetTag, date))
                continue
              }
            }
          }
        }

        if (facts !== null && !verifiedPairs.has(pairKey(targetTag, date))) {
          const RESTRICTED_TAGS = ['IncreaseDecreaseInRestrictedCashAndRestrictedCashEquivalents', 'IncreaseDecreaseInRestrictedCash', 'IncreaseDecreaseInRestrictedCashAndInvestments']
          const us = facts['us-gaap']

          for (const rt of RESTRICTED_TAGS) {
            for (const e of entriesOf(us, rt, 'USD')) {
              if (e.end === date && 'start' in e) {
                const days = daysBetween(date, e.start)
                if (days === null) continue
                if (inRange(days, QUARTER_OR_YEAR)) {
                  const adjDiff = Math.abs(val + e.val - targetRow.values[date]!)
                  if (adjDiff <= tolerance(val, e.val, targetRow.values[date])) {
                    verifiedPairs.add(pairKey(targetTag, date))
                    break
                  }
                }
              }
            }
            if (verifiedPairs.has(pairKey(targetTag, date))) break
          }
          if (verifiedPairs.has(pairKey(targetTag, date))) continue
        }

        if (facts !== null && !verifiedPairs.has(pairKey(targetTag, date))) {
          const ACTIVITY_PAIRS = [
            ['NetCashProvidedByUsedInOperatingActivities', 'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations'],
            ['NetCashProvidedByUsedInInvestingActivities', 'NetCashProvidedByUsedInInvestingActivitiesContinuingOperations'],
            ['NetCashProvidedByUsedInFinancingActivities', 'NetCashProvidedByUsedInFinancingActivitiesContinuingOperations'],
          ] as const
          const FX_ALT = ['EffectOfExchangeRateOnCashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents', 'EffectOfExchangeRateOnCashAndCashEquivalents', 'EffectOfExchangeRateOnCashAndCashEquivalentsContinuingOperations']
          const NC_ALT = [
            'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalentsPeriodIncreaseDecreaseIncludingExchangeRateEffect',
            'CashAndCashEquivalentsPeriodIncreaseDecrease',
            'CashAndCashEquivalentsPeriodIncreaseDecreaseExcludingExchangeRateEffect',
          ]
          const IFRS_ACTIVITY_PAIRS = [
            ['CashFlowsFromUsedInOperatingActivities', 'CashFlowsFromUsedInOperatingActivitiesContinuingOperations'],
            ['CashFlowsFromUsedInInvestingActivities', 'CashFlowsFromUsedInInvestingActivitiesContinuingOperations'],
            ['CashFlowsFromUsedInFinancingActivities', 'CashFlowsFromUsedInFinancingActivitiesContinuingOperations'],
          ] as const
          const IFRS_FX_ALT = ['EffectOfExchangeRateChangesOnCashAndCashEquivalents']
          const IFRS_NC_ALT = ['IncreaseDecreaseInCashAndCashEquivalents']
          const us = facts['us-gaap']
          const ifrs = facts['ifrs-full']
          const ccy = detectReportingCurrency(facts)

          const cfVals = (tagName: string, ns: Record<string, any> | undefined, unit: string): Set<number> => {
            const out = new Set<number>()
            for (const e of entriesOf(ns, tagName, unit)) {
              if (e.end === date && 'start' in e) {
                const d = daysBetween(date, e.start)
                if (d === null) continue
                if (inRange(d, QUARTER_OR_YEAR)) out.add(e.val)
              }
            }
            return out
          }
          const union = (...sets: Set<number>[]): Set<number> => new Set(sets.flatMap((s) => [...s]))

          const actOpts: Set<number>[] = ACTIVITY_PAIRS.map(([tot, cont]) => union(cfVals(tot, us, 'USD'), cfVals(cont, us, 'USD')))
          IFRS_ACTIVITY_PAIRS.forEach(([tot, cont], idx) => {
            actOpts[idx] = union(actOpts[idx]!, cfVals(tot, ifrs, ccy), cfVals(cont, ifrs, ccy))
          })

          let fxOpts = new Set<number>([0.0])
          for (const ft of FX_ALT) fxOpts = union(fxOpts, cfVals(ft, us, 'USD'))
          for (const ft of IFRS_FX_ALT) fxOpts = union(fxOpts, cfVals(ft, ifrs, ccy))

          let discFxVals = new Set<number>()
          for (const dft of DISC_FX_TAGS) discFxVals = union(discFxVals, cfVals(dft, us, 'USD'))
          if (discFxVals.size) {
            for (const fv of [...fxOpts]) for (const dfv of discFxVals) fxOpts.add(fv + dfv)
          }

          let ncOpts = new Set<number>()
          for (const nt of NC_ALT) ncOpts = union(ncOpts, cfVals(nt, us, 'USD'))
          for (const nt of IFRS_NC_ALT) ncOpts = union(ncOpts, cfVals(nt, ifrs, ccy))

          let matched = false
          if (actOpts.every((s) => s.size > 0) && ncOpts.size > 0) {
            search: for (const o of actOpts[0]!) for (const i of actOpts[1]!) for (const f of actOpts[2]!) for (const fx of fxOpts) for (const nc of ncOpts) {
              if (Math.abs(o + i + f + fx - nc) <= tolerance(o, i, f, fx, nc)) {
                matched = true
                break search
              }
            }
          }
          if (matched) {
            verifiedPairs.add(pairKey(targetTag, date))
            continue
          }
        }

        if (facts !== null && !verifiedPairs.has(pairKey(targetTag, date))) {
          const us = facts['us-gaap']
          const ifrs = facts['ifrs-full']
          const ccy = detectReportingCurrency(facts)
          const ncVal = targetRow.values[date]
          const CASH_BAL_TAGS: [string, string, string][] = [
            ['us-gaap', 'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents', 'USD'],
            ['us-gaap', 'CashAndCashEquivalentsAtCarryingValue', 'USD'],
            ['us-gaap', 'Cash', 'USD'],
            ['ifrs-full', 'CashAndCashEquivalents', ccy],
          ]

          for (const [nsKey, cbt, unit] of CASH_BAL_TAGS) {
            const ns = nsKey === 'ifrs-full' ? ifrs : us
            const endVals = new Set<number>()
            const startVals = new Set<number>()

            for (const e of entriesOf(ns, cbt, unit)) {
              if ('start' in e) continue
              const edate: string = e.end ?? ''
              if (edate === date) endVals.add(e.val)
              else if (edate) {
                const dd = daysBetween(date, edate)
                if (dd === null) continue
                if (dd >= 60 && dd <= 400) startVals.add(e.val)
              }
            }

            if (endVals.size && startVals.size && ncVal !== undefined) {
              let ok = false
              for (const ev of endVals) {
                for (const sv of startVals) if (Math.abs(ev - sv - ncVal) <= tolerance(ev, sv, ncVal)) ok = true
              }
              if (ok) {
                verifiedPairs.add(pairKey(targetTag, date))
                break
              }
            }
          }
          if (verifiedPairs.has(pairKey(targetTag, date))) continue
        }
      }

      if (targetTag === 'total_liabilities' && facts !== null && !verifiedPairs.has(pairKey(targetTag, date)) && diff > 0) {
        const leRow = rowOf('total_liabilities_and_equity')
        const enciRow = rowOf('total_equity_and_noncontrolling_interests')
        const leV = leRow?.values[date]
        const enciV = enciRow?.values[date]
        const lV = targetRow.values[date]

        if (leV !== undefined && enciV !== undefined && lV !== undefined) {
          const totalMezzComputed = leV - lV - enciV
          if (totalMezzComputed > 0) {
            verifiedPairs.add(pairKey(targetTag, date))
            continue
          }
          if (Math.abs(totalMezzComputed) <= tolerance(leV, lV, enciV)) {
            verifiedPairs.add(pairKey(targetTag, date))
            continue
          }
        }
      }

      if ((targetTag === 'total_equity_and_noncontrolling_interests' || targetTag === 'total_equity') && facts !== null && !verifiedPairs.has(pairKey(targetTag, date))) {
        const rnciRow = rowOf('temporary_equity')
        const rnciVal = rnciRow ? (rnciRow.values[date] ?? 0) : 0
        if (Math.abs(rnciVal) > 0 || diff > tolerance(diff, rnciVal)) {
          const MEZZ_TAGS_EQ = [
            'RedeemableNoncontrollingInterestEquityCarryingAmount',
            'RedeemableNoncontrollingInterestEquityCommonCarryingAmount',
            'RedeemableNoncontrollingInterestEquityPreferredCarryingAmount',
            'TemporaryEquityCarryingAmountAttributableToParent',
            'TemporaryEquityCarryingAmountAttributableToNoncontrollingInterest',
            'TemporaryEquityCarryingAmountIncludingPortionAttributableToNoncontrollingInterests',
            'TemporaryEquityCarryingAmount',
            'RedeemablePreferredStockCarryingAmountOrRedemptionValue',
            'PreferredStockValue',
          ]
          const us = facts['us-gaap']
          let eqResolved = false
          let mezzSum = 0.0

          for (const mt of MEZZ_TAGS_EQ) {
            for (const e of entriesOf(us, mt, 'USD')) {
              if (e.end === date && !('start' in e)) {
                if (Math.abs(diff - e.val) <= tolerance(diff, e.val)) eqResolved = true
                mezzSum += e.val
                break
              }
            }
            if (eqResolved) break
          }

          if (!eqResolved && Math.abs(diff - mezzSum) <= tolerance(diff, mezzSum)) eqResolved = true

          if (eqResolved) {
            verifiedPairs.add(pairKey(targetTag, date))
            continue
          }
        }

        const nciRow = rowOf('noncontrolling_interests')
        const nciVal = nciRow?.values[date]
        if (nciVal !== undefined && nciVal < 0 && Math.abs(diff - 2 * Math.abs(nciVal)) <= tolerance(diff, nciVal)) {
          verifiedPairs.add(pairKey(targetTag, date))
          continue
        }
      }

      if (targetTag === 'total_operating_income' && statement === 'income_statement' && facts !== null && !verifiedPairs.has(pairKey(targetTag, date))) {
        const signedGap = targetRow.values[date]! - val
        const us = facts['us-gaap']
        const OTHER_OP_TAGS = ['GainLossOnDispositionOfAssets', 'GainLossOnSaleOfPropertyPlantEquipment', 'GainLossOnDispositionOfProperty', 'OtherOperatingIncomeExpenseNet']
        let oiBridgeResolved = false

        for (const ot of OTHER_OP_TAGS) {
          for (const e of entriesOf(us, ot, 'USD')) {
            if (e.end === date && 'start' in e && e.val !== 0 && Math.abs(signedGap - e.val) <= tolerance(signedGap, e.val)) {
              oiBridgeResolved = true
              break
            }
          }
          if (oiBridgeResolved) break
        }

        if (!oiBridgeResolved) {
          const vals: number[] = []
          for (const t of ['total_gross_profit', 'total_operating_expenses', 'total_operating_income']) {
            const r = rowOf(t)
            if (r !== undefined) {
              const v = r.values[date]
              if (v !== undefined) vals.push(Math.abs(Math.trunc(v)))
            }
          }
          if (vals.length === 3 && vals.every((v) => v % 1_000_000 === 0) && diff <= 1_000_000) oiBridgeResolved = true
        }

        if (oiBridgeResolved) {
          verifiedPairs.add(pairKey(targetTag, date))
          continue
        }
      }

      const targetSrc = targetRow.sources[date] ?? ''
      const formula = formatImputeSource('', sources).replace(/^[: ]+/, '')
      const ambiguousCf = targetTag === 'net_change_in_cash' && ncIncludesFx === null
      const skipEnforce = ambiguousCf || cfScopeMismatch

      if (isTargetSoft(targetSrc) && !skipEnforce) {
        targetRow.values[date] = val
        targetRow.sources[date] = `identity-enforced: ${formula} [solving ${targetTag}]`
        verifiedPairs.add(pairKey(targetTag, date))
        continue
      }

      if (!skipEnforce) {
        const softSrcTags: [string, number][] = []
        for (const [srcTag, sign] of sources) {
          const srcRow = rowOf(srcTag)
          if (srcRow !== undefined && isSourceSoft(srcRow.sources[date] ?? '')) softSrcTags.push([srcTag, sign])
        }

        if (softSrcTags.length === 1) {
          const [fixTag, fixSign] = softSrcTags[0]!
          let otherSum = 0
          for (const [srcTag, sign] of sources) if (srcTag !== fixTag) otherSum += rows[tagIdx[srcTag]!]!.values[date]! * sign
          const solved = (targetRow.values[date]! - otherSum) * fixSign

          if (!NONNEGATIVE_LINES.has(fixTag) || solved >= -tolerance(solved)) {
            const fixRow = rows[tagIdx[fixTag]!]!
            fixRow.values[date] = solved
            fixRow.sources[date] = `identity-enforced: derived from ${targetTag} [solving ${fixTag}]`
            verifiedPairs.add(pairKey(targetTag, date))
            continue
          }
        }
      }

      if (targetTag === 'net_change_in_cash' && !verifiedPairs.has(pairKey(targetTag, date))) {
        const DERIVED_MARKERS = ['ytd_derived', 'Q4:', 'H2:', 'q4_h2_derived']
        const ncIsDerived = DERIVED_MARKERS.some((m) => targetSrc.includes(m))
        let anySrcDerived = false

        if (!ncIsDerived) {
          for (const [st] of sources) {
            const si = rowOf(st)
            if (si !== undefined) {
              const ss = si.sources[date] ?? ''
              if (DERIVED_MARKERS.some((m) => ss.includes(m))) {
                anySrcDerived = true
                break
              }
            }
          }
        }

        if (ncIsDerived || anySrcDerived) {
          targetRow.values[date] = val
          targetRow.sources[date] = cfScopeMismatch ? `scope-aligned: ${formula} [solving ${targetTag}]` : `identity-enforced: ${formula} [solving ${targetTag}]`
          verifiedPairs.add(pairKey(targetTag, date))
          continue
        }
      }

      if (ambiguousCf) {
        const newWarning: ValidationWarning = { date, tag: targetTag, expected: val, actual: targetRow.values[date]!, formula, identity: `${targetTag} = ${formula}` }
        const existing = pendingDiagnostics.get(pairKey(targetTag, date))
        if (existing !== undefined) {
          if (diff < Math.abs(existing.actual - existing.expected)) pendingDiagnostics.set(pairKey(targetTag, date), newWarning)
        } else {
          pendingDiagnostics.set(pairKey(targetTag, date), newWarning)
        }
        continue
      }

      if (cfScopeMismatch) {
        targetRow.values[date] = val
        targetRow.sources[date] = `scope-aligned: ${formula} [solving ${targetTag}]`
        verifiedPairs.add(pairKey(targetTag, date))
        continue
      }

      if (facts !== null && targetSrc.includes(':') && !targetSrc.includes('identity-enforced') && !targetSrc.includes('imputed')) {
        const parts = targetSrc.split(':')
        const tgtNs = parts[0]!
        const tgtXbrl = parts[1]!.trim().split(/\s+/)[0]!
        const tgtEntries = (facts[tgtNs]?.[tgtXbrl]?.units ?? {}) as Record<string, FactEntry[]>
        let vintageMatch = false
        for (const unitEntries of Object.values(tgtEntries)) {
          for (const e of unitEntries) {
            if (e.end === date && !('start' in e) && Math.abs(e.val - val) <= tolerance(val, e.val)) {
              vintageMatch = true
              break
            }
          }
          if (vintageMatch) break
        }
        if (vintageMatch) {
          targetRow.values[date] = val
          targetRow.sources[date] = targetSrc + ' (vintage-corrected)'
          verifiedPairs.add(pairKey(targetTag, date))
          continue
        }
      }

      const anySrcSoft = sources.some(([st]) => rowOf(st) !== undefined && isSourceSoft(rowOf(st)!.sources[date] ?? ''))
      if (!anySrcSoft) {
        diagnostics.push({ date, tag: targetTag, expected: val, actual: targetRow.values[date]!, formula, identity: `${targetTag} = ${formula}` })
      } else {
        targetRow.values[date] = val
        targetRow.sources[date] = `identity-enforced: ${formula} [solving ${targetTag}]`
      }
      verifiedPairs.add(pairKey(targetTag, date))
    }
  }

  for (const [key, warning] of pendingDiagnostics) {
    if (!verifiedPairs.has(key)) {
      const [tag, date] = key.split('\u0000') as [string, string]
      const ti = rowOf(tag)
      if (ti !== undefined) {
        ti.values[date] = warning.expected
        ti.sources[date] = `identity-enforced: ${warning.formula} [solving ${tag}]`
        verifiedPairs.add(key)
      }
    }
  }

  if (rows.some((r) => dates.some((d) => (r.sources[d] ?? '').includes('identity-enforced') || (r.sources[d] ?? '').includes('scope-aligned') || (r.sources[d] ?? '').startsWith('corrected: total_pretax_income')))) {
    applyHierarchicalArticulation(rows, filingDates)
  }

  return diagnostics
}
