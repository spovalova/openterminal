// Python and pandas behaviour the filing routes depend on, sec provider. Ported from pandas 3.0.6 pandas/io/html.py,
// pandas/io/parsers/python_parser.py and base_parser.py (BSD-3-Clause) as used by openbb_sec through
// `pandas.read_html` (OpenBB Platform 5.0.0, Apache-2.0); modified: node-html-parser instead of lxml, and a frame is
// just named columns of typed cells, with only the operations the SEC filing code applies to one.
import { HTMLElement, NodeType, parse, type Node as HtmlNode } from 'node-html-parser'

/** A cell of a frame: text, a number (int or float, see the column's dtype), a bool, or null for NaN/None. */
export type Cell = string | number | boolean | null

export type Dtype = 'int' | 'float' | 'bool' | 'str'

export type Column = { dtype: Dtype; values: Cell[] }

/** A column label: a name, a position (frames without a header) or, in a MultiIndex, the tuple of its levels. */
export type ColKey = string | number | string[]

export type Frame = { columns: ColKey[]; multi: boolean; data: Column[] }

export const nrows = (f: Frame): number => f.data[0]?.values.length ?? 0

/** `DataFrame.empty`: no rows or no columns. */
export const isEmpty = (f: Frame): boolean => f.data.length === 0 || nrows(f) === 0

// ---------------------------------------------------------------------------------------------------------------
// Python text
// ---------------------------------------------------------------------------------------------------------------

/** The characters Python's `str.isspace()` and the `\s` of its `re` module treat as white space. */
export const PY_WS = '\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000'
const PY_WS_START = new RegExp(`^[${PY_WS}]+`)
const PY_WS_END = new RegExp(`[${PY_WS}]+$`)

/** `str.strip()` */
export function pyStrip(s: string): string {
  return s.replace(PY_WS_START, '').replace(PY_WS_END, '')
}

/** `str.split()` with no argument: runs of white space separate, and none is left at the ends. */
export function pySplitWs(s: string): string[] {
  const t = pyStrip(s)
  return t === '' ? [] : t.split(new RegExp(`[${PY_WS}]+`))
}

const REMOVE_WS = new RegExp(`[\\r\\n]+|[${PY_WS}]{2,}`, 'g')

/** `pandas.io.html._remove_whitespace` */
export function removeWhitespace(s: string): string {
  return pyStrip(s).replace(REMOVE_WS, ' ')
}

// ---------------------------------------------------------------------------------------------------------------
// HTML tables (pandas.io.html, lxml flavor)
// ---------------------------------------------------------------------------------------------------------------

const isElement = (n: HtmlNode): n is HTMLElement => n.nodeType === NodeType.ELEMENT_NODE
const tagOf = (el: HTMLElement): string => el.rawTagName.toLowerCase()

/** The text of a node, entities decoded; `br` as a newline (`read_html` puts one after every `<br>`) or as nothing (bs4's `.text`). */
export function elementText(el: HtmlNode, brNewline: boolean): string {
  if (!isElement(el)) return el.nodeType === NodeType.TEXT_NODE ? el.text : ''
  let out = ''
  for (const child of el.childNodes) {
    if (isElement(child)) out += tagOf(child) === 'br' ? (brNewline ? '\n' : '') : elementText(child, brNewline)
    else if (child.nodeType === NodeType.TEXT_NODE) out += child.text
  }
  return out
}

/** `lxml`'s `text_content()` as `read_html` sees it. */
const textContent = (el: HtmlNode): string => elementText(el, true)

function descendants(el: HTMLElement, test: (e: HTMLElement) => boolean, out: HTMLElement[] = []): HTMLElement[] {
  for (const child of el.childNodes) {
    if (!isElement(child)) continue
    if (test(child)) out.push(child)
    descendants(child, test, out)
  }
  return out
}

const childElements = (el: HTMLElement, ...tags: string[]): HTMLElement[] => el.childNodes.filter(isElement).filter((c) => tags.includes(tagOf(c)))
const hiddenStyle = (el: HTMLElement): boolean => (el.getAttribute('style') ?? '').replaceAll(' ', '').includes('display:none')

type RawRow = HTMLElement
type Remainder = [number, string, number][]

