// equity/fundamental/management_discussion_analysis, provider sec. Ported from
// openbb_sec/models/management_discussion_analysis.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead
// of pydantic models, pandas date offsets as calendar arithmetic.
import type { NativeCtx, NativeParams, Row } from '../../types.js'
import { companyFilingsQuery, fetchCompanyFilings } from '../company-filings.js'
import { SEC_HEADERS, cachedRequest } from '../helpers.js'
import { htmlToMarkdown } from './html2markdown.js'
import { isDigit, split, strip, stripChars, splitLines } from './py.js'
import { mdaFromFullText } from './mda-full-text.js'

const raw = String.raw

/** OpenBB's `EmptyDataError`: the API answers it with 204 and no rows. */
class EmptyDataError extends Error {}

/** The filing list raises EmptyDataError (not OpenBBError) when it has nothing to list; that comes from company-filings.ts as a plain Error. */
const isNoFilings = (err: unknown): boolean => err instanceof Error && (err.message.startsWith('No filings found for CIK') || err.message.startsWith('No filings were found using the filters'))

type Filing = Row & { filing_date: string; report_type: string; report_url: string; filing_detail_url: string; report_date?: string | null }

/** The pandas `to_datetime("YYYYQn")` quarter: first and last day. */
function quarterBounds(year: number, quarter: number): { start: string; end: string } {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const startMonth = (quarter - 1) * 3 + 1
  const endMonth = startMonth + 2
  const lastDay = new Date(Date.UTC(year, endMonth, 0)).getUTCDate()
  return { start: `${String(year).padStart(4, '0')}-${pad(startMonth)}-01`, end: `${String(year).padStart(4, '0')}-${pad(endMonth)}-${pad(lastDay)}` }
}

const quarterOfDate = (d: string): number => Math.floor((parseInt(d.slice(5, 7), 10) - 1) / 3) + 1

/**
 * `_extract_exhibit_links`: parse a filing index page and return hrefs for rows whose Type cell starts with
 * *type_prefix* (e.g. ``EX-99``). The filing-index table has columns Seq | Description | Document (with <a href>) |
 * Type | Size; the TYPE label lives in the cell text, not in the href URL.
 */
function extractExhibitLinks(indexHtml: string, typePrefix = 'EX-99'): string[] {
  const results: string[] = []
  for (const rm of indexHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...rm[1]!.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => c[1]!)
    if (cells.length < 4) continue
    // Type is column index 3.
    const type = strip(cells[3]!.replace(/<[^>]+>/g, ''))
    if (!type.toUpperCase().startsWith(typePrefix.toUpperCase())) continue
    // Document column (index 2) has the <a href>.
    const hrefM = /<a\b[^>]*href="([^"]+)"/i.exec(cells[2]!)
    if (!hrefM) continue
    let href = hrefM[1]!
    // Strip XBRL inline viewer prefix.
    const ix = /^\/ix\?doc=(\/.+)/.exec(href)
    if (ix) href = ix[1]!
    results.push(href)
  }
  return results
}

const rsplitLast = (s: string): string => s.slice(s.lastIndexOf('/') + 1)
const isStr = (v: unknown): v is string => typeof v === 'string'

type Query = {
  symbol: string
  calendar_year: number | null
  calendar_period: string | null
  include_tables: boolean
  use_cache: boolean
  raw_html: boolean
}

type Extracted = {
  symbol: string
  calendar_year: number
  calendar_period: number
  period_ending: string
  report_type: string
  url: string
  content: string
  exhibit_content?: string
  exhibit_url?: string
  exhibit_is_full_document?: boolean
}

