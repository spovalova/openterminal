// The reply as plain prose (product rule and prompt rule 8: no headings, bullets, bold or tables). The prompt forbids
// markdown and the model still writes "On the fundamentals:" followed by bold bullets in one run of four (bench v2,
// proposal 8; seen again in phase 2b), so the server enforces it on the final text the way verification enforces
// rule 4: bold and italic markers go, headings become sentences, each bullet or numbered item becomes a sentence of
// its paragraph, and a markdown table becomes one sentence per row ("CRWV: P/E 12.1, debt 5.2B").
// Chips (`[[widget:id]]`) and numbers are untouched, so verification sees the same figures.

const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+/

function sentence(s: string): string {
  const t = s.trim()
  if (!t) return ''
  return /[.!?…]$|\]\]$/.test(t) ? t : `${t}.`
}

/** `| a | b |` rows of a markdown table as "a: b, c" sentences; the separator row is dropped. */
function tableToSentences(rows: string[]): string[] {
  const cells = rows.map((r) => r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim()))
  const body = cells.filter((cs) => !cs.every((c) => /^:?-{2,}:?$/.test(c) || c === ''))
  if (body.length === 0) return []
  const [header, ...data] = body
  if (data.length === 0) return [sentence(header!.join(', '))]
  return data.map((cs) => {
    const [first, ...rest] = cs
    const pairs = rest.map((c, i) => (header![i + 1] ? `${header![i + 1]} ${c}` : c)).filter(Boolean)
    return sentence(`${first}: ${pairs.join(', ')}`)
  })
}

/** Markdown in a reply flattened to plain prose; text that is already plain comes back unchanged. */
export function plainProse(text: string): string {
  let t = text.replace(/\r\n/g, '\n')
  // bold and italic markers (not a lone asterisk between digits, which is multiplication)
  t = t.replace(/\*\*(.+?)\*\*/gs, '$1').replace(/__(.+?)__/gs, '$1').replace(/(^|[\s(])\*(?!\s)([^*\n]+?)\*(?=[\s).,;:!?]|$)/g, '$1$2').replace(/(^|[\s(])_(?!\s)([^_\n]+?)_(?=[\s).,;:!?]|$)/g, '$1$2')
  // inline code
  t = t.replace(/`([^`\n]+)`/g, '$1')
  const out: string[] = []
  const lines = t.split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows: string[] = []
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]!)) rows.push(lines[i++]!)
      out.push(tableToSentences(rows).join(' '))
      continue
    }
    if (BULLET.test(line)) {
      const items: string[] = []
      while (i < lines.length && BULLET.test(lines[i]!)) items.push(sentence(lines[i++]!.replace(BULLET, '')))
      // A heading-like line right before the list ("On the fundamentals:") leads the same paragraph.
      const prev = out.length > 0 ? out[out.length - 1]! : ''
      if (prev && /:\s*$/.test(prev) && !prev.includes('\n')) out[out.length - 1] = `${prev.replace(/:\s*$/, '.')} ${items.join(' ')}`
      else out.push(items.join(' '))
      continue
    }
    const heading = /^\s*#{1,6}\s+(.*)$/.exec(line)
    if (heading) {
      out.push(sentence(heading[1]!.replace(/#+\s*$/, '')))
      i++
      continue
    }
    if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) {
      i++
      continue
    }
    out.push(line)
    i++
  }
  // Collapse the blank lines a list used to sit between, keep paragraph breaks.
  return out
    .join('\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