function cellSpan(td: HTMLElement, attr: string): number {
  const raw = td.getAttribute(attr)
  if (raw === undefined || raw === '') return 1
  const n = Number(raw.trim())
  if (!Number.isInteger(n)) throw new Error(`invalid literal for int() with base 10: '${raw}'`)
  return n
}

/** `_HtmlFrameParser._expand_colspan_rowspan` */
function expandColspanRowspan(rows: RawRow[], remainderIn: Remainder, overflow: boolean): { texts: string[][]; remainder: Remainder } {
  const allTexts: string[][] = []
  let remainder = remainderIn.slice()
  for (const tr of rows) {
    const texts: string[] = []
    const next: Remainder = []
    let index = 0
    for (const td of childElements(tr, 'td', 'th')) {
      while (remainder.length > 0 && remainder[0]![0] <= index) {
        const [prevI, prevText, prevRowspan] = remainder.shift()!
        texts.push(prevText)
        if (prevRowspan > 1) next.push([prevI, prevText, prevRowspan - 1])
        index += 1
      }
      const text = removeWhitespace(textContent(td))
      const rowspan = cellSpan(td, 'rowspan')
      const colspan = cellSpan(td, 'colspan')
      for (let k = 0; k < colspan; k++) {
        texts.push(text)
        if (rowspan > 1) next.push([index, text, rowspan - 1])
        index += 1
      }
    }
    for (const [prevI, prevText, prevRowspan] of remainder) {
      texts.push(prevText)
      if (prevRowspan > 1) next.push([prevI, prevText, prevRowspan - 1])
    }
    allTexts.push(texts)
    remainder = next
  }
  if (!overflow) {
    while (remainder.length > 0) {
      const next: Remainder = []
      const texts: string[] = []
      for (const [prevI, prevText, prevRowspan] of remainder) {
        texts.push(prevText)
        if (prevRowspan > 1) next.push([prevI, prevText, prevRowspan - 1])
      }
      allTexts.push(texts)
      remainder = next
    }
  }
  return { texts: allTexts, remainder }
}

/** `_parse_thead_tbody_tfoot` for one table element: the header, body and footer rows as lists of cell text. */
function tableRows(table: HTMLElement): { head: string[][]; body: string[][]; foot: string[][] } {
  const headRows: RawRow[] = []
  for (const thead of descendants(table, (e) => tagOf(e) === 'thead')) {
    headRows.push(...childElements(thead, 'tr'))
    // lxml does not clean up <thead><th>foo</th></thead>: the thead itself then stands for the row.
    if (childElements(thead, 'td', 'th').length > 0) headRows.push(thead)
  }
  const bodyRows: RawRow[] = []
  for (const tbody of descendants(table, (e) => tagOf(e) === 'tbody')) bodyRows.push(...descendants(tbody, (e) => tagOf(e) === 'tr'))
  bodyRows.push(...childElements(table, 'tr'))
  const footRows: RawRow[] = []
  for (const tfoot of descendants(table, (e) => tagOf(e) === 'tfoot')) footRows.push(...descendants(tfoot, (e) => tagOf(e) === 'tr'))

  const rowIsAllTh = (row: RawRow): boolean => childElements(row, 'td', 'th').every((t) => tagOf(t) === 'th')
  if (headRows.length === 0) while (bodyRows.length > 0 && rowIsAllTh(bodyRows[0]!)) headRows.push(bodyRows.shift()!)

  const header = expandColspanRowspan(headRows, [], true)
  const body = expandColspanRowspan(bodyRows, header.remainder, footRows.length > 0)
  const footer = expandColspanRowspan(footRows, body.remainder, false)
  return { head: header.texts, body: body.texts, foot: footer.texts }
}

// ---------------------------------------------------------------------------------------------------------------
// TextParser (the python engine): header rows, column names, thousands separators, type inference
// ---------------------------------------------------------------------------------------------------------------

/** `STR_NA_VALUES`: the strings pandas reads as missing. */
const NA_VALUES = new Set(['', '#N/A', '#N/A N/A', '#NA', '-1.#IND', '-1.#QNAN', '-NaN', '-nan', '1.#IND', '1.#QNAN', '<NA>', 'N/A', 'NA', 'NULL', 'NaN', 'None', 'n/a', 'nan', 'null'])
const THOUSANDS_NUM = /^[-+]?([0-9]+,|[0-9])*(\.[0-9]*)?([0-9]?(E|e)-?[0-9]+)?$/
const TRUE_VALUES = new Set(['True', 'TRUE', 'true'])
const FALSE_VALUES = new Set(['False', 'FALSE', 'false'])
const FLOAT_TEXT = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/
const INF_TEXT = /^[-+]?(inf|infinity)$/i

