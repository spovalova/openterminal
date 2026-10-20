// sec/latest_financial_reports, equity/discovery/latest_financial_reports and sec/full_text_search, provider sec.
// Ported from openbb_sec/models/latest_financial_reports.py and full_text_search.py (OpenBB Platform 5.0.0,
// Apache-2.0); modified: plain rows instead of pydantic models, ctx.now() for "today".
import type { NativeCtx, NativeParams, Row } from '../../types.js'
import { HEADERS, secResponse, urlencode } from '../helpers.js'

const REPORT_TYPE_CHOICES = ['1-K', '1-SA', '1-U', '10-D', '10-K', '10-KT', '10-Q', '10-QT', '20-F', '40-F', '6-K', '8-K']

/** A JSON response of the EDGAR full-text search index (`amake_request`: a status of 400 or more is an error). */
async function searchIndex(ctx: NativeCtx, url: string): Promise<unknown> {
  const res = await secResponse(ctx, url, { headers: HEADERS })
  if (res.status >= 400) throw new Error(`Failed to get SEC data: HTTP ${res.status} for ${url}`)
  return res.json()
}

type Hit = { _id: string; _source: Record<string, unknown> }
type SearchResponse = { hits?: { total?: { value?: number }; hits?: Hit[] } }

const pad2 = (n: number): string => String(n).padStart(2, '0')
const isoDate = (d: Date): string => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
/** Weekday as Python numbers it: Monday 0 … Sunday 6. */
const weekday = (d: Date): number => (d.getDay() + 6) % 7
const addDays = (d: Date, n: number): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)

const DEFAULT_FORMS =
  '1-K%2C1-SA%2C1-U%2C1-Z%2C1-Z-W%2C10-D%2C10-K%2C10-KT%2C10-Q%2C10-QT%2C11-K%2C11-KT%2C15-12B%2C15-12G%2C' +
  '15-15D%2C15F-12B%2C15F-12G%2C15F-15D%2C18-K%2C20-F%2C24F-2NT%2C25%2C25-NSE%2C40-17F2%2C40-17G%2C40-F%2C' +
  '6-K%2C8-K%2C8-K12G3%2C8-K15D5%2CABS-15G%2CABS-EE%2CANNLRPT%2CDSTRBRPT%2CN-30B-2%2CN-30D%2CN-CEN%2CN-CSR%2C' +
  'N-CSRS%2CN-MFP%2CN-MFP1%2CN-MFP2%2CN-PX%2CN-Q%2CNSAR-A%2CNSAR-B%2CNSAR-U%2CNT%2010-D%2CNT%2010-K%2C' +
  'NT%2010-Q%2CNT%2011-K%2CNT%2020-F%2CQRTLYRPT%2CSD%2CSP%2015D2'

function reportTypes(params: NativeParams): string | undefined {
  const v = params.report_type
  const list = Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? v.split(',') : []
  if (!list.length) return undefined
  for (const rpt of list) if (!REPORT_TYPE_CHOICES.includes(rpt)) throw new Error(`Invalid report type: ${rpt}. Choices: ${REPORT_TYPE_CHOICES.join(', ')}`)
  return list.join(',')
}

async function extractReports(ctx: NativeCtx, params: NativeParams): Promise<Hit[]> {
  const reportType = reportTypes(params)
  const today = ctx.now()
  let queryDate = typeof params.date === 'string' && params.date ? new Date(`${params.date}T00:00:00`) : new Date(today.getFullYear(), today.getMonth(), today.getDate())
  if (weekday(queryDate) > 4) queryDate = addDays(queryDate, -(weekday(queryDate) - 4))
  const forms = reportType ?? DEFAULT_FORMS
  const getUrl = (date: string, offset: number) => `https://efts.sec.gov/LATEST/search-index?dateRange=custom&category=form-cat1&startdt=${date}&enddt=${date}&forms=${forms}&count=100&from=${offset}`

  /** All hits for a single date, following pagination. */
  const fetchForDate = async (day: string): Promise<Hit[]> => {
    const out: Hit[] = []
    const response = (await searchIndex(ctx, getUrl(day, 0))) as SearchResponse
    if (!response || typeof response !== 'object' || Array.isArray(response)) throw new Error(`Unexpected data response. Expected dictionary, got ${typeof response}`)
    const hits = response.hits ?? {}
    const totalHits = hits.total?.value || 0
    if (hits.hits?.length) out.push(...hits.hits)
    while (out.length < totalHits) {
      let next: SearchResponse
      try {
        next = (await searchIndex(ctx, getUrl(day, out.length))) as SearchResponse
      } catch (err) {
        ctx.log(`Failed to get the next page of SEC data: ${err instanceof Error ? err.message : String(err)}`)
        break
      }
      const more = next.hits?.hits ?? []
      if (!more.length) break
      out.push(...more)
    }
    return out
  }

  // Filings are not submitted on weekends or market holidays. Step back to the most recent business day that actually has filings.
  let results: Hit[] = []
  for (let i = 0; i < 10; i++) {
    results = await fetchForDate(isoDate(queryDate))
    if (results.length) break
    queryDate = addDays(queryDate, -1)
    while (weekday(queryDate) > 4) queryDate = addDays(queryDate, -1)
  }
  if (!results.length && reportType === undefined) throw new Error('No data was returned.')
  if (!results.length) throw new Error(`No data was returned for form type ${reportType}.`)
  return results
}

