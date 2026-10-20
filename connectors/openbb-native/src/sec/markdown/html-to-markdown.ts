// html_to_markdown, provider sec. Ported from openbb_sec/utils/html2markdown.py lines 6100-6905 and
// `get_text_content` (lines 5132-5224) (OpenBB Platform 5.0.0, Apache-2.0); modified: bs4 → ./soup.ts, bytes are
// decoded as UTF-8 with replacement characters instead of being dropped.
import { convertTable } from './convert-table.js'
import { getHeaderLevel, isHeaderElement, mergeContinuationTables, NO_SPACE_AFTER, NO_SPACE_BEFORE, BULLET_CHARS, convertImageToHtml, urljoin } from './table-clean.js'
import { joinSplitParagraphs, mergeConsecutiveHeaders, convertInlineSubheadings, normalizeBulletChars, removeRepeatedPageElements } from './markdown-post.js'
import { reflowAbsoluteLayout } from './reflow.js'
import { Comment, NavigableString, parse, Tag } from './soup.js'
import { isAlpha, strip } from './py.js'
import { WIN1252_MAP } from './win1252.js'

/**
 * Get text from element, handling XBRL wrappers and preserving word boundaries.
 *
 * If preserve_links_in_text is True, converts <a> tags to markdown [text](href) format.
 */
export function getTextContent(element: Tag | NavigableString, preserveLinksInText = false, baseUrl = ''): string {
  if (element instanceof NavigableString) return element.text

  const texts: string[] = []
  for (const child of element.contents) {
    if (child instanceof NavigableString) texts.push(child.text)
    else if ((child as Tag).name === 'br') texts.push(' ') // Treat line breaks as spaces
    else if ((child as Tag).name === 'a' && preserveLinksInText) {
      const c = child as Tag
      // Convert link to markdown format
      let href = c.getStr('href', '')
      const linkText = c.getText('', true)
      if (href && linkText) {
        // Keep anchor links as-is, resolve relative links
        if (!href.startsWith('#') && baseUrl && !(href.startsWith('http://') || href.startsWith('https://'))) href = urljoin(baseUrl, href)
        texts.push(`[${linkText}](${href})`)
      } else texts.push(linkText || '')
    } else if ((child as Tag).name && (child as Tag).name.startsWith('ix:')) {
      // XBRL wrapper - get its text content
      texts.push((child as Tag).getText(' '))
    } else texts.push(getTextContent(child as Tag, preserveLinksInText, baseUrl))
  }

  const resultParts: string[] = []
  let hadWhitespaceSeparator = false

  for (const rawT of texts) {
    const t = rawT.replaceAll('\xa0', ' ') // Normalize non-breaking spaces first

    if (!strip(t)) {
      // This prevents split words like <b>INCOM</b><b>E</b> → "INCOM E"
      // while preserving spaces where <b>WORD1</b><b> </b><b>WORD2</b>.
      if (resultParts.length) hadWhitespaceSeparator = true
      continue
    }

    if (resultParts.length) {
      const lastPart = resultParts[resultParts.length - 1]!
      const lastChar = lastPart ? lastPart[lastPart.length - 1]! : ''
      const firstChar = t ? t[0]! : ''

      if (hadWhitespaceSeparator) {
        // Explicit whitespace between parts — add space unless
        // punctuation rules say not to
        if (!NO_SPACE_AFTER.has(lastChar) && !NO_SPACE_BEFORE.has(firstChar)) resultParts.push(' ')
        // Adjacent elements of the same type with no separator
        // (e.g. <b>INCOM</b><b>E</b>) are parts of one word.
      } else if (!(isAlpha(lastChar) && isAlpha(firstChar)) && !NO_SPACE_AFTER.has(lastChar) && !NO_SPACE_BEFORE.has(firstChar)) resultParts.push(' ')

      hadWhitespaceSeparator = false
    }

    resultParts.push(t)
  }

  const result = resultParts.join('')
  // Collapse any remaining multiple spaces
  return result.replace(/ +/g, ' ')
}

