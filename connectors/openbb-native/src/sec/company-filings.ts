// sec/company_filings and equity/fundamental/filings, provider sec. Ported from openbb_sec/models/company_filings.py
// (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of DataFrames and pydantic models. Other
// routes (filing sections, proxy statements, MD&A) look filings up through `fetchCompanyFilings`.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { FORM_LIST } from './definitions.js'
import { HEADERS, cachedRequest, padCik, symbolMap } from './helpers.js'

export type CompanyFilingsQuery = {
  /** Upper-cased by the query model; a list is joined with commas. */
  symbol?: string | null
  cik?: string | null
  /** `YYYY-MM-DD`. */
  start_date?: string | null
  end_date?: string | null
  /** Comma-separated, as the query model normalises it. */
  form_type?: string | null
  limit?: number | null
  use_cache?: boolean
}

type Raw = Record<string, unknown>

const DAY_S = 24 * 3600

/** `SecCompanyFilingsQueryParams` as the handler gets them: validators applied, defaults filled. */
export function companyFilingsQuery(params: NativeParams): CompanyFilingsQuery {
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? v.split(',') : [])
  const symbols = list(params.symbol)
  const forms = list(params.form_type)
    .map((f) => f.trim())
    .filter(Boolean)
    .map((f) => (FORM_LIST.includes(f.toUpperCase()) ? f.toUpperCase() : f))
  return {
    symbol: symbols.length ? symbols.map((s) => s.toUpperCase()).join(',') : null,
    cik: params.cik === undefined || params.cik === '' ? null : String(params.cik),
    start_date: typeof params.start_date === 'string' && params.start_date ? params.start_date : null,
    end_date: typeof params.end_date === 'string' && params.end_date ? params.end_date : null,
    form_type: forms.length ? forms.join(',') : null,
    limit: params.limit === undefined || params.limit === null ? null : Number(params.limit),
    use_cache: params.use_cache === undefined ? true : Boolean(params.use_cache),
  }
}

/** `DataFrame.from_records(columns)`: a dict of equally long lists as a list of row dicts. */
function recordsOf(columns: unknown): Raw[] {
  if (!columns || typeof columns !== 'object') return []
  const entries = Object.entries(columns as Record<string, unknown[]>).filter(([, v]) => Array.isArray(v))
  const n = Math.max(0, ...entries.map(([, v]) => v.length))
  return Array.from({ length: n }, (_, i) => Object.fromEntries(entries.map(([k, v]) => [k, v[i]])))
}

/** `aextract_data`: the recent filings of a CIK plus, when asked for more, every older page. */
async function extractData(ctx: NativeCtx, query: CompanyFilingsQuery): Promise<Raw[]> {
  const useCache = query.use_cache ?? true
  if (query.symbol && !query.cik) {
    query.cik = await symbolMap(ctx, query.symbol.toLowerCase(), useCache)
    if (!query.cik) throw new Error(`CIK not found for symbol ${query.symbol}`)
  }
  if (query.cik === undefined || query.cik === null) throw new Error('CIK or symbol must be provided.')
  // The leading 0s need to be inserted but are typically removed from the data to store as an integer.
  if (query.cik.length !== 10) query.cik = padCik(query.cik)

  const data = (await cachedRequest(ctx, `https://data.sec.gov/submissions/CIK${query.cik}.json`, { headers: HEADERS, useCache, expireS: DAY_S })) as { filings?: { recent?: unknown; files?: { name: string }[] } }
  const results = data.filings ? recordsOf(data.filings.recent) : []
  const limit = query.limit
  // If there are lots of filings, there will be custom pagination.
  if ((limit && results.length >= 1000) || query.form_type != null || limit === 0) {
    const urls = (data.filings?.files ?? []).map((f) => `https://data.sec.gov/submissions/${f.name}`)
    const extra = await Promise.all(urls.map((url) => cachedRequest(ctx, url, { headers: HEADERS, useCache, expireS: DAY_S })))
    for (const result of extra) if (result) results.push(...recordsOf(result))
  }
  return results
}

const COLUMNS = ['reportDate', 'filingDate', 'acceptanceDateTime', 'act', 'form', 'items', 'primaryDocDescription', 'primaryDocument', 'accessionNumber', 'fileNumber', 'filmNumber', 'isInlineXBRL', 'isXBRL', 'size']

