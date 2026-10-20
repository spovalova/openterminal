// Statements, notes and items of filings without XBRL, provider sec. Ported from openbb_sec/utils/non_xbrl_parser.py
// (OpenBB Platform 5.0.0, Apache-2.0); modified: bs4 is ../markdown/soup.ts, and a DataFrame of line items is a list of
// rows (the keys of `_build_statement_dataframe`).
import { NavigableString, Tag, parse } from '../markdown/soup.js'
import { PY_WS, pyFloatStr, pyStrip } from './pandas-lite.js'

type Dict = Record<string, any>

export type LineItem = { label: string; section: string | null; values: (number | null)[]; skip_multiplier: boolean }
export type StatementResult = { data: Dict[]; meta: Dict | null }

const WS = new RegExp(`[${PY_WS}]+`, 'g')
const collapse = (s: string): string => s.replace(WS, ' ')
const isUpperStr = (s: string): boolean => /\p{Lu}/u.test(s) && s === s.toUpperCase()
const isDigitStr = (s: string): boolean => s.length > 0 && /^[\p{Nd}²³¹]+$/u.test(s)
const hasDigit = (s: string): boolean => /\p{Nd}/u.test(s)
const strOf = pyFloatStr

/** `str.title()` */
function pyTitle(s: string): string {
  return s.replace(/\p{L}+/gu, (w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase())
}

/** `_clean_html_entities` */
export function cleanHtmlEntities(textIn: string): string {
  let text = textIn
  text = text.replaceAll('&nbsp;', ' ')
  text = text.replaceAll('&#146;', "'")
  text = text.replaceAll('&#147;', '"')
  text = text.replaceAll('&#148;', '"')
  text = text.replaceAll('&#149;', '•')
  text = text.replaceAll('&#150;', '-')
  text = text.replaceAll('&#151;', '—')
  text = text.replaceAll('&#160;', ' ')
  text = text.replaceAll('&amp;', '&')
  text = text.replaceAll('&mdash;', '—')
  text = text.replaceAll('&ndash;', '-')
  text = text.replaceAll('&bull;', '•')
  text = text.replaceAll('&rsquo;', "'")
  text = text.replaceAll('&lsquo;', "'")
  text = text.replaceAll('&rdquo;', '"')
  text = text.replaceAll('&ldquo;', '"')

  // SEC ASCII renderings of trademark symbols in old plain-text filings.
  text = text.replaceAll('-Registered Trademark-', '®')
  text = text.replaceAll('-Servicemark-', '℠')
  text = text.replaceAll('-TM-', '™')

  // Unicode dashes -> ASCII
  text = text.replaceAll('–', '-')
  text = text.replaceAll('—', '-')

  text = text.replace(/&\w+;/g, '')
  text = text.replace(/&#\d+;/g, '')
  return pyStrip(text)
}

const cellText = (cell: Tag): string => pyStrip(collapse(cell.getText(' ', true)))

// ---------------------------------------------------------------------------------------------------------------
// statements
// ---------------------------------------------------------------------------------------------------------------

function statementKeywords(statementType: string): string[] {
  const keywords: Record<string, string[]> = {
    income: ['statements of earnings', 'statements of income', 'statements of operations', 'net earnings', 'net income', 'total revenues'],
    balance: ['balance sheet', 'financial condition', 'financial position', 'total assets', 'total liabilities', 'stockholders equity', 'shareholders equity', 'cash and cash equivalents'],
    cash: ['cash flows', 'operating activities', 'investing activities', 'financing activities'],
    equity: ['stockholders equity', 'shareholders equity', 'changes in equity'],
  }
  return keywords[statementType] ?? keywords.income!
}

/** `get_statement_names` */
export function getStatementNames(): Record<string, string> {
  return {
    income: 'Consolidated Statements of Operations',
    balance: 'Consolidated Balance Sheet',
    cash: 'Consolidated Statements of Cash Flows',
    equity: "Consolidated Statements of Stockholders' Equity",
  }
}

function detectMultiplier(table: Tag): [number, string] {
  const tableText = table.getText(' ', true).toLowerCase()
  if (tableText.includes('in millions') || tableText.includes('(millions)')) return [1_000_000, 'millions']
  if (tableText.includes('in thousands') || tableText.includes('(thousands)')) return [1_000, 'thousands']
  if (tableText.includes('in billions') || tableText.includes('(billions)')) return [1_000_000_000, 'billions']
  return [1, 'units']
}

function isHeaderRow(rowText: string, cellTexts: string[]): boolean {
  const periodPhrases = ['year ended', 'years ended', 'months ended', 'month ended', 'quarter ended', 'quarters ended', 'fiscal year', 'fiscal years', 'in millions', 'in thousands', 'in billions', '(except', 'except per share']
  if (periodPhrases.some((p) => rowText.includes(p))) return true
  const yearsInRow = cellTexts.join(' ').match(/\b(19|20)\d{2}\b/g) ?? []
  if (yearsInRow.length >= 2) {
    let standalone = 0
    for (const text of cellTexts) if (/^(19|20)\d{2}(\s*\(\d+\))?$/.test(pyStrip(text))) standalone += 1
    if (standalone >= 2) return true
  }
  return false
}

function extractPeriods(headerRows: Tag[]): string[] {
  let periodPrefixes: string[] = []
  let years: string[] = []
  let columnHeaders: string[] = []

  for (const row of headerRows) {
    const cells = row.findAll(['td', 'th'])
    if (cells.length > 50) continue
    const cellTexts = cells.map(cellText)
    const nonEmpty = cellTexts.filter((c) => c)
    if (nonEmpty.length === 0) continue
    const rowText = nonEmpty.join(' ')

    if (/(months? ended|year ended|quarter ended)/i.test(rowText)) periodPrefixes = nonEmpty.filter((c) => /(months?|year|quarter)/i.test(c))

    const yearMatches = rowText.match(/\b((?:19|20)\d{2})\b/g) ?? []
    if (yearMatches.length >= 2 && years.length === 0) years = yearMatches

    if (columnHeaders.length === 0) {
      const headerKeywords = ['amount', 'balance', 'value', 'gross', 'net', 'carrying', 'accumulated', 'additions', 'segment', 'adjustments', 'divestitures', 'translation']
      const potentialHeaders: string[] = []
      let hasKeyword = false
      for (const c of nonEmpty) {
        if (/^(19|20)\d{2}$/.test(c)) continue
        if (/^[\d,.$()-]+$/.test(c.replaceAll(',', ''))) continue
        if (c.length < 3) continue
        if (['$', 'for the', 'at'].includes(c.toLowerCase())) continue
        potentialHeaders.push(c)
        if (headerKeywords.some((kw) => c.toLowerCase().includes(kw))) hasKeyword = true
      }
      if (hasKeyword && potentialHeaders.length >= 2) columnHeaders = potentialHeaders.length > 2 ? potentialHeaders.slice(1) : potentialHeaders
    }
  }

  if (periodPrefixes.length > 0 && years.length > 0) {
    const periods: string[] = []
    let prefixIdx = 0
    years.forEach((year, i) => {
      if (prefixIdx < periodPrefixes.length) {
        periods.push(`${periodPrefixes[prefixIdx]} ${year}`)
        if ((i + 1) % 2 === 0) prefixIdx += 1
      } else periods.push(year)
    })
    return periods
  }
  if (columnHeaders.length > 0) return columnHeaders
  if (years.length > 0) return years
  return []
}

/** `_parse_number` */
function parseNumber(textIn: string): number | null {
  if (!textIn) return null
  let text = pyStrip(textIn)
  const isNegative = text.startsWith('(') && text.endsWith(')')
  if (isNegative) text = text.slice(1, -1)
  const cleaned = text.replaceAll(',', '')
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null
  const value = Number(cleaned)
  return isNegative ? -value : value
}

function parseDataRow(cellTexts: string[], expectedValues: number): [string, (number | null)[], boolean] | null {
  if (cellTexts.length === 0) return null
  let label: string | null = null
  const values: (number | null)[] = []
  let pendingNegative: number | null = null

  for (const cell of cellTexts) {
    if (!cell || ['$', '—', '-', ''].includes(cell)) continue
    if (cell === ')' && pendingNegative !== null) {
      values.push(-pendingNegative)
      pendingNegative = null
      continue
    }
    if (cell.startsWith('(') && !cell.endsWith(')')) {
      const numPart = cell.slice(1).replaceAll(',', '')
      const f = pyFloatLoose(numPart)
      if (f !== null) {
        pendingNegative = f
        continue
      }
    }
    const num = parseNumber(cell)
    if (num !== null) values.push(num)
    else if (label === null) label = cell
  }

  if (label === null) return null
  if (label.length > 100) return null
  if (/\d{3},\d{3}/.test(label)) return null
  if (values.length === 0) return null

  const labelLower = label.toLowerCase()
  const isPerShare = ['per share', 'basic', 'diluted', 'eps'].some((kw) => labelLower.includes(kw))
  const isShareCount = ['shares', 'share count', 'units issued', 'units outstanding'].some((kw) => labelLower.includes(kw))
  const skipMultiplier = isPerShare || isShareCount

  if (values.length < expectedValues) while (values.length < expectedValues) values.push(null)
  else if (values.length > expectedValues) values.length = expectedValues
  return [label, values, skipMultiplier]
}

/** Python's `float(text)` for the number part of a "(14" cell. */
function pyFloatLoose(text: string): number | null {
  const t = pyStrip(text)
  if (/^[+-]?(\d+(_\d+)*(\.(\d+(_\d+)*)?)?|\.\d+(_\d+)*)([eE][+-]?\d+(_\d+)*)?$/.test(t)) return Number(t.replaceAll('_', ''))
  const lower = t.toLowerCase()
  if (/^[+-]?(inf|infinity)$/.test(lower)) return lower.startsWith('-') ? -Infinity : Infinity
  if (/^[+-]?nan$/.test(lower)) return NaN
  return null
}

function extractTableData(table: Tag): [LineItem[], string[], number, string | null] | null {
  const rows = table.findAll('tr')
  if (rows.length < 5) return null

  const [multiplier] = detectMultiplier(table)

  let periods = extractPeriods(rows.slice(0, 20))
  if (periods.length === 0) {
    for (const row of rows.slice(1, 10)) {
      const cells = row.findAll(['td', 'th'])
      const cellTexts = cells.map(cellText)
      const values = cellTexts.filter((c) => c && /^[\d,.$()-]+$/.test(c.replaceAll(',', '').replaceAll('$', '')))
      if (values.length >= 2) {
        periods = values.map((_, i) => `Col ${i + 1}`)
        break
      }
    }
    if (periods.length === 0) periods = ['Value']
  }

  const numPeriods = periods.length
  const lineItems: LineItem[] = []
  let currentSection: string | null = null
  const title: string | null = null

  for (const row of rows) {
    const cells = row.findAll(['td', 'th'])
    if (cells.length > 50 || cells.length === 0) continue
    const cellTexts = cells.map(cellText)
    if (!cellTexts.some((c) => c)) continue
    const rowText = cellTexts.join(' ').toLowerCase()
    if (isHeaderRow(rowText, cellTexts)) continue

    const nonEmpty = cellTexts.filter((c) => c)
    if (nonEmpty.length === 1) {
      const text = nonEmpty[0]!.replace(/:+$/, '')
      if (text && !/\d/.test(text) && text.length < 100) {
        currentSection = text
        continue
      }
    }

    const parsed = parseDataRow(cellTexts, numPeriods)
    if (parsed) {
      const [label, values, skipMultiplier] = parsed
      lineItems.push({ label, section: currentSection, values, skip_multiplier: skipMultiplier })
    }
  }

  if (lineItems.length === 0) return null
  return [lineItems, periods, multiplier, title]
}

const MONTH_NUMBERS: [string, string][] = [
  ['january', '01'],
  ['february', '02'],
  ['march', '03'],
  ['april', '04'],
  ['may', '05'],
  ['june', '06'],
  ['july', '07'],
  ['august', '08'],
  ['september', '09'],
  ['october', '10'],
  ['november', '11'],
  ['december', '12'],
  ['jan', '01'],
  ['feb', '02'],
  ['mar', '03'],
  ['apr', '04'],
  ['jun', '06'],
  ['jul', '07'],
  ['aug', '08'],
  ['sep', '09'],
  ['oct', '10'],
  ['nov', '11'],
  ['dec', '12'],
]

/** `_extract_period_ending`: a date from a label like 'Year Ended June 30 2003'. */
function extractPeriodEnding(period: string): string | null {
  const yearMatch = /\b(19|20)\d{2}\b/.exec(period)
  if (!yearMatch) return null
  const year = yearMatch[0]
  const periodLower = period.toLowerCase()
  for (const [monthName, monthNum] of MONTH_NUMBERS) {
    if (periodLower.includes(monthName)) {
      const dayMatch = new RegExp(`${monthName}\\s+(\\d{1,2})`).exec(periodLower)
      let day: string
      if (dayMatch) day = dayMatch[1]!.padStart(2, '0')
      else {
        day = ['04', '06', '09', '11'].includes(monthNum) ? '30' : '31'
        if (monthNum === '02') day = '28'
      }
      return `${year}-${monthNum}-${day}`
    }
  }
  return `${year}-12-31`
}

function buildStatementRows(lineItems: LineItem[], periods: string[], multiplier: number): Dict[] {
  const rows: Dict[] = []
  lineItems.forEach((item, idx) => {
    const order = idx + 1
    const scale = item.skip_multiplier ? 1 : multiplier
    const labelLower = item.label ? item.label.toLowerCase() : ''
    const sharesPos = labelLower.indexOf('shares')
    const perPos = labelLower.indexOf('per')
    const isShareCount = sharesPos >= 0 && (perPos < 0 || sharesPos < perPos)
    const isPerShare = !isShareCount && (/\bper\b.*\bshare\b/.test(labelLower) || labelLower.includes('eps'))
    const unit = isPerShare ? 'USD/shares' : isShareCount ? 'shares' : 'USD'
    periods.forEach((period, i) => {
      const v = item.values[i]
      rows.push({
        order,
        tag: null,
        parent_tag: item.section,
        preferred_label: null,
        balance: null,
        weight: null,
        decimals: null,
        context_ref: period,
        period_beginning: null,
        period_ending: extractPeriodEnding(period),
        unit,
        label: item.label,
        value: i < item.values.length && v !== null && v !== undefined ? v * scale : null,
      })
    })
  })
  return rows
}

function buildMeta(title: string | null, periods: string[], multiplier: number): Dict {
  const scale = multiplier === 1_000_000_000 ? 'billions' : multiplier === 1_000_000 ? 'millions' : multiplier === 1_000 ? 'thousands' : 'units'
  return { title: title || 'Financial Statement', periods, num_periods: periods.length, is_xbrl: false, source: 'HTML Table', scale, multiplier }
}

/** `_is_sgml_content`: pre-2000 plain-text filings with <PAGE> markers and <S>/<C> tables. */
export function isSgmlContent(content: string): boolean {
  const hasSgmlMarkers = /<PAGE>/.test(content)
  const hasSgmlTables = /<S>\s+<C>/.test(content)
  const lacksHtml = !/<(?:html|body|div|span)\b/i.test(content)
  return (hasSgmlMarkers || hasSgmlTables) && lacksHtml
}

/** `parse_non_xbrl_statement` */
export function parseNonXbrlStatementHtml(htmlContent: string, statementType = 'income'): StatementResult {
  if (isSgmlContent(htmlContent)) return parseSgmlStatement(htmlContent, statementType)

  const soup = parse(htmlContent, 'html.parser')
  const keywords = statementKeywords(statementType)
  const allTables = soup.findAll('table')

  let bestTable: Tag | null = null
  let bestScore = 0

  for (const table of allTables) {
    const tableText = table.getText(' ', true).toLowerCase()
    let score = keywords.filter((kw) => tableText.includes(kw.toLowerCase())).length

    if (score > 0) {
      if (tableText.includes('page no') || tableText.includes('item 1:')) {
        score = Math.max(0, score - 5)
        if (score <= 0) continue
      }
      const numbers = tableText.match(/\b\d{1,3}(?:,\d{3})*(?:\.\d+)?\b/g) ?? []
      if (numbers.length < 10) continue
      if (tableText.includes('in millions') || tableText.includes('in thousands') || tableText.includes('in billions')) score += 2
      const dollarCount = tableText.split('$').length - 1
      if (dollarCount > 5) score += 1
      if (numbers.length > 30) score += 1
    }

    if (score > bestScore) {
      bestTable = table
      bestScore = score
    }
  }

  if (bestTable === null) return { data: [], meta: null }
  const result = extractTableData(bestTable)
  if (result === null) return { data: [], meta: null }
  const [lineItems, periods, multiplier, title] = result
  if (lineItems.length === 0) return { data: [], meta: null }
  return { data: buildStatementRows(lineItems, periods, multiplier), meta: buildMeta(title, periods, multiplier) }
}

/** `find_all_statements`: every statement type the document holds. */
export function findAllStatements(htmlContent: string): Record<string, StatementResult> {
  const results: Record<string, StatementResult> = {}
  for (const stmtType of ['income', 'balance', 'cash', 'equity']) {
    const r = parseNonXbrlStatementHtml(htmlContent, stmtType)
    if (r.data.length > 0) results[stmtType] = r
  }
  return results
}

// ---------------------------------------------------------------------------------------------------------------
// table of contents
// ---------------------------------------------------------------------------------------------------------------

const VALID_ITEM_PATTERN = /^ITEM\s*(1[0-5]?|[2-9])(A|B|C)?[.:]?$/i

/** `extract_toc`: item numbers ('1', '1A', '7') to titles. */
export function extractToc(htmlContent: string): Record<string, string> {
  const soup = parse(htmlContent, 'html.parser')
  let tocDict: Record<string, string> = {}

  const hrefToTexts = new Map<string, string[]>()
  for (const link of soup.findAll('a', { attrs: { href: true } })) {
    const href = link.getStr('href', '')
    if (!href || !href.startsWith('#')) continue
    const linkText = link.getText('', true)
    if (!linkText) continue
    if (!hrefToTexts.has(href)) hrefToTexts.set(href, [])
    hrefToTexts.get(href)!.push(linkText)
  }

  for (const [, texts] of hrefToTexts) {
    let itemNum: string | null = null
    let title: string | null = null
    for (const text of texts) {
      const itemMatch = VALID_ITEM_PATTERN.exec(pyStrip(text))
      if (itemMatch) itemNum = `${itemMatch[1]}${itemMatch[2] ?? ''}`.toUpperCase()
      else if (text && !/^\d+$/.test(text)) {
        if (title === null && text.length > 5) title = text
      }
    }
    if (itemNum && title && !(itemNum in tocDict)) tocDict[itemNum] = title
  }

  if (Object.keys(tocDict).length === 0) tocDict = extractTocFromTable(soup)

  if (Object.keys(tocDict).length === 0) {
    const text = soup.getText('\n', true)
    for (const m of text.matchAll(/ITEM\s+(1[0-5]?|[2-9])(A|B|C)?[.\s]+([A-Z][A-Z\s,\-']+?)(?:\n|$)/gi)) {
      const itemNum = `${m[1]}${m[2] ?? ''}`.toUpperCase()
      if (!(itemNum in tocDict)) tocDict[itemNum] = pyStrip(m[3]!)
    }
  }

  if (isSgmlContent(htmlContent) && Object.keys(tocDict).length < 4) {
    const sgmlToc = extractTocSgml(htmlContent)
    if (Object.keys(sgmlToc).length > Object.keys(tocDict).length) tocDict = sgmlToc
    else for (const [k, v] of Object.entries(sgmlToc)) if (!(k in tocDict)) tocDict[k] = v
  }
  return tocDict
}

function extractTocFromTable(soup: Tag): Record<string, string> {
  const tocDict: Record<string, string> = {}
  let currentPart = 'I'

  for (const table of soup.findAll('table')) {
    const tableText = table.getText()
    if (!tableText.toUpperCase().includes('PART I') && !tableText.includes('Item')) continue

    for (const row of table.findAll('tr')) {
      const cells = row.findAll(['td', 'th'])
      let cellTexts = [...new Set(cells.map((c) => c.getText('', true)).filter((t) => t))]
      if (cellTexts.length === 0) continue

      let shortCells = cellTexts.filter((t) => t.length <= 100)
      if (cellTexts.length > 5) {
        shortCells = cellTexts.filter((t) => t.length <= 100).slice(-5)
        cellTexts = shortCells
      }

      for (const text of cellTexts) {
        if (text.length > 20) continue
        const partMatch = /^PART\s+(I{1,2}|[12])\s*:?$/i.exec(text.replaceAll('\xa0', ' '))
        if (partMatch) {
          let partNum = partMatch[1]!
          if (partNum === '1') partNum = 'I'
          else if (partNum === '2') partNum = 'II'
          const hasTitleCell = cellTexts.some((t) => t.length < 50 && !isDigitStr(t) && t !== text)
          if (hasTitleCell && shortCells.length <= 5) {
            currentPart = partNum
            for (const otherText of cellTexts) {
              if (otherText !== text && !isDigitStr(otherText) && otherText.length < 50) {
                const cleanTitle = pyStrip(collapse(otherText.replaceAll('\n', ' ')))
                if (cleanTitle && cleanTitle.length > 3) {
                  tocDict[`PART_${partNum}`] = cleanTitle
                  break
                }
              }
            }
          }
          break
        }
      }

      if (cellTexts.length >= 2 && cellTexts.length <= 5) {
        for (let i = 0; i < cellTexts.length; i++) {
          const text = cellTexts[i]!
          if (text.length > 15) continue
          const itemMatch = /^Item\s*(\d+[A-Za-z]?)\s*:?$/i.exec(text.replaceAll('\xa0', ' '))
          if (itemMatch && i + 1 < cellTexts.length) {
            const itemNum = itemMatch[1]!.toUpperCase()
            let title = pyStrip(cellTexts[i + 1]!.replaceAll('\n', ' ').replaceAll('\t', ' '))
            title = collapse(title)
            if (title && !isDigitStr(title) && title.length > 3) {
              if (/\d{2}$/.test(title)) title = pyStrip(title.replace(/\d+$/, ''))
              const key = currentPart === 'II' ? `II_${itemNum}` : itemNum
              if (!(key in tocDict)) tocDict[key] = title
            }
            break
          }
        }
      }
    }
  }
  return tocDict
}

function extractTocSgml(content: string): Record<string, string> {
  const text = sgmlToText(content)
  const tocDict: Record<string, string> = {}
  let currentPart = 'I'
  const tocPattern = /^[ \t]*ITEM\s+(\d+[A-Za-z]?)\s*[.:\s]\s*(.+?)\s+(\d{1,3})\s*$/gim
  for (const m of text.matchAll(tocPattern)) {
    const itemNum = m[1]!.toUpperCase()
    let title = pyStrip(m[2]!)
    title = title.replace(/[.\s]+$/, '')
    if (title && title.length > 3) {
      const preceding = text.slice(Math.max(0, m.index! - 200), m.index!)
      const partMatch = /PART\s+(I{1,3}|[1-3])/i.exec(preceding)
      if (partMatch) {
        const p = partMatch[1]!.toUpperCase()
        if (p === '2' || p === 'II') currentPart = 'II'
        else if (p === '1' || p === 'I') currentPart = 'I'
      }
      const key = currentPart === 'II' ? `II_${itemNum}` : itemNum
      if (!(key in tocDict)) tocDict[key] = title
    }
  }
  return tocDict
}

// ---------------------------------------------------------------------------------------------------------------
// notes
// ---------------------------------------------------------------------------------------------------------------

function isBulletTable(table: Tag): boolean {
  const rows = table.findAll('tr')
  let bulletCount = 0
  for (const row of rows.slice(0, 5)) {
    const cells = row.findAll('td')
    if (cells.length > 0) {
      const firstCell = cells[0]!.getText('', true)
      if (['•', '&#149;', '*', '-', '—'].includes(firstCell)) bulletCount += 1
    }
  }
  return bulletCount >= 1
}

function extractBulletList(table: Tag): string | null {
  const bullets: string[] = []
  for (const row of table.findAll('tr')) {
    const cells = row.findAll('td')
    if (cells.length >= 2) {
      const firstCell = cells[0]!.getText('', true)
      if (['•', '&#149;', '*', '-', '—', ''].includes(firstCell)) {
        let text = cells.slice(1).map((c) => c.getText(' ', true)).join(' ')
        text = cleanHtmlEntities(text)
        text = pyStrip(collapse(text))
        if (text && text.length > 5) bullets.push(`- ${text}`)
      }
    }
  }
  return bullets.length > 0 ? bullets.join('\n\n') : null
}

function isFinancialTable(table: Tag): boolean {
  const numbers = table.getText().match(/\d{1,3}(?:,\d{3})+/g) ?? []
  return numbers.length >= 3
}

function getDirectText(elem: Tag): string {
  const parts: string[] = []
  for (const child of elem.contents) {
    if (child instanceof NavigableString) {
      const text = pyStrip(child.text)
      if (text) parts.push(text)
    } else if (child instanceof Tag && child.name !== 'p' && child.name !== 'table') {
      const text = child.getText('', true)
      if (text) parts.push(text)
    }
  }
  return parts.join(' ')
}

function cleanParagraphText(textIn: string): string | null {
  if (!textIn) return null
  let text = cleanHtmlEntities(textIn)
  if (/^\d+$/.test(text)) return null
  if (text.length < 5) return null
  if (text === '(UNAUDITED)' || text === '(Continued)' || text.endsWith('(Continued)')) return null
  if (text.includes('PAGEBREAK')) return null
  if (text.toLowerCase().includes('page') && text.length < 50) return null
  if (/19\d{2}19\d{2}/.test(text)) return null
  if (/\$[\d,]+\$[\d,]+/.test(text)) return null
  if (text.split('$').length - 1 > 3) return null
  text = collapse(text)
  return text
}

function isSectionHeader(elem: Tag): boolean {
  const bTags = elem.contents.filter((c): c is Tag => c instanceof Tag && c.name === 'b')
  if (bTags.length !== 1) return false
  const bText = bTags[0]!.getText('', true)
  const directText = getDirectText(elem)
  if (directText === bText && bText.length > 3 && bText.length < 60) return !/^\d+\./.test(bText)
  return false
}

function parseHtmlTableForNotes(table: Tag): [string[], string[][]] {
  const result = extractTableData(table)
  if (result) {
    const [lineItems, periods, multiplier] = result
    const headers = ['', ...periods]
    const dataRows: string[][] = []
    for (const item of lineItems) {
      const row = [item.label]
      for (const v of item.values) {
        if (v === null) row.push('')
        else if (item.skip_multiplier) row.push(strOf(v))
        else row.push(multiplier !== 1 ? strOf(v * multiplier) : strOf(v))
      }
      dataRows.push(row)
    }
    return [headers, dataRows]
  }

  const allTrs = table.findAll('tr')
  if (allTrs.length < 2) return [[], []]
  let headers: string[] = []
  const dataRows: string[][] = []
  for (const tr of allTrs) {
    const cells = tr.contents.filter((c): c is Tag => c instanceof Tag && (c.name === 'td' || c.name === 'th'))
    const rowData = cells.map(cellText)
    if (!rowData.some((c) => c)) continue
    if (headers.length === 0) headers = rowData
    else dataRows.push(rowData)
  }
  return [headers, dataRows]
}

function tableToMarkdownNotes(headers: string[], dataRows: string[][]): string {
  if (headers.length === 0 && dataRows.length === 0) return ''
  const numCols = headers.length > 0 ? headers.length : dataRows.length > 0 ? dataRows[0]!.length : 0
  if (numCols === 0) return ''
  const lines = [`| ${headers.join(' | ')} |`, `| ${Array.from({ length: numCols }, () => '---').join(' | ')} |`]
  for (const row of dataRows) {
    const rowData = [...row]
    while (rowData.length < numCols) rowData.push('')
    lines.push(`| ${rowData.slice(0, numCols).join(' | ')} |`)
  }
  return lines.join('\n')
}

/** Python's `result[:200] if len(result) > 200 else result` */
const textKey = (s: string): string => (s.length > 200 ? s.slice(0, 200) : s)

function findNotesInSection(htmlContent: string): [number, string, string, number | null][] {
  let matches: [number, string, string, number | null][] = []
  const notesMatch = /Notes?\s+to\s+(?:Consolidated\s+)?Financial\s+Statements?/i.exec(htmlContent)
  if (!notesMatch) return matches
  const notesStart = notesMatch.index

  const tocPattern = /<td[^>]*>\s*<p[^>]*>\s*(?:<font[^>]*>)?\s*([A-Z])\s*(?:<\/font>)?\s*<\/p>\s*<\/td>\s*<td[^>]*width="8[0-9]%"[^>]*>.*?<font[^>]*>([^<]{5,80})<\/font>/gis
  const tocNotes: [string, string][] = []
  const seenLetters = new Set<string>()
  for (const m of htmlContent.slice(notesStart, notesStart + 50000).matchAll(tocPattern)) {
    const letter = m[1]!.toUpperCase()
    let title = pyStrip(m[2]!)
    title = collapse(title)
    title = cleanHtmlEntities(title)
    if (!seenLetters.has(letter) && title.length >= 5) {
      seenLetters.add(letter)
      tocNotes.push([letter, title])
    }
  }
  if (tocNotes.length === 0) return matches

  for (const [letter, title] of tocNotes) {
    const contentPattern = new RegExp(`<b[^>]*>\\s*(?:<font[^>]*>)?\\s*${letter}\\.\\s+[^<]*(?:</font>)?\\s*</b>`, 'i')
    const searchStart = notesStart + 100000
    const m = contentPattern.exec(htmlContent.slice(searchStart))
    if (m) matches.push([searchStart + m.index + m[0].length, letter, title, null])
  }
  matches = matches.map((match, i) => [match[0], match[1], match[2], i + 1 < matches.length ? matches[i + 1]![0] : null])
  return matches
}

/** `extract_text_blocks`: the notes to the financial statements, keyed by note. */
export function extractTextBlocks(htmlContent: string): Record<string, Dict> {
  const textBlocks: Record<string, Dict> = {}
  if (isSgmlContent(htmlContent)) return extractTextBlocksSgml(htmlContent)

  const notePattern = /<[Bb]>Note\s*(\d+)[.\s](?:&nbsp;)?([^<]+)<\/[Bb]>/gi
  type NoteMatch = { start: number; end: number; id: string; title: string }
  let matches: NoteMatch[] = [...htmlContent.matchAll(notePattern)].map((m) => {
    let title = pyStrip(m[2]!)
    title = title.replaceAll('&nbsp;', ' ').replaceAll('&#151;', '—')
    title = title.replace(/&\w+;/g, '')
    return { start: m.index!, end: m.index! + m[0].length, id: m[1]!, title }
  })
  let tupleMatches: [number, string, string, number | null][] = []
  if (matches.length === 0) {
    tupleMatches = findNotesInSection(htmlContent)
    matches = tupleMatches.map((t) => ({ start: t[0], end: t[0], id: t[1], title: t[2] }))
    if (matches.length === 0) return textBlocks
  }

  matches.forEach((match, i) => {
    let noteId: string
    let title: string
    let startPos: number
    let nextStart: number | null
    if (tupleMatches.length === 0) {
      noteId = match.id
      title = match.title
      startPos = match.end
      nextStart = i + 1 < matches.length ? matches[i + 1]!.start : null
    } else {
      const t = tupleMatches[i]!
      noteId = t[1]
      title = t[2]
      startPos = t[0]
      nextStart = t[3]
    }

    let endPos: number
    if (nextStart) endPos = nextStart
    else {
      const endPatterns = [/<[Bb]>Review Report/i, /<[Bb]>Item\s*(?:&nbsp;)?2[:\s.]/i, /<[Bb]>PART\s+II/i]
      let earliestEnd = htmlContent.length
      for (const pattern of endPatterns) {
        const endMatch = pattern.exec(htmlContent.slice(startPos))
        if (endMatch) earliestEnd = Math.min(earliestEnd, startPos + endMatch.index)
      }
      endPos = earliestEnd
    }

    const sectionHtml = htmlContent.slice(startPos, endPos)
    const soup = parse(sectionHtml, 'html.parser')
    const contentParts: string[] = []
    const tablesData: Dict[] = []
    const processedTables = new Set<Tag>()
    const processedTexts = new Set<string>()

    for (const elem of soup.findAll(['p', 'table'])) {
      if (elem.name === 'table') {
        if (elem.findParent('table')) continue
        if (processedTables.has(elem)) continue
        processedTables.add(elem)
        let result: string | null
        if (isBulletTable(elem)) result = extractBulletList(elem)
        else {
          const [headers, dataRows] = parseHtmlTableForNotes(elem)
          if (dataRows.length > 0) {
            tablesData.push({ headers, data: dataRows })
            result = tableToMarkdownNotes(headers, dataRows)
          } else result = null
        }
        if (result) {
          const key = textKey(result)
          if (!processedTexts.has(key)) {
            contentParts.push(result)
            processedTexts.add(key)
          }
        }
      } else if (elem.name === 'p') {
        if (elem.findParent('table')) continue
        const text = cleanParagraphText(getDirectText(elem))
        if (text) {
          const key = textKey(text)
          if (!processedTexts.has(key)) {
            contentParts.push(text)
            processedTexts.add(key)
          }
        }
      }
    }

    const key = `note_${noteId}`
    textBlocks[key] = { name: title, disclosure: [key], text: contentParts.join('\n\n') }
    if (tablesData.length > 0) textBlocks[key].tables = tablesData
  })
  return textBlocks
}

// ---------------------------------------------------------------------------------------------------------------
// SGML (pre-2000 plain-text filings)
// ---------------------------------------------------------------------------------------------------------------

function sgmlToText(content: string): string {
  let text = content.replace(/<PAGE>\s*/g, '\n\n')
  text = convertSgmlTables(text)
  text = text.replace(/<[^>]+>/g, '')
  text = cleanHtmlEntities(text)
  return text.replace(/\n{4,}/g, '\n\n\n')
}

const SGML_VALUE_RE = /(\(\s*\$?\s*(?:\d[\d,]*(?:\.\d+)?|\.\d+)\s*\)|\$\s*\d[\d,]*(?:\.\d+)?|\$\s*\.\d+|\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b|--+)/g

function convertSgmlTables(content: string): string {
  const formatTable = (_match: string, block: string): string => {
    const rawLines = block.split('\n')
    const colPositions: number[] = []
    let formatIdx: number | null = null
    for (let i = 0; i < rawLines.length; i++) {
      const rawLine = rawLines[i]!
      if (rawLine.includes('<S>') && rawLine.includes('<C>')) {
        formatIdx = i
        for (const cm of rawLine.matchAll(/<C>/g)) colPositions.push(cm.index!)
        break
      }
    }
    const labelEnd = colPositions.length > 0 ? colPositions[0]! : null
    const numValCols = colPositions.length || 1

    const headerEnd = formatIdx !== null ? formatIdx : 0
    const headerLines: string[] = []
    for (const hl of rawLines.slice(0, headerEnd)) {
      const cleaned = pyStrip(hl.replace(/<[^>]+>/g, ''))
      if (cleaned) headerLines.push(cleaned)
    }

    const dataStart = formatIdx !== null ? formatIdx + 1 : 0

    const rows: [string, string[]][] = []
    for (const rawLine of rawLines.slice(dataStart)) {
      const line = rawLine.replace(/<[^>]+>/g, '')
      const stripped = pyStrip(line)
      if (!stripped || /^[-=_\s$]+$/.test(stripped)) continue

      let label: string
      let valueZone: string
      if (labelEnd !== null) {
        label = pyStrip(line.slice(0, labelEnd).replace(/\.{2,}/g, ''))
        valueZone = line.slice(labelEnd)
      } else {
        label = stripped
        valueZone = stripped
      }
      const vals = [...valueZone.matchAll(SGML_VALUE_RE)].map((m) => pyStrip(m[0]))
      if (label || vals.length > 0) rows.push([label, vals])
    }

    if (rows.length === 0) return headerLines.length > 0 ? `\n${headerLines.join('\n')}\n` : ''

    let colHeaders: string[] = []
    for (const hl of headerLines) {
      if (/(?:January|February|March|April|May|June|July|August|September|October|November|December|\b\d{4}\b)/i.test(hl)) {
        const parts = pyStrip(hl).split(/\s{3,}/)
        if (parts.length >= numValCols) {
          colHeaders = parts.slice(-numValCols).map(pyStrip)
          break
        }
      }
    }
    if (colHeaders.length === 0) colHeaders = Array.from({ length: numValCols }, (_, i) => `Col ${i + 1}`)

    const preLines: string[] = []
    for (const hl of headerLines) {
      if (/^[-=_.\s]+$/.test(hl)) continue
      if (!colHeaders.some((ch) => ch === pyStrip(hl) || hl.includes(ch))) preLines.push(hl)
    }

    const mdLines: string[] = []
    mdLines.push(`| |${colHeaders.map((h) => ` ${h} `).join('|')}|`)
    mdLines.push(`|:---|${colHeaders.map(() => '---:').join('|')}|`)
    for (const [label, vals] of rows) {
      let padded = [...vals]
      while (padded.length < numValCols) padded.unshift('')
      padded = padded.slice(-numValCols)
      const displayLabel = label.endsWith(':') ? `**${label}**` : label
      mdLines.push(`| ${displayLabel} |${padded.map((v) => ` ${v} `).join('|')}|`)
    }
    const resultParts = [...preLines, ...(preLines.length > 0 ? [''] : []), ...mdLines]
    return `\n\n${resultParts.join('\n')}\n\n`
  }
  return content.replace(/<TABLE>(.*?)<\/TABLE>/gs, formatTable)
}

function getItemDefaultName(itemNum: string, part: string): string {
  const names: Record<string, string> =
    part === 'I'
      ? { '1': 'Financial Statements', '2': "Management's Discussion and Analysis", '3': 'Quantitative and Qualitative Disclosures About Market Risk', '4': 'Controls and Procedures' }
      : { '1': 'Legal Proceedings', '1A': 'Risk Factors', '2': 'Changes in Securities', '3': 'Defaults Upon Senior Securities', '4': 'Mine Safety Disclosures', '5': 'Other Information', '6': 'Exhibits' }
  return names[itemNum] ?? `Item ${itemNum}`
}

function extractItemsSgml(content: string): Record<string, Dict> {
  const text = sgmlToText(content)
  const items: Record<string, Dict> = {}

  const partPositions: [number, string][] = []
  for (const m of text.matchAll(/^[ \t]*PART\s+(I{1,3}|[1-3])\s*[-.\s]*\n/gim)) {
    let partVal = m[1]!.toUpperCase()
    if (partVal === '1') partVal = 'I'
    else if (partVal === '2') partVal = 'II'
    else if (partVal === '3') partVal = 'III'
    partPositions.push([m.index!, partVal])
  }

  const itemPattern = /^[ \t]*ITEM\s+(\d+[A-Za-z]?)\s*[.:\s]\s*(.+?)[ \t]*$/gim
  const rawMatches = [...text.matchAll(itemPattern)]
  if (rawMatches.length === 0) return items

  let tocEnd = 0
  if (rawMatches.length >= 4) {
    const gaps: number[] = []
    for (let i = 0; i < Math.min(rawMatches.length - 1, 6); i++) gaps.push(rawMatches[i + 1]!.index! - (rawMatches[i]!.index! + rawMatches[i]![0].length))
    const avgGap = gaps.length > 0 ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0
    if (avgGap < 300) {
      let found = false
      for (let i = 0; i < gaps.length; i++) {
        if (gaps[i]! > 500) {
          tocEnd = rawMatches[i]!.index! + rawMatches[i]![0].length
          found = true
          break
        }
      }
      if (!found) tocEnd = rawMatches[gaps.length]!.index! + rawMatches[gaps.length]![0].length
    }
  }

  const matches: [number, string, string][] = []
  for (const m of rawMatches) {
    if (m.index! < tocEnd) continue
    const itemNum = m[1]!.toUpperCase()
    let title = pyStrip(m[2]!)
    if (/^.{0,50}\d{1,3}\s*$/.test(title)) continue
    if (/^\p{Ll}/u.test(title.slice(0, 1))) continue
    title = title.replace(/[.\s]+$/, '')
    if (!title) continue
    matches.push([m.index!, itemNum, title])
  }
  if (matches.length === 0) return items

  const getPart = (pos: number): string => {
    let current = 'I'
    for (const [pPos, pVal] of partPositions) {
      if (pPos <= pos) current = pVal
      else break
    }
    return current
  }

  const seenItems = new Set<string>()
  matches.forEach(([pos, itemNum, itemTitle], i) => {
    let title = itemTitle
    let part = getPart(pos)
    if (seenItems.has(itemNum) && part === 'I') part = 'II'
    seenItems.add(itemNum)

    const endPos = i + 1 < matches.length ? matches[i + 1]![0] : text.length
    let sectionText = text.slice(pos, endPos)

    const headerEnd = sectionText.indexOf('\n')
    if (headerEnd > 0) {
      sectionText = sectionText.slice(headerEnd + 1)
      const cont = /^[ \t]*([A-Z][A-Z &/'.-]{2,40})[ \t]*\n\s*\n/.exec(sectionText)
      if (cont) {
        title = pyStrip(`${title} ${pyStrip(cont[1]!)}`)
        sectionText = sectionText.slice(cont[0].length)
      }
    }
    sectionText = pyStrip(sectionText.replace(/\n{3,}/g, '\n\n'))
    const key = part === 'II' ? `item_II_${itemNum}` : `item_${itemNum}`
    items[key] = { name: title || getItemDefaultName(itemNum, part), part, item_num: itemNum, text: sectionText }
  })
  return items
}

function getNegativeKeywords(statementType: string): string[] {
  const common = ['selected financial data', 'selected consolidated financial data', 'unit sales', 'unit shipment']
  const negatives: Record<string, string[]> = {
    income: ['cash flows', 'cash flow', 'balance sheet', 'financial position', 'financial condition', 'stockholders equity', 'shareholders equity'],
    balance: ['cash flows', 'cash flow', 'statements of operations', 'statements of earnings', 'statements of income'],
    cash: ['balance sheet', 'financial position', 'financial condition', 'statements of operations', 'statements of earnings', 'statements of income', 'stockholders equity'],
    equity: ['cash flows', 'cash flow', 'balance sheet', 'statements of operations', 'statements of earnings'],
  }
  return [...(negatives[statementType] ?? []), ...common]
}

function findBestSgmlTable(content: string, statementType: string): [string, number][] {
  const keywords = statementKeywords(statementType)
  const negativeKeywords = getNegativeKeywords(statementType)
  const candidates: [string, number, number][] = []

  for (const m of content.matchAll(/<TABLE>(.*?)<\/TABLE>/gis)) {
    const block = m[1]!
    let text = block.replace(/<[^>]+>/g, ' ').toLowerCase()
    text = collapse(text)
    const preambleStart = Math.max(0, m.index! - 600)
    const preamble = content.slice(preambleStart, m.index!).replace(/<[^>]+>/g, ' ').toLowerCase()
    const combined = `${preamble} ${text}`
    if (negativeKeywords.some((nk) => combined.includes(nk))) continue
    const score = keywords.filter((kw) => combined.includes(kw.toLowerCase())).length
    if (score <= 0) continue
    const numbers = text.match(/\d{1,3}(?:,\d{3})+/g) ?? []
    if (numbers.length < 5) continue
    candidates.push([block, m.index!, score + Math.floor(numbers.length / 10)])
  }
  if (candidates.length === 0) return []
  const bestScore = Math.max(...candidates.map((c) => c[2]))
  const threshold = bestScore * 0.5
  return candidates
    .filter((c) => c[2] >= threshold)
    .map((c): [string, number] => [c[0], c[1]])
    .sort((a, b) => a[1] - b[1])
}

function extractTableSubtitle(preamble: string, headerText: string): string | null {
  const combined = `${preamble}\n${headerText}`
  const m = /^\s*(LIABILITIES\s+AND\s+(?:SHAREHOLDERS?|STOCKHOLDERS?)[''’]?S?\s+EQUITY|(?:CURRENT\s+)?LIABILITIES|(?:CURRENT\s+)?ASSETS|(?:SHAREHOLDERS?|STOCKHOLDERS?)[''’]?S?\s+EQUITY)\s*$/im.exec(combined)
  if (m) {
    const raw = collapse(pyStrip(m[1]!))
    return pyTitle(raw).replaceAll(' And ', ' and ').replaceAll("'S", "'s")
  }
  return null
}

function parseSgmlValue(textIn: string): number | null {
  const text = pyStrip(textIn)
  if (!text || ['--', '---', '----', '-', '—'].includes(text)) return null
  const isNeg = text.includes('(') && text.includes(')')
  const clean = text.replace(new RegExp(`[$()${PY_WS}]`, 'g'), '').replaceAll(',', '')
  const val = pyFloatLoose(clean)
  if (val === null) return null
  return isNeg ? -val : val
}

const BLOCK_VALUE_RE = /(\(\s*\$?\s*(?:\d[\d,]*(?:\.\d+)?|\.\d+)\s*\)|\$\s*\d[\d,]*(?:\.\d+)?|\$\s*\.\d+|\b\d{1,3}(?:,\d{3})*(?:\.\d+)?\b|--+)/g

function extractBlockLineItems(blockText: string, numCols: number, fallbackTotalLabel: string | null): LineItem[] {
  const rawLines = blockText.split('\n')
  const colPositions: number[] = []
  let formatLineIdx: number | null = null
  for (let i = 0; i < rawLines.length; i++) {
    const rawLine = rawLines[i]!
    if (rawLine.includes('<S>') && rawLine.includes('<C>')) {
      formatLineIdx = i
      for (const m of rawLine.matchAll(/<C>/g)) colPositions.push(m.index!)
      break
    }
  }
  const blockNumCols = colPositions.length || numCols
  const labelEndPos = colPositions.length > 0 ? colPositions[0]! : null
  const dataStart = formatLineIdx !== null ? formatLineIdx + 1 : Math.min(10, rawLines.length)
  const dataLines = rawLines.slice(dataStart)

  const lineItems: LineItem[] = []
  let section: string | null = null
  let labelBuffer: string[] = []

  for (const rawLine of dataLines) {
    const line = rawLine.replace(/<[^>]+>/g, '')
    const stripped = pyStrip(line)

    if (!stripped) {
      if (labelBuffer.length > 0) {
        const combined = labelBuffer.join(' ')
        if (combined.replace(/\s+$/, '').endsWith(':')) section = pyStrip(combined.replace(/\s+$/, '').replace(/:+$/, ''))
        labelBuffer = []
      }
      continue
    }
    if (/^[-=_\s$]+$/.test(stripped)) {
      labelBuffer = []
      continue
    }
    const lower = stripped.toLowerCase()
    if (lower.includes('see accompanying') || lower.includes('see notes')) continue

    let labelZone: string
    let valueZone: string
    if (labelEndPos !== null) {
      labelZone = pyStrip(line.slice(0, labelEndPos))
      valueZone = line.slice(labelEndPos)
    } else {
      labelZone = stripped
      valueZone = stripped
    }

    const valMatches = [...valueZone.matchAll(BLOCK_VALUE_RE)].filter((m) => !/^(19|20)\d{2}$/.test(pyStrip(m[0])))
    const hasRealValues = valMatches.length > 0 && valMatches.some((m) => parseSgmlValue(m[0]) !== null)
    const hasDashes = valMatches.length > 0 && valMatches.every((m) => /^--+$/.test(pyStrip(m[0])))

    if (hasRealValues || hasDashes) {
      let fullLabel: string
      if (labelBuffer.length > 0) {
        const parts = [...labelBuffer, ...(labelZone ? [labelZone] : [])]
        fullLabel = parts.join(' ')
        labelBuffer = []
      } else fullLabel = labelZone

      fullLabel = fullLabel.replace(/\.{2,}/g, '')
      fullLabel = pyStrip(collapse(fullLabel))
      if (!fullLabel) {
        if (fallbackTotalLabel) fullLabel = `Total ${fallbackTotalLabel}`
        else if (section) fullLabel = `Total ${section}`
        else fullLabel = 'Total'
      }

      let values: (number | null)[] = valMatches.map((m) => parseSgmlValue(m[0]))
      if (values.length > blockNumCols) values = values.slice(-blockNumCols)
      while (values.length < blockNumCols) values.unshift(null)
      values = values.slice(0, blockNumCols)

      const labelLower = fullLabel.toLowerCase()
      const sharesPos = labelLower.indexOf('shares')
      const perPos = labelLower.indexOf('per')
      const isShareCount = sharesPos >= 0 && (perPos < 0 || sharesPos < perPos)
      const skipMult = !isShareCount && (/\bper\b.*\bshare\b/.test(labelLower) || labelLower.includes('eps'))
      lineItems.push({ label: fullLabel, section, values, skip_multiplier: skipMult })
    } else if (labelZone && labelZone.replace(/\s+$/, '').endsWith(':')) {
      const combined = [...labelBuffer, labelZone].join(' ')
      section = pyStrip(combined.replace(/\s+$/, '').replace(/:+$/, ''))
      labelBuffer = []
    } else if (labelZone) labelBuffer.push(labelZone)
  }
  return lineItems
}

function extractSgmlPeriods(lines: string[], numCols: number): string[] {
  const headerText = lines.join('\n')
  const monthRe = /((?:January|February|March|April|May|June|July|August|September|October|November|December)\s*\d{1,2})/gi
  const yearRe = /\b((?:19|20)\d{2})\b/g

  let dateFragments: string[] = []
  let yearFragments: string[] = []
  let dateLineIdx = -1

  lines.forEach((line, i) => {
    const monthsOnLine = [...line.matchAll(monthRe)].map((m) => m[1]!)
    if (monthsOnLine.length > 0) {
      dateFragments = monthsOnLine
      dateLineIdx = i
    }
  })

  if (dateFragments.length > 0 && dateLineIdx >= 0) {
    for (const line of lines.slice(dateLineIdx + 1, dateLineIdx + 5)) {
      const stripped = pyStrip(line)
      if (!stripped) continue
      const years = [...stripped.matchAll(yearRe)].map((m) => m[1]!)
      if (years.length > 0) {
        yearFragments = years
        break
      }
    }
    if (yearFragments.length > 0 && dateFragments.length === yearFragments.length) {
      return dateFragments.map((d, i) => `${pyStrip(d).replace(/,+$/, '')}, ${yearFragments[i]}`).slice(0, numCols)
    } else if (yearFragments.length > 0) {
      const periods: string[] = []
      yearFragments.forEach((y, i) => {
        if (i < dateFragments.length) periods.push(`${pyStrip(dateFragments[i]!).replace(/,+$/, '')}, ${y}`)
        else periods.push(y)
      })
      return periods.slice(0, numCols)
    }
  }

  const dateFullRe = /((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s*\d{4})/gi
  const dates = [...headerText.matchAll(dateFullRe)].map((m) => m[1]!)
  if (dates.length > 0) {
    const cleaned = dates.map((d) => collapse(pyStrip(d)).replace(/,\s*/g, ', '))
    if (cleaned.length >= numCols) return cleaned.slice(0, numCols)
    const monthDay = /^([A-Za-z]+\s+\d{1,2})/.exec(cleaned[0]!)
    const years = [...headerText.matchAll(yearRe)].map((m) => m[1]!)
    if (monthDay && years.length >= numCols) return years.slice(-numCols).map((y) => `${monthDay[1]}, ${y}`)
    return cleaned.slice(0, numCols)
  }

  for (const line of lines) {
    const stripped = pyStrip(line)
    const years = [...stripped.matchAll(yearRe)].map((m) => m[1]!)
    if (years.length >= 2 && !stripped.includes('$')) return years.slice(0, numCols)
  }
  return []
}

function sgmlHeaderEnd(lines: string[], fallback: number): number {
  for (let i = 0; i < lines.length; i++) if (lines[i]!.includes('<S>') && lines[i]!.includes('<C>')) return i
  return fallback
}

function parseSgmlStatement(content: string, statementType: string): StatementResult {
  const tables = findBestSgmlTable(content, statementType)
  if (tables.length === 0) return { data: [], meta: null }
  const keywords = statementKeywords(statementType)

  const [firstBlock, firstStart] = tables[0]!
  const preambleStart = Math.max(0, firstStart - 600)
  const preamble = content.slice(preambleStart, firstStart).replace(/<[^>]+>/g, '')

  const rawLinesFirst = firstBlock.split('\n')
  let numCols = 2
  for (const rawLine of rawLinesFirst) {
    if (rawLine.includes('<S>') && rawLine.includes('<C>')) {
      numCols = [...rawLine.matchAll(/<C>/g)].length || 2
      break
    }
  }

  const headerEnd = sgmlHeaderEnd(rawLinesFirst, 10)
  const headerText = rawLinesFirst.slice(0, headerEnd).join('\n').replace(/<[^>]+>/g, '')
  const headerLines = headerText.split('\n')

  const fullHeader = `${preamble}\n${headerText}`.toLowerCase()
  let multiplier: number
  if (fullHeader.includes('in millions') || fullHeader.includes('(millions)')) multiplier = 1_000_000
  else if (fullHeader.includes('in thousands') || fullHeader.includes('(thousands)')) multiplier = 1_000
  else if (fullHeader.includes('in billions')) multiplier = 1_000_000_000
  else multiplier = 1

  let title: string | null = null
  for (const line of `${preamble}\n${headerText}`.split('\n')) {
    const stripped = pyStrip(line)
    if (stripped && keywords.some((kw) => stripped.toLowerCase().includes(kw.toLowerCase()))) {
      title = stripped
      break
    }
  }

  let periods = extractSgmlPeriods(headerLines, numCols)
  if (periods.length === 0) {
    for (const [blockText] of tables.slice(1)) {
      const blockLines = blockText.split('\n')
      const blockHeaderEnd = sgmlHeaderEnd(blockLines, 10)
      const blockHeader = blockLines.slice(0, blockHeaderEnd).join('\n').replace(/<[^>]+>/g, '').split('\n')
      periods = extractSgmlPeriods(blockHeader, numCols)
      if (periods.length > 0) break
    }
  }
  if (periods.length === 0) periods = Array.from({ length: numCols }, (_, i) => `Period_${i + 1}`)

  const allLineItems: LineItem[] = []
  for (const [blockText, blockStart] of tables) {
    const blkPreambleStart = Math.max(0, blockStart - 600)
    const blkPreamble = content.slice(blkPreambleStart, blockStart).replace(/<[^>]+>/g, '')
    const blkLines = blockText.split('\n')
    const blkHeaderEnd = sgmlHeaderEnd(blkLines, Math.min(10, blkLines.length))
    const blkHeader = blkLines.slice(0, blkHeaderEnd).join('\n').replace(/<[^>]+>/g, '')
    const subtitle = extractTableSubtitle(blkPreamble, blkHeader)
    allLineItems.push(...extractBlockLineItems(blockText, numCols, subtitle))
  }
  if (allLineItems.length === 0) return { data: [], meta: null }
  return { data: buildStatementRows(allLineItems, periods, multiplier), meta: buildMeta(title, periods, multiplier) }
}

// ---------------------------------------------------------------------------------------------------------------
// plain-text notes
// ---------------------------------------------------------------------------------------------------------------

const TITLE_LOWERCASE_WORDS = new Set(['of', 'and', 'for', 'to', 'the', 'in', 'on', 'a', 'an', 'or'])

function extractNumberedTitleNotes(text: string): Record<string, Dict> {
  const heads = [...text.matchAll(/^[ \t]*Note\s+(\d{1,2})\s*[-.:–—]+\s*(\S.*?)[ \t]*$/gim)]
  if (heads.length < 2) return {}

  const lastEnd = heads.at(-1)!.index! + heads.at(-1)![0].length
  const tail = /^[ \t]*(?:ITEM\s+2\b|PART\s+II\b|SIGNATURES?\b|MANAGEMENT.S\s+DISCUSSION)/im.exec(text.slice(lastEnd))
  const end = tail ? lastEnd + tail.index : text.length

  const firsts: RegExpMatchArray[] = []
  const seen = new Set<string>()
  for (const head of heads) {
    if (!seen.has(head[1]!)) {
      seen.add(head[1]!)
      firsts.push(head)
    }
  }

  const notes: Record<string, Dict> = {}
  firsts.forEach((head, index) => {
    const number = head[1]!
    let title = pyStrip(head[2]!.replace(/\s{2,}\S.*$/, '')).replace(/\.+$/, '')
    title = pyStrip(title.replace(/\s*\(continued\)\s*$/i, ''))
    const stop = index + 1 < firsts.length ? firsts[index + 1]!.index! : end
    let body = text.slice(head.index! + head[0].length, stop)
    body = body.replace(/^[ \t]*(?:Note\s+\d+\s*[-.:–—]+|Notes?\s+to)[^\n]*\(continued\)[^\n]*$\n?/gim, '')
    notes[`note_${number}`] = { name: title || `Note ${number}`, disclosure: [`note_${number}`], text: pyStrip(body) }
  })
  return notes
}

/** `extract_plain_text_notes` */
export function extractPlainTextNotes(text: string): Record<string, Dict> {
  const numberedTitle = extractNumberedTitleNotes(text)
  if (Object.keys(numberedTitle).length > 0) return numberedTitle

  const heads = [...text.matchAll(/^[ \t]*Notes?\s+to\s+.{0,45}Financial Statements\.?[ \t]*$/gim)]
  if (heads.length === 0) return {}

  let section = text.slice(heads.at(-1)!.index! + heads.at(-1)![0].length)
  const end = /^[ \t]*(SIGNATURES|SCHEDULE\s+[IVXivx]+|EXHIBIT\s+INDEX|INDEX TO EXHIBITS)\b/im.exec(section)
  if (end) section = section.slice(0, end.index)

  const lines = section
    .split('\n')
    .filter((line) => !/^\s*(<PAGE>|<[^>]+>|\d{1,4})\s*$/.test(line))
    .map((line) => line.replace(/\s+$/, ''))

  const isHeading = (line: string, following: string): boolean => {
    const stripped = pyStrip(line)
    if (!(stripped.length >= 3 && stripped.length <= 48) || '.,:;-'.includes(stripped.at(-1)!)) return false
    if (!/^\p{Lu}/u.test(stripped[0]!) || isUpperStr(stripped)) return false
    if (/\s{3,}/.test(stripped) || hasDigit(stripped)) return false
    const cased = stripped.split(/\s+/).every((word) => /^\p{Lu}/u.test(word[0]!) || TITLE_LOWERCASE_WORDS.has(word.toLowerCase()))
    return cased && pyStrip(following).length > 55
  }

  const notes: Record<string, Dict> = {}
  let title: string | null = null
  let body: string[] = []
  let order = 0
  const flush = (): void => {
    if (title && body.length > 0) {
      order += 1
      const key = `note_${order}`
      notes[key] = { name: title, disclosure: [key], text: pyStrip(body.join(' ')) }
    }
    title = null
    body = []
  }
  lines.forEach((line, index) => {
    const following = index + 1 < lines.length ? lines[index + 1]! : ''
    if (isHeading(line, following)) {
      flush()
      title = pyStrip(line)
    } else if (title) body.push(pyStrip(line))
  })
  flush()
  return notes
}

function extractTextBlocksSgml(content: string): Record<string, Dict> {
  const text = sgmlToText(content)
  const textBlocks: Record<string, Dict> = {}
  const named = extractPlainTextNotes(text)

  const notesMatch = /NOTES?\s+TO\s+(?:(?:CONSOLIDATED|CONDENSED|INTERIM|UNAUDITED)\s+)*FINANCIAL\s+STATEMENTS?/i.exec(text)
  if (!notesMatch) return named

  const notesStart = notesMatch.index + notesMatch[0].length
  const endPatterns = [/\bITEM\s+2\b/i, /\bPART\s+II\b/i, /\bSIGNATURES?\b/i, /\bMANAGEMENT.S\s+DISCUSSION\b/i]
  let notesEnd = text.length
  for (const pattern of endPatterns) {
    const m = pattern.exec(text.slice(notesStart))
    if (m) notesEnd = Math.min(notesEnd, notesStart + m.index)
  }
  const notesText = text.slice(notesStart, notesEnd)

  const matches = [...notesText.matchAll(/^[ \t]*(\d{1,2})\.\s{1,4}(\S.+)/gm)]
  if (Object.keys(named).length >= matches.length) return named

  matches.forEach((m, i) => {
    const noteNum = m[1]!
    const start = m.index!
    const end = i + 1 < matches.length ? matches[i + 1]!.index! : notesText.length
    const body = pyStrip(notesText.slice(start, end)).replace(/^[ \t]*\d{1,2}\.\s+/, '')
    const key = `note_${noteNum}`
    textBlocks[key] = { name: `Note ${noteNum}`, disclosure: [key], text: body }
  })
  return textBlocks
}

// ---------------------------------------------------------------------------------------------------------------
// items
// ---------------------------------------------------------------------------------------------------------------

function cleanItemTitle(rawTitle: string): string {
  let title = rawTitle.replace(/<[Bb][Rr]\s*\/?>/g, ' ')
  title = title.replace(/<[^>]+>/g, '')
  title = cleanHtmlEntities(title)
  title = title.replace(/:?\s*$/, '')
  return pyStrip(collapse(title))
}

function get8kItemName(itemNum: string): string {
  const names: Record<string, string> = {
    '1.01': 'Entry into a Material Definitive Agreement',
    '1.02': 'Termination of a Material Definitive Agreement',
    '1.03': 'Bankruptcy or Receivership',
    '1.04': 'Mine Safety - Reporting of Shutdowns and Patterns of Violations',
    '2.01': 'Completion of Acquisition or Disposition of Assets',
    '2.02': 'Results of Operations and Financial Condition',
    '2.03': 'Creation of a Direct Financial Obligation',
    '2.04': 'Triggering Events That Accelerate or Increase a Direct Financial Obligation',
    '2.05': 'Costs Associated with Exit or Disposal Activities',
    '2.06': 'Material Impairments',
    '3.01': 'Notice of Delisting or Failure to Satisfy a Continued Listing Rule',
    '3.02': 'Unregistered Sales of Equity Securities',
    '3.03': 'Material Modification to Rights of Security Holders',
    '4.01': "Changes in Registrant's Certifying Accountant",
    '4.02': 'Non-Reliance on Previously Issued Financial Statements',
    '5.01': 'Changes in Control of Registrant',
    '5.02': 'Departure of Directors or Certain Officers',
    '5.03': 'Amendments to Articles of Incorporation or Bylaws',
    '5.04': "Temporary Suspension of Trading Under Registrant's Employee Benefit Plans",
    '5.05': "Amendment to Registrant's Code of Ethics",
    '5.06': 'Change in Shell Company Status',
    '5.07': 'Submission of Matters to a Vote of Security Holders',
    '5.08': 'Shareholder Director Nominations',
    '6.01': '[Reserved]',
    '6.02': '[Reserved]',
    '6.03': '[Reserved]',
    '6.04': '[Reserved]',
    '6.05': '[Reserved]',
    '7.01': 'Regulation FD Disclosure',
    '8.01': 'Other Events',
    '9.01': 'Financial Statements and Exhibits',
  }
  return names[itemNum] ?? `Item ${itemNum}`
}

function extract8kItems(htmlContent: string): Record<string, Dict> {
  const items: Record<string, Dict> = {}
  const itemPattern = /Item[\s\u2009]+(\d+\.\d+)[\s\u2009]*([^\n<]{0,100})/gi

  let matches: [number, string, string][] = []
  for (const m of htmlContent.matchAll(itemPattern)) {
    const itemNum = m[1]!
    let title = pyStrip(m[2]!)
    title = title.replace(/<[^>]+>/g, '')
    title = cleanHtmlEntities(title)
    title = pyStrip(collapse(title))
    if (title.length < 5) title = get8kItemName(itemNum)
    matches.push([m.index!, itemNum, title])
  }
  matches.sort((a, b) => a[0] - b[0])
  if (matches.length === 0) return items

  const seenItems = new Map<string, [number, string]>()
  let filtered: [number, string, string][] = []
  for (const [pos, itemNum, title] of matches) {
    if (seenItems.has(itemNum)) {
      const prevPos = seenItems.get(itemNum)![0]
      if (pos - prevPos > 1000) {
        filtered = filtered.filter((m) => m[1] !== itemNum)
        filtered.push([pos, itemNum, title])
        seenItems.set(itemNum, [pos, title])
      }
    } else {
      filtered.push([pos, itemNum, title])
      seenItems.set(itemNum, [pos, title])
    }
  }
  matches = filtered.sort((a, b) => a[0] - b[0])

  matches.forEach(([pos, itemNum, title], i) => {
    const endPos = i + 1 < matches.length ? matches[i + 1]![0] : htmlContent.length
    const sectionHtml = htmlContent.slice(pos, endPos)
    const soup = parse(sectionHtml, 'html.parser')
    const contentParts: string[] = []
    const processedTexts = new Set<string>()

    for (const elem of soup.findAll(['p', 'table', 'div', 'span'])) {
      if (elem.name === 'table') {
        if (elem.findParent('table')) continue
        let result: string | null
        if (isBulletTable(elem)) result = extractBulletList(elem)
        else if (!isFinancialTable(elem)) {
          let text = elem.getText(' ', true)
          text = cleanHtmlEntities(text)
          text = pyStrip(collapse(text))
          result = text.length > 20 ? text : null
        } else {
          const [headers, dataRows] = parseHtmlTableForNotes(elem)
          result = dataRows.length > 0 ? tableToMarkdownNotes(headers, dataRows) : null
        }
        if (result) {
          const key = textKey(result)
          if (!processedTexts.has(key)) {
            contentParts.push(result)
            processedTexts.add(key)
          }
        }
      } else if (elem.name === 'p' || elem.name === 'div') {
        if (elem.findParent('table')) continue
        let text = elem.getText(' ', true)
        text = cleanHtmlEntities(text)
        text = pyStrip(collapse(text))
        if (text && text.length > 10) {
          const key = textKey(text)
          if (!processedTexts.has(key)) {
            contentParts.push(text)
            processedTexts.add(key)
          }
        }
      }
    }
    items[`item_${itemNum}`] = { name: title || get8kItemName(itemNum), section: itemNum.split('.')[0], item_num: itemNum, text: contentParts.join('\n\n') }
  })
  return items
}

/** `extract_items`: filing items (MD&A, Risk Factors, …) by item identifier. */
export function extractItems(htmlContent: string, filingType: string | null = null): Record<string, Dict> {
  const items: Record<string, Dict> = {}

  let is8k = Boolean(filingType && filingType.toUpperCase().includes('8-K'))
  if (!is8k) is8k = /Item[\s\u2009]+\d+\.\d+/i.test(htmlContent)
  if (is8k) return extract8kItems(htmlContent)

  const itemPatternBold = /<[Bb]>Item\s*(?:&nbsp;)?(\d+[A-Za-z]?)\s*[:\s.]\s*(?:&nbsp;)?(.+?)<\/[Bb]>/gis
  const itemPatternSplit = /<[Bb]>Item\s*(?:&nbsp;)?(\d+[A-Za-z]?)\s*[:\s.]\s*(?:&nbsp;)?<\/[Bb]>\s*<\/TD>\s*<TD[^>]*>\s*<[Bb]>([^<]+)<\/[Bb]>/gi
  const itemPatternNonbold = />ITEM\s*(\d+[A-Za-z]?)\s*[.\s](?:&nbsp;)*\s*(?:<[^>]*>)*\s*([A-Z][^<]{5,100}?)\s*<\/FONT>/gis

  const matches: [number, string, string][] = []
  for (const m of htmlContent.matchAll(itemPatternSplit)) matches.push([m.index!, m[1]!.toUpperCase(), cleanItemTitle(m[2]!)])

  for (const m of htmlContent.matchAll(itemPatternBold)) {
    const itemNum = m[1]!.toUpperCase()
    const title = cleanItemTitle(m[2]!)
    if (!matches.some(([pos]) => Math.abs(pos - m.index!) < 100)) matches.push([m.index!, itemNum, title])
  }

  for (const m of htmlContent.matchAll(itemPatternNonbold)) {
    const itemNum = m[1]!.toUpperCase()
    const title = cleanItemTitle(m[2]!)
    if (title.length < 10) continue
    if (!matches.some(([pos, num]) => Math.abs(pos - m.index!) < 500 && num === itemNum)) matches.push([m.index!, itemNum, title])
  }

  matches.sort((a, b) => a[0] - b[0])
  if (matches.length === 0) {
    if (isSgmlContent(htmlContent)) return extractItemsSgml(htmlContent)
    return items
  }

  const seenItems = new Set<string>()
  matches.forEach(([pos, itemNum, title], i) => {
    let part: string
    if (itemNum === '1' && seenItems.size > 0) part = 'II'
    else if (['1', '2', '3', '4'].some((n) => seenItems.has(n)) && ['1', '2', '3', '4', '5', '6'].includes(itemNum)) part = seenItems.has(itemNum) ? 'II' : 'I'
    else part = 'I'
    seenItems.add(itemNum)

    const endPos = i + 1 < matches.length ? matches[i + 1]![0] : htmlContent.length
    const sectionHtml = htmlContent.slice(pos, endPos)
    const soup = parse(sectionHtml, 'html.parser')
    const contentParts: [string, string][] = []
    const processedTexts = new Set<string>()

    for (const elem of soup.findAll(['p', 'table'])) {
      if (elem.name === 'table') {
        if (elem.findParent('table')) continue
        let result: string | null
        if (isBulletTable(elem)) result = extractBulletList(elem)
        else if (!isFinancialTable(elem)) {
          let text = elem.getText(' ', true)
          text = cleanHtmlEntities(text)
          text = pyStrip(collapse(text))
          result = text.length > 20 ? text : null
        } else {
          const [headers, dataRows] = parseHtmlTableForNotes(elem)
          result = dataRows.length > 0 ? tableToMarkdownNotes(headers, dataRows) : null
        }
        if (result) {
          const key = textKey(result)
          if (!processedTexts.has(key)) {
            contentParts.push(['table', result])
            processedTexts.add(key)
          }
        }
      } else if (elem.name === 'p') {
        if (elem.findParent('table')) continue
        if (isSectionHeader(elem)) {
          let headerText = getDirectText(elem)
          headerText = cleanHtmlEntities(headerText)
          headerText = pyStrip(collapse(headerText))
          const key = textKey(headerText)
          if (!processedTexts.has(key)) {
            contentParts.push(['header', `## ${headerText}`])
            processedTexts.add(key)
          }
          continue
        }
        const text = cleanParagraphText(getDirectText(elem))
        if (text) {
          const key = textKey(text)
          if (!processedTexts.has(key)) {
            contentParts.push(['text', text])
            processedTexts.add(key)
          }
        }
      }
    }

    const fullText = contentParts.map((c) => c[1]).join('\n\n')
    const key = part === 'II' ? `item_II_${itemNum}` : `item_${itemNum}`
    items[key] = { name: title || getItemDefaultName(itemNum, part), part, item_num: itemNum, text: fullText }
  })
  return items
}
