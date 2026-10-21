// FX forward and option pricing math: CIP forwards, Garman-Kohlhagen, lognormal SABR. Ported from
// openbb_cftc/utils/fx_theory.py (OpenBB Platform 5.0.0, Apache-2.0); modified: `erf` (absent from JavaScript) is
// evaluated with its non-alternating power series, accurate to double precision.

/** The error function, to double precision (`math.erf`). */
export function erf(x: number): number {
  if (Number.isNaN(x)) return NaN
  const ax = Math.abs(x)
  if (ax >= 6) return x < 0 ? -1 : 1
  // erf(x) = 2/sqrt(pi) * exp(-x^2) * sum_{n>=0} 2^n x^(2n+1) / (1*3*5*...*(2n+1))
  const x2 = ax * ax
  let term = ax
  let total = ax
  for (let n = 1; n < 400; n++) {
    term *= (2 * x2) / (2 * n + 1)
    total += term
    if (term < total * 1e-17) break
  }
  const value = (2 / Math.sqrt(Math.PI)) * Math.exp(-x2) * total
  const bounded = Math.min(value, 1)
  return x < 0 ? -bounded : bounded
}

const normCdf = (x: number): number => 0.5 * (1.0 + erf(x / Math.sqrt(2.0)))

/** Covered-interest-parity forward rate for a quote-per-base pair; rates are decimals (`cip_forward_rate`). */
export function cipForwardRate(spot: number, rateQuote: number, rateBase: number, days: number, basisQuote = 360.0, basisBase = 360.0): number {
  return (spot * (1.0 + (rateQuote * days) / basisQuote)) / (1.0 + (rateBase * days) / basisBase)
}

/** The d1 and d2 terms of the Garman-Kohlhagen formula (`d1_d2`). */
function d1d2(spot: number, strike: number, t: number, rateDom: number, rateFor: number, vol: number): [number, number] {
  const volT = vol * Math.sqrt(t)
  const first = (Math.log(spot / strike) + (rateDom - rateFor + 0.5 * vol * vol) * t) / volT
  return [first, first - volT]
}

/** Garman-Kohlhagen price of a vanilla FX option per unit of base-currency notional (`garman_kohlhagen`). */
export function garmanKohlhagen(spot: number, strike: number, t: number, rateDom: number, rateFor: number, vol: number, isCall: boolean): number {
  const [d1, d2] = d1d2(spot, strike, t, rateDom, rateFor, vol)
  const discFor = Math.exp(-rateFor * t)
  const discDom = Math.exp(-rateDom * t)
  if (isCall) return spot * discFor * normCdf(d1) - strike * discDom * normCdf(d2)
  return strike * discDom * normCdf(-d2) - spot * discFor * normCdf(-d1)
}

const VOL_LOW = 1e-4
const VOL_HIGH = 5.0

/** Bisection implied volatility repricing a vanilla FX option to `price`, or null (`implied_vol`). */
export function impliedVol(price: number, spot: number, strike: number, t: number, rateDom: number, rateFor: number, isCall: boolean): number | null {
  if (t <= 0.0) return null
  const forward = spot * Math.exp((rateDom - rateFor) * t)
  const discDom = Math.exp(-rateDom * t)
  const intrinsic = discDom * Math.max(isCall ? forward - strike : strike - forward, 0.0)
  if (price <= intrinsic) return null
  let low = VOL_LOW
  let high = VOL_HIGH
  if (price >= garmanKohlhagen(spot, strike, t, rateDom, rateFor, high, isCall)) return null
  for (let i = 0; i < 100; i++) {
    const mid = 0.5 * (low + high)
    if (garmanKohlhagen(spot, strike, t, rateDom, rateFor, mid, isCall) < price) low = mid
    else high = mid
  }
  return 0.5 * (low + high)
}

/** Hagan lognormal-SABR implied volatility at a strike (`sabr_vol`). */
export function sabrVol(forward: number, strike: number, t: number, alpha: number, rho: number, nu: number): number {
  const drift = 1.0 + (0.25 * rho * nu * alpha + ((2.0 - 3.0 * rho * rho) / 24.0) * nu * nu) * t
  if (Math.abs(forward - strike) < 1e-12) return alpha * drift
  const logFk = Math.log(forward / strike)
  const z = (nu / alpha) * logFk
  const x = Math.log((Math.sqrt(1.0 - 2.0 * rho * z + z * z) + z - rho) / (1.0 - rho))
  return alpha * (z / x) * drift
}

/** SABR alpha repricing the at-the-money vol (`_sabr_alpha_from_atm`). */
function sabrAlphaFromAtm(atmVol: number, t: number, rho: number, nu: number): number | null {
  const a = 0.25 * rho * nu * t
  const b = 1.0 + ((2.0 - 3.0 * rho * rho) / 24.0) * nu * nu * t
  if (Math.abs(a) < 1e-12) return b > 0.0 ? atmVol / b : null
  const disc = b * b + 4.0 * a * atmVol
  if (disc < 0.0) return null
  const root = (-b + Math.sqrt(disc)) / (2.0 * a)
  return root > 0.0 ? root : null
}

type Fit = [number, number, number, number]

/** Lexicographic tuple order, as Python compares tuples. */
function fitLess(a: Fit, b: Fit): boolean {
  for (let i = 0; i < 4; i++) {
    if (a[i]! < b[i]!) return true
    if (a[i]! > b[i]!) return false
  }
  return false
}

/** Fit SABR to points, or null if thin or one-sided (`calibrate_sabr`). */
export function calibrateSabr(forward: number, t: number, atmVol: number, points: [number, number][]): [number, number, number] | null {
  const below = points.filter(([s]) => s < forward)
  const above = points.filter(([s]) => s > forward)
  if (points.length < 4 || below.length === 0 || above.length === 0) return null

  const evaluate = (rho: number, nu: number): Fit => {
    const alpha = sabrAlphaFromAtm(atmVol, t, rho, nu)
    if (alpha === null) return [Infinity, 0.0, rho, nu]
    let total = 0.0
    for (const [strike, vol] of points) total += (sabrVol(forward, strike, t, alpha, rho, nu) - vol) ** 2
    return [total, alpha, rho, nu]
  }
  const best = (rhos: number[], nus: number[]): Fit => {
    let top: Fit | null = null
    for (const r of rhos) {
      for (const n of nus) {
        const candidate = evaluate(r, n)
        if (top === null || fitLess(candidate, top)) top = candidate
      }
    }
    return top!
  }

  const rhoGrid = Array.from({ length: 19 }, (_v, i) => (i - 9) / 10.0)
  const nuGrid = Array.from({ length: 30 }, (_v, i) => 0.05 + 0.15 * i)
  const [, , rho, nu] = best(rhoGrid, nuGrid)
  const fineRho: number[] = []
  for (let i = -4; i < 5; i++) if (-0.99 < rho + 0.02 * i && rho + 0.02 * i < 0.99) fineRho.push(rho + 0.02 * i)
  const fineNu: number[] = []
  for (let i = -4; i < 5; i++) if (nu + 0.03 * i > 0.01) fineNu.push(nu + 0.03 * i)
  const [, alpha, rho2, nu2] = best(fineRho, fineNu)
  return [alpha, rho2, nu2]
}