/**
 * `DataFrame(data, columns=…).astype(str)` for one column: a missing key is NaN ("nan"), a null is "None", and an
 * integer column with a gap becomes a float one ("1.0").
 */
function columnAsStrings(values: unknown[]): string[] {
  const numeric = values.some((v) => typeof v === 'number') && values.every((v) => typeof v === 'number' || v === null || v === undefined)
  if (numeric && values.some((v) => v === null || v === undefined)) return values.map((v) => (typeof v === 'number' ? (Number.isInteger(v) ? `${v}.0` : String(v)) : 'nan'))
  return values.map((v) => (v === undefined ? 'nan' : v === null ? 'None' : v === true ? 'True' : v === false ? 'False' : String(v)))
}

/** `to_datetime(col).dt.date`: ISO dates; an empty or "nan" cell is NaT. */
function toDate(s: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s.trim())
  return m ? m[1]! : null
}

/** Descending, NaT last (`sort_values(ascending=False)`). */
function compareDesc(a: string | null, b: string | null): number {
  if (a === b) return 0
  if (a === null) return 1
  if (b === null) return -1
  return a < b ? 1 : -1
}

/** `transform_data` (without the pydantic step): the rows `SecCompanyFilingsData` holds, keyed by OpenBB's field names. */
async function transformData(ctx: NativeCtx, query: CompanyFilingsQuery, data: Raw[]): Promise<Row[]> {
  // XOM got a new CIK in July 2026, so all historical filings are under the old CIK. This is special handling for the transition.
  if (query.symbol === 'XOM') {
    query.symbol = null
    query.cik = '0000034088'
    data.push(...(await extractData(ctx, query)))
  }
  if (data.length === 0) throw new Error(`No filings found for CIK ${query.cik}, or symbol ${query.symbol}`)
  const columns = Object.fromEntries(COLUMNS.map((c) => [c, columnAsStrings(data.map((d) => d[c]))])) as Record<string, string[]>
  let filings = data.map((_, i) => {
    const row = Object.fromEntries(COLUMNS.map((c) => [c, columns[c]![i]!])) as Record<string, string>
    return { row, reportDate: toDate(row.reportDate!), filingDate: toDate(row.filingDate!) }
  })
  filings = filings.map((f, i) => ({ ...f, i })).sort((a, b) => compareDesc(a.filingDate, b.filingDate) || compareDesc(a.reportDate, b.reportDate) || a.i - b.i)
  if (query.start_date) filings = filings.filter((f) => f.filingDate !== null && f.filingDate >= query.start_date!)
  if (query.end_date) filings = filings.filter((f) => f.filingDate !== null && f.filingDate <= query.end_date!)
  const baseUrl = `https://www.sec.gov/Archives/edgar/data/${parseInt(query.cik!, 10)}/`
  if (query.form_type) {
    const re = new RegExp(query.form_type.replaceAll('_', ' ').split(',').join('|'), 'i')
    filings = filings.filter((f) => re.test(f.row.form!))
  }
  if (query.limit) filings = filings.slice(0, query.limit)
  if (filings.length === 0) throw new Error('No filings were found using the filters provided.')
  return filings.map(({ row, reportDate, filingDate }) => {
    const accession = row.accessionNumber!
    return {
      filing_date: filingDate,
      report_type: row.form,
      report_url: `${baseUrl}${accession.replaceAll('-', '')}/${row.primaryDocument}`,
      report_date: reportDate,
      act: row.act,
      items: row.items,
      primary_doc_description: row.primaryDocDescription,
      primary_doc: row.primaryDocument,
      accession_number: accession,
      file_number: row.fileNumber,
      film_number: row.filmNumber,
      is_inline_xbrl: row.isInlineXBRL,
      is_xbrl: row.isXBRL,
      size: row.size,
      complete_submission_url: `${baseUrl}${accession}.txt`,
      filing_detail_url: `${baseUrl}${accession}-index.htm`,
      accepted_date: row.acceptanceDateTime,
    }
  })
}

/** The filings of a company or CIK, newest first: `SecCompanyFilingsFetcher.fetch_data`. Throws when there are none. */
export async function fetchCompanyFilings(ctx: NativeCtx, query: CompanyFilingsQuery): Promise<Row[]> {
  const q = { ...query }
  return transformData(ctx, q, await extractData(ctx, q))
}

export async function secCompanyFilings(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  return fetchCompanyFilings(ctx, companyFilingsQuery(params))
}
