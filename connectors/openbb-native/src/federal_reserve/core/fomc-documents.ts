// economy/fomc_documents, provider federal_reserve. Ported from openbb_federal_reserve/models/fomc_documents.py and
// utils/fomc_documents.py (OpenBB Platform 5.0.0, Apache-2.0); modified: node-html-parser instead of BeautifulSoup,
// ctx.cache instead of the on-disk cache (the historical list is a JSON asset copied from OpenBB).
import { parse } from 'node-html-parser'
import type { NativeCtx, NativeParams, Row } from '../../types.js'
import historicalJson from './assets/fomc-historical-releases.json' with { type: 'json' }
import { DAY_MS, request, str } from './helpers.js'

type Doc = { date: string; doc_type: string; doc_format: string; url: string }

const DOCUMENT_TYPES = ['all', 'monetary_policy', 'minutes', 'projections', 'materials', 'press_release', 'press_conference', 'agenda', 'transcript', 'speaker_key', 'beige_book', 'teal_book', 'green_book', 'blue_book', 'red_book']
const HOME = 'https://www.federalreserve.gov'

/** `get_current_fomc_documents`: the links of an FOMC calendar page (plus the Beige Book page by default). */
async function currentDocuments(ctx: NativeCtx, url?: string): Promise<Doc[]> {
  const releases: Doc[] = []
  if (url === undefined) releases.push(...(await beigeBooks(ctx)))
  const page = url ?? `${HOME}/monetarypolicy/fomccalendars.htm`
  const html = await ctx.cache(`fed:fomc:${page}`, DAY_MS, () => ctx.http.text(page, request()))
  for (const link of parse(html).querySelectorAll('a')) {
    const href = link.getAttribute('href') ?? ''
    if (href.includes('/newsevents/pressreleases')) continue
    const fileUrl = href.startsWith(HOME) ? href : `${HOME}${href}`
    const parts = fileUrl.split('/')
    const date = (parts[fileUrl.endsWith('/default.htm') ? parts.length - 2 : parts.length - 1] ?? '').split('.')[0] ?? ''
    const m = /(\d{4})(\d{2})(\d{2})/.exec(date)
    if (!m) continue
    let docType = ''
    if (href.toLowerCase().includes('beige')) docType = 'beige_book'
    if (href.includes('files') && date.includes('monetary')) docType = 'monetary_policy'
    if (date.includes('fomcproj')) docType = 'projections'
    if (date.includes('fomcminutes')) docType = 'minutes'
    if (date.includes('fomcpresconf')) docType = 'press_conference'
    releases.push({ date: `${m[1]}-${m[2]}-${m[3]}`, doc_type: docType, doc_format: fileUrl.slice(fileUrl.lastIndexOf('.') + 1), url: fileUrl })
  }
  return releases.sort((a, b) => b.date.localeCompare(a.date))
}

function beigeBooks(ctx: NativeCtx): Promise<Doc[]> {
  return currentDocuments(ctx, `${HOME}/monetarypolicy/publications/beige-book-default.htm`)
}

export async function fomcDocuments(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const year = params.year === undefined || params.year === null || params.year === '' ? undefined : Number(params.year)
  const documentType = str(params, 'document_type') ?? 'all'
  if (!DOCUMENT_TYPES.includes(documentType)) throw new Error(`Invalid document type. Must be one of: ${DOCUMENT_TYPES.join(', ')}`)
  if (year !== undefined && !Number.isInteger(year)) throw new Error('Year must be an integer.')
  if (year && year < 1959) throw new Error('Year must be from 1959.')

  const historical = historicalJson as Doc[]
  let docs: Doc[]
  if (year) docs = year > 2024 ? await currentDocuments(ctx) : historical
  else docs = [...(await currentDocuments(ctx)), ...historical]

  const filtered = docs.filter((d) => (!year || Number(d.date.split('-')[0]) === year) && (documentType === 'all' || d.doc_type === documentType))
  if (filtered.length === 0) throw new Error('No FOMC documents found.')
  return filtered.sort((a, b) => b.date.localeCompare(a.date)).map((d) => ({ ...d }))
}
