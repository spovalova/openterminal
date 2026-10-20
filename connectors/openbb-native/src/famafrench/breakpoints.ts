// famafrench/breakpoints, provider famafrench. Ported from openbb_famafrench/models/breakpoints.py (OpenBB Platform
// 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models and a DataFrame.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { BREAKPOINT_FILES } from './constants.js'
import { getBreakpointData } from './helpers.js'

export async function breakpoints(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const type = String(params.breakpoint_type ?? 'me')
  if (!(type in BREAKPOINT_FILES)) throw new Error(`Invalid breakpoint_type: '${type}'. Valid values are: ${Object.keys(BREAKPOINT_FILES).join(', ')}`)
  const { rows } = await getBreakpointData(ctx, type)
  if (rows.length === 0) throw new Error(`The data is unexpectedly empty. -> ${type}`)

  const start = typeof params.start_date === 'string' ? params.start_date : undefined
  const end = typeof params.end_date === 'string' ? params.end_date : undefined
  return rows.filter((r) => !(start && String(r.date) < start) && !(end && String(r.date) > end))
}
