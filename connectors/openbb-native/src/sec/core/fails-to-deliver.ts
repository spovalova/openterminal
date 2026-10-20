// equity/shorts/fails_to_deliver, provider sec. Ported from openbb_sec/models/equity_ftd.py and `download_zip_file`,
// `get_ftd_urls` in openbb_sec/utils/helpers.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of
// DataFrames and pydantic models, zip files read with fflate.
import { unzipSync } from 'fflate'
import { parseCsv } from '../../lib/csv.js'
import type { NativeCtx, NativeParams, Row } from '../../types.js'
import { DEFAULT_EXPIRE_S, HEADERS, SEC_HEADERS, cachedRequest, decodeLatin1 } from '../helpers.js'

/** `get_ftd_urls`: report date (e.g. "202508a") → zip URL, newest first as the SEC's data catalog lists them. */
async function getFtdUrls(ctx: NativeCtx): Promise<Map<string, string>> {
  const r = (await cachedRequest(ctx, 'https://www.sec.gov/data.json', { headers: SEC_HEADERS, useCache: false })) as { dataset?: { title?: string; distribution?: { downloadURL?: string }[] }[] }
  const results = new Map<string, string>()
  const fails = (r.dataset ?? []).find((d) => d.title === 'Fails-to-Deliver Data')
  if (!fails) return results
  const urls = (fails.distribution ?? []).map((d) => d.downloadURL).filter((u): u is string => !!u)
  // The key is the 11th to 5th character from the end of the URL ("..._202508a.zip" or "...fails202508a.zip"), without "_".
  for (const url of urls) results.set(url.slice(-11, -4).replaceAll('_', ''), url)
  return results
}

/** A zip member as a table: pipe-separated, a header line, and two trailer lines that are not data. */
function parseMember(text: string): Record<string, string>[] {
  const rows = parseCsv(text, '|')
  const header = rows[0] ?? []
  return rows.slice(1, -2).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])))
}

/** `download_zip_file`: one report's rows for a symbol, with the renamed columns and parsed dates and prices. */
async function downloadZipFile(ctx: NativeCtx, url: string, symbol: string | undefined, useCache: boolean): Promise<Row[]> {
  const bytes = (await cachedRequest(ctx, url, { kind: 'bytes', headers: HEADERS, useCache, expireS: DEFAULT_EXPIRE_S })) as Uint8Array
  const files = Object.entries(unzipSync(bytes))
  let table: Record<string, string>[]
  const single = files.length === 1 ? files[0]![1] : undefined
  let utf8: string | undefined
  if (single) {
    try {
      utf8 = new TextDecoder('utf-8', { fatal: true }).decode(single)
    } catch {
      utf8 = undefined
    }
  }
  // One UTF-8 file is read directly; anything else (several files, another encoding) is read as ISO-8859-1.
  if (utf8 !== undefined) table = parseMember(utf8)
  else table = files.flatMap(([, content]) => parseMember(decodeLatin1(content)))
  if (!table.length) return []

  let rows = table.map((r) => ({ date: r['SETTLEMENT DATE'], symbol: r['SYMBOL'], cusip: r['CUSIP'], quantity: r['QUANTITY (FAILS)'], price: r['PRICE'], description: r['DESCRIPTION'] }))
  if (symbol) rows = rows.filter((r) => r.symbol === symbol)
  return rows.map((r) => {
    const d = r.date ?? ''
    const price = r.price !== undefined && /^\d+(?:\.\d+)?$/.test(r.price) ? Number(r.price) : null
    return {
      date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`,
      symbol: r.symbol,
      cusip: r.cusip,
      quantity: r.quantity === undefined || r.quantity === '' ? null : parseInt(r.quantity, 10),
      price,
      description: r.description,
    }
  })
}

export async function equityFtd(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const symbol = String(params.symbol ?? '').toUpperCase()
  const limit = params.limit === undefined ? 24 : Number(params.limit)
  const skip = params.skip_reports === undefined ? 0 : Number(params.skip_reports)
  const useCache = params.use_cache === undefined ? true : Boolean(params.use_cache)

  let urls = [...(await getFtdUrls(ctx)).values()]
  if (limit > 0) urls = !skip ? urls.slice(0, limit) : urls.slice(skip, limit + skip)
  const reports = await Promise.all(urls.map((url) => downloadZipFile(ctx, url, symbol, useCache)))
  const results = reports.flat()
  if (!results.length) throw new Error('There was an error collecting data, no results were returned.')
  // `sorted(..., reverse=True)` keeps equal dates in their original order.
  const sorted = results.map((r, i) => ({ r, i })).sort((a, b) => (a.r.date! < b.r.date! ? 1 : a.r.date! > b.r.date! ? -1 : a.i - b.i))
  return sorted.map(({ r }) => ({ settlement_date: r.date, symbol: r.symbol, cusip: r.cusip, quantity: r.quantity, price: r.price, description: r.description }))
}

