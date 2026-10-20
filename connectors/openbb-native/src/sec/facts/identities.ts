// Statement identities, provider sec: which term an identity's evidence points to, enforcing it, and the diagnostics for
// identities that do not hold. Ported from openbb_sec/utils/statement_schema/_imputation.py (OpenBB Platform 5.0.0,
// Apache-2.0); modified: rows are identified by object identity, and dates are visited in sorted order.
import { applyHierarchicalArticulation } from './articulation.js'
import { getUnitData } from './extraction.js'
import { BS_VERIFY, CF_VERIFY, IDENTITIES, IS_VERIFY, NONNEGATIVE_LINES, OTHER_LINES, ROLLUP_REQUIRES } from './rules.js'
import { daysBetween } from './py.js'
import { ALL_FORMS, factorOn, sourceTag, tolerance as tol, type Facts, type Frequency, type RowResult, type ValidationWarning } from './types.js'

const stripPrelim = (s: string): string => (s.startsWith('preliminary:') ? s.slice('preliminary:'.length) : s)

/** Whether a value is derived rather than read from a filing for its period. */
export function reportedDerived(row: RowResult, date: string): boolean {
  const source = stripPrelim(row.sources[date] ?? '')
  return ['imputed', 'identity-enforced', 'derived:'].some((p) => source.startsWith(p)) || source.includes('(fallback)')
}

/** Whether a row is the plug articulation creates for a parent without a remainder line. */
export function synthetic(row: RowResult, parent: string): boolean {
  const base = parent.startsWith('total_') ? parent.slice('total_'.length) : parent
  return row.tag === `other_${base}` && !(OTHER_LINES[parent] ?? []).includes(row.tag)
}

/** The scale tolerance, at least the rounding of `figures` reported figures. */
export function identityTolerance(values: number[], figures: number): number {
  const present = values.filter((v) => v)
  let unit = 1
  for (const u of [1_000_000, 1_000]) {
    if (present.length && present.every((v) => Number.isInteger(v) && Math.trunc(v) % u === 0)) {
      unit = u
      break
    }
  }
  return Math.max(tol(...values), (unit * figures) / 2)
}

export type Signed = [string, number][]
type ByTag = Map<string, RowResult>
type Children = Map<string, RowResult[]>

function index(rows: RowResult[]): { byTag: ByTag; children: Children } {
  const byTag: ByTag = new Map()
  for (const r of rows) byTag.set(r.tag, r)
  const children: Children = new Map()
  for (const r of rows) {
    if (r.parent) {
      if (!children.has(r.parent)) children.set(r.parent, [])
      children.get(r.parent)!.push(r)
    }
  }
  return { byTag, children }
}

/** The signed terms of an identity at a date, or null when it does not apply. */
export function identity(target: string, terms: Signed | null, byTag: ByTag, children: Children, date: string): Signed | null {
  const row = byTag.get(target)
  if (row === undefined || row.values[date] === undefined) return null

  if (terms !== null) {
    const signed = terms.filter(([tag]) => byTag.has(tag))
    if (signed.length === 0 || signed.some(([tag]) => byTag.get(tag)!.values[date] === undefined)) return null
    return signed
  }

  const kids = (children.get(target) ?? []).filter((c) => ['+', '-'].includes(factorOn(c, date)) && !synthetic(c, target)).sort((a, b) => Number(a.sequence) - Number(b.sequence))
  if (kids.length === 0 || kids[0]!.values[date] === undefined) return null
  return kids.map((c): [string, number] => [c.tag, factorOn(c, date) === '+' ? 1 : -1])
}

/** The target value, the sum of the terms and the identity's tolerance at a date. */
export function identityState(target: string, signed: Signed, byTag: ByTag, date: string, allowance = 0): [number, number, number] {
  const lhs = byTag.get(target)!.values[date]!
  let rhs = 0
  for (const [tag, sign] of signed) rhs += sign * (byTag.get(tag)!.values[date] || 0)
  return [lhs, rhs, Math.max(tol(lhs, rhs), allowance)]
}

