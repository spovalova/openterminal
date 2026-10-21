// `math.erf`, which JavaScript lacks. Python calls the C library's erf, which is Sun's fdlibm s_erf.c: rational
// approximations on four ranges, with the tail built from two exponentials. This follows it step for step, so the
// result is the same double in all but the rare case where Math.exp rounds differently from the C library's exp.
// Used by the optimizer's Black-Scholes values (`statistics.NormalDist().cdf`).
//
// fdlibm's notice, which its license requires to be kept with the code:
//   Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.
//   Developed at SunPro, a Sun Microsystems, Inc. business.
//   Permission to use, copy, modify, and distribute this software is freely granted, provided that this notice is
//   preserved.
//
// The C library on the OpenBB host evaluates the polynomials with fused multiply-adds (the compiler contracts every
// `a + b * c`), which rounds once where plain JavaScript rounds twice; `fma` below reproduces that, so the result is the
// same double rather than one a unit in the last place away.

const erx = 8.45062911510467529297e-1
const efx = 1.28379167095512586316e-1
const efx8 = 1.02703333676410069053
const pp = [1.28379167095512558561e-1, -3.25042107247001499370e-1, -2.84817495755985104766e-2, -5.77027029648944159157e-3, -2.3763016656650163e-5]
const qq = [1.0, 3.97917223959155352819e-1, 6.50222499887672944485e-2, 5.08130628187576562776e-3, 1.3249473800432164e-4, -3.96022827877536812320e-6]
const pa = [-2.36211856075265944077e-3, 4.14856118683748331666e-1, -3.72207876035701323847e-1, 3.18346619901161753674e-1, -1.10894694282396677476e-1, 3.54783043256182359371e-2, -2.166375594868790843e-3]
const qa = [1.0, 1.06420880400844228286e-1, 5.40397917702171048937e-1, 7.18286544141962662868e-2, 1.26171219808761642112e-1, 1.36370839120290507362e-2, 1.19844998467991074170e-2]
const ra = [-9.86494403484714822705e-3, -6.93858572707181764372e-1, -1.05586262253232909814e1, -6.23753324503260060396e1, -1.62396669462573470355e2, -1.84605092906711035994e2, -8.12874355063065934246e1, -9.81432934416914548592]
const sa = [1.0, 1.96512716674392571292e1, 1.37657754143519042600e2, 4.34565877475229228821e2, 6.45387271733267880336e2, 4.29008140027567833386e2, 1.08635005541779435134e2, 6.57024977031928170135, -6.04244152148580987438e-2]
const rb = [-9.86494292470009928597e-3, -7.99283237680523006574e-1, -1.77579549177547519889e1, -1.60636384855821916062e2, -6.37566443368389627722e2, -1.02509513161107724954e3, -4.83519191608651397019e2]
const sb = [1.0, 3.03380607434824582924e1, 3.25792512996573918826e2, 1.53672958608443695994e3, 3.19985821950859553908e3, 2.55305040643316442583e3, 4.74528541206955367215e2, -2.24409524465858183362e1]

const scratch = new DataView(new ArrayBuffer(8))

/** Veltkamp's split of a double into two halves whose product with another half is exact. */
function split(a: number): [number, number] {
  const c = 134217729 * a
  const hi = c - (c - a)
  return [hi, a - hi]
}

/** `a * b + c` rounded once (error-free product and sum, then the rounded total of the three parts). */
function fma(a: number, b: number, c: number): number {
  const p = a * b
  if (!Number.isFinite(p) || !Number.isFinite(c)) return p + c
  const [ah, al] = split(a)
  const [bh, bl] = split(b)
  const e = ah * bh - p + ah * bl + al * bh + al * bl
  const sum = p + c
  const bb = sum - p
  const t = p - (sum - bb) + (c - bb)
  return sum + (t + e)
}

/** The high 32 bits of a double. */
function highWord(x: number): number {
  scratch.setFloat64(0, x)
  return scratch.getUint32(0)
}

/** A double with its low 32 bits cleared. */
function clearLowWord(x: number): number {
  scratch.setFloat64(0, x)
  scratch.setUint32(4, 0)
  return scratch.getFloat64(0)
}

