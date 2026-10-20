// index/search, provider cboe. Ported from openbb_cboe/models/index_search.py (OpenBB Platform 5.0.0, Apache-2.0);
// modified: plain rows instead of a DataFrame and pydantic models.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { containsCI, getIndexRows, useCacheOf } from './helpers.js'
import { indexRow } from './index-available.js'

export async function indexSearch(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const matches = containsCI(String(params.query ?? ''))
  const rows = await getIndexRows(ctx, useCacheOf(params))
  // `is_symbol` looks at the symbol alone; otherwise the name, symbol and description are searched.
  const hit = (r: Row) => (params.is_symbol === true ? matches(r.index_symbol) : matches(r.name) || matches(r.index_symbol) || matches(r.description))
  return rows
    .filter(hit)
    .map(({ source: _source, ...rest }) => indexRow(rest))
}
