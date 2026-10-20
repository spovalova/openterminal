// equity/search, provider cboe. Ported from openbb_cboe/models/equity_search.py (OpenBB Platform 5.0.0, Apache-2.0);
// modified: plain rows instead of a DataFrame and pydantic models.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { containsCI, getCompanyRows, useCacheOf } from './helpers.js'

export async function equitySearch(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const matches = containsCI(String(params.query ?? ''))
  const target = params.is_symbol === true ? 'symbol' : 'name'
  return (await getCompanyRows(ctx, useCacheOf(params))).filter((r) => matches(r[target]))
}
