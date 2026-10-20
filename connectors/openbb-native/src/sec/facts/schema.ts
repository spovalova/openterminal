// StatementSchema, provider sec: loads the split JSON schema and orchestrates extraction. Ported from
// openbb_sec/utils/statement_schema/_schema.py (OpenBB Platform 5.0.0, Apache-2.0); modified: the class is a set of
// functions over the schema constants, dates are visited in sorted order (Python iterates a set), and the clock
// (`datetime.now().year`) is a parameter taken from ctx.now().
import balanceSheetJson from './schemas/balance_sheet.json' with { type: 'json' }
import cashFlowJson from './schemas/cash_flow.json' with { type: 'json' }
import incomeStatementJson from './schemas/income_statement.json' with { type: 'json' }
import metaJson from './schemas/_meta.json' with { type: 'json' }
import { applyHierarchicalArticulation } from './articulation.js'
import { detectReportingCurrency, detectType, getFilingDates, getFiscalMeta, preliminaryView, type DetectionSignals } from './detection.js'
import { computeRefFilings, extractRowValues, rescaledFacts } from './extraction.js'
import { enforceIdentities, identityDiagnostics, reportedDerived } from './identities.js'
import { impute } from './imputation.js'
import { reconcileFiscalYearEnds } from './reconcile.js'
import { CF_SIGN_KEEP, CHAIN_SUBSETS } from './rules.js'
import { has } from './py.js'
import {
  QUARTERLY_FORMS,
  SEMI_ANNUAL_FORMS,
  newRow,
  tolerance,
  viewOf,
  type CompanyType,
  type FactEntry,
  type Facts,
  type Frequency,
  type RowDef,
  type RowResult,
  type StatementName,
  type StatementResult,
  type ValidationWarning,
} from './types.js'

// CECL provision reconstruction: filers such as Bank of America report a single income-statement "provision for credit
// losses" line that combines the funded (financing-receivable) provision with the off-balance-sheet (unfunded
// commitment) provision, tagging the combined total with a company-specific extension absent from Company Facts. Only
// the standard component tags survive, so the standardized total is rebuilt as funded + unfunded for those filers.
const PROVISION_ROW_TAGS = ['provision_for_credit_losses', 'provision_for_loan_losses']
const PROVISION_FUNDED_SOURCES = ['FinancingReceivableExcludingAccruedInterestCreditLossExpenseReversal', 'ProvisionForLoanLossesExpensed']
const UNFUNDED_PROVISION_TAG = 'OffBalanceSheetCreditLossLiabilityCreditLossExpenseReversal'

type SchemaRow = {
  tag: string
  label: string
  description?: string
  parent?: string | null
  sequence?: number
  factor?: string
  balance?: string
  unit?: string
  period_type: string
  xbrl_tags: { tag: string; namespace: string }[]
}

const STATEMENT_FILES: Record<StatementName, unknown> = {
  income_statement: incomeStatementJson,
  balance_sheet: balanceSheetJson,
  cash_flow: cashFlowJson,
}

const ROW_DEFS: Record<string, Record<string, RowDef[]>> = {}
for (const [stmtName, types] of Object.entries(STATEMENT_FILES)) {
  ROW_DEFS[stmtName] = {}
  for (const [stype, rows] of Object.entries(types as Record<string, SchemaRow[]>)) {
    ROW_DEFS[stmtName]![stype] = rows.map((r) => ({
      tag: r.tag,
      label: r.label,
      description: r.description ?? '',
      parent: r.parent ?? null,
      sequence: r.sequence ?? 0,
      factor: r.factor ?? '+',
      balance: r.balance ?? '',
      unit: r.unit ?? 'monetary',
      period_type: r.period_type,
      xbrl_tags: r.xbrl_tags.map((x) => ({ tag: x.tag, namespace: x.namespace })),
    }))
  }
}

