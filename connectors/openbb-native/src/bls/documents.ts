// The BLS release-document routes (bls/cpi/documents, employment_situation/documents, real_earnings/documents,
// import_export/documents, jolts/documents, ppi/documents, productivity/documents), provider bls. Ported from
// openbb_bls/models/{cpi,empsit,realer,ximpim,jolts,ppi,productivity}_documents.py and utils/{cpi,empsit,realer,ximpim}
// _archive.py, jolts_catalog.py and productivity_catalog.py (OpenBB Platform 5.0.0, Apache-2.0); modified: one
// archive scraper for the four single-release surveys, node-html-parser instead of BeautifulSoup, pages memoised
// through ctx.cache.
import type { HTMLElement } from 'node-html-parser'
import type { NativeCtx, NativeHandler, NativeParams, Row } from '../types.js'
import { anchors, applyDateWindow, fetchPage, fetchPageOrNull, findAll, isoDate, parentWithTag, parseHtml, squish, str, stripChars, textOf } from './helpers.js'

const BLS = 'https://www.bls.gov'
const MIN_DATE = '0001-01-01'
const FORMAT_LABELS = ['', 'TXT', 'PDF', 'HTM', 'HTML']

/** Promote a BLS-relative href to an absolute URL (`_abs`). */
function absolute(href: string): string {
  if (href.startsWith('http')) return href
  return href.startsWith('/') ? `${BLS}${href}` : `${BLS}/${href}`
}

/** A real calendar date or null (`dateType(y, m, d)` raising ValueError). */
function validDate(y: number, m: number, d: number): string | null {
  const t = new Date(Date.UTC(y, m - 1, d))
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d && y >= 1 ? isoDate(y, m, d) : null
}

type Doc = Row & { name: string; url: string; category: string; date?: string | null; is_current?: boolean; release_code?: string }

/** The documents sort: current first, then newest, then by the tie-break columns, all descending (`sort(reverse=True)`). */
function sortDocuments(docs: Doc[], tieBreaks: readonly string[]): Row[] {
  const key = (d: Doc): (string | number)[] => [d.is_current ? 1 : 0, d.date || MIN_DATE, ...tieBreaks.map((k) => (d[k] as string | undefined) || '')]
  const sorted = [...docs].sort((a, b) => {
    const ka = key(a)
    const kb = key(b)
    for (let i = 0; i < ka.length; i++) {
      if (ka[i]! < kb[i]!) return 1
      if (ka[i]! > kb[i]!) return -1
    }
    return 0
  })
  return sorted.map(({ is_current: _c, ...rest }) => rest)
}

// ---------------------------------------------------------------------------------------------------------------
// CPI, Employment Situation, Real Earnings, Import/Export: one current PDF plus a monthly archive of PDFs.

type Release = { archiveUrl: string; currentPdf: string; code: string; currentTitle: string; fallbackTitle: string }

const RELEASES: Record<string, Release> = {
  'bls/cpi/documents': { archiveUrl: `${BLS}/bls/news-release/cpi.htm`, currentPdf: `${BLS}/news.release/pdf/cpi.pdf`, code: 'cpi', currentTitle: 'Consumer Price Index — current release', fallbackTitle: 'CPI release' },
  'bls/employment_situation/documents': { archiveUrl: `${BLS}/bls/news-release/empsit.htm`, currentPdf: `${BLS}/news.release/pdf/empsit.pdf`, code: 'empsit', currentTitle: 'Employment Situation — current release', fallbackTitle: 'Employment Situation release' },
  'bls/real_earnings/documents': { archiveUrl: `${BLS}/bls/news-release/realer.htm`, currentPdf: `${BLS}/news.release/pdf/realer.pdf`, code: 'realer', currentTitle: 'Real Earnings — current release', fallbackTitle: 'Real Earnings release' },
  'bls/import_export/documents': { archiveUrl: `${BLS}/bls/news-release/ximpim.htm`, currentPdf: `${BLS}/news.release/pdf/ximpim.pdf`, code: 'ximpim', currentTitle: 'U.S. Import and Export Price Indexes — current release', fallbackTitle: 'XIMPIM release' },
}

type ArchiveEntry = { date: string; title: string; url: string }

