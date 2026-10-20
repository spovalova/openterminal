// A small RFC 4180 CSV reader: quoted fields, doubled quotes, CRLF or LF, a BOM. Enough for the government and
// exchange downloads the providers read; no type guessing (callers convert the columns they use).

/** Rows of fields. */
export function parseCsv(text: string, delimiter = ','): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0
  for (; i < text.length; i++) {
    const ch = text[i]!
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += ch
      continue
    }
    if (ch === '"' && field === '') quoted = true
    else if (ch === delimiter) {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += ch
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''))
}

/** Records keyed by the header row, names trimmed (pandas keeps the spaces; rename with the trimmed name). */
export function parseCsvRecords(text: string, delimiter = ','): Record<string, string>[] {
  const [header, ...rows] = parseCsv(text, delimiter)
  if (!header) return []
  const names = header.map((h) => h.trim())
  return rows.map((r) => Object.fromEntries(names.map((n, i) => [n, r[i] ?? ''])))
}