const detection = (metaJson as { detection: Record<string, any> }).detection
const SIGNALS: DetectionSignals = {
  insuranceIsSignals: detection.insurance_is_signals ?? [],
  insuranceBsSignals: detection.insurance_bs_signals ?? [],
  financialSignals: detection.financial_signals ?? [],
  minFinancialSignals: detection.min_financial_signals ?? 2,
  industrialSignals: detection.industrial_signals ?? [],
  diversifiedSignals: detection.diversified_signals ?? [],
  revenueMeasures: detection.measures?.revenue ?? [],
  insuranceMeasures: detection.measures?.insurance ?? [],
  financialMeasures: detection.measures?.financial ?? [],
  minInsuranceShare: detection.min_insurance_share ?? 0.0,
  minFinancialShare: detection.min_financial_share ?? 0.0,
}

export const STATEMENTS: StatementName[] = ['income_statement', 'balance_sheet', 'cash_flow']

export function getRows(statement: StatementName, companyType: CompanyType): RowDef[] {
  return ROW_DEFS[statement]?.[companyType] ?? []
}

export function detectCompanyType(facts: Facts, nowYear: number): CompanyType {
  return detectType(facts, SIGNALS, nowYear)
}

/** Facts restated at each filer's scale, in the preliminary view when preliminary data is requested. */
function preliminaryFacts(facts: Facts, includePreliminary: boolean, pitMode: boolean): Facts {
  if (viewOf(facts) === undefined) facts = rescaledFacts(facts)
  const view = viewOf(facts)
  if (!includePreliminary || (view?.kind === 'preliminary' && view.pitMode === pitMode)) return facts
  return preliminaryView(facts, pitMode)
}

type ExtractOptions = {
  frequency?: Frequency
  companyType?: CompanyType | null
  filingDates?: Set<string> | null
  skipImputation?: boolean
  refFiledMap?: Record<string, string> | null
  crossIdentities?: Record<string, Record<string, number>> | null
  pitMode?: boolean
  includePreliminary?: boolean
  annualRefMap?: Record<string, string> | null
  nowYear: number
}

/** Fold the unfunded-commitment CECL provision into the funded provision (financial filers without a distinct after-provision line). */
function combineUnfundedProvision(resultRows: RowResult[], statement: StatementName, companyType: CompanyType, facts: Facts, frequency: Frequency, currency: string, refFiledMap: Record<string, string>): void {
  if (companyType !== 'financial' || !['income_statement', 'cash_flow'].includes(statement)) return
  if ('InterestIncomeExpenseAfterProvisionForLoanLoss' in (facts['us-gaap'] ?? {})) return

  const provRow = resultRows.find((r) => PROVISION_ROW_TAGS.includes(r.tag))
  if (provRow === undefined || Object.keys(provRow.values).length === 0) return

  const unfundedDef: RowDef = {
    tag: UNFUNDED_PROVISION_TAG,
    label: '',
    description: '',
    parent: null,
    sequence: 0,
    factor: '+',
    balance: 'debit',
    unit: 'monetary',
    period_type: 'duration',
    xbrl_tags: [{ tag: UNFUNDED_PROVISION_TAG, namespace: 'us-gaap' }],
  }
  const [unfundedVals] = extractRowValues(facts, unfundedDef, frequency, currency, refFiledMap)

  for (const [date, src] of Object.entries(provRow.sources)) {
    if (!PROVISION_FUNDED_SOURCES.some((t) => src.includes(t))) continue
    const add = unfundedVals[date]
    if (add === undefined) continue
    provRow.values[date] = (provRow.values[date] ?? 0) + add
    provRow.sources[date] = `${src}+us-gaap:${UNFUNDED_PROVISION_TAG}(combined)`
  }
}

