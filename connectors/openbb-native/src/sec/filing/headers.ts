// sec/filing_headers, provider sec. Ported from openbb_sec/models/sec_filing.py (OpenBB Platform 5.0.0, Apache-2.0);
// modified: plain rows instead of pydantic models.
import type { NativeCtx, NativeParams, Row } from '../../types.js'
import { fetchCompanyFilings } from '../company-filings.js'
import { Filing } from './filing.js'

const DEFAULT_FILING_SYMBOL = 'AAPL'

/** `SecFilingFetcher._default_filing_url`: the most recent filing of the default symbol. */
async function defaultFilingUrl(ctx: NativeCtx, useCache: boolean): Promise<string> {
  const filings = await fetchCompanyFilings(ctx, { symbol: DEFAULT_FILING_SYMBOL, use_cache: useCache, limit: 1 })
  if (filings.length === 0) throw new Error('No filings found for the default symbol.')
  return String(filings[0]!.report_url)
}

export async function filingHeaders(params: NativeParams, ctx: NativeCtx): Promise<Row> {
  const useCache = params.use_cache === undefined ? true : Boolean(params.use_cache)
  const url = (typeof params.url === 'string' && params.url) || (await defaultFilingUrl(ctx, useCache))
  const filing = await Filing.create(ctx, url, useCache)
  return filing.toRow()
}
