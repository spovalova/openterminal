// Governance tables from proxy statements (DEF 14A), provider sec. Ported from openbb_sec/utils/proxy_statement.py
// (OpenBB Platform 5.0.0, Apache-2.0); modified: BeautifulSoup is the emulation in ../markdown/soup.ts, str(tag) is
// tag.decode(), and `resolve_proxy_url` reads the filings list through the shared company-filings port. The Python
// helpers `_table_from_section` and `management_profiles_table` are not used by any route and are not ported.
import type { NativeCtx } from '../../types.js'
import { companyFilingsQuery, fetchCompanyFilings } from '../company-filings.js'
import { convertTable, htmlToMarkdown } from '../markdown/html2markdown.js'
import { Tag, parse } from '../markdown/soup.js'
import { pyStrip, pySplitlines, spaceCollapse } from './py.js'

/** A tag attribute as a string, joining multi-valued attributes. */
function attr(tag: Tag, name: string): string {
  const value = tag.get(name)
  if (Array.isArray(value)) return value.join(' ')
  return value || ''
}

/**
 * The ownership source URL for a symbol: the latest DEF 14A, otherwise the latest 20-F/40-F annual filing of a foreign
 * private issuer. With a calendar year, a filing of that year wins when there is one.
 */
export async function resolveProxyUrl(ctx: NativeCtx, symbol: string, calendarYear: number | null, useCache: boolean): Promise<string | null> {
  const filings = await fetchCompanyFilings(ctx, companyFilingsQuery({ symbol, form_type: 'DEF_14A,20-F,40-F,20-F/A,40-F/A', use_cache: useCache }))
  const proxyRows: [string, string][] = []
  const foreignRows: [string, string][] = []

  for (const filing of filings) {
    const filingDate = String(filing.filing_date ?? '')
    const reportUrl = filing.report_url as string | undefined
    const reportType = String(filing.report_type || 'DEF_14A').toUpperCase()
    if (!reportUrl) continue
    if (reportType.startsWith('DEF 14A') || reportType.startsWith('DEF_14A')) proxyRows.push([filingDate, reportUrl])
    else if (reportType.startsWith('20-F') || reportType.startsWith('40-F')) foreignRows.push([filingDate, reportUrl])
  }

  /** `max(rows)[1]`: the greatest (date, url) pair. */
  const greatest = (rows: [string, string][]): string => {
    let best = rows[0]!
    for (const r of rows) if (r[0] > best[0] || (r[0] === best[0] && r[1] > best[1])) best = r
    return best[1]
  }
  const pick = (rows: [string, string][]): string | null => {
    if (rows.length === 0) return null
    if (calendarYear !== null) {
      const match = rows.filter(([d]) => d.slice(0, 4) === String(calendarYear))
      if (match.length) return greatest(match)
    }
    return greatest(rows)
  }

  return pick(proxyRows) ?? pick(foreignRows) ?? null
}

/** The lowercased, whitespace-collapsed text of a tag. */
const normalizedText = (tag: Tag): string => spaceCollapse(tag.getText(' ', true)).toLowerCase()

/** The first table whose lowercased text matches `predicate`, as markdown. */
function tableMarkdown(html: string, predicate: (text: string) => boolean): string {
  const soup = parse(html, 'html.parser')
  for (const table of soup.findAll('table')) {
    if (predicate(normalizedText(table))) return pyStrip(convertTable(table))
  }
  return ''
}

const STOP_RE = /^\s*(?:[A-Z]\.\s+|ITEM\s+\d+[A-Z]?)/i