/** Extract one standardized statement. */
export function extract(companyFacts: Facts, statement: StatementName, opts: ExtractOptions): StatementResult {
  const frequency = opts.frequency ?? 'annual'
  const includePreliminary = opts.includePreliminary ?? false
  const pitMode = opts.pitMode ?? false
  const skipImputation = opts.skipImputation ?? false
  const facts = preliminaryFacts(companyFacts.facts ?? companyFacts, includePreliminary, pitMode)

  const companyType = opts.companyType ?? detectCompanyType(facts, opts.nowYear)
  const filingDates = opts.filingDates ?? getFilingDates(facts, frequency, includePreliminary)

  let preliminaryDates = new Set<string>()
  if (includePreliminary) {
    const confirmed = getFilingDates(facts, frequency)
    preliminaryDates = new Set([...filingDates].filter((d) => !confirmed.has(d)))
  }

  const currency = detectReportingCurrency(facts)
  const rowsDef = getRows(statement, companyType)
  let resultRows: RowResult[] = []
  const dates = [...filingDates].sort()

  let refFiledMap = opts.refFiledMap ?? null
  if (refFiledMap === null) refFiledMap = computeRefFilings(facts, rowsDef, frequency, currency, includePreliminary, pitMode)

  if (statement === 'balance_sheet') {
    refFiledMap = { ...refFiledMap }
    for (const anchorTag of ['total_assets', 'total_liabilities_and_equity']) {
      Object.assign(refFiledMap, computeRefFilings(facts, rowsDef.filter((rd) => rd.tag === anchorTag), frequency, currency, includePreliminary, pitMode))
    }
  }

  let annualRefMap = opts.annualRefMap ?? null
  if (frequency === 'quarterly' && annualRefMap === null) annualRefMap = computeRefFilings(facts, rowsDef, 'annual', currency, includePreliminary, pitMode)

  const applyCfSign = statement === 'cash_flow'

  for (const rowDef of rowsDef) {
    const crossTargets = opts.crossIdentities?.[rowDef.tag] ?? null
    let [values, sources] = extractRowValues(facts, rowDef, frequency, currency, refFiledMap, crossTargets, statement, includePreliminary, annualRefMap)
    values = Object.fromEntries(Object.entries(values).filter(([d]) => filingDates.has(d)))
    sources = Object.fromEntries(Object.entries(sources).filter(([d]) => filingDates.has(d)))

    for (const [broad, narrow] of CHAIN_SUBSETS[rowDef.tag] ?? []) {
      const [narrowNs, narrowTag] = narrow.split(':') as [string, string]
      const [narrowValues, narrowSources] = extractRowValues(facts, { ...rowDef, xbrl_tags: [{ tag: narrowTag, namespace: narrowNs }] }, frequency, currency, refFiledMap, null, statement, includePreliminary, annualRefMap)
      const broadPattern = new RegExp(broad.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Za-z])')

      for (const [d, v] of Object.entries(values)) {
        const nVal = narrowValues[d]
        if (nVal !== undefined && broadPattern.test(sources[d] ?? '') && nVal - v > tolerance(nVal, v)) {
          values[d] = nVal
          sources[d] = narrowSources[d] ?? narrow
        }
      }
    }

    if (applyCfSign && rowDef.balance === 'credit' && rowDef.factor !== '0' && !CF_SIGN_KEEP.has(rowDef.tag)) {
      values = Object.fromEntries(Object.entries(values).map(([d, v]) => [d, -v || 0]))
    }

    resultRows.push(newRow({ tag: rowDef.tag, label: rowDef.label, description: rowDef.description, parent: rowDef.parent, sequence: rowDef.sequence, factor: rowDef.factor, balance: rowDef.balance, unit: rowDef.unit, period_type: rowDef.period_type, values, sources }))
  }

  combineUnfundedProvision(resultRows, statement, companyType, facts, frequency, currency, refFiledMap)

  let diagnostics: ValidationWarning[] = []

  if (statement === 'cash_flow') {
    const eopRow = resultRows.find((r) => r.tag === 'cash_at_end_of_period')
    const eopDef = rowsDef.find((rd) => rd.tag === 'cash_at_end_of_period')
    if (eopRow && eopDef) {
      const [standalone, standaloneSrc] = extractRowValues(facts, eopDef, frequency, currency)
      for (const date of dates) {
        if (!has(eopRow.values, date) && has(standalone, date)) {
          eopRow.values[date] = standalone[date]!
          eopRow.sources[date] = standaloneSrc[date] ?? 'standalone'
        }
      }
    }
  }

  if (!skipImputation) {
    ;[resultRows, diagnostics] = impute(resultRows, statement, companyType, filingDates, facts, frequency)
  }

  if (statement === 'cash_flow') {
    const tagMap = new Map(resultRows.map((r) => [r.tag, r] as const))
    const eopRow = tagMap.get('cash_at_end_of_period')
    const bopRow = tagMap.get('cash_at_beginning_of_period')

    if (eopRow && bopRow) {
      dates.forEach((date, i) => {
        if (i > 0) {
          const prevDate = dates[i - 1]!
          const prevVal = eopRow.values[prevDate]
          if (prevVal !== undefined) {
            bopRow.values[date] = prevVal
            bopRow.sources[date] = `derived: cash_at_end_of_period(${prevDate})`
          }
        }
      })
    }
  }

  if (statement === 'cash_flow' && !skipImputation) {
    const tagMap = new Map(resultRows.map((r) => [r.tag, r] as const))
    const eop = tagMap.get('cash_at_end_of_period')
    const bop = tagMap.get('cash_at_beginning_of_period')
    const nc = tagMap.get('net_change_in_cash')

    if (eop && bop && nc) {
      for (const date of dates) {
        const ev = eop.values[date]
        const bv = bop.values[date]
        const nv = nc.values[date]
        if (ev === undefined || bv === undefined || nv === undefined) continue

        const diff = Math.abs(bv + nv - ev)
        if (diff > tolerance(ev, bv, nv)) {
          const bopSrc = bop.sources[date] ?? ''
          const flows: number[] = []
          for (const t of ['net_cash_from_operating_activities', 'net_cash_from_investing_activities', 'net_cash_from_financing_activities']) {
            const v = tagMap.get(t)?.values[date]
            if (v !== undefined) flows.push(v)
          }
          const fx = tagMap.get('effect_of_exchange_rate_changes')
          const flowSum = flows.length === 3 ? flows.reduce((a, b) => a + b, 0) + (fx?.values[date] || 0.0) : null

          if (bopSrc.includes('derived:') && flowSum !== null && (Math.abs(bv + flowSum - ev) <= tolerance(ev, bv, flowSum) || 10 * Math.abs(bv + flowSum - ev) <= diff)) {
            nc.values[date] = ev - bv
            nc.sources[date] = 'corrected: cash_at_end_of_period - cash_at_beginning_of_period'
            applyHierarchicalArticulation(resultRows, [date])
          } else if (bopSrc.includes('derived:')) {
            bop.values[date] = ev - nv
            bop.sources[date] = 'identity-enforced: cash_at_end_of_period - net_change_in_cash'
          }
          // The Python branches below this one are unreachable: cash_at_beginning has no XBRL tags and is never
          // imputed, so a present value always carries a "derived:" source and the first branch above always wins.
        }
      }
    }
  }

  if (!skipImputation) {
    enforceIdentities(resultRows, statement, filingDates, facts, currency, { derived: reportedDerived, frequency })
    diagnostics = identityDiagnostics(resultRows, statement, filingDates)
  }

  const prunedDates = new Set<string>()
  for (const date of dates) if (resultRows.some((r) => r.values[date] !== undefined)) prunedDates.add(date)

  resultRows = resultRows.filter((r) => {
    const vals = Object.values(r.values)
    return vals.length === 0 || vals.some((v) => v !== 0) || Object.values(r.sources).some((s) => ['imputed', 'corrected', 'reconciled', 'derived'].some((p) => s.startsWith(p)))
  })

  const fiscalData = getFiscalMeta(facts, frequency, prunedDates)

  const finalPreliminary = new Set([...preliminaryDates].filter((d) => prunedDates.has(d)))
  if (finalPreliminary.size) {
    for (const row of resultRows) {
      for (const date of finalPreliminary) {
        if (has(row.sources, date) && !row.sources[date]!.startsWith('preliminary:')) row.sources[date] = `preliminary:${row.sources[date]}`
      }
    }
  }

  return { statement, company_type: companyType, frequency, currency, dates: [...prunedDates].sort(), rows: resultRows, fiscal_data: fiscalData, diagnostics, preliminary_dates: finalPreliminary }
}