/** Minimal HTML escaping for reflowed text. */
export function htmlEscape(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

export type HtmlToMarkdownOptions = { baseUrl?: string; keepTables?: boolean | null }

const HEADER_PATTERNS = [
  /^(Introduction)$/gim,
  /^(Executive Overview)$/gim,
  /^(Financial Overview)$/gim,
  /^(Business Environment)$/gim,
  /^(Critical Accounting Policies)$/gim,
  /^(Results of Operations)$/gim,
  /^(Liquidity and Capital Resources)$/gim,
  /^(Risk Management)$/gim,
  /^(Balance Sheet Analysis)$/gim,
  /^(Segment Results)$/gim,
  /^(Recent Developments)$/gim,
  /^(Forward[-\s]Looking Statements?)$/gim,
  /^(Market Risk)$/gim,
  /^(Credit Risk)$/gim,
  /^(Operational Risk)$/gim,
  /^(Legal Proceedings?)$/gim,
  /^(Controls and Procedures)$/gim,
  /^(Fair Value)$/gim,
  /^(Allowance for Credit Losses)$/gim,
  /^(Capital)$/gim,
  /^(Funding)$/gim,
]

const INVISIBLE_RE = /font-size\s*:\s*1(?:pt|px)/i
const WHITE_RE = /color\s*:\s*white/i
const TOC_STRING_RE = /^\s*Table of Contents\s*$/i
const TOC_HEADING_RE = /^#{1,6}\s+Table of Contents/i

/**
 * Convert SEC HTML content to Markdown format.
 *
 * @param htmlContent HTML content to convert
 * @param baseUrl Base URL for resolving relative links and images
 * @param keepTables If True, convert tables to markdown tables. If False, skip tables entirely.
 */
export function htmlToMarkdown(htmlContent: string | Uint8Array, baseUrlOrOptions: string | HtmlToMarkdownOptions = '', keepTablesArg: boolean | null = true): string {
  let baseUrl: string
  let keepTables: boolean | null
  if (typeof baseUrlOrOptions === 'object') {
    baseUrl = baseUrlOrOptions.baseUrl ?? ''
    keepTables = baseUrlOrOptions.keepTables === undefined ? true : baseUrlOrOptions.keepTables
  } else {
    baseUrl = baseUrlOrOptions
    keepTables = keepTablesArg
  }
  // Handle legacy parameter
  if (!keepTables) keepTables = false

  if (!htmlContent) return ''

  let html = typeof htmlContent === 'string' ? htmlContent : Buffer.from(htmlContent).toString('utf8')

  // Remove XML declaration
  html = html.replace(/<\?xml[\s\S]*?\?>/gi, '')

  for (const [entity, char] of WIN1252_MAP) html = html.replaceAll(entity, char)

  // Detect and rewrite absolute-positioned layouts (e.g. TD 40-F
  // exhibits generated by PDF-to-HTML converters) into flowing HTML
  // before the main converter processes them.
  const reflowed = reflowAbsoluteLayout(html)
  if (reflowed !== null) html = reflowed

  const soup = parse(html, 'lxml')

  // Remove hidden XBRL elements and junk
  for (const tag of soup.findAll(['ix:header', 'ix:hidden', 'script', 'style', 'noscript'])) tag.decompose()

  for (const comment of soup.findAllStrings({ string: (s) => s instanceof Comment })) comment.extract()

  for (const tag of soup.findAll(true)) {
    if (tag.attrs.size && tag.attrs.has('style')) {
      const style = tag.getStr('style', '').toLowerCase().replaceAll(' ', '')
      if (style.includes('display:none') || style.includes('visibility:hidden')) {
        // Do NOT decompose table cells (td/th) — their colspan
        // is structural even when hidden.  Removing them breaks
        // the column grid and causes data columns to disappear.
        // Instead, clear their content so they remain as empty
        // placeholders in the grid.
        if (tag.name === 'td' || tag.name === 'th') tag.string = ''
        else tag.decompose()
      }
    }
  }

  mergeContinuationTables(soup)

  // Presentation slide decks (e.g. Spotify 6-K EX-99):
  // Each slide is a <div class="slide"> containing an <img> (the
  // actual slide) and a <div class="slideText"> with invisible
  // (1pt / white) accessibility text.  The text is an unstructured
  // dump that doesn't convert to readable markdown.  Convert the
  // slideText content into HTML comments so it is preserved for
  // search / AI consumption but not rendered visually.
  const slideDivs = soup.findAll('div', { class_: 'slide' })
  if (slideDivs.length >= 3) {
    // at least 3 slides → slide deck
    for (const sd of slideDivs) {
      for (const st of sd.findAll('div', { class_: 'slideText' })) {
        let txt = st.getText(' ', true)
        txt = strip(txt.replace(/\s+/g, ' '))
        if (txt) st.replaceWith(new Comment(` ${txt} `))
        else st.decompose()
      }
    }
    // Also remove the spacer divs between slides.
    for (const sp of soup.findAll('div', { class_: 'spaceAfterSlideText' })) sp.decompose()
  }

  // General invisible accessibility text (e.g. LOW 8-K infographics):
  // Some filings embed tiny white text (<font style="font-size:1pt;
  // color:white">) as accessibility descriptions for images.  This
  // text dumps as an unformatted wall of text in markdown.  Convert
  // it to HTML comments so it's preserved for search / AI but not
  // rendered visually.  This handles patterns not covered by the
  // slide-deck detection above.
  for (const invTag of soup.findAll(['font', 'span', 'div', 'p'])) {
    const style = invTag.getStr('style', '')
    if (!style) continue
    if (INVISIBLE_RE.test(style) && WHITE_RE.test(style)) {
      let txt = invTag.getText(' ', true)
      txt = strip(txt.replace(/\s+/g, ' '))
      if (txt && txt.length > 20) invTag.replaceWith(new Comment(` ${txt} `))
      else if (!txt) invTag.decompose()
      // Short text (<= 20 chars) is left alone — unlikely to be
      // meaningful accessibility description.
    }
  }

  // Track whether we have already emitted a TOC / page-navigation table.
  // Older SEC exhibits (e.g. IBM 2008 Annual Report) embed the same sidebar
  // navigation table on every page — dozens of copies.  We keep only the
  // first one and suppress the rest.
  let seenTocTable = false

  /** Recursively process element to markdown. */
  const processElement = (element: Tag | NavigableString, depth = 0): string => {
    if (element instanceof NavigableString) {
      // Preserve Comment nodes as HTML comments in markdown output.
      if (element instanceof Comment) return `<!--${element.text}-->\n\n`
      let text = element.text
      // Normalize whitespace: convert tabs/newlines to spaces, collapse multiple spaces
      text = text.replaceAll('\xa0', ' ') // Non-breaking space
      text = text.replace(/[\t\n\r]+/g, ' ')
      text = text.replace(/ +/g, ' ') // Collapse multiple spaces
      return text
    }

    if (['script', 'style', 'noscript'].includes(element.name)) return ''

    // Skip "Table of Contents" page-header elements.
    // SEC filings repeat these at every page break.  Two patterns:
    //   1) A simple div/p whose *only* text is the TOC link.
    //   2) A container div (often with min-height style) that holds
    //      a TOC link *plus* a running section name (e.g.
    //      "Notes to Consolidated Financial Statements — (continued)").
    // Both are navigation artefacts, not document content.
    if (element.name === 'div' || element.name === 'p') {
      const tocLink = element.findAll('a', { attrs: { href: true } }).find((a) => {
        const s = a.string
        return s !== null && TOC_STRING_RE.test(s.text)
      })
      if (tocLink) {
        const fullText = element.getText(' ', true)
        if (fullText.length < 200) return '' // Skip this navigation / page-header element
      }
    }

    // Also skip h1-h6 navigation headings whose sole text is "Table of Contents".
    // Some SEC filings embed these as page-break separators (e.g. <h5>Table of Contents</h5>).
    if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(element.name)) {
      const hText = element.getText(' ', true)
      if (TOC_STRING_RE.test(hText)) return ''
    }

    // This handles modern HTML where anchors use id= on div/p/td/etc
    const elementId = element.getStr('id')
    let anchorPrefix = ''

    if (elementId && element.name !== 'a') {
      // Don't double-process <a> tags
      anchorPrefix = `<a id="${elementId}"></a>`
    }

    // Handle XBRL inline elements (ix:continuation, ix:nonNumeric, etc.)
    // These are containers that should preserve the structure of their children
    if (element.name.startsWith('ix:')) {
      const parts: string[] = []

      for (const child of element.contents) {
        if (child instanceof NavigableString) {
          const text = strip(child.text)
          if (text) parts.push(text)
        } else parts.push(processElement(child as Tag, depth + 1))
      }
      // Join with empty string to preserve paragraph breaks (\n\n) from children
      return parts.join('')
    }

    // Images - use helper to preserve sizes
    if (element.name === 'img') {
      const imgMd = convertImageToHtml(element, baseUrl)

      if (imgMd) return `\n\n${imgMd}\n\n`

      return ''
    }

    // Tables
    if (element.name === 'table') {
      if (keepTables) {
        // Detect TOC / page-navigation tables and suppress duplicates.
        // Older SEC exhibits (e.g. IBM 2008 Annual Report) embed a
        // sidebar navigation table on every page.  These tables have
        // section names with page numbers — NOT financial data.
        // Key signal: a row whose first cell says "Management
        // Discussion" (or similar TOC heading) combined with most
        // rows ending in a bare page-number integer.
        const tblRows = element.findAll('tr')
        if (tblRows.length >= 5) {
          let hasTocHeading = false
          let pageNumRows = 0
          for (const tr of tblRows) {
            const cells = tr.findAll(['td', 'th'])
            if (cells.length === 0) continue
            const first = cells[0]!.getText('', true).toLowerCase()
            if (first === 'management discussion' || first === 'table of contents' || first.startsWith('management\n')) hasTocHeading = true
            const last = cells[cells.length - 1]!.getText('', true)
            if (/^\p{Nd}+$/u.test(last) && 0 < parseInt(last, 10) && parseInt(last, 10) < 300) pageNumRows++
          }
          if (hasTocHeading && pageNumRows >= tblRows.length * 0.5) {
            if (seenTocTable) return '' // Already emitted one — skip
            seenTocTable = true
          }
        }
        return '\n\n' + convertTable(element, baseUrl) + '\n\n'
      }
      return ''
    }

    // Headers
    if (isHeaderElement(element)) {
      const anchorTag = element.find('a', { attrs: { name: true } })
      let anchorHtml = anchorPrefix // Use element's id if present

      if (anchorTag) {
        const anchorName = anchorTag.getStr('name')
        if (anchorName) anchorHtml = `<a id="${anchorName}"></a>\n\n`
      } else if (anchorPrefix) anchorHtml = anchorPrefix + '\n\n'

      let text = strip(getTextContent(element))
      text = text.replace(/\s+/g, ' ')

      if (text) {
        const level = getHeaderLevel(element)
        return `\n\n${anchorHtml}${'#'.repeat(level)} ${text}\n\n`
      }

      return anchorHtml || ''
    }

    // Lists
    if (element.name === 'ul') {
      const items: string[] = []

      for (const li of element.findAll('li', { recursive: false })) {
        // Check for id on li element
        const liId = li.getStr('id')
        const liAnchor = liId ? `<a id="${liId}"></a>` : ''
        const itemText = strip(processElement(li, depth + 1))

        if (itemText) items.push(`- ${liAnchor}${itemText}`)
      }

      const result = items.length ? '\n' + items.join('\n') + '\n' : ''

      return anchorPrefix ? `${anchorPrefix}${result}` : result
    }

    if (element.name === 'ol') {
      const items: string[] = []

      element.findAll('li', { recursive: false }).forEach((li, idx) => {
        // Check for id on li element
        const liId = li.getStr('id')
        const liAnchor = liId ? `<a id="${liId}"></a>` : ''
        const itemText = strip(processElement(li, depth + 1))

        if (itemText) items.push(`${idx + 1}. ${liAnchor}${itemText}`)
      })

      const result = items.length ? '\n' + items.join('\n') + '\n' : ''

      return anchorPrefix ? `${anchorPrefix}${result}` : result
    }

    // Paragraphs and divs
    if (element.name === 'p' || element.name === 'div') {
      // Chart divs produced by _build_chart_summary() should be
      // preserved as raw HTML blocks in the markdown output.
      const cls = element.get('class')
      if (cls && cls.length && (Array.isArray(cls) ? cls : [cls]).includes('chart')) return `\n\n${element.toString()}\n\n`

      // Check if this is an inline element (display:inline in style)
      // Be careful not to match "display:inline-block" which is block-level
      const style = element.getStr('style', '')
      const isInline = /display:\s*inline(?:\s*;|\s*$|(?![a-z-]))/i.test(style)
      const hasBold = /font-weight:\s*(bold|bolder|[6-9]00)/i.test(style)
      const hasItalic = /font-style:\s*italic/i.test(style)

      // Check if this is a CSS table-row with bullet (display: table-row)
      // These are used as pseudo-lists in SEC filings
      const isTableRow = style.includes('display: table-row') || style.includes('display:table-row')

      if (isTableRow) {
        // Look for bullet in first table-cell, text in second
        const cells = element.findAll('div', { attrs: { style: /display:\s*table-cell/i } })
        if (cells.length >= 2) {
          const firstCellText = cells[0]!.getText('', true)

          if (BULLET_CHARS.has(firstCellText)) {
            // This is a bullet item - extract text from remaining cells
            let text = cells
              .slice(1)
              .map((c) => c.getText(' ', true))
              .join(' ')
            text = strip(text.replace(/\s+/g, ' '))
            if (text) return `\n- ${text}`
          }
        }
      }

      // These are section headers where an anchor tag splits bold text
      const childrenList = [...element.contents]
      const childrenText: string[] = []
      let skipUntil = -1

      for (let ci = 0; ci < childrenList.length; ci++) {
        const child = childrenList[ci]!
        if (ci <= skipUntil) continue
        // Check for anchor with bold content followed by sibling bold
        if (child instanceof Tag && child.name === 'a' && (child.getStr('name') || child.getStr('id'))) {
          const innerB = child.find(['b', 'strong'])

          if (innerB) {
            const anchorText = child.getText()

            if (strip(anchorText)) {
              // Look for following <b>/<strong> siblings
              let combined = anchorText
              let lastConsumed = ci
              let foundBoldSib = false

              for (let j = ci + 1; j < childrenList.length; j++) {
                const sib = childrenList[j]!

                if (sib instanceof NavigableString && strip(sib.text) === '') {
                  lastConsumed = j
                  continue
                }

                if (sib instanceof Tag && (sib.name === 'b' || sib.name === 'strong')) {
                  combined += sib.getText()
                  lastConsumed = j
                  foundBoldSib = true
                } else break
              }

              if (foundBoldSib) {
                const anchorId = child.getStr('name') || child.getStr('id')
                const anchorHtml = `<a id="${anchorId}"></a>\n\n`
                combined = strip(combined.replace(/\s+/g, ' '))
                childrenText.push(`\n\n${anchorHtml}### ${combined}\n\n`)
                skipUntil = lastConsumed
                continue
              }
            }
          }
        }

        childrenText.push(processElement(child as Tag | NavigableString, depth + 1))
      }

      let text = strip(childrenText.join(''))

      if (text) {
        if (isInline) {
          // Apply bold/italic formatting for CSS-styled inline elements
          if (hasBold && hasItalic) text = `***${text}***`
          else if (hasBold) text = `**${text}**`
          else if (hasItalic) text = `*${text}*`
          return anchorPrefix ? `${anchorPrefix}${text}` : text
        }

        // Convert to proper heading + paragraph
        const subheadingMatch = /^(\*{2,3})([^*]+)\1\s*\.\s*(.+)$/s.exec(text)

        if (subheadingMatch) {
          const title = strip(subheadingMatch[2]!)
          const body = strip(subheadingMatch[3]!)

          return `\n\n${anchorPrefix}#### ${title}\n\n${body}\n\n`
        }

        return `\n\n${anchorPrefix}${text}\n\n`
      }

      return anchorPrefix || ''
    }

    // Line breaks
    if (element.name === 'br') return '\n'

    // Horizontal rules
    if (element.name === 'hr') return '\n\n---\n\n'

    // Anchor tags - handle both links and anchor targets
    if (element.name === 'a') {
      const name = element.getStr('name')
      const elemId = element.getStr('id') // Modern HTML uses id instead of name
      let href: string | undefined = element.has('href') ? element.getStr('href') : undefined
      const text = strip(getTextContent(element))

      // Anchor target (for TOC links to jump to) - support both name and id
      if (name || elemId) {
        const anchorId = name || elemId // Prefer name, fall back to id
        const anchor = `<a id="${anchorId}"></a>`

        if (text) return `${anchor}\n${text}`

        return anchor
      }

      // Regular link
      if (href && text) {
        if (!href.startsWith('#') && baseUrl && !(href.startsWith('http://') || href.startsWith('https://'))) href = urljoin(baseUrl, href)

        return `[${text}](${href})`
      }

      return text || ''
    }

    // Bold - process children to preserve anchors inside
    if (element.name === 'b' || element.name === 'strong') {
      if (element.find('img') && !element.getText('', true)) {
        const parts: string[] = []

        for (const child of element.contents) parts.push(processElement(child as Tag | NavigableString, depth + 1))

        return parts.join('')
      }

      const parts: string[] = []

      for (const child of element.contents) parts.push(processElement(child as Tag | NavigableString, depth + 1))

      let inner = strip(parts.join(''))
      inner = inner.replace(/\s+/g, ' ')

      if (inner) {
        if (inner.includes('<a id="')) {
          const match = /(<a id="[^"]+"><\/a>)(.*)/.exec(inner)
          if (match) {
            const anchor = match[1]!
            const text = strip(match[2]!)
            if (text) return `${anchor}**${text}** `

            return anchor
          }
        }
        // If inner is only asterisks (footnote markers like *, **),
        // escape them to prevent collision with Markdown formatting
        if (/^\*+$/.test(inner)) return inner.replaceAll('*', '\\*')

        return `**${inner}** `
      }

      return ''
    }

    // Italic - process children to preserve anchors
    if (element.name === 'i' || element.name === 'em') {
      const parts: string[] = []

      for (const child of element.contents) parts.push(processElement(child as Tag | NavigableString, depth + 1))

      const inner = strip(parts.join(''))

      if (inner) {
        if (inner.includes('<a id="')) {
          const match = /(<a id="[^"]+"><\/a>)(.*)/.exec(inner)
          if (match) {
            const anchor = match[1]!
            const text = strip(match[2]!)

            if (text) return `${anchor}*${text}*`

            return anchor
          }
        }
        // If inner is only asterisks (footnote markers like *, **),
        // escape them to prevent collision with Markdown formatting
        if (/^\*+$/.test(inner)) return inner.replaceAll('*', '\\*')

        return `*${inner}*`
      }

      return ''
    }

    // Underline - just process children
    if (element.name === 'u') {
      const parts: string[] = []

      for (const child of element.contents) parts.push(processElement(child as Tag | NavigableString, depth + 1))

      return strip(parts.join(''))
    }

    // Superscript - ensure space separation from adjacent text
    // SEC footnotes use <sup>1</sup>Text which concatenates as "1Text" without this
    if (element.name === 'sup') {
      const text = strip(element.getText())
      if (text) return `${text} `
      return ''
    }

    // Blockquote
    if (element.name === 'blockquote') {
      const parts: string[] = []

      for (const child of element.contents) parts.push(processElement(child as Tag | NavigableString, depth + 1))

      const text = strip(parts.join(''))

      if (text) {
        const lines = text.split('\n')
        const quoted = lines.map((line) => `> ${line}`).join('\n')

        return `\n\n${quoted}\n\n`
      }

      return ''
    }

    // Pre/code
    if (element.name === 'pre') {
      const text = element.getText()

      return `\n\n\`\`\`\n${text}\n\`\`\`\n\n`
    }

    if (element.name === 'code') {
      const text = element.getText()

      if (!text.includes('\n')) return `\`${text}\``

      return `\n\`\`\`\n${text}\n\`\`\`\n`
    }

    // Default: process children (including spans, sections, etc.)
    const resultList: string[] = []

    for (const child of element.contents) resultList.push(processElement(child as Tag | NavigableString, depth + 1))

    const inner = resultList.join('')
    // Prepend anchor if element had an id attribute
    if (anchorPrefix && strip(inner)) return `${anchorPrefix}${inner}`

    return inner
  }

  // Process the body or root
  const body = soup.body ?? soup
  let markdown = processElement(body)

  // Clean up
  markdown = markdown.replace(/\n{3,}/g, '\n\n')
  markdown = markdown.replace(/ {2,}/g, ' ')

  // Fix orphaned bullet characters
  markdown = markdown.replace(/^([•●◦○▪■\-*])\s*\n+([A-Z])/gm, '• $2')

  // Convert inline bullet characters to markdown bullets
  markdown = markdown.replace(/(?:^|\n\n)([•●◦○▪■])([A-Z])/g, '\n\n- $2')

  // Detect section headers from standalone short lines
  for (const pattern of HEADER_PATTERNS) markdown = markdown.replace(pattern, '## $1')

  // Strip anchor tags that are not referenced by any in-document link.
  // XBRL cell IDs (Tc_*), GUID-like IDs, and other noise anchors clutter
  // the output and break section header formatting.
  const referencedIds = new Set<string>()
  for (const m of markdown.matchAll(/\(#([^)]+)\)/g)) referencedIds.add(m[1]!)

  markdown = markdown.replace(/<a id="([^"]+)"><\/a>/g, (whole: string, anchorId: string) => (referencedIds.has(anchorId) ? whole : ''))
  // Clean up lines that are now empty after anchor removal
  markdown = markdown.replace(/\n[ \t]*\n/g, '\n\n')

  // Merge consecutive bold sections on the same line.
  // Use [ ]+ (not \s*) to avoid merging across paragraph boundaries,
  // and skip merges when either side contains an image tag.
  const mergeBold = (whole: string, a: string, b: string): string => {
    if (a.includes('<img ') || b.includes('<img ')) return whole
    return `**${a} ${b}**`
  }

  markdown = markdown.replace(/\*\*([^*]+)\*\*[ ]+\*\*([^*]+)\*\*/g, mergeBold)
  for (let k = 0; k < 5; k++) {
    const newMd = markdown.replace(/\*\*([^*]+)\*\*[ ]+\*\*([^*]+)\*\*/g, mergeBold)
    if (newMd === markdown) break
    markdown = newMd
  }

  // Remove repeated "Table of Contents" headers.
  // Some filings (e.g. IBM) produce lines like:
  //   ### Table of Contents Management Discussion – (continued)
  // so match any heading that *starts with* the TOC prefix.
  const lines = markdown.split('\n')
  let firstTocKept = false
  const filteredLines: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (TOC_HEADING_RE.test(strip(line))) {
      // Keep the very first occurrence when it is followed by an
      // actual TOC table (pipe-delimited rows).
      let j = i + 1
      while (j < lines.length && strip(lines[j]!) === '') j++
      if (j < lines.length && strip(lines[j]!).startsWith('|') && !firstTocKept) {
        filteredLines.push(line)
        firstTocKept = true
        i++
        continue
      }
      i++
      continue
    }
    filteredLines.push(line)
    i++
  }
  markdown = filteredLines.join('\n')

  // Remove repeated [Table of Contents](#...) links (page header navigation)
  // Anchor target varies by filing: #toc, GUIDs, etc.
  markdown = markdown.replace(/\n+\[Table of Contents\]\(#[^)]+\)\n+/gi, '\n\n')

  // Remove page break horizontal rules (often followed/preceded by excessive whitespace)
  // These are artifacts from page-break-before:always in the HTML
  markdown = markdown.replace(/\n{2,}---\n{2,}/g, '\n\n')

  // Remove standalone page numbers
  markdown = markdown.replace(/\n\n(?:S-)?(?:[ivxlcdm]+|[IVX]+|\d{1,3}|F-\d{1,2})\n\n/gi, '\n\n')

  // Clean up double bullet/dash patterns (e.g., "- •" or "- –")
  // These occur when the converter adds a markdown bullet and the source also had a Unicode bullet
  markdown = markdown.replace(/^- •\s*/gm, '- ')
  markdown = markdown.replace(/^- ●\s*/gm, '- ')
  markdown = markdown.replace(/^- –\s*/gm, '- ')
  markdown = markdown.replace(/^- —\s*/gm, '- ')
  markdown = markdown.replace(/^• •\s*/gm, '- ')
  markdown = markdown.replace(/^● ●\s*/gm, '- ')
  markdown = markdown.replace(/^•\s+/gm, '- ') // Convert standalone • to -
  markdown = markdown.replace(/^●\s+/gm, '- ') // Convert standalone ● to -

  // Remove specific page header/footer patterns with images (e.g., DEF14A proxy statements)
  markdown = markdown.replace(/\n(?:\d{1,3}\s+)?<img[^>]+>\s*\d{4}\s+Annual Meeting of Stockholders\s*\n/g, '\n')
  markdown = markdown.replace(/\n\d{4}\s+Annual Meeting of Stockholders\s*<img[^>]+>(?:\s*\d{1,3})?\s*\n/g, '\n')

  // Remove repeated page footer/header patterns
  // Find short lines that repeat many times (likely page footers/headers)
  markdown = removeRepeatedPageElements(markdown)

  // Normalize bullet characters (•) into proper markdown bullet lines
  markdown = normalizeBulletChars(markdown)

  // Join paragraphs that were split by page breaks
  markdown = joinSplitParagraphs(markdown)

  // Convert inline subheadings to proper markdown headers
  // Pattern: "Title . Body text" where Title starts the line and is followed by period-space
  // These are common in SEC filings for subsection titles
  markdown = convertInlineSubheadings(markdown)

  // Merge consecutive headers at the same level
  // SEC filings often have split headers like:
  //   ### CONDENSED CONSOLIDATED STATEMENTS OF CHANGES IN
  //   ### STOCKHOLDERS EQUITY AND PARTNERS CAPITAL
  // These should be merged into a single header
  markdown = mergeConsecutiveHeaders(markdown)

  // Separate footnote markers from text.
  // SEC filings often have footnotes like "1Refer to Note 11..." or
  // "2We calculated..." where the footnote number (from a <font> or
  // <span> tag with small font-size, NOT a <sup> tag) is directly
  // concatenated with the following text.  Insert a space so it
  // renders as "1 Refer to Note 11..." instead of "1Refer...".
  // Only match 1-2 digit markers immediately followed by an uppercase
  // letter at the start of a line (or after a double-newline paragraph
  // break) to avoid splitting things like "3M" or "401k".
  markdown = markdown.replace(/^(\d{1,2})([A-Z][a-z])/gm, '$1 $2')

  // Final whitespace cleanup - convert any remaining Windows-1252 characters
  for (const [winChar, unicodeChar] of WIN1252_MAP) markdown = markdown.replaceAll(winChar, unicodeChar)

  // Replace non-breaking spaces with regular spaces
  markdown = markdown.replaceAll('\xa0', ' ')
  // Collapse multiple consecutive spaces to single space
  markdown = markdown.replace(/ {2,}/g, ' ')
  // Clean up trailing whitespace on lines
  markdown = markdown.replace(/ +$/gm, '')
  // Clean up leading whitespace on lines (except for code blocks/lists)
  // Only strip leading spaces that aren't part of markdown formatting
  markdown = markdown.replace(/^[ \t]+(?=[^\-*\d|#])/gm, '')
  // Collapse excessive blank lines (more than 2 newlines -> 2 newlines)
  markdown = markdown.replace(/\n{3,}/g, '\n\n')
  // Also collapse lines that are just whitespace
  markdown = markdown.replace(/\n[ \t]+\n/g, '\n\n')
  markdown = markdown.replace(/\n{3,}/g, '\n\n')
  markdown = strip(markdown)

  return markdown
}