/** The targets of the statement's IDENTITIES that do not hold at a date. */
export function failing(rows: RowResult[], statement: string, date: string, allowance: Record<string, number>): Set<string> {
  const { byTag, children } = index(rows)
  const out = new Set<string>()
  for (const [target, terms] of IDENTITIES[statement] ?? []) {
    const signed = identity(target, terms, byTag, children, date)
    if (signed !== null) {
      const [lhs, rhs, t] = identityState(target, signed, byTag, date, allowance[target] ?? 0)
      if (Math.abs(lhs - rhs) > t) out.add(target)
    }
  }
  return out
}

/** {target: target value less the sum of its terms} for the statement's IDENTITIES at a date. */
export function identityResiduals(rows: RowResult[], statement: string, date: string): Record<string, number> {
  const { byTag, children } = index(rows)
  const residuals: Record<string, number> = {}
  for (const [target, terms] of IDENTITIES[statement] ?? []) {
    const signed = identity(target, terms, byTag, children, date)
    if (signed !== null) {
      const [lhs, rhs] = identityState(target, signed, byTag, date)
      residuals[target] = lhs - rhs
    }
  }
  return residuals
}

/** The line a verify rule over an identity's terms aligns, else the identity's target. */
export function roundingTerm(statement: string, target: string, signed: Signed): string {
  const terms = new Set([target, ...signed.map(([t]) => t)])
  const rules = ({ income_statement: IS_VERIFY, balance_sheet: BS_VERIFY, cash_flow: CF_VERIFY } as Record<string, typeof IS_VERIFY>)[statement] ?? []
  for (const [line, sources] of rules) {
    const set = new Set([line, ...sources.map(([t]) => t)])
    if (set.size === terms.size && [...set].every((t) => terms.has(t))) return line
  }
  return target
}

/** The sum of a row's reported lines at a date, through articulation plugs, when its ROLLUP_REQUIRES lines are present. */
export function components(row: RowResult, children: Children, date: string, depth = 0): number | null {
  const lines = (children.get(row.tag) ?? []).filter((c) => ['+', '-'].includes(factorOn(c, date)) && !synthetic(c, row.tag))
  const present = new Set(lines.filter((c) => c.values[date] !== undefined).map((c) => c.tag))
  if (present.size === 0 || !(ROLLUP_REQUIRES[row.tag] ?? []).every((t) => present.has(t))) return null

  let total = 0
  let found = false
  for (const c of lines) {
    const factor = factorOn(c, date)
    if (c.values[date] === undefined) continue
    const sign = factor === '+' ? 1 : -1

    if ((c.sources[date] ?? '').startsWith('imputed-plug') || (c.sources[date] ?? '').startsWith('imputed-zero-plug')) {
      const sub = depth < 3 ? components(c, children, date, depth + 1) : null
      if (sub === null) continue
      total += sign * sub
    } else {
      total += sign * c.values[date]!
    }
    found = true
  }
  return found ? total : null
}

/** Other filings' values of a row's concept for its period. */
export function alternatives(row: RowResult, date: string, facts: Facts | null, currency: string, frequency: Frequency): Set<number> {
  const concept = sourceTag(stripPrelim(row.sources[date] ?? ''))
  const found = new Set<number>()
  if (facts === null || concept === null) return found

  const [namespace, tag] = [concept.slice(0, concept.indexOf(':')), concept.slice(concept.indexOf(':') + 1)]
  const tagData = facts[namespace]?.[tag]
  const entries = tagData ? getUnitData(tagData, row.unit, currency) : null
  const span = frequency === 'annual' ? [300, 400] : [60, 135]

  for (const entry of entries ?? []) {
    const start = entry.start
    if (entry.end !== date || entry.val === null || entry.val === undefined || !ALL_FORMS.has(entry.form) || Boolean(start) !== (row.period_type === 'duration')) continue
    if (start) {
      const d = daysBetween(date, start)
      if (d === null) throw new Error(`time data '${start}' does not match format '%Y-%m-%d'`)
      if (!(span[0]! <= d && d <= span[1]!)) continue
    }
    found.add(entry.val)
  }
  if (row.values[date] !== undefined) found.delete(row.values[date]!)
  return found
}

