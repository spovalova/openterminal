// The helpers that go with the constants of openbb_cftc/utils/constants.py (OpenBB Platform 5.0.0, Apache-2.0).
import { ASSET_CLASSES, BENCHMARK_TENORS, DAY_COUNT_BASIS, FIXED_FLOAT_CURVE_SPECS, FX_PAIRS, FX_TENOR_BUCKETS, MAJOR_FX_PAIRS, OIS_INDICES } from './constants-data.js'

export * from './constants-data.js'

type Spec = { index?: string; central_bank?: string; day_count: string; fisn?: string; overnight_index?: string }
const oisIndices = OIS_INDICES as Record<string, Spec>
const fixedFloatSpecs = FIXED_FLOAT_CURVE_SPECS as Record<string, Spec>
const dayCountBasisTable = DAY_COUNT_BASIS as Record<string, number>
const assetClasses = ASSET_CLASSES as Record<string, string>

/** The PPD path segment of an asset class key (`normalize_asset_class`). */
export function normalizeAssetClass(assetClass: string): string {
  const key = (assetClass || '').trim().toLowerCase()
  const value = assetClasses[key]
  if (value === undefined) throw new Error(`Invalid asset class: '${assetClass}'. Valid asset classes are: ${Object.keys(assetClasses).join(', ')}`)
  return value
}

/** A fixed-leg day count code as its accrual denominator (`day_count_basis`). */
export function dayCountBasis(code: string | null | undefined, dflt: string): number {
  const resolved = (code ?? '').trim() || dflt
  return dayCountBasisTable[resolved] ?? dayCountBasisTable[dflt] ?? 365.0
}

export const oisFisn = (currency: string): string => `NA/Swap OIS ${currency.toUpperCase()}`

/** Money-market accrual basis of a currency's rate leg, from its OIS day count (`currency_basis`). */
export function currencyBasis(currency: string): number {
  return dayCountBasis(oisIndices[currency.toUpperCase()]?.day_count, 'A004')
}

/** The benchmark spec a currency's rate curve is built against (`curve_spec`). */
export function curveSpec(currency: string): Spec {
  const ccy = (currency || '').trim().toUpperCase()
  const spec = oisIndices[ccy] ?? fixedFloatSpecs[ccy]
  if (!spec) throw new Error(`KeyError: '${ccy}'`)
  return spec
}

/** The FISN a currency's rate curve is built from (`curve_fisn`). */
export const curveFisn = (currency: string): string => curveSpec(currency).fisn || oisFisn(currency)

/** Swap families that could price a currency's rate curve, deepest source first (`rate_curve_fisns`). */
export function rateCurveFisns(currency: string): string[] {
  const ccy = (currency || '').trim().toUpperCase()
  const candidates: string[] = ccy in oisIndices ? [oisFisn(ccy)] : []
  candidates.push(`NA/Swap Fxd Flt ${ccy}`)
  candidates.push(`NA/Swap Fxd Flt ${ccy} USD`)
  return candidates
}

const tenorDays = new Map<string, number>(BENCHMARK_TENORS.map(([label, days]) => [label, days]))

/** A benchmark tenor label as a year fraction (`tenor_to_years`). */
export function tenorToYears(label: string): number {
  const days = tenorDays.get((label || '').trim().toUpperCase())
  if (days === undefined) throw new Error(`Invalid tenor '${label}'. Valid tenors are: ${BENCHMARK_TENORS.map(([t]) => t).join(', ')}`)
  return days / 365.0
}

export type FxSpec = { base: string; quote: string; invert: boolean; pip: number; forward_fisn: string; swap_fisn: string; ndf?: boolean }
export type MajorPairSpec = { base: string; quote: string; pip: number; ndf?: boolean }

export const fxPairs = FX_PAIRS as unknown as Record<string, FxSpec>
export const majorFxPairs = MAJOR_FX_PAIRS as unknown as Record<string, MajorPairSpec>
export const fxTenorBuckets = FX_TENOR_BUCKETS as unknown as readonly (readonly [string, number, number])[]

export { oisIndices, fixedFloatSpecs }