export function erf(x: number): number {
  if (Number.isNaN(x)) return NaN
  const hx = highWord(x)
  const negative = (hx & 0x80000000) !== 0
  const ix = hx & 0x7fffffff
  if (ix >= 0x7ff00000) return negative ? -1 : 1
  if (ix < 0x3feb0000) {
    // |x| < 0.84375
    if (ix < 0x3e300000) {
      // |x| < 2**-28
      if (ix < 0x00800000) return 0.125 * (8.0 * x + efx8 * x)
      return fma(efx, x, x)
    }
    const z = x * x
    const r1 = fma(z, pp[1]!, pp[0]!)
    const z2 = z * z
    const r2 = fma(z, pp[3]!, pp[2]!)
    const z4 = z2 * z2
    const s1 = fma(z, qq[1]!, 1)
    const s2 = fma(z, qq[3]!, qq[2]!)
    const s3 = fma(z, qq[5]!, qq[4]!)
    const r = fma(z4, pp[4]!, fma(z2, r2, r1))
    const s = fma(z4, s3, fma(z2, s2, s1))
    return fma(x, r / s, x)
  }
  if (ix < 0x3ff40000) {
    // 0.84375 <= |x| < 1.25
    const s = Math.abs(x) - 1
    const p1 = fma(s, pa[1]!, pa[0]!)
    const s2 = s * s
    const q1 = fma(s, qa[1]!, 1)
    const s4 = s2 * s2
    const p2 = fma(s, pa[3]!, pa[2]!)
    const s6 = s4 * s2
    const q2 = fma(s, qa[3]!, qa[2]!)
    const p3 = fma(s, pa[5]!, pa[4]!)
    const q3 = fma(s, qa[5]!, qa[4]!)
    const p = fma(s6, pa[6]!, fma(s4, p3, fma(s2, p2, p1)))
    const q = fma(s6, qa[6]!, fma(s4, q3, fma(s2, q2, q1)))
    return negative ? -erx - p / q : erx + p / q
  }
  if (ix >= 0x40180000) return negative ? -1 : 1 // |x| >= 6: one minus tiny
  const ax = Math.abs(x)
  const s = 1 / (ax * ax)
  let numerator: number
  let denominator: number
  if (ix < 0x4006db6e) {
    // |x| < 1/0.35
    const r1 = fma(s, ra[1]!, ra[0]!)
    const s2 = s * s
    const d1 = fma(s, sa[1]!, 1)
    const s4 = s2 * s2
    const r2 = fma(s, ra[3]!, ra[2]!)
    const s6 = s4 * s2
    const d2 = fma(s, sa[3]!, sa[2]!)
    const s8 = s4 * s4
    const r3 = fma(s, ra[5]!, ra[4]!)
    const d3 = fma(s, sa[5]!, sa[4]!)
    const r4 = fma(s, ra[7]!, ra[6]!)
    const d4 = fma(s, sa[7]!, sa[6]!)
    numerator = fma(s6, r4, fma(s4, r3, fma(s2, r2, r1)))
    denominator = fma(s8, sa[8]!, fma(s6, d4, fma(s4, d3, fma(s2, d2, d1))))
  } else {
    // |x| >= 1/0.35
    const r1 = fma(s, rb[1]!, rb[0]!)
    const s2 = s * s
    const d1 = fma(s, sb[1]!, 1)
    const s4 = s2 * s2
    const r2 = fma(s, rb[3]!, rb[2]!)
    const s6 = s4 * s2
    const d2 = fma(s, sb[3]!, sb[2]!)
    const r3 = fma(s, rb[5]!, rb[4]!)
    const d3 = fma(s, sb[5]!, sb[4]!)
    const d4 = fma(s, sb[7]!, sb[6]!)
    numerator = fma(s6, rb[6]!, fma(s4, r3, fma(s2, r2, r1)))
    denominator = fma(s6, d4, fma(s4, d3, fma(s2, d2, d1)))
  }
  const z = clearLowWord(ax)
  const r = Math.exp(fma(-z, z, -0.5625)) * Math.exp(fma(z - ax, z + ax, numerator / denominator))
  return negative ? r / ax - 1 : 1 - r / ax
}