/** Every archived release PDF of the survey, newest first (`scrape_archive`). */
async function scrapeArchive(ctx: NativeCtx, rel: Release): Promise<ArchiveEntry[]> {
  const re = new RegExp(`^/news\\.release/archives/${rel.code}_(\\d{2})(\\d{2})(\\d{4})\\.pdf$`, 'i')
  const soup = parseHtml(await fetchPage(ctx, rel.archiveUrl))
  const titlesByPdf = new Map<string, string>()
  for (const { el, href } of anchors(soup)) {
    if (!re.test(href)) continue
    // Prefer the visible <li> list text; BLS aria-labels are sometimes stale while the list text carries the correct month.
    let title = ''
    const li = parentWithTag(el, 'li')
    if (li) {
      const liText = squish(textOf(li)).replace(/\(\s*(?:TXT|PDF|HTM|HTML)\s*\)/gi, '')
      title = stripChars(liText, ' -—')
    }
    if (FORMAT_LABELS.includes(title.toUpperCase())) {
      const aria = el.getAttribute('aria-label')
      if (aria) {
        let clean = aria.trim()
        for (const suffix of [' PDF', ' HTM', ' HTML']) {
          if (clean.toUpperCase().endsWith(suffix)) {
            clean = clean.slice(0, clean.length - suffix.length).trim()
            break
          }
        }
        title = clean
      }
    }
    if (FORMAT_LABELS.includes(title.toUpperCase())) title = squish(textOf(el))
    // When several anchors point at one PDF, keep the descriptive title rather than a bare "PDF" link.
    const existing = titlesByPdf.get(href)
    if (existing === undefined || FORMAT_LABELS.includes(existing.toUpperCase())) titlesByPdf.set(href, title)
  }
  const out: ArchiveEntry[] = []
  for (const [href, title] of titlesByPdf) {
    const m = re.exec(href)!
    const date = validDate(Number(m[3]), Number(m[1]), Number(m[2]))
    if (!date) continue
    out.push({ date, title: title || `${rel.fallbackTitle} ${date}`, url: `${BLS}${href}` })
  }
  return out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
}

function archiveDocuments(rel: Release): NativeHandler {
  return async (params: NativeParams, ctx: NativeCtx): Promise<Row[]> => {
    const category = str(params.category) ?? 'all'
    const archive = await scrapeArchive(ctx, rel)
    const latest = archive[0]?.date ?? null
    let out: Doc[] = []
    if (category === 'all' || category === 'current') out.push({ name: rel.currentTitle, url: rel.currentPdf, category: 'current', date: latest, is_current: true, format: 'pdf' })
    if (category === 'all' || category === 'archived') for (const e of archive) out.push({ name: e.title, url: e.url, category: 'archived', date: e.date, is_current: false, format: 'pdf' })
    out = applyDateWindow(out, str(params.start_date), str(params.end_date))
    if (out.length === 0) throw new Error(`No BLS ${rel.code} documents matched the requested filter.`)
    return sortDocuments(out, ['name'])
  }
}

// ---------------------------------------------------------------------------------------------------------------
// JOLTS: national and state releases with an archive page each.

type JoltsRelease = { code: string; category: string; title: string; pdfUrl: string; archiveIndexUrl: string }

const JOLTS_RELEASES: JoltsRelease[] = [
  { code: 'jolts', category: 'national', title: 'Job Openings and Labor Turnover Survey (JOLTS) — National', pdfUrl: `${BLS}/news.release/pdf/jolts.pdf`, archiveIndexUrl: `${BLS}/bls/news-release/jolts.htm` },
  { code: 'jltst', category: 'state', title: 'JOLTS — State estimates', pdfUrl: `${BLS}/news.release/pdf/jltst.pdf`, archiveIndexUrl: `${BLS}/bls/news-release/jltst.htm` },
]

type Archived = { code: string; date: string; title: string | null; htmlUrl: string | null; pdfUrl: string | null }
type ArchiveLink = { code: string; url: string; format: string; date: string; title: string | null; section?: string | null }

const DATED_HREF = /\/news\.release\/archives\/([a-z0-9]+)_(\d{2})(\d{2})(\d{4})\.(htm|html|pdf|xlsx|txt)$/i
const LINK_LABELS = ['HTML', 'PDF', 'XLSX', 'TXT']