/** `lib.maybe_convert_numeric` / `maybe_convert_bool` on one column of text, as `_infer_types` applies them. */
export function inferColumn(texts: string[]): Column {
  let ok = true
  let allInt = true
  let sawNull = false
  const numbers: Cell[] = []
  for (const t of texts) {
    if (NA_VALUES.has(t)) {
      sawNull = true
      numbers.push(null)
    } else if (FLOAT_TEXT.test(t)) {
      if (!/^[-+]?\d+$/.test(t)) allInt = false
      numbers.push(Number(t))
    } else if (INF_TEXT.test(t)) {
      allInt = false
      numbers.push(t.startsWith('-') ? -Infinity : Infinity)
    } else {
      ok = false
      break
    }
  }
  if (ok) {
    const bigInt = allInt && numbers.some((n) => typeof n === 'number' && !Number.isSafeInteger(n))
    return { dtype: allInt && !sawNull && !bigInt ? 'int' : 'float', values: numbers }
  }
  const strings: Cell[] = texts.map((t) => (NA_VALUES.has(t) ? null : t))
  if (texts.length > 0 && texts.every((t) => TRUE_VALUES.has(t) || FALSE_VALUES.has(t))) return { dtype: 'bool', values: texts.map((t) => TRUE_VALUES.has(t)) }
  return { dtype: 'str', values: strings }
}

function dedupNames(names: ColKey[], multi: boolean): ColKey[] {
  const out = names.slice()
  const counts = new Map<string, number>()
  const keyOf = (c: ColKey): string => JSON.stringify(c)
  out.forEach((name, i) => {
    let col = name
    let cur = counts.get(keyOf(col)) ?? 0
    while (cur > 0) {
      counts.set(keyOf(col), cur + 1)
      col = multi ? [...(col as string[]).slice(0, -1), `${(col as string[]).at(-1)}.${cur}`] : `${col as string}.${cur}`
      cur = counts.get(keyOf(col)) ?? 0
    }
    out[i] = col
    counts.set(keyOf(col), cur + 1)
  })
  return out
}

const isBlankLine = (line: string[]): boolean => line.length === 0 || (line.length === 1 && pyStrip(line[0]!) === '')

/** The column names of a header line: blanks become "Unnamed: i", duplicates get ".1", ".2" (regular names first). */
function plainHeaderNames(line: string[]): string[] {
  const names = line.map((c, i) => (c === '' ? `Unnamed: ${i}` : c))
  const unnamed = line.flatMap((c, i) => (c === '' ? [i] : []))
  const order = [...names.keys()].filter((i) => line[i] !== '').concat(unnamed)
  const counts = new Map<string, number>()
  for (const i of order) {
    let col = names[i]!
    const old = col
    let cur = counts.get(col) ?? 0
    if (cur > 0) {
      while (cur > 0) {
        counts.set(old, cur + 1)
        col = `${old}.${cur}`
        if (names.includes(col)) cur += 1
        else cur = counts.get(col) ?? 0
      }
    }
    names[i] = col
    counts.set(col, cur + 1)
  }
  return names
}

/**
 * `TextParser(rows, header=…)` (the python engine) on rows of cell text: `header` is `null` (no header row), a row
 * index, or a list of row indexes (a MultiIndex of columns, which also reads the line after the last one).
 */
