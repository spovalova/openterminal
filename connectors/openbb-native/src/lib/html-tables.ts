// HTML tables as rows of text, the way pandas.read_html reads them for the exchange pages the providers scrape: a header
// row (the first row, or the <thead> row), the body rows, cell text stripped and runs of whitespace collapsed, numbers
// left as text (callers convert the columns they use; see `cellNumber`).
import { parse } from 'node-html-parser'

export type HtmlTable = {
  /** The id attribute, when the table has one. */
  id: string | undefined
  headers: string[]
  rows: string[][]
}

/** pandas' `_remove_whitespace`: strip, then fold newlines and runs of blanks into one space. */
export function cellText(text: string): string {
  return text.trim().replace(/[\r\n]+|\s{2,}/g, ' ')
}

/** Every <table> of a page. A table without a header row gets an empty `headers`. */
export function htmlTables(html: string): HtmlTable[] {
  const root = parse(html)
  return root.querySelectorAll('table').map((table) => {
    const rows = table.querySelectorAll('tr')
    let headers: string[] = []
    const body: string[][] = []
    rows.forEach((tr, i) => {
      const cells = tr.querySelectorAll('th, td')
      const texts = cells.map((c) => cellText(c.text))
      const isHeader = headers.length === 0 && i === 0 && cells.length > 0 && cells.every((c) => c.tagName.toLowerCase() === 'th')
      if (isHeader || (headers.length === 0 && tr.parentNode?.tagName?.toLowerCase() === 'thead')) headers = texts
      else if (cells.length > 0) body.push(texts)
    })
    return { id: table.getAttribute('id') ?? undefined, headers, rows: body }
  })
}

/** A table as records keyed by its header texts. */
export function tableRecords(table: HtmlTable): Record<string, string>[] {
  return table.rows.map((r) => Object.fromEntries(table.headers.map((h, i) => [h, r[i] ?? ''])))
}

/**
 * pandas' reading of a numeric cell: digits with `,` thousands separators, an optional sign and fraction; anything
 * else (including the empty cell) is not a number.
 */
export function cellNumber(text: string | undefined): number | undefined {
  if (text === undefined) return undefined
  const s = text.trim()
  if (!/^[+-]?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/.test(s) && !/^[+-]?\.\d+$/.test(s)) return undefined
  return Number(s.replaceAll(',', ''))
}
