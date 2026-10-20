// html2markdown, provider sec. Ported from openbb_sec/utils/html2markdown.py (OpenBB Platform 5.0.0, Apache-2.0); modified:
// split across the files of this directory (soup.ts is the Beautiful Soup emulation), bs4 → ./soup.ts.
//
// Import from here: `htmlToMarkdown(html, baseUrl?, keepTables?)` (or `htmlToMarkdown(html, { baseUrl, keepTables })`) and
// `convertTable(table: Tag, baseUrl?)` take the same arguments as Python's `html_to_markdown` and `convert_table`.
export { htmlToMarkdown, getTextContent, htmlEscape, type HtmlToMarkdownOptions } from './html-to-markdown.js'
export { convertTable, extractChartLegend, splitCompositeTable, makeSubTable } from './convert-table.js'
export { classifyTable, extractBulletList, extractFootnoteText, extractHeaderText, convertLayoutTable, extractCellText, cleanHtmlEntities } from './layout-tables.js'
export {
  BULLET_CHARS,
  INVISIBLE_CHARS,
  MONTHS_PATTERN,
  NO_SPACE_AFTER,
  NO_SPACE_BEFORE,
  cleanTableCells,
  collapseRepeatedHeaders,
  convertImageToHtml,
  detectAndMergeMultiindexHeaders,
  getHeaderLevel,
  isDataRowHeader,
  isHeaderElement,
  mergeContinuationTables,
  mergeSplitCells,
  mergeSplitRows,
  normalizeFinancialCell,
  normalizeFinancialRows,
  parseRowSemantic,
  removeEmptyColumns,
  stripAll,
  urljoin,
} from './table-clean.js'
export { extractPeriodsFromRows } from './extract-periods.js'
export { buildColumnHeadersFromColspan } from './column-headers.js'
export { joinSplitParagraphs, mergeConsecutiveHeaders, convertInlineSubheadings, normalizeBulletChars, removeRepeatedPageElements } from './markdown-post.js'
export { reflowAbsoluteLayout } from './reflow.js'
export { BeautifulSoup, Comment, NavigableString, Tag, parse } from './soup.js'
