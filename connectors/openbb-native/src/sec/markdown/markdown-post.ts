// html2markdown: markdown post-processing, provider sec. Ported from openbb_sec/utils/html2markdown.py lines
// 6905-7400 (OpenBB Platform 5.0.0, Apache-2.0); modified: none beyond the language.
import { isLower, rstripChars, split, strip } from './py.js'

// Words that signal the heading phrase is incomplete.
const CONTINUATION_ENDINGS = new Set([
  'in', 'of', 'and', 'the', 'for', 'to', 'with', 'on', 'a', 'an', 'by', 'at', 'as', 'or', 'nor', 'but', 'from', 'into', 'onto', 'upon', 'per', 'its', 'their', 'our', 'your', 'this', 'that', 'these', 'those', 'which', 'who', 'whom', 'whose',
])

/** Return True if *text* appears to be an incomplete title phrase. */
function looksIncomplete(text: string): boolean {
  const t = text.replace(/[\s]+$/, '')
  if (!t) return false
  // Ends with a continuation punctuation mark (comma, dash, colon)
  if (t.endsWith(',') || t.endsWith('–') || t.endsWith('—') || t.endsWith('-')) return true
  const words = split(t)
  const lastWord = rstripChars(words[words.length - 1]!.toLowerCase(), '.,;:')
  return CONTINUATION_ENDINGS.has(lastWord)
}

/**
 * Merge consecutive headers at the same level into a single header.
 *
 * SEC filings often have titles split across multiple lines/elements:
 *     ### CONDENSED CONSOLIDATED STATEMENTS OF CHANGES IN
 *     ### STOCKHOLDERS EQUITY AND PARTNERS CAPITAL
 *     **(UNAUDITED)**
 *
 * This merges them into:
 *     ### CONDENSED CONSOLIDATED STATEMENTS OF CHANGES IN STOCKHOLDERS EQUITY AND PARTNERS CAPITAL
 *     **(UNAUDITED)**
 *
 * Only merges when the first header looks *incomplete* — i.e. its last
 * word is a preposition, conjunction, article, or determiner.  Two
 * genuinely separate headers (e.g. a section title followed by a
 * subsection title) are left alone.
 */