/** Extract all three statements, aligned on the periods all of them report. */
export function extractAll(
  companyFacts: Facts,
  opts: { frequency?: Frequency; companyType?: CompanyType | null; skipImputation?: boolean; pitMode?: boolean; includePreliminary?: boolean; annualResults?: Record<string, StatementResult> | null; nowYear: number },
): Record<StatementName, StatementResult> {
  const frequency = opts.frequency ?? 'annual'
  const includePreliminary = opts.includePreliminary ?? false
  const pitMode = opts.pitMode ?? false
  const skipImputation = opts.skipImputation ?? false
  const facts = preliminaryFacts(companyFacts.facts ?? companyFacts, includePreliminary, pitMode)

  const companyType = opts.companyType ?? detectCompanyType(facts, opts.nowYear)
  const filingDates = getFilingDates(facts, frequency, includePreliminary)

  if (filingDates.size === 0 && frequency === 'quarterly') {
    const formsSeen = new Set<string>()
    for (const nsFacts of Object.values(facts)) {
      for (const tagData of Object.values(nsFacts as Record<string, FactEntry>)) {
        for (const entries of Object.values((tagData.units ?? {}) as Record<string, FactEntry[]>)) for (const entry of entries) if (entry.form) formsSeen.add(entry.form)
      }
    }
    const annualOnly = ['20-F', '20-F/A', '40-F', '40-F/A'].filter((f) => formsSeen.has(f))
    const hasInterim = [...formsSeen].some((f) => QUARTERLY_FORMS.has(f) || SEMI_ANNUAL_FORMS.has(f))
    const entity = companyFacts.entityName ?? 'this company'

    if (annualOnly.length && !hasInterim) {
      const ftype = formsSeen.has('20-F') || formsSeen.has('20-F/A') ? '20-F' : '40-F'
      throw new Error(`${entity} files ${ftype} (annual only) and does not report interim (quarterly/semi-annual) data via 10-Q or 6-K filings. Only period='annual' is available.`)
    }
    throw new Error(`No quarterly filing dates found for ${entity}. Only period='annual' may be available.`)
  }

  const currency = detectReportingCurrency(facts)
  const allRows: RowDef[] = []
  for (const stmt of STATEMENTS) allRows.push(...getRows(stmt, companyType))

  const sharedRefMap = computeRefFilings(facts, allRows, frequency, currency, includePreliminary, pitMode)
  const annualRefMap = frequency === 'quarterly' ? computeRefFilings(facts, allRows, 'annual', currency, includePreliminary, pitMode) : null

  const results = {} as Record<StatementName, StatementResult>
  const crossIdentities: Record<string, Record<string, number>> = {}

  for (const stmt of STATEMENTS) {
    results[stmt] = extract(facts, stmt, { skipImputation, frequency, companyType, filingDates, refFiledMap: sharedRefMap, crossIdentities, pitMode, includePreliminary, annualRefMap, nowYear: opts.nowYear })
    for (const r of results[stmt].rows) {
      if (!has(crossIdentities, r.tag)) crossIdentities[r.tag] = {}
      Object.assign(crossIdentities[r.tag]!, r.values)
    }
  }

  const dateSets = STATEMENTS.map((s) => new Set(results[s].dates))
  const commonDates = new Set([...dateSets[0]!].filter((d) => dateSets[1]!.has(d) && dateSets[2]!.has(d)))

  if (frequency === 'quarterly' && commonDates.size) {
    const annualDates = [...getFilingDates(facts, 'annual')].sort()
    const union = new Set(dateSets.flatMap((s) => [...s]))
    for (const d of annualDates) if (union.has(d)) commonDates.add(d)

    if (annualDates.length) {
      const sortedQ = [...commonDates].sort()
      const fyGroups = new Map<string, string[]>()
      for (const qd of sortedQ) {
        const fyEnd = annualDates.find((ad) => qd <= ad)
        if (fyEnd) {
          if (!fyGroups.has(fyEnd)) fyGroups.set(fyEnd, [])
          fyGroups.get(fyEnd)!.push(qd)
        }
      }

      if (fyGroups.size > 2) {
        const sizeCounts = new Map<number, number>()
        for (const v of fyGroups.values()) sizeCounts.set(v.length, (sizeCounts.get(v.length) ?? 0) + 1)
        let expected = 0
        let best = -1
        for (const [size, count] of sizeCounts) {
          if (count > best) {
            expected = size
            best = count
          }
        }
        for (const fyEnd of [...fyGroups.keys()].sort()) {
          if (fyGroups.get(fyEnd)!.length < expected) for (const qd of fyGroups.get(fyEnd)!) commonDates.delete(qd)
          else break
        }
      }
    }
  }

  const aligned = [...commonDates].sort()
  const alignedFiscal = getFiscalMeta(facts, frequency, commonDates)

  const allPreliminary = new Set<string>()
  for (const r of Object.values(results)) for (const d of r.preliminary_dates) allPreliminary.add(d)
  const alignedPreliminary = new Set([...allPreliminary].filter((d) => commonDates.has(d)))

  for (const stmtResult of Object.values(results)) {
    stmtResult.dates = aligned
    stmtResult.fiscal_data = alignedFiscal
    stmtResult.preliminary_dates = alignedPreliminary
    for (const row of stmtResult.rows) {
      row.values = Object.fromEntries(Object.entries(row.values).filter(([d]) => commonDates.has(d)))
      row.sources = Object.fromEntries(Object.entries(row.sources).filter(([d]) => commonDates.has(d)))
    }
  }

  if (frequency === 'quarterly') {
    const annualResults = opts.annualResults ?? extractAll(facts, { frequency: 'annual', companyType, skipImputation, pitMode, includePreliminary, nowYear: opts.nowYear })

    for (const stmt of STATEMENTS) {
      reconcileFiscalYearEnds(results[stmt], annualResults[stmt], new Set(getRows(stmt, companyType).map((rd) => rd.tag)), facts, currency)
      if (skipImputation) results[stmt].diagnostics = []
    }
  } else if (!skipImputation) {
    for (const stmt of STATEMENTS) results[stmt].diagnostics = identityDiagnostics(results[stmt].rows, stmt, results[stmt].dates)
  }

  return results
}