/** One archive index page: every dated release link (`_scrape_archive_page` of jolts_catalog.py). */
async function joltsArchivePage(ctx: NativeCtx, url: string): Promise<ArchiveLink[]> {
  const page = await fetchPageOrNull(ctx, url)
  if (page === null) return []
  const soup = parseHtml(page)
  const seen = new Set<string>()
  const out: ArchiveLink[] = []
  for (const { el } of anchors(soup)) {
    const rawHref = el.getAttribute('href') ?? ''
    const m = DATED_HREF.exec(rawHref)
    if (!m) continue
    const code = m[1]!.toLowerCase()
    const date = validDate(Number(m[4]), Number(m[2]), Number(m[3]))
    if (!date) continue
    const key = `${code}\u0000${m[0]}`
    if (seen.has(key)) continue
    seen.add(key)
    const anchorText = squish(textOf(el))
    let title: string | null = null
    if (anchorText && !LINK_LABELS.includes(anchorText.toUpperCase())) title = anchorText
    else {
      let parent = el.parentNode as HTMLElement | null
      for (let i = 0; i < 3; i++) {
        if (!parent || !parent.tagName || ['BODY', 'HTML'].includes(parent.tagName)) break
        const stripped = squish(textOf(parent)).replace(/\s*\(\s*(?:HTML|PDF|XLSX|TXT)\s*\)\s*/gi, ' ').trim()
        if (stripped && !LINK_LABELS.includes(stripped.toUpperCase())) {
          title = stripped
          break
        }
        parent = parent.parentNode as HTMLElement | null
      }
    }
    out.push({ code, url: absolute(rawHref), format: m[5]!.toLowerCase(), date, title })
  }
  return out
}