function ownershipTableFromShareSection(html: string): string {
  const soup = parse(html, 'html.parser')
  const sectionRe = /^\s*(?:[A-Z]\.\s*)?(?:share\s+ownership|security\s+ownership\s+of\s+certain\s+beneficial\s+owners)\b/i

  for (const node of soup.findAllStrings({ string: sectionRe })) {
    const parent = node.parent
    if (!parent) continue

    const sectionTables: [string, string][] = []
    for (const nxt of findAllNext(parent)) {
      if (nxt.name === 'table') {
        const normalized = normalizedText(nxt)
        const markdown = pyStrip(convertTable(nxt))
        if (markdown) sectionTables.push([normalized, markdown])
      }
      const text = nxt.getText(' ', true)
      if (text && STOP_RE.test(text)) break
    }

    if (sectionTables.length === 0) continue

    for (let idx = 0; idx < sectionTables.length; idx++) {
      const [normalized, markdown] = sectionTables[idx]!
      const isMain =
        (normalized.includes('5% shareholder') || normalized.includes('5% shareholders') || normalized.includes('directors and executive officers')) &&
        (normalized.includes('voting power') || normalized.includes('beneficial ownership') || normalized.includes('percent'))
      if (!isMain) continue

      let content = markdown
      if (idx + 1 < sectionTables.length) {
        const [nextNormalized, nextMarkdown] = sectionTables[idx + 1]!
        if ((nextNormalized.includes('represents beneficial ownership') || nextNormalized.includes('voting power')) && (nextNormalized.includes('(1)') || nextNormalized.includes('*'))) content = `${content}\n\n${nextMarkdown}`
      }
      return content
    }
  }
  return ''
}

/** The tags that follow `tag` in document order (`find_all_next()`). */
function findAllNext(tag: Tag): Tag[] {
  const out: Tag[] = []
  const visit = (start: Tag): void => {
    for (const el of start.descendants()) if (el instanceof Tag) out.push(el)
  }
  visit(tag)
  for (let node: Tag = tag; node.parent; node = node.parent) {
    const siblings = node.parent.contents
    for (let i = siblings.indexOf(node) + 1; i < siblings.length; i++) {
      const sib = siblings[i]!
      if (sib instanceof Tag) {
        out.push(sib)
        visit(sib)
      }
    }
  }
  return out
}

/** The tags after `tag` among its parent's children (`find_next_siblings()`). */
function findNextSiblings(tag: Tag): Tag[] {
  const parent = tag.parent
  if (!parent) return []
  const siblings = parent.contents
  return siblings.slice(siblings.indexOf(tag) + 1).filter((s): s is Tag => s instanceof Tag)
}

/** The Summary Compensation Table (Reg S-K Item 402(c)) as markdown. */
export function summaryCompensationTable(html: string): string {
  return tableMarkdown(html, (t) => t.includes('salary') && t.includes('total') && t.includes('stock award') && t.includes('principal position') && t.includes('year'))
}

/** The security-ownership table that lists 5%+ beneficial owners. */
export function beneficialOwnersTable(html: string): string {
  const sectionTable = ownershipTableFromShareSection(html)
  if (sectionTable) return sectionTable

  return tableMarkdown(
    html,
    (t) =>
      ((t.includes('percent of class') || t.includes('percent of common stock') || t.includes('percent of common shares') || t.includes('percent of outstanding')) && (t.includes('beneficial owner') || t.includes('name and address') || t.includes('beneficially owned'))) ||
      ((t.includes('5% shareholders') || t.includes('5% shareholder')) && (t.includes('ownership') || t.includes('voting power') || t.includes('directors and executive officers'))),
  )
}