/** Merge several company-facts documents (a company that changed CIK) into one `facts` object. */
export function mergeFacts(...factsList: Facts[]): Facts {
  const merged: Record<string, Record<string, any>> = {}

  for (const raw of factsList) {
    const facts: Facts = raw.facts ?? raw

    for (const [ns, tags] of Object.entries(facts)) {
      if (!has(merged, ns)) merged[ns] = {}

      for (const [tagName, tagData] of Object.entries(tags as Record<string, any>)) {
        if (!has(merged[ns]!, tagName)) merged[ns]![tagName] = {}
        const target = merged[ns]![tagName]
        const srcLabel = tagData.label ?? ''
        const srcDesc = tagData.description ?? ''
        if (!('label' in target) && srcLabel) target.label = srcLabel
        if (!('description' in target) && srcDesc) target.description = srcDesc

        const srcUnits = (tagData.units ?? {}) as Record<string, FactEntry[]>
        if (!('units' in target)) target.units = {}

        for (const [unitKey, entries] of Object.entries(srcUnits)) {
          if (!has(target.units, unitKey)) target.units[unitKey] = []
          const existing: FactEntry[] = target.units[unitKey]
          const keyOf = (e: FactEntry) => JSON.stringify([e.end ?? '', e.start ?? '', e.val ?? null, e.form ?? '', e.filed ?? ''])
          const seen = new Set(existing.map(keyOf))
          for (const e of entries) {
            const key = keyOf(e)
            if (!seen.has(key)) {
              existing.push(e)
              seen.add(key)
            }
          }
        }
      }
    }
  }
  return merged
}
