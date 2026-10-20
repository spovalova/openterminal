// The one place the filing routes call html_to_markdown, provider sec. Ported from openbb_sec/models/sec_filing.py
// (`Filing._clean_html_to_text`; OpenBB Platform 5.0.0, Apache-2.0); modified: html_to_markdown is ../markdown/html2markdown.ts.
import { htmlToMarkdown } from '../markdown/html2markdown.js'
import { stripMarkdownFooters } from './sections.js'

/** `Filing._clean_html_to_text`: filing HTML as markdown without page footers. */
export function cleanHtmlToText(html: string | Uint8Array, baseUrl: string, keepTables = false): string {
  if (!html || (typeof html !== 'string' && html.length === 0)) return ''
  const text = typeof html === 'string' ? html : Buffer.from(html).toString('utf8')
  return stripMarkdownFooters(htmlToMarkdown(text, baseUrl, keepTables))
}