async function aextractData(ctx: NativeCtx, query: Query): Promise<Extracted> {
  const useCache = query.use_cache
  const fetchFilings = (params: Record<string, string | boolean>): Promise<Filing[]> => fetchCompanyFilings(ctx, companyFilingsQuery(params as NativeParams)) as Promise<Filing[]>
  /** `cached_request` with the SEC headers and `sec_callback`, as a string or null when it failed. */
  const fetchText = async (u: string): Promise<string | null> => {
    try {
      const r = await cachedRequest(ctx, u, { kind: 'sec', headers: SEC_HEADERS, useCache })
      return isStr(r) ? r : null
    } catch {
      return null
    }
  }

  // Get the company filings to find the URL.
  // Domestic issuers file 10-K (annual) / 10-Q (quarterly).
  // Foreign private issuers file 40-F or 20-F (annual) and
  // 6-K (current/quarterly).  Search for all applicable forms
  // and let the most-recent-filing logic pick the right one.
  const formTypes = '10-K,10-Q,40-F,20-F'
  const numeric = /^\p{N}+$/u.test(query.symbol)
  let filings: Filing[]
  if ((query.symbol === 'BLK' && query.calendar_year && query.calendar_year < 2025) || numeric) {
    filings = await fetchFilings({ cik: query.symbol === 'BLK' ? '0001364742' : query.symbol, form_type: formTypes, use_cache: useCache })
  } else {
    filings = await fetchFilings({ symbol: query.symbol, form_type: formTypes, use_cache: useCache })
  }

  if (filings.length === 0) throw new Error(`Could not find any 10-K, 10-Q, 40-F, or 20-F filings for the symbol. -> ${query.symbol}`)

  // If no calendar year or period is provided, get the most recent filing.
  let targetFiling: Filing | null = null
  let calendarYear: number | null = null
  let calendarPeriod: number | null = null

  const isForeignIssuer = filings.some((f) => ['40-F', '20-F', '40-F/A', '20-F/A'].includes(f.report_type))
  const symOrCik = (): Record<string, string> => ({ symbol: numeric ? '' : query.symbol, cik: numeric ? query.symbol : '' })

  if (query.calendar_year === null && query.calendar_period === null) {
    targetFiling = filings[0]!
    // For foreign issuers the most-recent 10-K/10-Q/40-F/20-F
    // may be older than a 6-K that contains quarterly MD&A.
    // Check whether a newer 6-K with an MD&A exhibit exists.
    if (targetFiling && isForeignIssuer) {
      const sixKRecent = await fetchFilings({ ...symOrCik(), form_type: '6-K', use_cache: useCache })
      if (sixKRecent.length && sixKRecent[0]!.filing_date > targetFiling.filing_date) {
        // A more-recent 6-K exists.  Scan its index for
        // an EX-99 exhibit with MD&A content.
        const mdaRe = /(?:mda|md&a|quarterly|discussion)/i
        for (const sixKf of sixKRecent) {
          if (sixKf.filing_date <= targetFiling.filing_date) break // older than current pick; stop
          const idxHtml = await fetchText(sixKf.filing_detail_url)
          if (idxHtml === null) continue
          const ex99Hrefs = extractExhibitLinks(idxHtml, 'EX-99')
          for (const href of ex99Hrefs) {
            if (mdaRe.test(rsplitLast(href))) {
              targetFiling = sixKf
              break
            }
          }
          if (targetFiling.report_type === '6-K') break
        }

        // Second pass: filenames didn't match.  Read the
        // 6-K cover page for exhibit descriptions like
        // "Q4 2025 Update", "Letter to Shareholders", etc.
        if (targetFiling.report_type !== '6-K') {
          const coverRe = /Q[1-4]\s+\d{4}\s+Update|Letter\s+to\s+Shareholders|Shareholder\s+Letter|Earnings\s+(?:Release|Update)|Quarterly\s+(?:Report|Update|Results)/i
          for (const sixKf of sixKRecent) {
            if (sixKf.filing_date <= targetFiling.filing_date) break
            const coverHtml = await fetchText(sixKf.report_url)
            if (coverHtml !== null && coverRe.test(coverHtml)) {
              targetFiling = sixKf
              break
            }
          }
        }
      }
    }

    // Domestic issuer: check for a more-recent 8-K that
    // contains earnings results (EX-99 exhibit) filed after
    // the latest 10-K/10-Q.  This covers the gap between
    // the earnings announcement and the formal 10-K/Q filing.
    if (targetFiling && !isForeignIssuer) {
      const eightKRecent = await fetchFilings({ ...symOrCik(), form_type: '8-K', use_cache: useCache })
      if (eightKRecent.length && eightKRecent[0]!.filing_date > targetFiling.filing_date) {
        // Item 2.02 = "Results of Operations and Financial
        // Condition" — the standard 8-K item for earnings.
        const eightKEarningsRe = /Item\s+2\.02|Results\s+of\s+Operations\s+and\s+Financial\s+Condition|Earnings\s+(?:Release|Press\s+Release|Update)|Financial\s+Results|Press\s+Release.*(?:Quarter|Annual|Fiscal)/i
        for (const eightKf of eightKRecent) {
          if (eightKf.filing_date <= targetFiling.filing_date) break // older than current 10-K/Q; stop
          // Check filing index for EX-99 exhibits.
          const idxHtml = await fetchText(eightKf.filing_detail_url)
          if (idxHtml === null) continue
          const ex99Hrefs = extractExhibitLinks(idxHtml, 'EX-99')
          if (ex99Hrefs.length === 0) continue
          // Read the 8-K filing for Item 2.02 or
          // earnings-related language.
          const coverHtml = await fetchText(eightKf.report_url)
          if (coverHtml !== null && eightKEarningsRe.test(coverHtml)) {
            targetFiling = eightKf
            break
          }
        }
      }
    }
  }

  if (!targetFiling) {
    if (query.calendar_period && !query.calendar_year) {
      const now = ctx.now()
      calendarYear = now.getUTCFullYear()
      calendarPeriod = Math.floor(now.getUTCMonth() / 3) + 1
    } else if (query.calendar_year && query.calendar_period) {
      calendarYear = query.calendar_year
      calendarPeriod = parseInt(query.calendar_period[1]!, 10)
    } else if (query.calendar_year) {
      calendarYear = query.calendar_year
      calendarPeriod = 1
    }

    if (query.calendar_year && !query.calendar_period) {
      let matches = filings.filter((f) => ['10-K', '40-F', '20-F', '40-F/A', '20-F/A'].includes(f.report_type) && parseInt(f.filing_date.slice(0, 4), 10) === query.calendar_year)
      if (matches.length === 0) matches = filings.filter((f) => parseInt(f.filing_date.slice(0, 4), 10) === query.calendar_year)
      if (matches.length) targetFiling = matches[0]!
    } else if (calendarYear && calendarPeriod) {
      const { start: startDate, end: endDate } = quarterBounds(calendarYear, calendarPeriod)
      for (const filing of filings) {
        if (startDate < filing.filing_date && filing.filing_date < endDate) {
          targetFiling = filing
          break
        }
      }
    }
  }

  // For foreign private issuer quarterly reports (6-K), the filing
  // list above only covers 10-K/10-Q/40-F/20-F.  When no match
  // was found for a specific quarter AND the issuer files foreign
  // forms, search 6-K filings for a quarterly report instead.
  //
  // Foreign issuers file many 6-Ks (press releases, certifications,
  // etc.).  Only a few contain quarterly results.  Strategy:
  //   1. Collect 6-Ks in the target date range.
  //   2. For each candidate, check the filing index page for an
  //      EX-99 exhibit whose filename suggests MD&A content
  //      (e.g. contains "mda", "md&a", or "quarterly").
  //   3. If none match by filename, fall back to the first 6-K
  //      whose EX-99 exhibit HTML contains "Discussion and Analysis".
  if (!targetFiling && isForeignIssuer && calendarYear && calendarPeriod) {
    const sixKFilings = await fetchFilings({ ...symOrCik(), form_type: '6-K', use_cache: useCache })
    if (sixKFilings.length) {
      const { start: sixKStart, end: sixKEnd } = quarterBounds(calendarYear, calendarPeriod)
      const candidates = sixKFilings.filter((f) => sixKStart <= f.filing_date && f.filing_date <= sixKEnd)

      // Try each candidate's filing index for an MD&A exhibit.
      const mdaFnameRe = /(?:mda|md&a|quarterly|discussion)/i

      const sixKWithEx99: Filing[] = []
      for (const sixKf of candidates) {
        const idxHtml = await fetchText(sixKf.filing_detail_url)
        if (idxHtml === null) continue
        // Parse the filing index table for EX-99
        // exhibit links (using the Type cell, not the
        // href URL which may not contain 'ex99').
        const ex99Hrefs = extractExhibitLinks(idxHtml, 'EX-99')
        for (const href of ex99Hrefs) {
          if (mdaFnameRe.test(rsplitLast(href))) {
            targetFiling = sixKf
            break
          }
        }
        if (targetFiling) break
        if (ex99Hrefs.length) sixKWithEx99.push(sixKf)
      }

      // Second pass: filename didn't match but the 6-K has
      // EX-99 exhibits.  Read the actual 6-K cover page —
      // it describes the exhibits (e.g. "Q4 2025 Update",
      // "Letter to Shareholders", "Earnings Release").
      if (!targetFiling && sixKWithEx99.length) {
        const coverDescRe = /Q[1-4]\s+\d{4}\s+Update|Letter\s+to\s+Shareholders|Shareholder\s+Letter|Earnings\s+(?:Release|Update)|Quarterly\s+(?:Report|Update|Results)/i
        for (const sixKf of sixKWithEx99) {
          const coverHtml = await fetchText(sixKf.report_url)
          if (coverHtml !== null && coverDescRe.test(coverHtml)) {
            targetFiling = sixKf
            break
          }
        }
      }
    }
  }

  // Domestic issuer 8-K fallback: when no 10-K/10-Q has been
  // filed yet for the requested quarter, the company may have
  // already published earnings via an 8-K press release (EX-99
  // exhibit).  Search 8-K filings in the target date range for
  // an earnings announcement.
  if (!targetFiling && !isForeignIssuer && calendarYear && calendarPeriod) {
    const eightKFilings = await fetchFilings({ ...symOrCik(), form_type: '8-K', use_cache: useCache })
    if (eightKFilings.length) {
      const { start: eightKStart, end: eightKEnd } = quarterBounds(calendarYear, calendarPeriod)
      const eightKCandidates = eightKFilings.filter((f) => eightKStart <= f.filing_date && f.filing_date <= eightKEnd)

      const earningsDescRe = /Q[1-4]\s+\d{4}\s+(?:Update|Results|Earnings)|Earnings\s+(?:Release|Press\s+Release|Update)|Press\s+Release|Quarterly\s+(?:Report|Update|Results)|(?:Financial|Operating)\s+Results|Results\s+(?:of|for)\s+Operations/i

      for (const eightKf of eightKCandidates) {
        const idxHtml = await fetchText(eightKf.filing_detail_url)
        if (idxHtml === null) continue
        const ex99Hrefs = extractExhibitLinks(idxHtml, 'EX-99')
        if (ex99Hrefs.length === 0) continue
        // Read the 8-K cover page for earnings description.
        const coverHtml = await fetchText(eightKf.report_url)
        if (coverHtml !== null && earningsDescRe.test(coverHtml)) {
          targetFiling = eightKf
          break
        }
      }
    }
  }

  if (!targetFiling) throw new Error(`Could not find a filing for the symbol -> ${query.symbol}`)

  const url = targetFiling.report_url
  const response = await cachedRequest(ctx, url, { kind: 'sec', headers: SEC_HEADERS, useCache })

  // Some 10-K filings have a stub Item 7 that simply
  // cross-references the Annual Report to Stockholders filed as
  // Exhibit 13.  When we detect this pattern we pre-fetch the
  // exhibit so that transform_data can extract MD&A from it.
  let exhibitContent: string | null = null
  let exhibitUrl: string | null = null
  let exhibitIsFullDocument = false

  if (isStr(response) && /incorporated\s+(?:herein\s+by\s+reference|by\s+reference\s+herein)/i.test(response)) {
    const baseDir = url.slice(0, url.lastIndexOf('/'))

    // Strategy 1: look for an inline exhibit link in the HTML
    // (modern filings embed <a href="...">Annual Report to
    // Security Holders</a>).
    const arRe = /<a\b[^>]*href="([^"]+)"[^>]*>[^<]*Annual\s+Report\s+to\s+(?:Security|Stock|Share)\s*[Hh]olders[^<]*<\/a>/i
    let mHref: string | null = arRe.exec(response)?.[1] ?? null

    // Strategy 2: fall back to the filing index page and look for
    // the EX-13 exhibit document (older filings).
    if (mHref === null) {
      try {
        const indexHtml = await cachedRequest(ctx, targetFiling.filing_detail_url, { kind: 'sec', headers: SEC_HEADERS, useCache })
        if (isStr(indexHtml)) {
          // Parse the filing index table for EX-13 rows.
          const ex13Hrefs = extractExhibitLinks(indexHtml, 'EX-13')
          if (ex13Hrefs.length) {
            const href = ex13Hrefs[0]!
            // Index page links are usually absolute paths
            if (href.startsWith('http')) mHref = href
            else if (href.startsWith('/')) mHref = 'https://www.sec.gov' + href
            else mHref = baseDir + '/' + href
          }
        }
      } catch {
        // Index page unavailable; proceed without exhibit
      }
    }

    if (mHref !== null) {
      const href = mHref
      exhibitUrl = href.startsWith('http') ? href : baseDir + '/' + href
      exhibitContent = (await cachedRequest(ctx, exhibitUrl, { kind: 'sec', headers: SEC_HEADERS, useCache })) as string
    }
  }

  // Foreign private issuer filings (40-F / 20-F) typically do not
  // contain an inline MD&A section.  Instead, the MD&A is filed as
  // a separate exhibit (usually EX-99.2).  When we detect a foreign
  // filing, browse the filing index page for EX-99 exhibit links,
  // fetch each candidate, and use the first one that contains
  // "Discussion and Analysis" text.
  //
  // The same logic applies to domestic 8-K earnings releases:
  // the actual content lives in an EX-99 exhibit.
  const hasExhibitContent = ['40-F', '20-F', '40-F/A', '20-F/A', '6-K', '8-K'].includes(targetFiling.report_type)

  if (isStr(response) && hasExhibitContent && !exhibitContent) {
    const baseDir = url.slice(0, url.lastIndexOf('/'))
    const indexHtml = await fetchText(targetFiling.filing_detail_url)

    if (indexHtml !== null) {
      // Parse the filing index table for EX-99 exhibit
      // links using the Type cell (the href URL itself
      // may not contain 'ex99' in the filename).
      const rawHrefs = extractExhibitLinks(indexHtml, 'EX-99')
      const ex99Links: string[] = []
      for (const href99 of rawHrefs) {
        let abs99: string
        if (href99.startsWith('http')) abs99 = href99
        else if (href99.startsWith('/')) abs99 = 'https://www.sec.gov' + href99
        else abs99 = baseDir + '/' + href99
        if (!ex99Links.includes(abs99)) ex99Links.push(abs99)
      }

      // Fetch each exhibit and remember the HTML so we can
      // do a multi-pass match without re-downloading.
      const fetchedExhibits: [string, string][] = []
      for (const exUrl of ex99Links) {
        const exHtml = await fetchText(exUrl)
        if (exHtml !== null) fetchedExhibits.push([exUrl, exHtml])
      }

      // `exhibit_content` is one of the fetched exhibits; remember which, as Python compares by identity.
      let chosen = -1

      // Two-pass approach: strong patterns first, weak
      // fallback second.  "MD&A" appears in many exhibits
      // (e.g. Annual Information Forms that merely mention
      // the abbreviation) so we must prefer exhibits whose
      // HTML contains the full section title.
      //
      // Pass 1 – strong: full "Management's Discussion and
      // Analysis" or "Operating and Financial Review" title.
      for (let n = 0; n < fetchedExhibits.length; n++) {
        const [exUrl, exHtml] = fetchedExhibits[n]!
        if (/(?:Management|MANAGEMENT).{0,10}(?:Discussion|DISCUSSION)\s+and\s+(?:Analysis|ANALYSIS)/.test(exHtml) || /(?:Operating|OPERATING)\s+and\s+Financial\s+Review/.test(exHtml)) {
          exhibitContent = exHtml
          exhibitUrl = exUrl
          chosen = n
          break
        }
      }

      // Pass 2 – weak fallback: "MD&A" abbreviation.
      if (!exhibitContent) {
        for (let n = 0; n < fetchedExhibits.length; n++) {
          const [exUrl, exHtml] = fetchedExhibits[n]!
          if (/MD&amp;A/.test(exHtml)) {
            exhibitContent = exHtml
            exhibitUrl = exUrl
            chosen = n
            break
          }
        }
      }

      // Pass 3 – 6-K / 8-K presentation slide deck or
      // shareholder update.  When both MD&A passes fail,
      // the exhibit may be a slide deck or quarterly update
      // that does NOT contain a dedicated MD&A section.
      // Read the cover page for exhibit descriptions and
      // check the exhibit HTML for slide-deck structure.
      if (!exhibitContent && (targetFiling.report_type === '6-K' || targetFiling.report_type === '8-K') && fetchedExhibits.length) {
        // (a) Slide-deck HTML fingerprint:
        //     <div class="slide"> wrapping <img> tags.
        for (let n = 0; n < fetchedExhibits.length; n++) {
          const [exUrl, exHtml] = fetchedExhibits[n]!
          if (/<div\b[^>]*\bclass="slide"/i.test(exHtml)) {
            exhibitContent = exHtml
            exhibitUrl = exUrl
            chosen = n
            exhibitIsFullDocument = true
            break
          }
        }

        // (b) The cover page describes the exhibit
        //     (e.g. "Q4 2025 Update", "Letter to
        //     Shareholders", "Earnings Release").
        if (!exhibitContent && isStr(response)) {
          const quarterlyDescRe = /Q[1-4]\s+\d{4}\s+Update|Letter\s+to\s+Shareholders|Shareholder\s+Letter|Earnings\s+(?:Release|Update)|Quarterly\s+(?:Report|Update|Results)|Press\s+Release|Financial\s+Results|Results\s+of\s+Operations/i
          if (quarterlyDescRe.test(response)) {
            const [exUrl, exHtml] = fetchedExhibits[0]!
            exhibitContent = exHtml
            exhibitUrl = exUrl
            chosen = 0
            exhibitIsFullDocument = true
          }
        }
      }

      // 8-K filings often split content across multiple
      // EX-99 exhibits (e.g. EX-99.1 = press release,
      // EX-99.2 = infographics / supplemental data).
      // Combine all fetched exhibits into one HTML blob so
      // the downstream converter gets the full picture.
      if (exhibitContent && targetFiling.report_type === '8-K' && fetchedExhibits.length > 1) {
        const extraParts: string[] = []
        fetchedExhibits.forEach(([, exHtml], n) => {
          if (n !== chosen) extraParts.push(exHtml)
        })
        // Wrap each extra exhibit so the converter
        // treats them as separate sections.
        for (const part of extraParts) exhibitContent += '\n<!-- additional exhibit -->\n' + part
      }
    }
  }

  if (isStr(response)) {
    const reportDate = targetFiling.report_date
    if (!reportDate) throw new Error("'NoneType' object has no attribute 'year'")
    const result: Extracted = {
      symbol: query.symbol,
      calendar_year: calendarYear ? calendarYear : parseInt(reportDate.slice(0, 4), 10),
      calendar_period: calendarPeriod ? calendarPeriod : quarterOfDate(reportDate),
      period_ending: reportDate,
      report_type: targetFiling.report_type,
      url,
      content: response,
    }
    if (exhibitContent && exhibitUrl) {
      result.exhibit_content = exhibitContent
      result.exhibit_url = exhibitUrl
      if (exhibitIsFullDocument) result.exhibit_is_full_document = true
    }
    return result
  }

  throw new Error(`Unexpected response received. Expected string and got -> ${typeof response}`)
}

