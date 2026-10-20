// index/available, provider cboe. Ported from openbb_cboe/models/available_indices.py (OpenBB Platform 5.0.0,
// Apache-2.0); modified: plain rows instead of a DataFrame and pydantic models.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { getIndexRows, useCacheOf } from './helpers.js'

/** Cboe field → OpenBB field (`__alias_dict__`). */
const INDEX_ALIASES: Record<string, string> = {
  index_symbol: 'symbol',
  mkt_data_delay: 'data_delay',
  calc_start_time: 'open_time',
  calc_end_time: 'close_time',
}

/** A directory row under OpenBB's field names. */
export function indexRow(row: Row): Row {
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [INDEX_ALIASES[k] ?? k, v]))
}

export async function indexAvailable(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  return (await getIndexRows(ctx, useCacheOf(params))).map(indexRow)
}
