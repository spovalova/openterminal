// Fixing indices: which index a swap underlier compounds, its accrual basis, and (further down) where its history
// is published. Ported from openbb_cftc/utils/fixings.py (OpenBB Platform 5.0.0, Apache-2.0); see the notes at the
// fetchers for the sources that are not ported.
import { diffDays } from './dates.js'
import { FIXED_FLOAT_CURRENCY_INDICES, FIXING_BASES, FIXING_PROFILES, OIS_CURRENCY_INDICES } from './fixings-data.js'

/** Accrual basis an index's compounding is defined on (`fixing_basis`). */
export const fixingBasis = (index: string | null | undefined): number => FIXING_BASES[index ?? ''] ?? 360.0

/** Readable name and country ISO3 an index is published for (`fixing_profile`). */
export const fixingProfile = (index: string): [string, string] => FIXING_PROFILES[index] ?? [index, '']

export { FIXING_BASES }

/** Index a currency-scoped FISN underlier resolves to, by swap family (`_currency_scoped_index`). */
function currencyScopedIndex(name: string): string | null {
  for (const [prefix, table] of [
    ['NA/SWAP OIS ', OIS_CURRENCY_INDICES],
    ['NA/SWAP FXD FLT ', FIXED_FLOAT_CURRENCY_INDICES],
  ] as const) {
    if (name.startsWith(prefix)) {
      const tokens = name.slice(prefix.length).split(/\s+/).filter(Boolean)
      if (tokens.length === 1) return table[tokens[0]!] ?? null
    }
  }
  return null
}

/** The fixing index an underlier name compounds, or null when unsupported (`index_for_underlier`). */
export function indexForUnderlier(underlier: string | null | undefined): string | null {
  const name = (underlier ?? '').toUpperCase()
  const has = (...s: string[]): boolean => s.some((x) => name.includes(x))
  if (has('SOFR')) return 'SOFR'
  if (has('FEDERAL FUNDS')) return 'EFFR'
  if (has('CORRA')) return 'CORRA'
  if (has('EUROSTR')) return 'ESTR'
  if (has('EURIBOR') && !has('SWAP RATE')) return 'EURIBOR'
  if (has('PRIBOR')) return 'PRIBOR'
  if (has('MYOR')) return 'MYOR'
  if (has('KLIBOR')) return 'KLIBOR'
  if (has('SONIA')) return 'SONIA'
  if (has('TONA')) return 'TONA'
  if (has('TIIE')) return 'TIIE'
  if (has('CDI')) return 'CDI'
  if (has('SARON')) return 'SARON'
  if (has('SORA')) return 'SORA'
  if (has('MIBOR')) return 'MIBOR'
  if (has('IBR')) return 'IBR'
  if (has('ZARONIA')) return 'ZARONIA'
  if (has('ICP', 'CLP-TNA')) return 'ICP'
  if (has('THOR')) return 'THOR'
  if (has('SHIR')) return 'SHIR'
  if (has('NZIONA')) return 'NZIONA'
  if (has('BKBM', 'BBR')) return 'BKBM'
  if (has('AONIA')) return 'AONIA'
  if (has('BBSW', 'BBSY')) return 'BBSW'
  if (has('HIBOR')) return 'HIBOR'
  if (has('JIBAR')) return 'JIBAR'
  if (has('KOFR')) return 'KOFR'
  if (has('BUBOR')) return 'BUBOR'
  if (has('POLSTR', 'WIRON')) return 'POLSTR'
  if (has('WIBOR')) return 'WIBOR'
  if (has('FIXING REPO', 'CNREPOFIX', 'FR007')) return 'FR007'
  if (has('TAIBOR')) return 'TAIBOR'
  if (has('KRW-CD', 'KRW CD')) return 'KRWCD'
  return currencyScopedIndex(name)
}

/** Published fixings by effective date: ISO date to decimal rate. */
export type Fixings = Record<string, number>

/** Compound published fixings over [start, end) (`compound_fixings`). */
export function compoundFixings(fixings: Fixings, startDate: string, endDate: string, basis = 360.0): number | null {
  if (basis === 252.0) {
    const applicable = Object.keys(fixings)
      .filter((day) => startDate <= day && day < endDate)
      .sort()
    if (applicable.length === 0) return null
    let factor = 1.0
    for (const day of applicable) factor *= 1.0 + fixings[day]!
    return factor - 1.0
  }
  const dates = Object.keys(fixings)
    .filter((day) => day < endDate)
    .sort()
  if (dates.length === 0) return null
  let applicable = dates.filter((day) => day >= startDate)
  const earlier = dates.filter((day) => day < startDate)
  if (earlier.length === 0 && (applicable.length === 0 || applicable[0] !== startDate)) return null
  if (earlier.length > 0) applicable = [earlier[earlier.length - 1]!, ...applicable]
  let factor = 1.0
  applicable.forEach((day, index) => {
    const appliedFrom = day > startDate ? day : startDate
    const next = index + 1 < applicable.length ? applicable[index + 1]! : null
    const appliedTo = next !== null ? (next < endDate ? next : endDate) : endDate
    const days = diffDays(appliedTo, appliedFrom)
    if (days > 0) factor *= 1.0 + (fixings[day]! * days) / basis
  })
  return factor - 1.0
}