/** Archived releases of one code, one entry per date (`scrape_archive`), newest first. */
function dedupeByDate(links: ArchiveLink[], htmlFormats: (f: string) => boolean = (f) => f === 'htm' || f === 'html'): Archived[] {
  const byDate = new Map<string, Archived>()
  for (const e of links) {
    let slot = byDate.get(e.date)
    if (!slot) {
      slot = { code: e.code, date: e.date, title: e.title, htmlUrl: null, pdfUrl: null }
      byDate.set(e.date, slot)
    }
    if (slot.title === null && e.title) slot.title = e.title
    if (e.format === 'pdf') slot.pdfUrl = e.url
    else if (htmlFormats(e.format)) slot.htmlUrl = e.url
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
}

async function joltsDocuments(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const category = str(params.category) ?? 'all'
  const codeFilter = (str(params.release_code) ?? '').trim().toLowerCase() || null
  const archives = new Map<string, Archived[]>()
  for (const rel of JOLTS_RELEASES) {
    const links = await joltsArchivePage(ctx, rel.archiveIndexUrl)
    archives.set(rel.code, dedupeByDate(links.filter((e) => e.code === rel.code)))
  }
  const latest = new Map<string, string>()
  for (const [code, list] of archives) for (const a of list) if (!latest.has(code) || a.date > latest.get(code)!) latest.set(code, a.date)

  let out: Doc[] = []
  if (['all', 'national', 'state'].includes(category)) {
    for (const rel of JOLTS_RELEASES) {
      if ((category === 'national' || category === 'state') && rel.category !== category) continue
      if (codeFilter && rel.code !== codeFilter) continue
      out.push({ name: rel.title, url: rel.pdfUrl, category: rel.category, release_code: rel.code, date: latest.get(rel.code) ?? null, is_current: true, format: 'pdf' })
    }
  }
  if (category === 'all' || category === 'archived') {
    const codes = codeFilter ? [codeFilter] : JOLTS_RELEASES.map((r) => r.code)
    for (const code of codes) {
      for (const a of archives.get(code) ?? []) {
        if (a.pdfUrl === null) continue
        out.push({ name: a.title || `${code} — ${a.date}`, url: a.pdfUrl, category: 'archived', release_code: code, date: a.date, is_current: false, format: 'pdf' })
      }
    }
  }
  out = applyDateWindow(out, str(params.start_date), str(params.end_date))
  if (out.length === 0) throw new Error('No BLS JOLTS documents matched the requested filter.')
  return sortDocuments(out, ['release_code', 'name'])
}

// ---------------------------------------------------------------------------------------------------------------
// PPI: the monthly detailed-report PDFs.

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const PPI_INDEX = `${BLS}/ppi/detailed-report/`
const PPI_PDF = /\/ppi\/detailed-report\/ppi-(?:detailed-report|tables)-([a-z]+)-(\d{4})\.pdf$/i

async function ppiDocuments(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const soup = parseHtml(await fetchPage(ctx, PPI_INDEX))
  const seen = new Set<string>()
  let docs: Doc[] = []
  for (const { href } of anchors(soup)) {
    const m = PPI_PDF.exec(href)
    if (!m) continue
    const month = MONTH_NAMES.findIndex((n) => n.toLowerCase() === m[1]!.toLowerCase()) + 1
    const year = Number(m[2])
    if (month === 0) continue
    const url = href.startsWith('http') ? href : `${BLS}${href}`
    if (seen.has(url)) continue
    seen.add(url)
    docs.push({ name: `PPI Detailed Report — ${MONTH_NAMES[month - 1]} ${year}`, url, category: 'detailed_report', date: isoDate(year, month, 1), format: 'pdf' })
  }
  docs.sort((a, b) => (a.date! < b.date! ? 1 : a.date! > b.date! ? -1 : 0))
  if (params.year !== undefined && params.year !== '') docs = docs.filter((d) => Number(d.date!.slice(0, 4)) === Number(params.year))
  if (docs.length === 0) throw new Error('No BLS PPI documents matched the requested filter.')
  return docs
}

// ---------------------------------------------------------------------------------------------------------------
// Productivity: current releases from the news-release index, archives from per-release archive pages.

const PRODUCTIVITY_INDEX = `${BLS}/productivity/news-releases.htm`
const NR_HREF = /^\/news\.release\/([a-z0-9]+)\.nr0\.htm$/i
const PDF_HREF = /^\/news\.release\/pdf\/([a-z0-9]+)\.pdf$/i

type ProductivityRelease = { code: string; category: string; title: string; pdfUrl: string }

async function productivityCatalog(ctx: NativeCtx): Promise<ProductivityRelease[]> {
  const text = await fetchPage(ctx, PRODUCTIVITY_INDEX)
  const lp = text.indexOf('id="lp"')
  const tfp = text.indexOf('id="tfp"')
  const end = text.indexOf('id="sch"')
  if (lp < 0 || tfp < 0 || end < 0) throw new Error('BLS productivity news-releases page layout changed — could not locate the LP/TFP/Schedule anchors.')
  const sections: [string, string][] = [
    ['labor_productivity', text.slice(lp, tfp)],
    ['total_factor_productivity', text.slice(tfp, end)],
  ]
  const out: ProductivityRelease[] = []
  const seenCodes = new Set<string>()
  for (const [category, chunk] of sections) {
    let current: ProductivityRelease | null = null
    for (const { el, href } of anchors(parseHtml(chunk))) {
      const inner = squish(textOf(el))
      const nr = NR_HREF.exec(href)
      if (nr) {
        const code = nr[1]!.toLowerCase()
        if (inner.toUpperCase() === 'HTML') continue
        if (seenCodes.has(code)) {
          current = null
          continue
        }
        seenCodes.add(code)
        current = { code, category, title: inner, pdfUrl: absolute(`/news.release/pdf/${code}.pdf`) }
        out.push(current)
        continue
      }
      const pdf = PDF_HREF.exec(href)
      if (pdf && current && pdf[1]!.toLowerCase() === current.code) current.pdfUrl = absolute(href)
    }
  }
  return out
}

/** Archive page and section of each productivity release (`_ARCHIVE_PAGE`). */
const PRODUCTIVITY_ARCHIVE: Record<string, [string, string | null]> = {
  prod2: [`${BLS}/bls/news-release/prod.htm`, null],
  prin: [`${BLS}/bls/news-release/prin.htm`, null],
  prin1: [`${BLS}/bls/news-release/prin.htm`, null],
  prin2: [`${BLS}/bls/news-release/prin.htm`, null],
  prin3: [`${BLS}/bls/news-release/home.htm`, 'tfp-detailed-industries'],
  prin4: [`${BLS}/bls/news-release/home.htm`, 'PRODSTATE'],
  prod3: [`${BLS}/bls/news-release/home.htm`, 'tfp'],
  prod5: [`${BLS}/bls/news-release/home.htm`, 'tfp-major-industries'],
}

async function productivityArchivePage(ctx: NativeCtx, url: string): Promise<ArchiveLink[]> {
  const page = await fetchPageOrNull(ctx, url)
  if (page === null) return []
  const soup = parseHtml(page)
  const titlesByUrl = new Map<string, string>()
  for (const { el, href } of anchors(soup)) {
    const text = squish(textOf(el))
    if (!text || text.length <= 4) continue
    const m = DATED_HREF.exec(href)
    if (m) titlesByUrl.set(m[0], text)
  }
  const seen = new Set<string>()
  let section: string | null = null
  const out: ArchiveLink[] = []
  for (const el of findAll(soup, ['h1', 'h2', 'h3', 'h4', 'a', 'span', 'div'])) {
    if (el.tagName !== 'A') {
      const id = el.getAttribute('id')
      if (id) section = id
      continue
    }
    const href = el.getAttribute('href') ?? ''
    if (!href) {
      const id = el.getAttribute('id')
      if (id) section = id
      continue
    }
    const m = DATED_HREF.exec(href)
    if (!m) continue
    const code = m[1]!.toLowerCase()
    const date = validDate(Number(m[4]), Number(m[2]), Number(m[3]))
    if (!date) continue
    const key = `${code}\u0000${m[0]}`
    if (seen.has(key)) continue
    seen.add(key)
    const ext = m[5]!.toLowerCase()
    out.push({ code, section, url: absolute(href), format: ['pdf', 'xlsx', 'txt'].includes(ext) ? ext : 'htm', date, title: titlesByUrl.get(m[0]) ?? null })
  }
  return out
}

async function productivityArchive(ctx: NativeCtx, code: string): Promise<Archived[]> {
  const location = PRODUCTIVITY_ARCHIVE[code.toLowerCase()]
  if (!location) return []
  const [url, section] = location
  const all = await productivityArchivePage(ctx, url)
  const candidates = all.filter((e) => e.code === code && (section === null || e.section === section))
  return dedupeByDate(candidates, () => true)
}

async function productivityDocuments(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const category = str(params.category) ?? 'all'
  const codeFilter = (str(params.release_code) ?? '').trim().toLowerCase() || null
  const catalog = await productivityCatalog(ctx)
  const archives = new Map<string, Archived[]>()
  const archiveOf = async (code: string): Promise<Archived[]> => {
    if (!archives.has(code)) archives.set(code, await productivityArchive(ctx, code))
    return archives.get(code)!
  }
  const latest = new Map<string, string>()
  for (const entry of catalog) for (const a of await archiveOf(entry.code)) if (!latest.has(entry.code) || a.date > latest.get(entry.code)!) latest.set(entry.code, a.date)

  let out: Doc[] = []
  if (['all', 'labor_productivity', 'total_factor_productivity'].includes(category)) {
    for (const entry of catalog) {
      if ((category === 'labor_productivity' || category === 'total_factor_productivity') && entry.category !== category) continue
      if (codeFilter && entry.code !== codeFilter) continue
      out.push({ name: entry.title, url: entry.pdfUrl, category: entry.category, release_code: entry.code, date: latest.get(entry.code) ?? null, is_current: true, format: 'pdf' })
    }
  }
  if (category === 'all' || category === 'archived') {
    const codes = codeFilter ? [codeFilter] : catalog.map((e) => e.code)
    for (const code of codes) {
      for (const a of await archiveOf(code)) {
        const url = a.pdfUrl ?? a.htmlUrl
        if (url === null) continue
        out.push({ name: a.title || `${code} — ${a.date}`, url, category: 'archived', release_code: code, date: a.date, is_current: false, format: a.pdfUrl ? 'pdf' : 'htm' })
      }
    }
  }
  out = applyDateWindow(out, str(params.start_date), str(params.end_date))
  if (out.length === 0) throw new Error('No BLS Productivity documents matched the requested filter.')
  return sortDocuments(out, ['release_code', 'name'])
}

export const documentRoutes: Record<string, NativeHandler> = {
  ...Object.fromEntries(Object.entries(RELEASES).map(([route, rel]) => [route, archiveDocuments(rel)] as const)),
  'bls/jolts/documents': joltsDocuments,
  'bls/ppi/documents': ppiDocuments,
  'bls/productivity/documents': productivityDocuments,
}