export function textParser(rowsIn: string[][], header: number | number[] | null): Frame {
  const rows = rowsIn.filter((r) => !isBlankLine(r))
  let columns: ColKey[]
  let multi = false
  let dataStart = 0
  if (header === null) {
    if (rows.length === 0) throw new Error('No columns to parse from file')
    columns = Array.from({ length: rows[0]!.length }, (_, i) => i)
  } else {
    const wanted = Array.isArray(header) ? header : [header]
    multi = Array.isArray(header) && header.length > 1
    const lines = multi ? [...wanted, wanted.at(-1)! + 1] : wanted
    const levels: string[][] = []
    for (const [level, hr] of lines.entries()) {
      const line = rows[hr]
      if (line === undefined) {
        // the extra line of a MultiIndex header may be missing (a table with no body rows); a header row may not
        if (multi && hr > 0 && hr === lines.at(-1)) break
        if (rows.length > 0 && rows.length <= hr) throw new Error(`Passed header=[${wanted.join(',')}], len of ${wanted.length}, but only ${rows.length} lines in file`)
        throw new Error('No columns to parse from file')
      }
      if (multi && hr === lines.at(-1)) {
        // the extra line is data whenever the table has no index column: it only closes the header
        dataStart = hr
        break
      }
      levels.push(multi ? line.map((c, i) => (c === '' ? `Unnamed: ${i}_level_${level}` : c)) : plainHeaderNames(line))
      dataStart = hr + 1
    }
    columns = multi ? levels[0]!.map((_, i) => levels.map((lvl) => lvl[i]!)) : levels[0]!
  }

  let content = rows.slice(dataStart)
  // thousands separators in cells that look like numbers
  content = content.map((line) => line.map((x) => (x.includes(',') && THOUSANDS_NUM.test(pyStrip(x)) ? x.replaceAll(',', '') : x)))
  const names = dedupNames(columns, multi)
  if (content.length === 0) return { columns: names, multi, data: names.map(() => ({ dtype: 'str' as Dtype, values: [] })) }
  return { columns: names, multi, data: names.map((_, c) => inferColumn(content.map((r) => r[c] ?? ''))) }
}

/** `_data_to_frame`: header rows from <thead> or the top <th>-only rows, the body and the footer as one table. */
function dataToFrame(head: string[][], bodyIn: string[][], foot: string[][]): Frame {
  let body = bodyIn
  let header: number | number[] | null = null
  if (head.length > 0) {
    body = [...head, ...body]
    header = head.length === 1 ? 0 : head.flatMap((row, i) => (row.some((t) => t !== '') ? [i] : []))
  }
  if (foot.length > 0) body = [...body, ...foot]
  // fill out elements of body that are "ragged"
  const max = Math.max(0, ...body.map((r) => r.length))
  body = body.map((r) => (r.length < max ? [...r, ...Array.from({ length: max - r.length }, () => '')] : r))
  return textParser(body, header)
}

/** `pandas.read_html(text)` with the defaults: every table that holds text, as a frame; empty ones are left out. */
export function readHtml(text: string): Frame[] {
  const start = text.search(/<html/i)
  const root = parse(start > 0 ? text.slice(start) : text, { comment: false })
  const tables = descendants(root, (e) => tagOf(e) === 'table').filter((t) => !hiddenStyle(t) && textContent(t).length > 0)
  if (tables.length === 0) throw new Error('No tables found matching regex \'.+\'')
  const frames: Frame[] = []
  for (const table of tables) {
    for (const hidden of descendants(table, hiddenStyle)) hidden.remove()
    const { head, body, foot } = tableRows(table)
    try {
      frames.push(dataToFrame(head, body, foot))
    } catch (err) {
      if (err instanceof Error && err.message === 'No columns to parse from file') continue
      throw err
    }
  }
  return frames
}

// ---------------------------------------------------------------------------------------------------------------
// Frame helpers
// ---------------------------------------------------------------------------------------------------------------

/** The cell at a row of a column by position, as Python would hand it back (`null` for NaN). */
export const cellAt = (f: Frame, col: number, row: number): Cell => f.data[col]?.values[row] ?? null

/** `str(cell)` for a cell of a column of the given dtype (`2026.0`, `True`, `nan`, `None`). */
export function pyStrCell(v: Cell, dtype: Dtype): string {
  if (v === null) return 'nan'
  if (typeof v === 'boolean') return v ? 'True' : 'False'
  if (typeof v === 'number') return dtype === 'float' ? pyFloatStr(v) : String(v)
  return v
}

/** Python's `str(float)` / `repr(float)` */
export function pyFloatStr(v: number): string {
  if (Number.isNaN(v)) return 'nan'
  if (v === Infinity) return 'inf'
  if (v === -Infinity) return '-inf'
  if (Number.isInteger(v) && Math.abs(v) < 1e16) return `${v}.0`
  const s = String(v)
  const m = /^(-?)(\d)(?:\.(\d+))?e([+-])(\d+)$/.exec(s)
  if (m) return `${m[1]}${m[2]}${m[3] ? `.${m[3]}` : ''}e${m[4]}${m[5]!.padStart(2, '0')}`
  return s
}