export function mergeConsecutiveHeaders(markdown: string): string {
  const lines = markdown.split('\n')
  const result: string[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]!
    const stripped = strip(line)

    // Check if this is a header line
    const headerMatch = /^(#{1,6})\s+(.+)$/.exec(stripped)

    if (headerMatch) {
      const level = headerMatch[1]! // e.g., "###"
      let headerText = headerMatch[2]!

      // Look ahead for consecutive headers at the same level
      let j = i + 1
      while (j < lines.length) {
        const nextLine = strip(lines[j]!)

        // Skip empty lines between consecutive headers
        if (!nextLine) {
          j++
          continue
        }

        // Check if next non-empty line is same-level header
        const nextMatch = /^(#{1,6})\s+(.+)$/.exec(nextLine)
        if (nextMatch && nextMatch[1] === level && looksIncomplete(headerText)) {
          // Merge this header text — first header is an
          // incomplete phrase that continues on the next line.
          headerText = headerText.replace(/\s+$/, '') + ' ' + nextMatch[2]!
          j++
        } else if (nextMatch && nextMatch[1] !== level && looksIncomplete(headerText)) {
          // Different-level header but first header is clearly
          // incomplete — merge at the current (higher) level.
          headerText = headerText.replace(/\s+$/, '') + ' ' + nextMatch[2]!
          j++
        } else {
          // Not a continuation — stop merging
          break
        }
      }

      // Output the merged header
      result.push(`${level} ${headerText}`)
      i = j
    } else {
      result.push(line)
      i++
    }
  }

  return result.join('\n')
}

const SUBHEADING_RE = new RegExp(
  "^([A-Z][A-Za-z]+(?:\\s+(?:and|of|on|the|for|in|to|a|an|with|as|or|by|at|from|" +
    "under|into|through|after|before|between|during|without|within|about|against|" +
    "among|around|behind|below|beyond|except|inside|outside|over|since|toward|until|" +
    "upon|versus|via|[A-Z][A-Za-z']+)){1,7})\\s+\\.\\s+([A-Z].+)$",
)

/**
 * Convert inline subheadings to proper markdown headers.
 *
 * SEC filings often have subsection titles formatted as:
 * "Subsection Title . Body text continues here..."
 *
 * This converts them to:
 * "#### Subsection Title
 *
 * Body text continues here..."
 */
export function convertInlineSubheadings(markdown: string): string {
  const lines = markdown.split('\n')
  const result: string[] = []
  for (const line of lines) {
    // Only process non-table, non-header lines
    const stripped = strip(line)
    if (stripped && !stripped.startsWith('|') && !stripped.startsWith('#')) {
      // Python's `.` and `$` stop at a newline; a line has none.
      result.push(line.replace(SUBHEADING_RE, (_m, title: string, body: string) => `#### ${strip(title)}\n\n${strip(body)}`))
    } else result.push(line)
  }
  return result.join('\n')
}

/**
 * Normalize Unicode bullet characters (•) into proper markdown bullet lines.
 *
 * Position-based HTML layouts (Workiva) often produce lines like:
 *     •item one; •item two; and •item three.
 * This splits them into separate markdown bullet lines:
 *     - item one;
 *     - item two; and
 *     - item three.
 *
 * Also handles lines that start with a single •.
 */
export function normalizeBulletChars(markdown: string): string {
  const lines = markdown.split('\n')
  const result: string[] = []
  for (const line of lines) {
    const stripped = strip(line)
    // Skip lines without bullet chars
    if (!stripped.includes('•')) {
      result.push(line)
      continue
    }

    // Skip if inside a markdown table row
    if (stripped.startsWith('|')) {
      result.push(line)
      continue
    }

    // Split on • to get individual bullet items
    // Handle leading text before first •
    const parts = stripped.split('•')

    // parts[0] is text before the first •  (may be empty)
    const prefixText = strip(parts[0]!)
    if (prefixText) result.push(prefixText)

    // Each subsequent part is a bullet item
    for (const part of parts.slice(1)) {
      const itemText = strip(part)
      if (itemText) result.push(`- ${itemText}`)
    }
  }

  return result.join('\n')
}

// Patterns for structural lines that should never be joined
// Note: \d{1,2}\.\s matches numbered lists (1-99) but NOT years like "2024."
const STRUCTURAL_RE = /^(?:#|\||- |\* |\d{1,2}\.\s|\(\d{1,2}\)|<img|<a\s|\[)/
// Connecting words that always indicate mid-sentence when at line end
const CONNECTING_RE = /\b(and|or|the|a|an|of|to|in|for|with|by|from|at|on|as|that|which|but|is|are|was|were|be|been|being|have|has|had|not|its|their|our|this|these|those|into|upon|about|through|under|between|during|after|before|including|such)\s*$/i
// Bullet prefixes that should participate in forward-joining
const BULLET_RE = /^(?:- |\* |\d+\.\s)/
// Non-bullet structural lines that should NEVER join
const HARD_STRUCTURAL_RE = /^(?:#|\||<img|<a\s|<div\s|\*\*Legend:\*\*)/
// Lines containing inline HTML spans/divs are intentionally formatted;
// they should never be joined or consumed as continuation lines.
const INLINE_HTML_RE = /<(?:span|div)\s/
// Running page headers: "Section Title [Link](#anchor)" patterns
// that repeat on every page of the original filing.
const PAGE_HEADER_LINK_RE = /^[A-Z].*\[.*\]\(#[^)]+\)\s*$/

const PAGE_HEADER_PATTERNS = [
  // Company name + section continuation markers
  /\*\*[A-Z][A-Z\s,.&]+(?:INC\.|CORP\.|LLC|LP|L\.P\.)?\s+(?:and\s+)?(?:SUBSIDIARIES?)?\s*(?:NOTES?\s+TO\s+)?(?:CONDENSED\s+)?(?:CONSOLIDATED\s+)?(?:FINANCIAL\s+STATEMENTS?)?\s*(?:—|–|-)\s*\(Continued\)\s*(?:\(UNAUDITED\))?\*\*/gim,
  // Just "(UNAUDITED)" on its own line
  /^\*\*\(UNAUDITED\)\*\*$/gim,
]

/**
 * Join paragraphs that were split by page breaks in SEC filings.
 *
 * Handles two patterns:
 * 1. Hyphenated words split across pages: "pre-" ... "tax" → "pre-tax"
 * 2. Sentences split at connecting words: "and" ... "acquisitions" → "and acquisitions"
 *
 * Also removes page headers that interrupt paragraphs (e.g., company name, section titles).
 */
export function joinSplitParagraphs(markdown: string): string {
  // First, remove common SEC filing page headers that interrupt text
  // These are bold lines that repeat throughout the document
  for (const pattern of PAGE_HEADER_PATTERNS) markdown = markdown.replace(pattern, '')

  // Clean up any resulting excessive blank lines
  markdown = markdown.replace(/\n{3,}/g, '\n\n')

  const lines = markdown.split('\n')
  const result: string[] = []
  let i = 0

  /** Return True if stripped line *s* is eligible for joining. */
  const isJoinableLine = (s: string): boolean => !!s && !STRUCTURAL_RE.test(s) && !INLINE_HTML_RE.test(s) && !PAGE_HEADER_LINK_RE.test(s)

  /** Return (index, stripped_text) of next non-blank line, or (start, None). */
  const nextNonblank = (start: number): [number, string | null] => {
    let j = start
    while (j < lines.length && !strip(lines[j]!)) j++
    if (j < lines.length) return [j, strip(lines[j]!)]
    return [j, null]
  }

  while (i < lines.length) {
    let line = lines[i]!
    const stripped = strip(line)

    // Skip blank lines and hard-structural lines (headers, tables, images)
    if (!stripped || HARD_STRUCTURAL_RE.test(stripped) || INLINE_HTML_RE.test(stripped) || PAGE_HEADER_LINK_RE.test(stripped)) {
      result.push(line)
      i++
      continue
    }

    // --- Iterative joining loop ---
    const isBullet = BULLET_RE.test(stripped)
    const isFootnote = /^\(\d{1,2}\)/.test(stripped)
    let joinedAny = true
    let joinCount = 0

    while (joinedAny) {
      joinedAny = false

      // 1) Hyphenated word split: "pre-" ... "tax" → "pre-tax"
      if (line.replace(/\s+$/, '').endsWith('-') && !line.replace(/\s+$/, '').endsWith('--')) {
        const [j, nxt] = nextNonblank(i + 1)

        if (nxt && isLower(nxt[0]!)) {
          const m = /^(\S+)([\s\S]*)/.exec(nxt)
          if (m) {
            line = line.replace(/\s+$/, '').slice(0, -1) + m[1]! + m[2]!
            i = j + 1
            joinCount++
            joinedAny = true
            continue
          }
        }
      }

      const curStripped = strip(line)

      // 2) Line ends with a connecting word → ALWAYS continuation
      //    (regardless of next-line case)
      if (CONNECTING_RE.test(line.replace(/\s+$/, ''))) {
        const [j, nxt] = nextNonblank(i + 1)

        if (nxt && isJoinableLine(nxt)) {
          line = line.replace(/\s+$/, '') + ' ' + nxt
          i = j + 1
          joinCount++
          joinedAny = true
          continue
        }
      }

      // 3) General mid-sentence: line does NOT end with sentence-terminal
      //    punctuation → join with next non-structural line.
      //    3a) next starts lowercase → always join
      //    3b) current line is >30 chars AND first join attempt → join
      //        (guards against runaway merging: titles/references that
      //         don't end with punctuation won't chain into the next
      //         paragraph after the first join)
      //    3c) line ends with continuation punctuation (, ; &) → join
      //        Also handles quoted forms like ,"  or ;"
      const endStripped = rstripChars(curStripped, '"”’‘\'')
      const hasContPunct = endStripped.endsWith(',') || endStripped.endsWith(';') || endStripped.endsWith('&')

      if (!(curStripped.endsWith('.') || curStripped.endsWith('!') || curStripped.endsWith('?') || curStripped.endsWith(':') || curStripped.endsWith('"') || curStripped.endsWith('”')) || hasContPunct) {
        const [j, nxt] = nextNonblank(i + 1)

        if (nxt && isJoinableLine(nxt)) {
          const shouldJoin = isLower(nxt[0]!) || (curStripped.length > 30 && joinCount === 0 && !isBullet && !isFootnote) || hasContPunct

          if (shouldJoin) {
            line = line.replace(/\s+$/, '') + ' ' + nxt
            i = j + 1
            joinCount++
            joinedAny = true
            continue
          }
        }
      }

      // 4) Abbreviation / mid-sentence period: line ends with "." but
      //    next non-blank starts lowercase → definitely a continuation
      //    (handles "U.S." / "Inc." / "No." at visual line-wrap boundary)
      if (curStripped.endsWith('.')) {
        const [j, nxt] = nextNonblank(i + 1)

        if (nxt && isJoinableLine(nxt) && isLower(nxt[0]!)) {
          line = line.replace(/\s+$/, '') + ' ' + nxt
          i = j + 1
          joinCount++
          joinedAny = true
          continue
        }
      }

      // 5) Unclosed quote: line contains an opening " (or ")
      //    that hasn't been closed yet → we're inside a quoted
      //    reference (e.g. refer to "Part II, Item 7.)
      //    The period/punctuation is NOT sentence-terminal.
      const closeChars = (curStripped.match(/”/g) ?? []).length
      const openSmart = (curStripped.match(/“/g) ?? []).length
      const straight = (curStripped.match(/"/g) ?? []).length
      // For straight quotes, odd count means unclosed; for smart
      // quotes, more openers than closers means unclosed.
      const hasUnclosed = openSmart > closeChars || (straight % 2 === 1 && !curStripped.includes('“') && !curStripped.includes('”'))

      if (hasUnclosed) {
        const [j, nxt] = nextNonblank(i + 1)

        if (nxt && isJoinableLine(nxt)) {
          line = line.replace(/\s+$/, '') + ' ' + nxt
          i = j + 1
          joinCount++
          joinedAny = true
          continue
        }
      }
    }

    result.push(line)
    i++
  }

  return result.join('\n')
}

function normalizeLine(line: string): string {
  // Normalize a line for comparison by replacing variable parts.
  let normalized = strip(line)
  // Replace page numbers (standalone digits) with placeholder
  normalized = normalized.replace(/\b\d{1,3}\b/g, '#')
  // Replace markdown image URLs with placeholder, but keep the image marker
  // so we can distinguish "text with image" from "standalone image"
  normalized = normalized.replace(/!\[([^\]]*)\]\([^)]+\)/g, '![IMG]')
  // Also replace HTML <img> tags with placeholder
  normalized = normalized.replace(/<img[^>]+>/g, '[IMG]')
  return normalized
}

/**
 * Remove repeated page footer/header patterns from markdown.
 *
 * Detects short text patterns that appear many times (5+) in the document,
 * which are likely page headers or footers that got repeated during conversion.
 *
 * Examples of patterns this catches:
 * - "- 32 2025 Annual Meeting of Stockholders"
 * - "Company Name | Page 5"
 * - "CONFIDENTIAL"
 */
export function removeRepeatedPageElements(markdown: string): string {
  const lines = markdown.split('\n')

  // Count normalized patterns
  const lineCounts = new Map<string, number>()

  for (const line of lines) {
    const stripped = strip(line)
    const normalized = normalizeLine(stripped)
    // Only consider lines that normalize to short patterns (< 80 chars after normalization)
    // that aren't empty, headers, table rows, or STANDALONE images
    // Standalone images like ![LOGO](url) or <img ...> should NOT be removed
    if (
      normalized &&
      normalized.length < 80 &&
      !stripped.startsWith('#') && // Not a header
      !stripped.startsWith('|') && // Not a table row
      !stripped.startsWith('[') && // Not a link
      !/^!\[/.test(stripped) && // Not a standalone markdown image
      !/^<img\s/.test(stripped) && // Not a standalone HTML image
      !/^<div[\s>]/.test(stripped) && // Not an HTML div block
      stripped !== '---'
    ) {
      // Not a horizontal rule
      lineCounts.set(normalized, (lineCounts.get(normalized) ?? 0) + 1)
    }
  }

  // Find patterns that repeat 5+ times (likely page footers/headers)
  const repeatedPatterns = new Set<string>()
  for (const [pattern, count] of lineCounts) if (count >= 5) repeatedPatterns.add(pattern)

  if (repeatedPatterns.size === 0) return markdown

  // Filter out the repeated lines
  const filteredLines: string[] = []
  for (const line of lines) {
    const stripped = strip(line)
    const normalized = normalizeLine(stripped)
    if (repeatedPatterns.has(normalized)) {
      // Skip this repeated page element
      continue
    }
    filteredLines.push(line)
  }

  return filteredLines.join('\n')
}
