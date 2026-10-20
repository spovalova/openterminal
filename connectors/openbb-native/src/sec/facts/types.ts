// Ported from openbb_sec/utils/statement_schema/_types.py (OpenBB Platform 5.0.0, Apache-2.0); modified: dataclasses are
// plain types, the company facts are loosely typed JSON, and the "scaled" and "preliminary" fact views are marked in a
// WeakMap instead of by subclassing dict.

/** One fact of a company-facts tag: `{start?, end, val, accn, fy, fp, form, filed, frame?}`. */
export type FactEntry = Record<string, any>
/** The company-facts `facts` object: namespace → tag → `{label, description, units: {unit: FactEntry[]}}`. */
export type Facts = Record<string, any>

export const ANNUAL_FORMS: ReadonlySet<string> = new Set(['10-K', '10-K/A', '20-F', '20-F/A', '40-F', '40-F/A'])
export const QUARTERLY_FORMS: ReadonlySet<string> = new Set(['10-Q', '10-Q/A'])
export const SEMI_ANNUAL_FORMS: ReadonlySet<string> = new Set(['6-K', '6-K/A'])
export const PRELIMINARY_FORMS: ReadonlySet<string> = new Set(['8-K', '8-K/A'])
export const ALL_FORMS: ReadonlySet<string> = new Set([...ANNUAL_FORMS, ...QUARTERLY_FORMS, ...SEMI_ANNUAL_FORMS])

/**
 * Forms that may carry a full-year reporting period. Foreign private issuers (20-F/40-F filers) routinely furnish their
 * annual financial statements in 6-K exhibits rather than tagging them in the 20-F/40-F itself, so a 6-K whose duration
 * is ~365 days is treated as an annual period. The ~365-day length, not the form alone, is the discriminator.
 */
export const ANNUAL_PERIOD_FORMS: ReadonlySet<string> = new Set([...ANNUAL_FORMS, ...SEMI_ANNUAL_FORMS])
export const SUPERSEDED_SUFFIX = ' (superseded)'

export type Frequency = 'annual' | 'quarterly'
export type StatementName = 'income_statement' | 'balance_sheet' | 'cash_flow'
export type CompanyType = 'industrial' | 'financial' | 'diversified' | 'insurance'

const TOLERANCE_FLOOR = 100_000
const TOLERANCE_CAP = 1_000_000

/** Scale-adaptive tolerance: 0.1% of max magnitude, floored at 100k, capped at 1M. */
export function tolerance(...values: (number | null | undefined)[]): number {
  let scale = 0
  for (const v of values) if (v !== null && v !== undefined) scale = Math.max(scale, Math.abs(v))
  return Math.max(TOLERANCE_FLOOR, Math.min(TOLERANCE_CAP, scale * 0.001))
}

const SOURCE_TAG = /^(?:preliminary:)?(?:ytd_derived\()?([a-z][a-z-]*:[A-Za-z0-9_]+)/

/** The concept a value was read from, or null for a derived value. */
export function sourceTag(source: string): string | null {
  const m = SOURCE_TAG.exec(source)
  return m ? m[1]! : null
}

const views = new WeakMap<object, { kind: 'scaled' | 'preliminary'; pitMode: boolean }>()

/** Facts restated at each filer's scale (`ScaledFacts`). */
export function markScaled(facts: Facts): Facts {
  views.set(facts, { kind: 'scaled', pitMode: false })
  return facts
}

/** Facts in which only 8-K entries eligible as preliminary data keep their form (`PreliminaryFacts`). */
export function markPreliminary(facts: Facts, pitMode: boolean): Facts {
  views.set(facts, { kind: 'preliminary', pitMode })
  return facts
}

export function viewOf(facts: Facts): { kind: 'scaled' | 'preliminary'; pitMode: boolean } | undefined {
  return views.get(facts)
}

export type RowDef = {
  tag: string
  label: string
  description: string
  parent: string | null
  sequence: number
  factor: string
  balance: string
  /** "monetary", "per_share" or "shares". */
  unit: string
  /** "duration" or "instant". */
  period_type: string
  xbrl_tags: { tag: string; namespace: string }[]
}

export type RowResult = {
  tag: string
  label: string
  description: string
  parent: string | null
  sequence: number
  factor: string
  balance: string
  unit: string
  period_type: string
  /** {period_end_date: value} */
  values: Record<string, number>
  /** {date: "ns:Tag" or "imputed: …"} */
  sources: Record<string, string>
  date_factors: Record<string, string>
}

/** Factor for a period: the period override, else the schema factor (`RowResult.factor_on`). */
export function factorOn(row: RowResult, date: string): string {
  return Object.prototype.hasOwnProperty.call(row.date_factors, date) ? row.date_factors[date]! : row.factor
}

export type ValidationWarning = {
  date: string
  tag: string
  expected: number
  actual: number
  formula: string
  identity: string
}

export type StatementResult = {
  statement: string
  company_type: string
  frequency: string
  currency: string
  dates: string[]
  rows: RowResult[]
  fiscal_data: Record<string, { fiscal_year: number; fiscal_period: string }>
  diagnostics: ValidationWarning[]
  preliminary_dates: Set<string>
}

/** A fresh `RowResult` (the dataclass defaults). */
export function newRow(base: Omit<RowResult, 'values' | 'sources' | 'date_factors'> & Partial<Pick<RowResult, 'values' | 'sources' | 'date_factors'>>): RowResult {
  return { values: {}, sources: {}, date_factors: {}, ...base }
}