/**
 * Normalize a mangled Table of Contents markdown table.
 *
 * Foreign-filer exhibits (and some domestic filings) include a
 * TOC rendered as an HTML table with colspan-driven multi-
 * column layouts.  The converter produces markdown rows with
 * varying column counts (4–7 cells per row).  This helper
 * detects the TOC table and re-builds it as a clean 4-column
 * table:  Page | Section | Page | Section.
 */
function normalizeTocTable(md: string): string {
  const m = /^\|[^\n]*Table\s+of\s+Contents[^\n]*\|/m.exec(md)
  if (!m) return md

  // Locate the full table block.
  let tocStart = m.index === 0 ? -1 : md.lastIndexOf('\n', m.index - 1)
  tocStart = tocStart >= 0 ? tocStart + 1 : m.index
  // Advance past the header line's trailing newline.
  let tocEnd = m.index + m[0].length
  const firstNl = md.indexOf('\n', tocEnd)
  if (firstNl >= 0) tocEnd = firstNl + 1
  while (tocEnd < md.length) {
    const nl = md.indexOf('\n', tocEnd)
    if (nl < 0) {
      tocEnd = md.length
      break
    }
    const nextLine = strip(md.slice(tocEnd, nl))
    if (nextLine.startsWith('|')) tocEnd = nl + 1
    else {
      tocEnd = nl
      break
    }
  }

  const tocBlock = md.slice(tocStart, tocEnd)
  const linkRe = /^\[([^\]]*)\]\((#[^)]*)\)/

  const newRows: [string, string, string, string][] = []
  for (const rawRow of splitLines(tocBlock)) {
    const tocRow = strip(rawRow)
    if (!tocRow.startsWith('|') || tocRow.startsWith('|---')) continue
    const cells = stripChars(tocRow, '|')
      .split('|')
      .map((c) => strip(c))
    if (cells.some((c) => c.includes('Table of Contents'))) continue

    // Pair up (page_link, section_name) from non-empty cells.
    const nonEmpty = cells.filter((c) => c)
    const pairs: [string, string][] = []
    let j = 0
    while (j < nonEmpty.length) {
      const val = nonEmpty[j]!
      if (linkRe.test(val) || isDigit(val)) {
        const sect = j + 1 < nonEmpty.length ? nonEmpty[j + 1]! : ''
        pairs.push([val, sect])
        j += 2
      } else {
        pairs.push(['', val])
        j += 1
      }
    }

    if (pairs.length === 1) newRows.push([pairs[0]![0], pairs[0]![1], '', ''])
    else if (pairs.length >= 2) newRows.push([pairs[0]![0], pairs[0]![1], pairs[1]![0], pairs[1]![1]])
  }

  if (newRows.length === 0) return md

  const tocLines = ['| Table of Contents | | | |', '|---|---|---|---|']
  for (const [p1, s1, p2, s2] of newRows) tocLines.push(`| ${p1} | ${s1} | ${p2} | ${s2} |`)
  tocLines.push('')
  return md.slice(0, tocStart) + tocLines.join('\n') + md.slice(tocEnd)
}

const RUNNING_HEADER_RE = /^Management.s\s+Discussion\s+and\s+Analysis\s+of\s+Financial\s+Condition\s+and\s+Results\s+of\s+Operations[^\n]*$\n?/gim
const TOC_BREADCRUMB_RE = /^\[(?:Financial\s+)?Table\s+of\s+Contents\]\(#[^)]+\)[^\n]*$\n?/gim

type MdaRow = Extracted & { content: string; exhibit_content?: string }

function toRow(data: Extracted): Row {
  const row: Row = { ...data }
  return row
}

async function transformData(ctx: NativeCtx, query: Query, data: Extracted): Promise<Row> {
  if (query.raw_html === true) return toRow(data)

  const filingHtml = data.content ?? ''
  const baseUrl = data.url ?? ''
  const reportType = data.report_type ?? ''
  const isQuarterly = reportType.endsWith('Q')
  const is20f = reportType === '20-F' || reportType === '20-F/A'

  // Convert the full HTML filing to markdown.
  let markdown = htmlToMarkdown(filingHtml, { baseUrl, keepTables: query.include_tables })

  if (!markdown) {
    throw new EmptyDataError(`No content was found in the filing after HTML-to-Markdown conversion. -> ${data.url ?? ''} -> The content can be analyzed by setting \`raw_html=True\` in the query.`)
  }

  // Strip leftover HTML anchor tags that the converter may leave
  // (e.g. <a id="item_2_management"></a>).  These interfere with
  // line-start-anchored regex matching.
  markdown = markdown.replace(/<a\s[^>]*>\s*<\/a>/g, '')
  // Strip leading "Table of Contents" breadcrumb links that XBRL
  // authoring tools (e.g. Workiva) insert at the start of every
  // section.  These are internal markdown links like
  //   [Table of Contents](#hash)
  // or split variants like [Tab](#hash)[le of Contents](#hash).
  // They prevent ^-anchored regex patterns from matching Item
  // headers reliably.
  markdown = markdown.replace(/^(?:\[[^\]]*\]\(#[^)]*\)\s*)+/gm, '')

  markdown = normalizeTocTable(markdown)

  const lines = splitLines(markdown)
  // Matches an Item 7 / Item 2 header for MD&A (the formal SEC item).
  const itemHeaderRe = new RegExp(raw`^(?:#{1,4}\s*)?(?:\*{1,2})?\s*(?:Part\s+(?:I{1,2}|1|2)[.\s,\-–—]*\s*)?(?:ITEM|Item)\s*(?:7|2)[.\s\-–—:]*(?:Management.s|MANAGEMENT.S)\s+Discussion`, 'i')
  // When we see a bare Item header we check the next non-blank line for the
  // MD&A title.
  const bareItemRe = new RegExp(raw`^(?:#{1,4}\s*)?(?:\*{1,2})?\s*(?:Part\s+(?:I{1,2}|1|2)[.\s,\-–—]*\s*)?(?:ITEM|Item)\s*(?:7|2)\s*[.\-–—:]*\s*$`, 'i')
  const mdaTitleRe = new RegExp(raw`^(?:#{1,4}\s*)?(?:\*{1,2})?\s*(?:Management.s|MANAGEMENT.S)\s+Discussion`, 'i')

  const standaloneMdaRe = new RegExp(raw`^(?:#{1,4}\s*)?\*{0,2}\s*(?:Management.s|MANAGEMENT.S)\s+Discussion\s+and\s+Analysis`, 'i')

  // -- 20-F: Item 5 "Operating and Financial Review and Prospects" --
  // Foreign private issuers filing on Form 20-F use Item 5 instead
  // of Item 7 for the MD&A-equivalent section.
  const item5HeaderRe = new RegExp(raw`^(?:#{1,4}\s*)?(?:\*{1,2})?\s*(?:Part\s+(?:I{1,2}|1|2)[.\s,\-–—]*\s*)?(?:ITEM|Item)\s*5[.\s\-–—:]*(?:Operating|OPERATING)\s+and\s+Financial\s+Review`, 'i')
  const bareItem5Re = new RegExp(raw`^(?:#{1,4}\s*)?(?:\*{1,2})?\s*(?:Part\s+(?:I{1,2}|1|2)[.\s,\-–—]*\s*)?(?:ITEM|Item)\s*5\s*[.\-–—:]*\s*$`, 'i')
  const item5TitleRe = new RegExp(raw`^(?:#{1,4}\s*)?(?:\*{1,2})?\s*(?:Operating|OPERATING)\s+and\s+Financial\s+Review`, 'i')
  const standaloneItem5Re = new RegExp(raw`^(?:#{1,4}\s*)?\*{0,2}\s*(?:Operating|OPERATING)\s+and\s+Financial\s+Review\s+and\s+Prospects`, 'i')

  // Any Item header (to detect section boundaries).
  const anyItemRe = /^(?:#{1,4}\s*)?\*{0,2}\s*(?:ITEM|Item)\s*\d/i

  // End-of-section patterns.
  const endPatternsQuarterly = [new RegExp(raw`^(?:#{1,4}\s*)?\*{0,2}\s*(?:ITEM|Item)\s*(?:3|4)[.\s\-–—:]`, 'i'), /^(?:#{1,4}\s*)?\*{0,2}\s*SIGNATURES/i]

  const endPatternsAnnual = [
    new RegExp(raw`^(?:#{1,4}\s*)?\*{0,2}\s*(?:ITEM|Item)\s*(?:7A|8)[.\s\-–—:]`, 'i'),
    /^(?:#{1,4}\s*)?\*{0,2}\s*(?:Financial\s+Statements\s+and\s+Supplementary\s+Data|FINANCIAL\s+STATEMENTS)/i,
    /^(?:#{1,4}\s*)?\*{0,2}\s*SIGNATURES/i,
    /^(?:#{1,4}\s*)?\*{0,2}\s*PART\s+IV/i,
  ]

  // 20-F end patterns: Item 6 ("Directors, Senior Management …"),
  // SIGNATURES, or PART III/IV mark the end of Item 5.
  const endPatterns20f = [new RegExp(raw`^(?:#{1,4}\s*)?\*{0,2}\s*(?:ITEM|Item)\s*(?:6)[.\s\-–—:]`, 'i'), /^(?:#{1,4}\s*)?\*{0,2}\s*SIGNATURES/i, /^(?:#{1,4}\s*)?\*{0,2}\s*PART\s+(?:III|IV)/i]

  const endPatterns = is20f ? endPatterns20f : isQuarterly ? endPatternsQuarterly : endPatternsAnnual

  // Select active header patterns based on filing type.
  // 20-F uses Item 5 / "Operating and Financial Review";
  // 10-K / 10-Q use Item 7/2 / "Management's Discussion".
  const activeHeaderRe = is20f ? item5HeaderRe : itemHeaderRe
  const activeBareRe = is20f ? bareItem5Re : bareItemRe
  const activeTitleRe = is20f ? item5TitleRe : mdaTitleRe
  const activeStandaloneRe = is20f ? standaloneItem5Re : standaloneMdaRe

  /** Find the end line index for a section starting at *start*. */
  const findEnd = (start: number): number => {
    let bodyLines = 0
    for (let j = start + 1; j < lines.length; j++) {
      const stripped = strip(lines[j]!)
      if (!stripped) continue
      bodyLines++
      if (bodyLines > 15) {
        for (const pat of endPatterns) if (pat.test(stripped)) return j
      }
    }
    return lines.length
  }

  const crossrefRe = /see\s+(?:the\s+)?(?:information|discussion)|(?:is|are)\s+(?:presented|included|incorporated)\s+(?:in|by)|incorporated\s+herein\s+by\s+reference|(?:refer|refers)\s+to\s+(?:Item|Part|the\s+section|pages?\s+\d)|included\s+(?:elsewhere|herein|in\s+(?:Part|Item))|set\s+forth\s+(?:in|under|below)|appears?\s+on\s+page|begins?\s+on\s+page|found\s+(?:on|in)\s+(?:page|section)|(?:should|must)\s+be\s+read\s+in\s+conjunction|contained\s+(?:in|on)\s+page|(?:is|are)\s+(?:set\s+forth|described|discussed)\s+(?:in|on|under)/i

  /**
   * Return True if the section at *start* is a stub / cross-ref.
   *
   * A stub is a very short section (< 500 chars of body text) that
   * either contains a cross-reference phrase or is immediately
   * followed by another Item header with no real body content.
   */
  const isStub = (start: number): boolean => {
    // Gather text until the next Item header or end of document.
    const bodyChars: string[] = []
    for (let j = start + 1; j < Math.min(start + 30, lines.length); j++) {
      const stripped = strip(lines[j]!)

      if (!stripped) continue
      // Hit another Item header → the section between is the body.

      if (anyItemRe.test(stripped)) break
      bodyChars.push(stripped)
    }

    const bodyText = bodyChars.join(' ')
    // If the body is substantial, it's not a stub.
    if (bodyText.length > 500) return false
    // Short body — check for cross-reference language.
    if (crossrefRe.test(bodyText)) return true
    // Very short body with no cross-ref — still a stub if nearly empty.
    return bodyText.length < 100
  }

  // -- main extraction --------------------------------------------------

  // Strategy:
  //  1. Find all Item header matches (Item 7/2 for 10-K/Q,
  //     Item 5 for 20-F).
  //  2. For each, check body length to determine stub vs real.
  //  3. If all are stubs, fall back to standalone heading.

  let bestStart: number | null = null
  let bestEnd: number | null = null
  let stubAnchorId: string | null = null

  for (let i = 0; i < lines.length; i++) {
    const stripped = strip(lines[i]!)

    if (!stripped) continue

    if (activeHeaderRe.test(stripped)) {
      if (isStub(i)) {
        // Check for an internal anchor link pointing to
        // the actual MD&A content elsewhere in the same
        // filing (e.g., in a "Financial Section").
        if (!stubAnchorId) {
          let am = /\[[^\]]*\]\(#([^)]+)\)/.exec(stripped)
          if (!am) {
            for (let k = i + 1; k < Math.min(i + 5, lines.length); k++) {
              const ks = strip(lines[k]!)
              if (ks) {
                am = /\[[^\]]*\]\(#([^)]+)\)/.exec(ks)
                break
              }
            }
          }
          if (am) stubAnchorId = am[1]!
        }
        continue
      }
      bestStart = i
      bestEnd = findEnd(i)
      break
    }
    // Handle split headers: "Item 2." on one line, MD&A title on next.
    if (activeBareRe.test(stripped)) {
      // Look at the next non-blank line for the section title.
      for (let k = i + 1; k < Math.min(i + 4, lines.length); k++) {
        const nextStripped = strip(lines[k]!)

        if (!nextStripped) continue

        if (activeTitleRe.test(nextStripped) && !isStub(i)) {
          bestStart = i
          bestEnd = findEnd(i)
        }
        break // Only check up to the first non-blank line
      }

      if (bestStart !== null) break
    }
  }

  // Fallback: standalone section heading without Item number.
  if (bestStart === null) {
    for (let i = 0; i < lines.length; i++) {
      const stripped = strip(lines[i]!)

      if (!stripped) continue

      if (activeStandaloneRe.test(stripped) && !isStub(i)) {
        const candidateEnd = findEnd(i)
        const body = strip(lines.slice(i, candidateEnd).join('\n'))

        if (body.length > 200) {
          bestStart = i
          bestEnd = candidateEnd
          break
        }
      }
    }
  }

  // -- Internal cross-reference extraction --
  // Some filings (e.g., Chevron, ExxonMobil 10-K) place the full
  // MD&A in a "Financial Section" appended to the same document.
  // The formal Item 7 is a one-line stub such as:
  //   "Reference is made to [MD&A title](#anchor) in the
  //    Financial Section of this report."
  // Follow the embedded anchor link directly to the referenced
  // section in the raw HTML, extract it, and convert it.
  //
  // When a stub anchor is available the anchor-based extraction
  // always takes priority.  The main markdown-level extraction
  // may also find a ``best_start`` inside the Financial Section,
  // but ``_find_end()`` cannot reliably determine the section
  // boundary because the Financial Section uses its own heading
  // structure (no Item 7A / Item 8 headers).  The anchor-based
  // path reads the Table of Contents that precedes the Financial
  // Section and uses its anchor IDs to cut precisely.
  if (stubAnchorId) {
    const anchorTag = `id="${stubAnchorId}"`
    const anchorPos = filingHtml.indexOf(anchorTag)
    if (anchorPos >= 0) {
      // Skip past the closing '>' of the anchor element.
      const gt = filingHtml.indexOf('>', anchorPos)
      const start = gt >= 0 ? gt + 1 : anchorPos
      const remainder = filingHtml.slice(start)

      // ── Locate the end of the MD&A section ──────────────
      // The remainder begins with a Financial Table of
      // Contents whose <a href="#anchor"> links enumerate
      // every section.  Parse those links and find the first
      // anchor whose title indicates a post-MD&A section
      // (financial statements, auditor reports, etc.).
      // Cutting at the target anchor's ``id="…"`` attribute
      // is far more reliable than regex-matching section
      // titles in raw HTML (which may appear inside TOC
      // links, cross-references, etc.).
      const hrefRe = /href="#([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
      const postMdaPats = [/Consolidated\s+Financial\s+Statements/i, /Reports?\s+of\s+Management/i, /Report\s+of\s+Independent\s+Registered/i, /To\s+the\s+(?:Stockholders|Shareholders|Board)/i, /Financial\s+Statements\s+and\s+Supplementary/i, /Changes\s+in\s+and\s+Disagreements/i]

      // Scan the TOC area (first ~80 KB should be enough).
      const tocChunk = remainder.slice(0, 80_000)
      let endAnchorId: string | null = null
      let startAnchorId: string | null = null
      const seenToc = new Set<string>()

      // Pattern to detect the MD&A section header in the TOC
      // so we can skip the TOC itself and start at the real
      // content.
      const mdaTitlePat = /Management.s\s+Discussion\s+and\s+Analysis/i

      for (const hm of tocChunk.matchAll(hrefRe)) {
        const aid = hm[1]!
        let rawText = hm[2]!.replace(/<[^>]+>/g, ' ')
        rawText = strip(rawText.replace(/\s+/g, ' '))
        for (const [ent, ch] of [
          ['&#8217;', '’'],
          ['&#x2019;', '’'],
          ['&rsquo;', '’'],
          ['&#160;', ' '],
          ['&amp;', '&'],
          ['&#8212;', '—'],
        ] as const) {
          rawText = rawText.replaceAll(ent, ch)
        }
        if (rawText.length < 4 || seenToc.has(aid)) continue
        seenToc.add(aid)

        // Track the first MD&A header anchor (to skip TOC).
        if (!startAnchorId && mdaTitlePat.test(rawText)) startAnchorId = aid

        for (const pp of postMdaPats) {
          if (pp.test(rawText)) {
            endAnchorId = aid
            break
          }
        }
        if (endAnchorId) break
      }

      // Determine HTML slice boundaries.
      // Back up to the opening '<' of the element that carries
      // the id attribute so we don't splice mid-tag and leak
      // raw attribute text into the markdown output.
      let htmlStart = 0
      if (startAnchorId) {
        const startTag = `id="${startAnchorId}"`
        const sp = remainder.indexOf(startTag)
        if (sp > 0) {
          const lt = remainder.lastIndexOf('<', sp - 1)
          htmlStart = lt >= 0 ? lt : sp
        }
      }

      let cut = remainder.length
      if (endAnchorId) {
        const endTag = `id="${endAnchorId}"`
        const endPos = remainder.indexOf(endTag)
        if (endPos > htmlStart) cut = endPos
      }

      let sectionMd = htmlToMarkdown(`<html><body>${remainder.slice(htmlStart, cut)}</body></html>`, { baseUrl, keepTables: query.include_tables })
      if (sectionMd && strip(sectionMd).length > 500) {
        // Strip repeated running page headers that appear
        // at the top of every page in the original filing
        // (e.g., CVX 10-K: "Management's Discussion …
        // [Financial Table of Contents](#anchor)").
        sectionMd = sectionMd.replace(RUNNING_HEADER_RE, '')
        // Strip standalone "[Financial Table of Contents](#…)"
        // or "[Table of Contents](#…)" breadcrumb lines.
        sectionMd = sectionMd.replace(TOC_BREADCRUMB_RE, '')
        return toRow({ ...data, content: strip(sectionMd) })
      }
    }
  }

  // -- Exhibit fallback: Annual Report / Foreign Filing Exhibits ---
  // When the main document only has a stub Item 7 (10-K) or is a
  // foreign private issuer filing (40-F / 20-F) whose MD&A lives
  // in a separately filed exhibit (EX-13 or EX-99.x),
  // aextract_data pre-fetched the exhibit HTML.
  if (bestStart === null && data.exhibit_content) {
    const exhibitBaseUrl = data.exhibit_url ?? ''
    let exhibitMd = htmlToMarkdown(data.exhibit_content, { baseUrl: exhibitBaseUrl, keepTables: query.include_tables })
    exhibitMd = exhibitMd.replace(/<a\s[^>]*>\s*<\/a>/g, '')
    exhibitMd = exhibitMd.replace(/^(?:\[[^\]]*\]\(#[^)]*\)\s*)+/gm, '')
    exhibitMd = normalizeTocTable(exhibitMd)
    const exhibitLines = splitLines(exhibitMd)
    const exhibitStartRe = /^(?:#{1,4}\s*)?\*{0,2}\s*(?:(?:Management|MANAGEMENT).{0,3}s?\s+(?:Discussion|DISCUSSION)|(?:Operating|OPERATING)\s+and\s+Financial\s+Review)/i
    const exhibitEndRe = /^(?:#{1,4}\s*)?\*{0,2}\s*(?:Management\s+Responsibility\s+for\s+Financial|Management.s\s+Report\s+on\s+Internal\s+Control|Report\s+of\s+(?:Management|Independent)|Consolidated\s+(?:Balance\s+Sheet|Statement|Financial)|Notes?\s+to\s+(?:Consolidated\s+)?Financial)/i

    for (let i = 0; i < exhibitLines.length; i++) {
      const estripped = strip(exhibitLines[i]!)
      if (!estripped || estripped.startsWith('|')) continue
      if (exhibitStartRe.test(estripped)) {
        let end = exhibitLines.length
        let bodyCount = 0
        for (let j = i + 1; j < exhibitLines.length; j++) {
          const sj = strip(exhibitLines[j]!)
          if (!sj) continue
          bodyCount++
          if (bodyCount > 15 && exhibitEndRe.test(sj)) {
            end = j
            break
          }
        }
        const content = strip(exhibitLines.slice(i, end).join('\n'))
        if (content.length > 200) return toRow({ ...data, content, url: exhibitBaseUrl })
      }
    }

    // Full-document fallback: 6-K presentation slide decks
    // and shareholder updates / earnings releases lack a
    // dedicated MD&A section.  Return the entire converted
    // exhibit content (with embedded markdown images).
    if (data.exhibit_is_full_document && exhibitMd && strip(exhibitMd).length > 100) return toRow({ ...data, content: strip(exhibitMd), url: exhibitBaseUrl })
  }

  if (bestStart === null) {
    const fallback = await mdaFromFullText(ctx, data.url ?? '', query.use_cache)
    if (fallback) return toRow({ ...data, content: fallback })
    throw new EmptyDataError(`Could not locate the MD&A section in the filing. -> ${data.url ?? ''} -> The content can be analyzed by setting \`raw_html=True\` in the query.`)
  }

  if (bestEnd === null) bestEnd = lines.length

  let mdaContent = strip(lines.slice(bestStart, bestEnd).join('\n'))

  // Strip repeated running page headers (see stub-path comment).
  mdaContent = mdaContent.replace(RUNNING_HEADER_RE, '')
  // Strip standalone "[Financial Table of Contents](#…)" breadcrumb lines.
  mdaContent = mdaContent.replace(TOC_BREADCRUMB_RE, '')

  if (!mdaContent) {
    throw new EmptyDataError(`The MD&A section appears to be empty after extraction. -> ${data.url ?? ''} -> The content can be analyzed by setting \`raw_html=True\` in the query.`)
  }

  // Ensure the section header has a markdown heading prefix and is
  // separated from any inline body text.  Many filings emit the
  // Item header as plain text (no <h1>/<h2> tag), so the converter
  // never inserts a '#' prefix.
  //
  // Detection strategy: ALL-CAPS words at the start of the content
  // form the section title (e.g. "ITEM 2. MANAGEMENT'S DISCUSSION
  // AND ANALYSIS …").  The title may span multiple lines; it ends
  // at the first word containing a lowercase letter.
  const mdaHeadingRe = new RegExp(
    raw`^((?:Part\s+\S+[.\s,\-–—]*\s*)?Item\s+\d+\.?\s+(?:Management.s\s+Discussion\s+and\s+Analysis(?:\s+of\s+Financial\s+Condition\s+and\s+Results\s+of\s+Operations)?|Operating\s+and\s+Financial\s+Review(?:\s+and\s+Prospects)?))`,
    'i',
  )
  let mdaLines = splitLines(mdaContent)
  if (mdaLines.length) {
    const first = strip(mdaLines[0]!)
    if (!first.startsWith('#')) {
      // Collect words from the opening lines, noting where the
      // first lowercase word appears (= end of ALL-CAPS title).
      const allWords: string[] = []
      let linesConsumed = 0
      let splitIdx: number | null = null // index of first lowercase word

      for (let i = 0; i < Math.min(mdaLines.length, 6); i++) {
        const line = strip(mdaLines[i]!)
        if (!line) {
          linesConsumed = i + 1
          break
        }
        for (const w of split(line)) {
          if (/[a-z]/.test(w) && splitIdx === null) splitIdx = allWords.length
          allWords.push(w)
        }
        linesConsumed = i + 1
        if (splitIdx !== null) break
      }

      let titleText: string
      let bodyText: string
      if (splitIdx !== null) {
        titleText = allWords.slice(0, splitIdx).join(' ')
        bodyText = allWords.slice(splitIdx).join(' ')
      } else {
        titleText = allWords.join(' ')
        bodyText = ''
      }

      const isCapsTitle = !!titleText && /^ITEM\s+\d/.test(titleText)

      if (isCapsTitle) {
        const newLines = ['## ' + titleText, '']
        if (bodyText) newLines.push(bodyText)
        mdaLines = [...newLines, ...mdaLines.slice(linesConsumed)]
      } else if (/^Item\s+\d/i.test(first)) {
        const headingMatch = mdaHeadingRe.exec(first)
        const heading = headingMatch ? strip(headingMatch[1]!) : first
        const remainder = headingMatch ? strip(first.slice(headingMatch.index + headingMatch[0].length)) : ''
        const newLines = ['## ' + heading, '']
        if (remainder) newLines.push(remainder)
        mdaLines = [...newLines, ...mdaLines.slice(1)]
      }

      mdaContent = mdaLines.join('\n')
    }
  }

  return toRow({ ...data, content: mdaContent })
}

/** equity/fundamental/management_discussion_analysis, provider sec. */
export async function managementDiscussionAnalysis(params: NativeParams, ctx: NativeCtx): Promise<Row | Row[]> {
  const periodRaw = params.calendar_period
  const query: Query = {
    symbol: String(params.symbol ?? '').toUpperCase(),
    calendar_year: params.calendar_year === undefined || params.calendar_year === null || params.calendar_year === '' ? null : Number(params.calendar_year),
    calendar_period: typeof periodRaw === 'string' && periodRaw ? periodRaw : null,
    include_tables: params.include_tables === undefined ? true : Boolean(params.include_tables),
    use_cache: params.use_cache === undefined ? true : Boolean(params.use_cache),
    raw_html: params.raw_html === undefined ? false : Boolean(params.raw_html),
  }
  try {
    const data = await aextractData(ctx, query)
    return await transformData(ctx, query, data)
  } catch (err) {
    // EmptyDataError is "no rows" to the API (HTTP 204); every other failure is an error.
    if (err instanceof EmptyDataError || isNoFilings(err)) return []
    throw err
  }
}

export type { MdaRow }
