// equity/search, sec/cik_map, sec/symbol_map, sec/institutions_search and sec/sic_search, provider sec. Ported from
// openbb_sec/models/equity_search.py, cik_map.py, symbol_map.py, institutions_search.py and sic_search.py (OpenBB
// Platform 5.0.0, Apache-2.0); modified: plain rows instead of DataFrames and pydantic models; sic_search follows
// the SEC's redirect to the moved SIC code page and reads its header row, which OpenBB's pandas call cannot.
import { parse } from 'node-html-parser'
import type { NativeCtx, NativeParams, Row } from '../../types.js'
import { SEC_HEADERS, cachedRequest, cikMap, containsIgnoreCase, getAllCiks, getAllCompanies, getMfAndEtfMap, symbolMap } from '../helpers.js'

const useCache = (params: NativeParams): boolean => (params.use_cache === undefined ? true : Boolean(params.use_cache))

/** equity/search: companies by name, symbol or CIK, or funds by CIK, series, class or symbol (`is_fund`). */
export async function equitySearch(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const query = typeof params.query === 'string' ? params.query : ''
  const cache = useCache(params)
  if (params.is_fund === true) {
    const matches = containsIgnoreCase(query)
    const funds = await getMfAndEtfMap(ctx, cache)
    return funds.filter((f) => matches(f.cik) || matches(f.seriesId) || matches(f.classId) || matches(f.symbol)).map((f) => ({ ...f }))
  }
  const matches = containsIgnoreCase(query)
  const companies = await getAllCompanies(ctx, cache)
  return companies.filter((c) => matches(c.name) || matches(c.symbol) || matches(c.cik)).map((c) => ({ symbol: c.symbol, name: c.name, cik: c.cik }))
}

/** sec/cik_map: the ten-digit CIK of a ticker. */
export async function secCikMap(params: NativeParams, ctx: NativeCtx): Promise<Row> {
  const symbol = String(params.symbol ?? '').toUpperCase()
  const cik = await symbolMap(ctx, symbol, useCache(params))
  if (!cik) throw new Error(`Symbol '${symbol}' not found in SEC database.`)
  return { cik }
}

/** sec/symbol_map: the ticker of a CIK (or OpenBB's error text when the CIK has no unique ticker). */
export async function secSymbolMap(params: NativeParams, ctx: NativeCtx): Promise<Row> {
  const query = String(params.query ?? '')
  if (!/^\d+$/.test(query)) throw new Error('Query is required and must be a valid CIK.')
  return { symbol: await cikMap(ctx, Number(query), useCache(params)) }
}

/** sec/institutions_search: entity names of EDGAR's CIK lookup file that match the query. */
export async function secInstitutionsSearch(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const institutions = await getAllCiks(ctx, useCache(params))
  if (typeof params.query !== 'string') throw new Error('query is required to search institutions.')
  const matches = containsIgnoreCase(params.query)
  return institutions.filter((i) => matches(i.Institution)).map((i) => ({ name: i.Institution, cik: i['CIK Number'] }))
}

const SIC_URL = 'https://www.sec.gov/corpfin/division-of-corporation-finance-standard-industrial-classification-sic-code-list'

/** The text of a table cell, as pandas.read_html gives it: the rendered text of the cell, trimmed. */
const cellText = (node: { text: string }): string => node.text.trim()

/** The meta-refresh target of a "this page moved" document, if it is one. */
function metaRefresh(html: string): string | undefined {
  const m = /<meta[^>]+http-equiv=["']refresh["'][^>]+content=["'][^"']*url=['"]?([^'"]+)['"]?/i.exec(html)
  return m ? m[1] : undefined
}

/** sec/sic_search: SIC codes, industry titles and reporting offices matching the query. */
export async function secSicSearch(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const query = typeof params.query === 'string' ? params.query : ''
  // The SIC code list changes rarely; refresh monthly.
  const fetchPage = (url: string) => cachedRequest(ctx, url, { kind: 'sec', headers: SEC_HEADERS, useCache: useCache(params), expireS: 3600 * 24 * 30 }) as Promise<string>
  let html = await fetchPage(SIC_URL)
  const moved = metaRefresh(html)
  if (moved && !/<table/i.test(html)) html = await fetchPage(new URL(moved, SIC_URL).href)

  const table = parse(html).querySelector('table')
  if (!table) return []
  const rows = table.querySelectorAll('tr').map((tr) => tr.querySelectorAll('th,td').map(cellText))
  const header = rows[0] ?? []
  const col = (name: string) => header.indexOf(name)
  const [sicAt, officeAt, industryAt] = [col('SIC Code'), col('Office'), col('Industry Title')]
  if (sicAt < 0 || officeAt < 0 || industryAt < 0) throw new Error(`Unexpected SIC code table header: ${header.join(', ')}`)
  const matches = containsIgnoreCase(query)
  const out: Row[] = []
  for (const r of rows.slice(1)) {
    if (!(matches(r[sicAt] ?? '') || matches(r[officeAt] ?? '') || matches(r[industryAt] ?? ''))) continue
    out.push({ sic: parseInt(r[sicAt]!, 10), industry: r[industryAt], office: r[officeAt] })
  }
  return out
}
