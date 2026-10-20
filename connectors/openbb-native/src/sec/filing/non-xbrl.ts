// Filings without XBRL, provider sec. Ported from openbb_sec/models/sec_financials.py (`_initialize_non_xbrl`,
// `_parse_exhibit_statements`, `_parse_exhibit_disclosures`, `_parse_exhibit_items`, `_parse_non_xbrl_statement`;
// OpenBB Platform 5.0.0, Apache-2.0); modified: a DataFrame of line items is a list of rows.
import type { Row } from '../../types.js'
import type { FinancialStatements } from './financial-statements.js'
import { extractItems, extractTextBlocks, extractToc, findAllStatements, getStatementNames, parseNonXbrlStatementHtml } from './non-xbrl-parser.js'

type Dict = Record<string, any>

const nonEmpty = (v: Dict): boolean => Object.keys(v).length > 0

/** `FinancialStatements._parse_non_xbrl_statement`: the rows of a statement parsed from the main document's HTML. */
export async function parseNonXbrlStatement(fs: FinancialStatements, statement: string): Promise<Row[]> {
  const content = await fs.getMainDocumentContent()
  if (!content) throw new Error('No main document content found for this filing')
  const { data } = parseNonXbrlStatementHtml(content, statement)
  if (data.length === 0) throw new Error(`Could not find ${statement} statement in the filing. This may be a non-standard HTML format.`)
  return data
}

function addStatements(fs: FinancialStatements, results: Record<string, { data: Dict[]; meta: Dict | null }>, names: Record<string, string>, keepExisting: boolean): void {
  for (const [stmtType, r] of Object.entries(results)) {
    if (keepExisting && stmtType in fs._nonXbrlStatements) continue
    fs._nonXbrlStatements[stmtType] = { name: names[stmtType] ?? stmtType[0]!.toUpperCase() + stmtType.slice(1), data: r.data, meta: r.meta }
  }
}

async function exhibitDocuments(fs: FinancialStatements, priority: string[]): Promise<{ embedded: string[]; downloaded: string[] }> {
  const embedded: string[] = []
  for (const key of priority) {
    const html = await fs.getEmbeddedDocument(key)
    if (html) embedded.push(html)
  }
  return { embedded, downloaded: [] }
}

/** `_parse_exhibit_statements`: statements from exhibits (an EX-13 annual report). */
async function parseExhibitStatements(fs: FinancialStatements, names: Record<string, string>): Promise<void> {
  const exhibitPriority = ['EX-13', 'EX-13.1', 'EX-13.2', '13', 'ANNUAL REPORT']

  for (const key of exhibitPriority) {
    const exhibitHtml = await fs.getEmbeddedDocument(key)
    if (exhibitHtml) {
      try {
        addStatements(fs, findAllStatements(exhibitHtml), names, true)
        if (nonEmpty(fs._nonXbrlStatements)) return
      } catch {
        continue
      }
    }
  }

  // Fall back to downloading exhibits if not embedded
  const exhibits = fs.exhibits()
  for (const key of exhibitPriority) {
    if (exhibits.has(key)) {
      try {
        const url = exhibits.get(key)!.url || ''
        if (!url) continue
        const exhibitHtml = await fs.documentText(url)
        if (exhibitHtml) {
          addStatements(fs, findAllStatements(exhibitHtml), names, true)
          if (nonEmpty(fs._nonXbrlStatements)) return
        }
      } catch {
        continue
      }
    }
  }

  // If still no statements, try all HTML exhibits
  for (const key of exhibits.keys()) {
    if (exhibitPriority.includes(key)) continue
    const url = exhibits.get(key)!.url || ''
    if (!(url.endsWith('.htm') || url.endsWith('.html'))) continue
    try {
      const exhibitHtml = await fs.documentText(url)
      if (exhibitHtml) {
        addStatements(fs, findAllStatements(exhibitHtml), names, true)
        if (nonEmpty(fs._nonXbrlStatements)) return
      }
    } catch {
      continue
    }
  }
}

