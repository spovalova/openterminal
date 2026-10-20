// derivatives/futures/instruments, provider cboe. Ported from openbb_cboe/models/futures_instruments.py (OpenBB
// Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { listFutures } from './helpers.js'

export async function futuresInstruments(_params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const data = await listFutures(ctx)
  if (data.length === 0) throw new Error('The futures roots directory returned empty.')
  return data
}
