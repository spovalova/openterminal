// derivatives/futures/curve, provider cboe. Ported from openbb_cboe/models/futures_curve.py (OpenBB Platform 5.0.0,
// Apache-2.0); modified: plain rows instead of DataFrames and pydantic models.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { getVxByDate, getVxCurrent, type VxType } from './vix.js'

export async function futuresCurve(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const given = String(params.symbol ?? '')
  const symbol = !given || ['vx', 'vix', '^vix', 'vix_index'].includes(given.toLowerCase()) ? 'VX_EOD' : given.toUpperCase()
  if (symbol !== 'VX_AM' && symbol !== 'VX_EOD') throw new Error(`symbol must be VX_AM or VX_EOD, got ${symbol}`)
  const vxType: VxType = symbol === 'VX_AM' ? 'am' : 'eod'
  const date = params.date ? String(params.date) : undefined

  const data: Row[] = date ? await getVxByDate(ctx, date, vxType) : await getVxCurrent(ctx, vxType)
  if (data.length === 0) throw new Error('The response was returned empty.')
  if (!date || !date.includes(',')) return data

  // Several dates: one row per relative contract, with a column for each session's price.
  const curves = new Map<string, Map<string, unknown>>()
  const sessions = new Set<string>()
  for (const record of data) {
    const contract = record.symbol
    if (!contract) continue
    const session = String(record.date)
    sessions.add(session)
    if (!curves.has(String(contract))) curves.set(String(contract), new Map())
    curves.get(String(contract))!.set(session, record.price)
  }
  const ordered = [...sessions].sort()
  const rank = (contract: string): number => {
    const suffix = contract.replace(/^VX/, '')
    return /^\d+$/.test(suffix) ? Number(suffix) : curves.size
  }
  return [...curves.keys()].sort((a, b) => rank(a) - rank(b)).map((contract) => ({ symbol: contract, ...Object.fromEntries(ordered.map((s) => [s, curves.get(contract)!.get(s)])) }))
}