/** `_parse_exhibit_disclosures`: the notes from an EX-13 when the main document has none. */
async function parseExhibitDisclosures(fs: FinancialStatements): Promise<void> {
  const exhibitPriority = ['EX-13', 'EX-13.1', 'EX-13.2', '13']
  for (const key of exhibitPriority) {
    const exhibitHtml = await fs.getEmbeddedDocument(key)
    if (exhibitHtml) {
      try {
        const disclosures = extractTextBlocks(exhibitHtml)
        if (nonEmpty(disclosures)) {
          fs._disclosuresStore = disclosures
          fs._nonXbrlTextBlocks = disclosures
          return
        }
      } catch {
        continue
      }
    }
  }
  const exhibits = fs.exhibits()
  for (const key of exhibitPriority) {
    if (exhibits.has(key)) {
      try {
        const url = exhibits.get(key)!.url || ''
        if (!url) continue
        const exhibitHtml = await fs.documentText(url)
        if (exhibitHtml) {
          const disclosures = extractTextBlocks(exhibitHtml)
          if (nonEmpty(disclosures)) {
            fs._disclosuresStore = disclosures
            fs._nonXbrlTextBlocks = disclosures
            return
          }
        }
      } catch {
        continue
      }
    }
  }
}

/** `_parse_exhibit_items`: items (and notes) from an EX-13 when the main document has none. */
async function parseExhibitItems(fs: FinancialStatements): Promise<void> {
  const exhibitPriority = ['EX-13', 'EX-13.1', 'EX-13.2', '13']
  for (const key of exhibitPriority) {
    const exhibitHtml = await fs.getEmbeddedDocument(key)
    if (exhibitHtml) {
      try {
        const items = extractItems(exhibitHtml)
        if (nonEmpty(items)) {
          fs._items = items as any
          if (!nonEmpty(fs._disclosuresStore)) {
            const disclosures = extractTextBlocks(exhibitHtml)
            if (nonEmpty(disclosures)) {
              fs._disclosuresStore = disclosures
              fs._nonXbrlTextBlocks = disclosures
            }
          }
          return
        }
      } catch {
        continue
      }
    }
  }
  const exhibits = fs.exhibits()
  for (const key of exhibitPriority) {
    if (exhibits.has(key)) {
      try {
        const url = exhibits.get(key)!.url || ''
        if (!url) continue
        const exhibitHtml = await fs.documentText(url)
        if (exhibitHtml) {
          const items = extractItems(exhibitHtml)
          if (nonEmpty(items)) {
            fs._items = items as any
            if (!nonEmpty(fs._disclosuresStore)) {
              const disclosures = extractTextBlocks(exhibitHtml)
              if (nonEmpty(disclosures)) {
                fs._disclosuresStore = disclosures
                fs._nonXbrlTextBlocks = disclosures
              }
            }
            return
          }
        }
      } catch {
        continue
      }
    }
  }
}

/** `_initialize_non_xbrl`: statements, table of contents, notes and items parsed from the HTML of a filing with no XBRL. */
export async function initializeNonXbrl(fs: FinancialStatements): Promise<void> {
  if (fs._nonXbrlInitialized) return
  try {
    let mainDoc = (await fs.getEmbeddedDocument('10-K')) || (await fs.getEmbeddedDocument('10-Q'))
    if (!mainDoc) mainDoc = (await fs.getEmbeddedDocument('10-K/A')) || (await fs.getEmbeddedDocument('10-Q/A'))

    let htmlContent: string | null
    if (mainDoc) htmlContent = mainDoc
    else {
      const mainUrl = fs.getMainDocumentUrl()
      htmlContent = mainUrl ? await fs.documentText(mainUrl) : await fs.getMainDocumentContent()
      if (!htmlContent) return
    }

    const statementsData = findAllStatements(htmlContent)
    const statementNames = getStatementNames()
    addStatements(fs, statementsData, statementNames, false)

    if (!nonEmpty(fs._nonXbrlStatements)) await parseExhibitStatements(fs, statementNames)

    fs._toc = extractToc(htmlContent)

    fs._nonXbrlTextBlocks = extractTextBlocks(htmlContent)
    fs._disclosuresStore = fs._nonXbrlTextBlocks
    if (!nonEmpty(fs._disclosuresStore)) await parseExhibitDisclosures(fs)

    if (!nonEmpty(fs._items)) {
      fs._items = extractItems(htmlContent) as any
      if (!nonEmpty(fs._items)) await parseExhibitItems(fs)
    }
    fs._nonXbrlInitialized = true
  } catch (e) {
    fs.ctx.log(`Failed to parse non-XBRL filing: ${e instanceof Error ? e.message : String(e)}`)
  }
}

void exhibitDocuments