/** Director and officer profile information from a proxy statement. */
export function managementInformationFromProxy(html: string): string {
  const soup = parse(html, 'html.parser')
  const fullMarkdown = pyStrip(htmlToMarkdown(html, { keepTables: true }))

  const tocEntries = (): [string, string | null][] => {
    const entries: [string, string | null][] = []
    for (const table of soup.findAll('table')) {
      for (const row of table.findAll('tr')) {
        const cells = row.findAll(['td', 'th'])
        if (cells.length < 2) continue
        const firstCell = cells[0]!
        const lastCell = cells[cells.length - 1]!
        const pageText = pyStrip(spaceCollapse(lastCell.getText(' ', true)))
        if (!pageText || !/^(?:\d{1,3}|[A-Z]-\d+)$/.test(pageText)) continue
        const anchor = firstCell.find('a')
        let title: string
        let href: string
        if (anchor) {
          title = pyStrip(spaceCollapse(anchor.getText(' ', true)))
          href = pyStrip(attr(anchor, 'href'))
        } else {
          title = pyStrip(spaceCollapse(firstCell.getText(' ', true)))
          href = ''
        }
        if (title.length < 4) continue
        entries.push([title, href.startsWith('#') ? href : null])
      }
    }
    return entries
  }

  const extractManagementSectionFromTocAnchors = (entries: [string, string | null][]): string => {
    if (entries.length === 0) return ''

    const startMatchers = [/^\s*executive\s+officers\s*$/i, /^\s*directors\s*$/i, /\bnominees?\s+for\s+election\b/i, /\bnominees?\s+to\s+.*board\s+of\s+directors\b/i, /\bdirectors?\s+and\s+executive\s+officers\b/i]
    const stopRe = /\b(executive\s+compensation|compensation\s+discussion|management\s+proposals|shareholder\s+proposals|other\s+information)\b/i

    let startIdx = -1
    for (const matcher of startMatchers) {
      for (let i = 0; i < entries.length; i++) {
        const [title, href] = entries[i]!
        if (!href) continue
        if (!matcher.test(title)) continue
        const anchorId = href.slice(1)
        if (soup.find(null, { attrs: { id: anchorId } })) {
          startIdx = i
          break
        }
      }
      if (startIdx >= 0) break
    }
    if (startIdx < 0) return ''

    let endId: string | null = null
    for (const [title, href] of entries.slice(startIdx + 1)) {
      if (!href) continue
      if (stopRe.test(title)) {
        const candidateId = href.slice(1)
        if (soup.find(null, { attrs: { id: candidateId } })) {
          endId = candidateId
          break
        }
      }
    }

    const startHref = entries[startIdx]![1]!
    const startAnchor = soup.find(null, { attrs: { id: startHref.slice(1) } })
    if (startAnchor === null) return ''

    let startNode: Tag = startAnchor
    while (startNode.parent && !['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'div', 'table'].includes(startNode.name)) startNode = startNode.parent

    const sectionNodes: Tag[] = [startNode]
    for (const sib of findNextSiblings(startNode)) {
      if (endId && (sib.get('id') === endId || sib.find(null, { attrs: { id: endId } }))) break
      sectionNodes.push(sib)
    }

    const sectionHtml = pyStrip(sectionNodes.map((n) => n.decode()).join(''))
    return pyStrip(htmlToMarkdown(sectionHtml, { keepTables: true }))
  }

  const tocTitles = (): string[] => {
    const titles: string[] = []
    for (const table of soup.findAll('table')) {
      for (const row of table.findAll('tr')) {
        const cells = row.findAll(['td', 'th'])
        if (cells.length < 2) continue
        const first = pyStrip(spaceCollapse(cells[0]!.getText(' ', true)))
        const last = pyStrip(spaceCollapse(cells[cells.length - 1]!.getText(' ', true)))
        if (!first || !last) continue
        if (!/^\d{1,3}$/.test(last)) continue
        if (first.length < 6) continue
        titles.push(first)
      }
    }
    return titles
  }

  const extractManagementSectionFromMarkdown = (markdown: string, titles: string[]): string => {
    if (!markdown) return ''
    const lines = pySplitlines(markdown)

    const isTocLine = (line: string): boolean => {
      const stripped = pyStrip(line)
      const bare = stripped.replace(/^#{1,6}\s+/, '')
      return /\s\d{1,3}$/.test(bare)
    }

    const startPatterns = [/^directors$/i, /^executive\s+officers$/i, /nominees?\s+for\s+election/i, /nominees?\s+to\s+.*board\s+of\s+directors/i, /directors?\s+and\s+(?:executive\s+officers|senior\s+management)/i]
    const stopPattern = /\b(executive\s+compensation|compensation\s+discussion|pay\s+versus\s+performance|security\s+ownership|related\s+party|proposal\s+\d+|audit\s+committee|board\s+meetings\s+and\s+attendance|corporate\s+governance\s+framework)\b/i

    const isHeadingLike = (line: string): boolean => {
      const stripped = pyStrip(line)
      if (stripped.startsWith('#')) return true
      const bare = stripped.replace(/^#{1,6}\s+/, '')
      if (bare.length > 140) return false
      if (bare.endsWith('.') || bare.endsWith(';') || bare.endsWith(':')) return false
      if (bare.includes(',')) return false
      if (/\bproxy\s+statement\b/i.test(bare)) return false
      return pyStrip(bare).split(/\s+/).filter(Boolean).length <= 18
    }

    const normalized = (s: string): string => spaceCollapse(pyStrip(s)).toLowerCase()

    const findLineIndex = (target: string, startAt = 0): number => {
      const normTarget = normalized(target)
      for (let i = startAt; i < lines.length; i++) {
        const stripped = pyStrip(lines[i]!)
        if (!stripped || isTocLine(stripped)) continue
        if (stripped.startsWith('|')) continue
        if (stripped.includes('|') && /\|\s*\d{1,3}\s*\|\s*$/.test(stripped)) continue
        const normLine = normalized(stripped.replace(/^#{1,6}\s+/, ''))
        if (normLine === normTarget || normLine.startsWith(`${normTarget} `)) return i
        if (!isHeadingLike(stripped)) continue
      }
      return -1
    }

    let tocStartTitleIdx = -1
    let tocStartLineIdx = -1
    for (const pat of startPatterns) {
      for (let i = 0; i < titles.length; i++) {
        const titleNorm = normalized(titles[i]!)
        if (!pat.test(titleNorm)) continue
        const lineIdx = findLineIndex(titles[i]!)
        if (lineIdx >= 0) {
          tocStartTitleIdx = i
          tocStartLineIdx = lineIdx
          break
        }
      }
      if (tocStartLineIdx >= 0) break
    }

    if (tocStartLineIdx >= 0) {
      let endIdx = lines.length
      for (const nextTitle of titles.slice(tocStartTitleIdx + 1)) {
        const cand = findLineIndex(nextTitle, tocStartLineIdx + 1)
        if (cand >= 0) {
          endIdx = cand
          break
        }
      }
      if (endIdx === lines.length) {
        for (let i = tocStartLineIdx + 1; i < lines.length; i++) {
          const stripped = pyStrip(lines[i]!)
          if (!stripped || isTocLine(stripped)) continue
          if (stopPattern.test(stripped)) {
            endIdx = i
            break
          }
        }
      }
      const section = pyStrip(lines.slice(tocStartLineIdx, endIdx).join('\n'))
      if (section) return section
    }

    let startIdx = -1
    for (let i = 0; i < lines.length; i++) {
      const stripped = pyStrip(lines[i]!)
      if (!stripped || isTocLine(stripped) || !isHeadingLike(stripped)) continue
      for (const pat of startPatterns) {
        if (pat.test(stripped)) {
          startIdx = i
          break
        }
      }
      if (startIdx >= 0) break
    }
    if (startIdx < 0) return ''

    let endIdx = lines.length
    for (let i = startIdx + 1; i < lines.length; i++) {
      const stripped = pyStrip(lines[i]!)
      if (!stripped || isTocLine(stripped)) continue
      if (stopPattern.test(stripped)) {
        endIdx = i
        break
      }
    }
    return pyStrip(lines.slice(startIdx, endIdx).join('\n'))
  }

  const extractManagementSectionMarkdown = (titles: string[]): string => {
    const headingRe = /\b(nominees?\s+for\s+election\s+as\s+directors?|nominees?\s+to\s+.*board\s+of\s+directors|directors?\s+and\s+(?:executive\s+officers|senior\s+management)|executive\s+officers?)\b/i
    const stopRe = /\b(executive\s+compensation|compensation\s+discussion|pay\s+versus\s+performance|security\s+ownership|related\s+party|proposal\s+\d+|audit\s+committee|board\s+meetings\s+and\s+attendance|corporate\s+governance\s+framework)\b/i
    const preferredRe = /\b(nominees?\s+for\s+election\s+as\s+directors?|nominees?\s+to\s+.*board\s+of\s+directors|directors?|executive\s+officers?)\b/i

    const preferredTitles = new Set(titles.filter((t) => preferredRe.test(t)).map((t) => pyStrip(spaceCollapse(t)).toLowerCase()))
    const skip = new Set(['table', 'tr', 'td', 'th', 'script', 'style', 'noscript'])

    let start: Tag | null = null
    for (const tag of soup.findAll(true)) {
      if (skip.has(tag.name)) continue
      const text = pyStrip(spaceCollapse(tag.getText(' ', true))).toLowerCase()
      if (text && preferredTitles.has(text)) {
        start = tag
        break
      }
    }

    if (!start) {
      for (const tag of soup.findAll(true)) {
        if (skip.has(tag.name)) continue
        const text = spaceCollapse(tag.getText(' ', true))
        if (text && headingRe.test(text)) {
          start = tag
          break
        }
      }
    }
    if (!start) return ''

    const sectionNodes: Tag[] = [start]
    for (const sib of findNextSiblings(start)) {
      const sibText = spaceCollapse(sib.getText(' ', true))
      if (sibText && stopRe.test(sibText)) break
      sectionNodes.push(sib)
    }

    return pyStrip(htmlToMarkdown(sectionNodes.map((n) => n.decode()).join(''), { keepTables: true }))
  }

  const anchoredSection = extractManagementSectionFromTocAnchors(tocEntries())
  if (anchoredSection) return anchoredSection

  const markdownSection = extractManagementSectionFromMarkdown(fullMarkdown, tocTitles())
  if (markdownSection) return markdownSection

  const sectionMarkdown = extractManagementSectionMarkdown(tocTitles())
  if (sectionMarkdown) return sectionMarkdown

  const tables: [string, Tag][] = []
  for (const table of soup.findAll('table')) {
    const normalized = normalizedText(table)
    if (!normalized) continue
    const tocLike = (normalized.match(/\b\d{1,3}\b/g) ?? []).length >= 6 && (normalized.includes('proxy statement summary') || normalized.includes('notice of') || normalized.includes('corporate governance') || normalized.includes('shareholder'))
    if (tocLike) continue
    tables.push([normalized, table])
  }

  const preferred: Tag[] = []
  for (const [normalized, table] of tables) {
    if (normalized.includes('nominee and principal occupation') && normalized.includes('independent') && normalized.includes('age')) {
      preferred.push(table)
      continue
    }
    if (normalized.includes('director since') && normalized.includes('age') && (normalized.includes('director') || normalized.includes('nominee'))) preferred.push(table)
  }

  if (preferred.length) {
    const markdown = pyStrip(htmlToMarkdown(preferred[0]!.decode(), { keepTables: true }))
    if (markdown) return markdown
  }

  const fallback: Tag[] = []
  for (const [normalized, table] of tables) {
    if (normalized.includes('age') && (normalized.includes('director') || normalized.includes('position') || normalized.includes('business experience') || normalized.includes('nominee') || normalized.includes('executive officer') || normalized.includes('director since'))) fallback.push(table)
  }

  if (fallback.length) {
    const markdown = pyStrip(htmlToMarkdown(fallback[0]!.decode(), { keepTables: true }))
    if (markdown) return markdown
  }
  return ''
}

const PVP_NUMERIC: Record<string, string> = {
  PeoTotalCompAmt: 'peo_total_compensation',
  PeoActuallyPaidCompAmt: 'peo_compensation_actually_paid',
  NonPeoNeoAvgTotalCompAmt: 'average_neo_total_compensation',
  NonPeoNeoAvgCompActuallyPaidAmt: 'average_neo_compensation_actually_paid',
  TotalShareholderRtnAmt: 'total_shareholder_return',
  PeerGroupTotalShareholderRtnAmt: 'peer_group_total_shareholder_return',
  NetIncomeLoss: 'net_income',
  CoSelectedMeasureAmt: 'company_selected_measure',
}

const PVP_REQUIRED_FIELDS = new Set(['peo_total_compensation', 'peo_compensation_actually_paid', 'average_neo_total_compensation', 'average_neo_compensation_actually_paid', 'total_shareholder_return', 'peer_group_total_shareholder_return', 'company_selected_measure'])

/** Python's `float(text)` for the strings an inline-XBRL fact can hold; null where Python raises ValueError. */
function pyFloat(text: string): number | null {
  const t = pyStrip(text)
  if (/^[+-]?(?:\d+(?:_\d+)*(?:\.(?:\d+(?:_\d+)*)?)?|\.\d+(?:_\d+)*)(?:[eE][+-]?\d+(?:_\d+)*)?$/.test(t)) return Number(t.replaceAll('_', ''))
  if (/^[+-]?(?:inf|infinity)$/i.test(t)) return t.startsWith('-') ? -Infinity : Infinity
  if (/^[+-]?nan$/i.test(t)) return NaN
  return null
}

/** Python's `int(text)` for a scale attribute; null where Python raises ValueError. */
function pyInt(text: string): number | null {
  const t = pyStrip(text)
  return /^[+-]?\d+(?:_\d+)*$/.test(t) ? Number(t.replaceAll('_', '')) : null
}

/** An inline-XBRL numeric fact with its sign and scale applied. */
function ixNumber(tag: Tag): number | null {
  let text = tag.getText('', true).replaceAll(',', '').replaceAll('$', '').replaceAll('%', '')
  text = pyStrip(text.replaceAll('—', '').replaceAll(' ', ''))
  if (!text || ['-', '--', 'N/A', 'n/a'].includes(text)) return null
  let value = pyFloat(text)
  if (value === null) return null
  const scaleText = attr(tag, 'scale')
  if (scaleText) {
    const scale = pyInt(scaleText)
    if (scale === null) throw new Error(`invalid literal for int() with base 10: '${scaleText}'`)
    value *= 10 ** scale
  }
  if (attr(tag, 'sign') === '-') value = -value
  return value
}

/** The Pay Versus Performance table from inline XBRL facts, by year (newest first). */
export function payVersusPerformance(html: string): Record<string, unknown>[] {
  const soup = parse(html, 'html.parser')

  const ctxYear = new Map<string, string>()
  for (const ctx of soup.findAll(/context$/i)) {
    if (ctx.find(/explicitmember$/i)) continue
    const period = ctx.find(/period$/i)
    if (!period) continue
    const date = period.find(/(enddate|instant)$/i)
    if (date && /^\d+$/.test(date.getText('', true).slice(0, 4))) ctxYear.set(attr(ctx, 'id'), date.getText('', true).slice(0, 4))
  }

  const rows = new Map<string, Record<string, unknown>>()
  for (const fact of soup.findAll(/nonfraction$/i)) {
    const concept = attr(fact, 'name').split(':').pop()!
    const field = PVP_NUMERIC[concept]
    const year = ctxYear.get(attr(fact, 'contextref'))
    if (!field || !year) continue
    if (!rows.has(year)) rows.set(year, { year: parseInt(year, 10) })
    rows.get(year)![field] = ixNumber(fact)
  }

  if (rows.size === 0) return []

  let measure: Tag | null = null
  for (const candidate of soup.findAll(/nonnumeric$/i)) {
    const concept = attr(candidate, 'name').split(':').pop()!
    if (concept === 'MeasureName' || concept === 'CoSelectedMeasureName') {
      measure = candidate
      break
    }
  }
  const measureName = measure ? measure.getText(' ', true) : null
  if (measureName) for (const row of rows.values()) row.company_selected_measure_name = measureName

  if (![...rows.values()].some((row) => [...PVP_REQUIRED_FIELDS].some((field) => field in row && row[field] !== null && row[field] !== undefined))) return []

  return [...rows.keys()].sort().reverse().map((y) => rows.get(y)!)
}
