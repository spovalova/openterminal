// Hierarchical articulation of statement rows, provider sec: roll up parents without a value and reconcile each reported
// parent with its children. Ported from `_apply_hierarchical_articulation` in
// openbb_sec/utils/statement_schema/_imputation.py (OpenBB Platform 5.0.0, Apache-2.0); modified: rows are identified by
// object identity, and dates are visited in sorted order (Python iterates a set).
import {
  BALANCE_TOTALS,
  CLASSIFIED_SECTIONS,
  CONTAINABLE,
  EVIDENCED_LINES,
  NONNEGATIVE_LINES,
  OTHER_LINES,
  PROMOTABLE_MEMOS,
  REMAINDER_REQUIRES,
  ROLLUP_REQUIRES,
  SCOPE_VARIANTS,
  SOFT_TOTALS,
  WHOLE_REMAINDERS,
} from './rules.js'
import { combinations, maxBy, sum } from './py.js'
import { factorOn, newRow, tolerance as tol, type RowResult } from './types.js'

type Pair = [RowResult, number]

/** Roll up parents without a value and reconcile each reported parent with its children; a cleared remainder line within tolerance of zero is written back. */
export function applyHierarchicalArticulation(rows: RowResult[], filingDates: Iterable<string>, cleared: Set<RowResult> | null = null): void {
  const dates = [...filingDates].sort()
  const tagToRow = new Map<string, RowResult>()
  for (const r of rows) tagToRow.set(r.tag, r)
  const childrenByParent = new Map<string, RowResult[]>()
  const memosByParent = new Map<string, RowResult[]>()
  const depthMap = new Map<string, number>()

  const getDepth = (tag: string): number => {
    const known = depthMap.get(tag)
    if (known !== undefined) return known
    const row = tagToRow.get(tag)
    if (!row || !row.parent || !tagToRow.has(row.parent)) {
      depthMap.set(tag, 0)
      return 0
    }
    depthMap.set(tag, 0)
    const d = 1 + getDepth(row.parent)
    depthMap.set(tag, d)
    return d
  }

  for (const row of rows) {
    getDepth(row.tag)
    if (row.parent && tagToRow.has(row.parent)) {
      if (row.factor === '+' || row.factor === '-') {
        if (!childrenByParent.has(row.parent)) childrenByParent.set(row.parent, [])
        childrenByParent.get(row.parent)!.push(row)
      } else if (PROMOTABLE_MEMOS.has(row.tag)) {
        if (!memosByParent.has(row.parent)) memosByParent.set(row.parent, [])
        memosByParent.get(row.parent)!.push(row)
      }
    }
  }

  const parents = [...childrenByParent.keys()]
  parents.sort((a, b) => getDepth(b) - getDepth(a))
  const newRows: RowResult[] = []
  const blocked = new Set<string>()
  const blockKey = (tag: string, date: string) => `${tag}\u0000${date}`
  for (const section of [...CLASSIFIED_SECTIONS, BALANCE_TOTALS]) {
    if (!section.every((t) => tagToRow.has(t))) continue
    for (const date of dates) {
      if (section.every((t) => tagToRow.get(t)!.values[date] === undefined)) for (const t of section) blocked.add(blockKey(t, date))
    }
  }

  const sign = (row: RowResult, date: string): number => (factorOn(row, date) === '-' ? -1 : 1)

  const ancestors = (row: RowResult): Set<string> => {
    const seen = new Set<string>()
    let tag = row.parent
    while (tag && !seen.has(tag) && tagToRow.has(tag)) {
      seen.add(tag)
      tag = tagToRow.get(tag)!.parent
    }
    return seen
  }

  const stripTotal = (tag: string): string => (tag.startsWith('total_') ? tag.slice('total_'.length) : tag)

  const otherLine = (parentTag: string): RowResult | null => {
    const kids = childrenByParent.get(parentTag) ?? []
    for (const line of OTHER_LINES[parentTag] ?? []) for (const c of kids) if (c.tag === line) return c
    const base = `other_${stripTotal(parentTag)}`
    return kids.find((c) => c.tag === base) ?? null
  }

  const complete = (row: RowResult, date: string): boolean => {
    const line = otherLine(row.tag)
    if (line === null || line.values[date] === undefined) return false
    return !(line.sources[date] ?? '').startsWith('imputed')
  }

  /** Whether a total is reported or derived in one step from reported totals. */
  const evidential = (row: RowResult, date: string): boolean => {
    const source = row.sources[date] ?? ''
    if (!source.startsWith('imputed')) return true
    let formula = source.startsWith('imputed-rollup') ? '' : source.slice(source.indexOf(':') + 1)
    if (source.startsWith('imputed-plug')) formula = formula.split('(', 1)[0]!
    const inputs = (formula.match(/[a-z][a-z0-9_]*/g) ?? []).filter((tag) => tagToRow.has(tag) && tag !== row.tag).map((tag) => tagToRow.get(tag)!)
    return inputs.length > 0 && !inputs.some((r) => (r.sources[date] ?? '').startsWith('imputed'))
  }

  const contained = (candidates: Pair[], holders: Pair[], direct: Set<RowResult>, date: string, gap: number, balance: number, tolerance: number): Pair[] => {
    const pool: Pair[] = []

    const fits = (members: Pair[]): boolean => {
      const excluded = new Set(members.map(([r]) => r))
      const outer = new Set<string>()
      for (const [r] of members) for (const t of ancestors(r)) outer.add(t)
      const room = [...pool, ...holders].filter(([r]) => !excluded.has(r) && !outer.has(r.tag) && !r.tag.startsWith('net_income')).map(([, y]) => y)
      return members.every(([r, c]) => SCOPE_VARIANTS.has(r.tag) || room.some((y) => y * c > 0 && Math.abs(y) >= Math.abs(c) - tolerance))
    }

    const walk = (row: RowResult, pathSign: number): void => {
      const value = row.values[date]
      if (value === undefined || !['+', '-'].includes(factorOn(row, date))) return
      const rowSign = pathSign * sign(row, date)
      const source = row.sources[date] ?? ''

      if ((row.factor === '+' || row.factor === '-') && !childrenByParent.has(row.tag) && Math.abs(value) > tolerance && !source.startsWith('imputed-plug') && (row.parent === null || otherLine(row.parent) !== row)) {
        pool.push([row, rowSign * value])
      }
      if (source.startsWith('imputed-rollup')) for (const child of childrenByParent.get(row.tag) ?? []) walk(child, rowSign)
    }

    for (const [row, pathSign] of candidates) walk(row, pathSign)

    /** Two components carrying one amount: the same fact, or equal balances over the parent. */
    const twin = (a: Pair, b: Pair): boolean => {
      const source = a[0].sources[date] ?? ''
      return (
        Math.abs(a[1] - b[1]) <= tolerance &&
        ((source !== '' && source === (b[0].sources[date] ?? '')) || (a[0].period_type === 'instant' && direct.has(a[0]) && direct.has(b[0]) && balance < -tolerance && balance + a[1] >= -tolerance))
      )
    }

    const lineage = new Map<RowResult, Set<string>>()
    for (const [r] of pool) lineage.set(r, ancestors(r))
    const seq = (rc: Pair) => Number(rc[0].sequence)
    const singles = pool.filter(([r, c]) => Math.abs(gap + c) <= tolerance && fits([[r, c]]))

    if (singles.length) {
      const deepest = maxBy(singles, (rc) => getDepth(rc[0].tag))
      if (singles.every(([r]) => r === deepest[0] || lineage.get(deepest[0])!.has(r.tag))) return [deepest]
      if (singles.length === 2 && twin(singles[0]!, singles[1]!)) return [maxBy(singles, seq)]
      return []
    }

    const pairs: [Pair, Pair][] = []
    pool.forEach((a, i) => {
      for (const b of pool.slice(i + 1)) {
        if (!lineage.get(b[0])!.has(a[0].tag) && !lineage.get(a[0])!.has(b[0].tag) && (a[1] * b[1] > 0 || (SCOPE_VARIANTS.has(a[0].tag) && SCOPE_VARIANTS.has(b[0].tag))) && Math.abs(gap + a[1] + b[1]) <= tolerance && fits([a, b])) pairs.push([a, b])
      }
    })
    if (pairs.length === 1) return [...pairs[0]!]

    const twins: [Pair, Pair][] = []
    pool.forEach((a, i) => {
      for (const b of pool.slice(i + 1)) if (twin(a, b)) twins.push([a, b])
    })
    const facts = twins.filter((pair) => (pair[0][0].sources[date] ?? '') !== '' && (pair[0][0].sources[date] ?? '') === (pair[1][0].sources[date] ?? ''))

    const dedupe = (items: Pair[]): Pair[] => {
      const m = new Map<RowResult, Pair>()
      for (const [r, c] of items) m.set(r, [r, c])
      return [...m.values()]
    }

    if (facts.length && facts.length === twins.length) return dedupe(facts.map((pair) => maxBy(pair, seq)))
    if (twins.length === 1) return [maxBy(twins[0]!, seq)]

    const repeats = dedupe(twins.map((pair) => maxBy(pair, seq)))
    if (twins.length > 1 && balance < -tolerance && balance + sum(repeats.map(([, c]) => c)) >= -tolerance) return repeats

    if (balance >= -tolerance || pool.some(([r]) => r.period_type !== 'instant')) return []

    const nested = pool.filter(([r, c]) => CONTAINABLE.has(r.tag) && direct.has(r) && c > tolerance && fits([[r, c]])).slice(0, 10)
    let best: [number, Pair[]] | null = null

    for (let size = 1; size <= nested.length; size++) {
      for (const group of combinations(nested, size)) {
        const rest = balance + sum(group.map(([, c]) => c))
        if (rest >= -tolerance && (best === null || rest < best[0])) best = [rest, group]
      }
    }
    return best === null ? [] : best[1]
  }

  /** The reported section total excluding exactly the missing component. */
  const relocated = (present: Pair[], date: string, gap: number, tolerance: number): [RowResult, RowResult] | null => {
    const found: [RowResult, RowResult][] = []

    const visit = (row: RowResult, pathSign: number): void => {
      const kids = childrenByParent.get(row.tag) ?? []
      const value = row.values[date]
      if (value === undefined || kids.length === 0) return

      const rowSign = pathSign * sign(row, date)
      const source = row.sources[date] ?? ''

      if (source.startsWith('imputed-rollup')) {
        for (const kid of kids) if (['+', '-'].includes(factorOn(kid, date))) visit(kid, rowSign)
        return
      }
      if (['imputed', 'corrected', 'identity-enforced'].some((p) => source.startsWith(p))) return

      const line = otherLine(row.tag)
      const members: Pair[] = kids.filter((kid) => kid !== line && kid.values[date] !== undefined && ['+', '-'].includes(factorOn(kid, date))).map((kid) => [kid, sign(kid, date) * kid.values[date]!])
      const inner = sum(members.map(([, c]) => c))
      if (value - inner >= -tolerance) return

      for (const [kid, c] of members) {
        if (!childrenByParent.has(kid.tag) && Math.abs(rowSign * c - gap) <= tolerance && value - inner + c >= -tolerance) found.push([row, kid])
      }
    }

    for (const [component] of present) visit(component, 1)
    return found.length === 1 ? found[0]! : null
  }

  const presented = (memos: RowResult[], date: string, gap: number, tolerance: number): RowResult | null => {
    const hits = memos.filter((m) => factorOn(m, date) === '0' && m.values[date] !== undefined && Math.abs(m.values[date]!) > tolerance && Math.abs(gap - m.values[date]!) <= tolerance)
    return hits.length === 1 ? hits[0]! : null
  }

  for (let iteration = 0; iteration < 2 * parents.length + 4; iteration++) {
    let changed = false

    for (const parentTag of parents) {
      const parentRow = tagToRow.get(parentTag)!
      const children = childrenByParent.get(parentTag)!
      const memos = memosByParent.get(parentTag) ?? []
      let otherRow = otherLine(parentTag)
      const otherTag = otherRow !== null ? otherRow.tag : `other_${stripTotal(parentTag)}`
      const required = ROLLUP_REQUIRES[parentTag]
      const requiredChildren = children.filter((c) => required !== undefined && required.includes(c.tag))
      const sections = children.filter((c) => (REMAINDER_REQUIRES[parentTag] ?? []).includes(c.tag))
      const ownPlug = `imputed-plug: ${parentTag} - `

      const state = (date: string): (number | undefined)[] => [parentRow.values[date], otherRow !== null ? otherRow.values[date] : undefined]

      const absorbable = (row: RowResult, date: string): boolean => {
        const source = row.sources[date] ?? ''
        if (source.startsWith(ownPlug)) return true
        return source.startsWith('imputed-rollup') && source.includes(' + ')
      }

      for (const date of dates) {
        if (blocked.has(blockKey(parentTag, date)) || blocked.has(blockKey(otherTag, date))) continue

        const before = state(date)
        const parentSource = parentRow.sources[date] ?? ''

        if (parentSource.startsWith('imputed-rollup') || (SOFT_TOTALS.has(parentTag) && parentSource.endsWith('(fallback)') && children.some((c) => c.values[date] !== undefined))) {
          delete parentRow.values[date]
          delete parentRow.sources[date]
        }

        let otherPopped = false
        if (otherRow !== null && (otherRow.sources[date] ?? '').startsWith('imputed-plug')) {
          delete otherRow.values[date]
          delete otherRow.sources[date]
          otherPopped = true
        }

        const present: Pair[] = [
          ...children.filter((c) => c !== otherRow && c.values[date] !== undefined && ['+', '-'].includes(factorOn(c, date))).map((c): Pair => [c, c.values[date]!]),
          ...memos.filter((m) => factorOn(m, date) === '+' && m.values[date] !== undefined).map((m): Pair => [m, m.values[date]!]),
        ]
        const otherVal = otherRow !== null ? otherRow.values[date] : undefined
        const otherSign = otherRow !== null ? sign(otherRow, date) : 1
        const explicitSum = sum(present.map(([c, v]) => sign(c, date) * v))
        const detail = present.map(([c]) => `${c.tag}(${factorOn(c, date)})`).join(' + ')
        const pVal = parentRow.values[date]

        if (pVal === undefined) {
          const skip =
            (required !== undefined && (required.length === 0 || (requiredChildren.length > 0 && !requiredChildren.some((c) => c.values[date] !== undefined)))) ||
            (!otherVal && !present.some(([, v]) => v)) ||
            (otherVal === undefined && present.every(([c]) => factorOn(c, date) === '-'))
          if (skip) {
            // nothing to roll up
          } else if (otherVal !== undefined && otherRow !== null) {
            parentRow.values[date] = explicitSum + otherVal * otherSign
            parentRow.sources[date] = 'imputed-rollup: ' + (detail ? [detail, `${otherRow.tag}(${factorOn(otherRow, date)})`] : [`${otherRow.tag}(${factorOn(otherRow, date)})`]).join(' + ')
          } else if (present.length) {
            parentRow.values[date] = explicitSum
            parentRow.sources[date] = `imputed-rollup: ${detail}`
          }
        } else if (
          (present.length > 0 || (WHOLE_REMAINDERS.has(parentTag) && otherRow !== null && (otherPopped || (otherRow.sources[date] ?? '').startsWith('imputed-rollup')))) &&
          (sections.length === 0 || sections.some((c) => c.values[date] !== undefined))
        ) {
          const gap = pVal - explicitSum
          const unexplained = gap - (otherVal ?? 0) * otherSign
          const tolerance = tol(pVal, explicitSum)

          if (Math.abs(unexplained) > tolerance) {
            const candidates: [RowResult, number][] = present.map(([c]) => [c, 1])
            const holders: Pair[] = present.map(([c, v]) => [c, sign(c, date) * v])
            let balance = gap

            if (otherRow !== null && otherVal !== undefined) {
              holders.push([otherRow, otherVal * otherSign])
              if ((otherRow.sources[date] ?? '').startsWith('imputed-rollup')) {
                balance = unexplained
                for (const g of childrenByParent.get(otherRow.tag) ?? []) candidates.push([g, otherSign])
              }
            }

            let hits: Pair[] = evidential(parentRow, date) ? contained(candidates, holders, new Set(present.map(([c]) => c)), date, unexplained, balance, tolerance) : []

            if (hits.length === 1 && otherVal !== undefined && Math.abs(otherVal * otherSign - hits[0]![1]) <= tolerance && !(hits[0]![0].parent === otherTag && otherRow !== null && (otherRow.sources[date] ?? '').startsWith('imputed-rollup'))) hits = []

            if (hits.length) {
              for (const [hit] of hits) hit.date_factors[date] = '0'
              changed = true
              continue
            }

            const memoHit = presented(memos, date, unexplained, tolerance)
            if (memoHit !== null) {
              memoHit.date_factors[date] = '+'
              changed = true
              continue
            }

            const moved = relocated(present, date, unexplained, tolerance)
            if (moved !== null) {
              const [sectionRow, leaf] = moved
              sectionRow.values[date]! += sign(leaf, date) * leaf.values[date]!
              sectionRow.sources[date] = `corrected: ${sectionRow.tag} + ${leaf.tag}`
              changed = true
              continue
            }

            const section = otherRow !== null && !otherRow.tag.startsWith('other_') && otherRow.tag !== 'redeemable_nci_other'
            const absorbers: RowResult[] = present.filter(([c]) => section && absorbable(c, date) && ((c.sources[date] ?? '').startsWith(ownPlug) || !complete(c, date))).map(([c]) => c)

            if (otherRow !== null && (otherPopped || (otherVal !== undefined && absorbable(otherRow, date) && !complete(otherRow, date)))) absorbers.push(otherRow)

            const fallbackRow = otherRow !== null && otherVal === undefined && unexplained * otherSign > 0 ? tagToRow.get(EVIDENCED_LINES[otherRow.tag] ?? '') : undefined

            if (fallbackRow !== undefined && fallbackRow.parent === parentTag && fallbackRow.values[date] === undefined) {
              delete fallbackRow.date_factors[date]
              fallbackRow.values[date] = unexplained * sign(fallbackRow, date)
              fallbackRow.sources[date] = `${ownPlug}(${detail})`
              changed = true
              continue
            }

            let absorberList = absorbers
            if (fallbackRow !== undefined && present.some(([c]) => c === fallbackRow) && ['imputed-rollup', ownPlug].some((p) => (fallbackRow.sources[date] ?? '').startsWith(p))) absorberList = [fallbackRow]

            if (absorberList.length === 1 && absorberList[0] !== otherRow) {
              const absorber = absorberList[0]!
              absorber.values[date]! += unexplained * sign(absorber, date)
              absorber.sources[date] = ownPlug + '(' + present.filter(([c]) => c !== absorber).map(([c]) => `${c.tag}(${factorOn(c, date)})`).join(' + ') + ')'
            } else if (NONNEGATIVE_LINES.has(otherTag) && gap * (otherRow === null ? 1 : sign(otherRow, date)) < -tolerance) {
              // a negative remainder in a nonnegative line stays unplugged
            } else if (otherRow !== null || (!tagToRow.has(otherTag) && present.some(([c]) => factorOn(c, date) !== '-'))) {
              if (otherRow === null) {
                otherRow = newRow({
                  tag: otherTag,
                  label: `Other ${parentRow.label.startsWith('Total ') ? parentRow.label.slice('Total '.length) : parentRow.label}`,
                  description: `Synthetic balancing plug derived from ${parentRow.label} minus explicitly mapped children.`,
                  parent: parentTag,
                  sequence: parentRow.sequence - 0.01,
                  factor: '+',
                  balance: parentRow.balance,
                  unit: parentRow.unit,
                  period_type: parentRow.period_type,
                })
                tagToRow.set(otherTag, otherRow)
                children.push(otherRow)
                newRows.push(otherRow)
              }
              delete otherRow.date_factors[date]
              otherRow.values[date] = gap * sign(otherRow, date)
              otherRow.sources[date] = `${ownPlug}(${detail})`
            }
          } else if (cleared && otherRow !== null && otherVal === undefined && cleared.has(otherRow)) {
            delete otherRow.date_factors[date]
            otherRow.values[date] = gap * sign(otherRow, date)
            otherRow.sources[date] = `${ownPlug}(${detail})`
          }
        }

        const after = state(date)
        if (after[0] !== before[0] || after[1] !== before[1]) changed = true
      }
    }

    if (!changed) break
  }

  for (const parentTag of parents) {
    const parentRow = tagToRow.get(parentTag)!
    const ownPlug = `imputed-plug: ${parentTag} - `

    for (const child of childrenByParent.get(parentTag)!) {
      for (const date of Object.entries(child.sources).filter(([d, s]) => s.startsWith(ownPlug) && parentRow.values[d] === undefined).map(([d]) => d)) {
        delete child.values[date]
        delete child.sources[date]
      }
    }
  }

  if (newRows.length) {
    rows.push(...newRows)
    rows.sort((a, b) => Number(a.sequence) - Number(b.sequence))
  }
}