function parseEntry(entry: Hit): Row {
  const source = entry._source ?? {}
  const ciksList = (source.ciks as string[] | undefined) ?? []
  const ciks = ciksList.length ? ciksList.join(',') : null
  const names: string[] = []
  const tickers: string[] = []
  const sics = ((source.sics as string[] | undefined) ?? []).join(',')
  for (const name of (source.display_names as string[] | undefined) ?? []) {
    const parts = name.split('(')
    if (parts.length < 2) throw new Error(`list index out of range: ${name}`)
    tickers.push(parts[1]!.split(')')[0]!.trim())
    names.push(parts[0]!.trim())
  }
  const reportType = source.form as string
  const id = entry._id
  const rootUrl = `https://www.sec.gov/Archives/edgar/data/${ciksList[0]}/${String(source.adsh).replaceAll('-', '')}/`
  const items = source.items as string[] | undefined
  const [accession, document] = id.split(':')
  return {
    filing_date: source.file_date,
    period_ending: source.period_ending,
    symbol: tickers.join(',').replaceAll(' ', ''),
    name: names.join(','),
    cik: ciks,
    sic: sics,
    report_type: reportType,
    description: source.file_description,
    items: items?.length ? items.join(',') : null,
    url: rootUrl + document,
    index_headers: `${rootUrl}${accession}-index-headers.html`,
    complete_submission: `${rootUrl}${accession}.txt`,
    metadata: reportType.startsWith('10-') || reportType.startsWith('8-') ? `${rootUrl}MetaLinks.json` : null,
    financial_report: reportType.startsWith('10-') || reportType.startsWith('8-') || ['N-CSR', 'QRTLYRPT', 'ANNLRPT'].includes(reportType) ? `${rootUrl}Financial_Report.xlsx` : null,
  }
}

/** sec/latest_financial_reports and equity/discovery/latest_financial_reports. */
export async function latestFinancialReports(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const data = await extractReports(ctx, params)
  // Some duplicates may exist in the data.
  const seen = new Set<string>()
  const results: Row[] = []
  for (const entry of data) {
    const parsed = parseEntry(entry)
    if (!seen.has(parsed.url as string)) {
      seen.add(parsed.url as string)
      results.push(parsed)
    }
  }
  return results
}

/** `_normalize_form_type`: a JSON-array string, a list or a comma-separated string, as EDGAR's comma-separated string. */
function normalizeFormType(v: unknown): string | undefined {
  let value = v
  if (typeof value === 'string') {
    const stripped = value.trim()
    if (stripped.startsWith('[') && stripped.endsWith(']')) {
      try {
        value = JSON.parse(stripped)
      } catch {
        return stripped || undefined
      }
    }
  }
  if (Array.isArray(value)) return value.map((i) => String(i).trim()).filter(Boolean).join(',') || undefined
  return typeof value === 'string' && value ? value : undefined
}

/** sec/full_text_search: EDGAR full-text search over filings since 2001. */
export async function fullTextSearch(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
  const query = str(params.query)
  const entity = str(params.entity)
  const category = str(params.category)
  const formType = normalizeFormType(params.form_type)
  const location = str(params.location)
  const startDate = str(params.start_date)
  const endDate = str(params.end_date)
  const limit = params.limit === undefined ? 100 : Number(params.limit)

  const forms = [category, formType].filter(Boolean).join(',')
  if (!(query || entity || forms || location || (startDate && endDate))) throw new Error('At least one search criterion is required.')

  const cap = limit || 100
  const results: Hit[] = []
  let offset = 0
  while (results.length < cap) {
    const search: Record<string, string | number> = { from: offset }
    if (query) search.q = query
    if (entity) search.entityName = entity
    if (forms) search.forms = forms
    if (location) search.locationCodes = location
    if (startDate && endDate) Object.assign(search, { dateRange: 'custom', startdt: startDate, enddt: endDate })
    const response = (await searchIndex(ctx, `https://efts.sec.gov/LATEST/search-index?${urlencode(search)}`)) as SearchResponse
    if (!response || typeof response !== 'object' || Array.isArray(response)) break
    const hitsObj = response.hits ?? {}
    const hits = hitsObj.hits ?? []
    if (!hits.length) break
    results.push(...hits)
    offset += hits.length
    if (offset >= (hitsObj.total?.value ?? 0)) break
  }
  const data = results.slice(0, cap)
  if (!data.length) throw new Error('No filings were found for the search criteria.')

  const out: Row[] = []
  const seen = new Set<string>()
  for (const hit of data) {
    const source = hit._source ?? {}
    const ciks = (source.ciks as string[] | undefined) ?? []
    const docId = hit._id ?? ''
    if (!ciks.length || !docId.includes(':')) continue
    const url = `https://www.sec.gov/Archives/edgar/data/${ciks[0]}/${String(source.adsh ?? '').replaceAll('-', '')}/${docId.split(':')[1]}`
    if (seen.has(url)) continue
    seen.add(url)
    const names: string[] = []
    const tickers: string[] = []
    for (const display of (source.display_names as string[] | undefined) ?? []) {
      names.push(display.split('(')[0]!.trim())
      for (const m of display.matchAll(/\(([^)]*)\)/g)) if (!m[1]!.toUpperCase().startsWith('CIK')) tickers.push(m[1]!.trim())
    }
    out.push({
      filing_date: source.file_date,
      form: source.form,
      name: names.filter(Boolean).join(', ') || null,
      symbol: tickers.filter(Boolean).join(', ') || null,
      cik: ciks.map((c) => c.replace(/^0+/, '') || c).join(', ') || null,
      description: source.file_description,
      url,
    })
  }
  return out
}