/** 'a + b - c' for signed tags. */
export function expression(coefficients: Signed): string {
  const parts = [(coefficients[0]![1] < 0 ? '-' : '') + coefficients[0]![0]]
  for (const [tag, sign] of coefficients.slice(1)) parts.push(`${sign > 0 ? '+' : '-'} ${tag}`)
  return parts.join(' ')
}

type Context = [Facts | null, string, Frequency, (row: RowResult, date: string) => boolean]

/** The term an identity's evidence points to, its value and its source. */
function chooseTerm(
  target: string,
  signed: Signed,
  byTag: ByTag,
  children: Children,
  date: string,
  opts: { context: Context; settled: Set<string>; elsewhere: Set<string>; tolerance: number; rounding?: string | null; fallback?: string | null },
): [string, number, string] | null {
  const [facts, currency, frequency, derived] = opts.context
  const { settled, elsewhere, tolerance } = opts
  const rounding = opts.rounding ?? null
  const fallback = opts.fallback ?? null
  const sign = new Map(signed)
  const tags = [target, ...sign.keys()]
  const value = new Map<string, number | undefined>(tags.map((tag) => [tag, byTag.get(tag)!.values[date]]))
  const total = byTag.get(target)!.values[date]!
  let rhs = 0
  for (const [tag, s] of signed) rhs += s * (value.get(tag) || 0)

  const implied = (tag: string): number => {
    if (tag === target) return rhs
    return sign.get(tag)! * (total - (rhs - sign.get(tag)! * (value.get(tag) || 0)))
  }

  let pool = [...value.keys()].filter((tag) => !settled.has(tag) && !(NONNEGATIVE_LINES.has(tag) && implied(tag) < -tolerance) && (value.get(tag) !== undefined || (OTHER_LINES[target] ?? []).includes(tag)))
  const alts = new Map<string, number[]>()
  for (const tag of pool) {
    if (value.get(tag) !== undefined && !derived(byTag.get(tag)!, date)) alts.set(tag, [...alternatives(byTag.get(tag)!, date, facts, currency, frequency)].filter((a) => Math.abs(a - implied(tag)) <= tolerance))
  }
  const comps = new Map<string, number | null>()
  for (const tag of pool) if (tag !== target) comps.set(tag, components(byTag.get(tag)!, children, date))

  const confirmed = (tag: string): boolean => {
    const found = comps.get(tag)
    const current = value.get(tag)
    return elsewhere.has(tag) || (found !== undefined && found !== null && current !== undefined && Math.abs(found - current) <= tolerance)
  }

  const levels: ((tag: string) => boolean)[] = [
    (tag) => value.get(tag) === undefined || derived(byTag.get(tag)!, date),
    (tag) => (OTHER_LINES[target] ?? []).includes(tag),
    (tag) => (alts.get(tag)?.length ?? 0) > 0,
    (tag) => {
      const found = comps.get(tag)
      return found !== undefined && found !== null && Math.abs(found - implied(tag)) <= tolerance
    },
    (tag) => tag !== target && (children.get(tag) ?? []).some((c) => synthetic(c, tag) && Math.abs(c.values[date] || 0) > tolerance),
    (tag) => !confirmed(tag),
  ]

  const solved = (tag: string): [string, number, string] => {
    const coefficients: Signed = tag === target ? [...signed] : [[target, sign.get(tag)!], ...signed.filter(([t]) => t !== tag).map(([t, s]): [string, number] => [t, -s * sign.get(tag)!])]
    return [tag, implied(tag), `identity-enforced: ${expression(coefficients)} [solving ${tag}]`]
  }

  if (rounding !== null) return pool.includes(rounding) ? solved(rounding) : null

  const eligible = new Set(pool)

  for (let level = 0; level < levels.length; level++) {
    const check = levels[level]!
    const matched = pool.filter((tag) => check(tag))
    if (matched.length > 1) pool = matched
    if (matched.length !== 1) continue

    const tag = matched[0]!
    if (level === 2) {
      const source = stripPrelim(byTag.get(tag)!.sources[date]!)
      return [tag, alts.get(tag)![0]!, `${source} (vintage-corrected)`]
    }
    return solved(tag)
  }

  if (fallback === null || !eligible.has(fallback) || (ROLLUP_REQUIRES[target] ?? []).some((tag) => value.get(tag) === undefined)) return null
  return solved(fallback)
}

/**
 * Make each of the statement's IDENTITIES hold at each date, changing the term the evidence points to.
 *
 * Evidence in order: a derived term (`derived`), the target's remainder line (OTHER_LINES), another filing's value of a
 * term that satisfies the identity, a term whose reported lines sum to its implied value, a term whose own articulation
 * needed a synthetic plug, and the only term not confirmed by its lines or by another identity. A difference within
 * `allowance` {date: {target: amount}} changes the line the statement's verify rules align instead, as does any
 * difference the evidence does not resolve when the target's ROLLUP_REQUIRES lines are present.
 */
export function enforceIdentities(
  rows: RowResult[],
  statement: string,
  dates: Iterable<string>,
  facts: Facts | null,
  currency: string,
  opts: { derived: (row: RowResult, date: string) => boolean; frequency?: Frequency; allowance?: Record<string, Record<string, number>> | null },
): void {
  const frequency = opts.frequency ?? 'annual'
  const context: Context = [facts, currency, frequency, opts.derived]
  const identities = IDENTITIES[statement] ?? []

  for (const date of [...dates].sort()) {
    const settled = new Set<string>()
    const allowed = opts.allowance?.[date] ?? {}

    for (let iteration = 0; iteration < 4 * identities.length; iteration++) {
      const { byTag, children } = index(rows)
      const states = new Map<string, { signed: Signed; lhs: number; rhs: number; tol: number }>()

      for (const [target, terms] of identities) {
        const signed = identity(target, terms, byTag, children, date)
        if (signed !== null) {
          const [lhs, rhs, t] = identityState(target, signed, byTag, date)
          states.set(target, { signed, lhs, rhs, tol: t })
        }
      }

      let choice: [string, number, string] | null = null

      for (const [target, { signed, lhs, rhs, tol: t }] of states) {
        if (Math.abs(lhs - rhs) <= t) continue

        const elsewhere = new Set<string>()
        for (const [other, s] of states) {
          if (other !== target && Math.abs(s.lhs - s.rhs) <= s.tol) {
            elsewhere.add(other)
            for (const [tag] of s.signed) elsewhere.add(tag)
          }
        }

        choice = chooseTerm(target, signed, byTag, children, date, {
          context,
          settled,
          elsewhere,
          tolerance: t,
          rounding: Math.abs(lhs - rhs) <= t + (allowed[target] ?? 0) ? roundingTerm(statement, target, signed) : null,
          fallback: roundingTerm(statement, target, signed),
        })
        if (choice !== null) break
      }

      if (choice === null) break

      const [tag, newValue, source] = choice
      byTag.get(tag)!.values[date] = newValue
      byTag.get(tag)!.sources[date] = source
      settled.add(tag)
      applyHierarchicalArticulation(rows, [date])
    }
  }
}

/** A warning for each of the statement's IDENTITIES that does not hold at a date. */
export function identityDiagnostics(rows: RowResult[], statement: string, dates: Iterable<string>): ValidationWarning[] {
  const { byTag, children } = index(rows)
  const warnings: ValidationWarning[] = []

  for (const date of [...dates].sort()) {
    for (const [target, terms] of IDENTITIES[statement] ?? []) {
      const signed = identity(target, terms, byTag, children, date)
      if (signed === null) continue
      const [lhs, rhs, t] = identityState(target, signed, byTag, date)
      if (Math.abs(lhs - rhs) > t) {
        const formula = expression(signed)
        warnings.push({ date, tag: target, expected: rhs, actual: lhs, formula, identity: `${target} = ${formula}` })
      }
    }
  }
  return warnings
}
