// Morningstar fact sheets of Nasdaq Nordic shares. Ported from openbb_nasdaq/utils/factsheet.py (OpenBB Platform 5.0.0,
// Apache-2.0); modified: the PDF is read with src/lib/pdf-words.ts (pdfplumber's characters and words, to the last bit)
// instead of pdfplumber, the parsed sheet is memoised through ctx.cache instead of the downloaded bytes through
// alru_cache, and a sheet the reader cannot handle is left to the OpenBB API (NativeUnsupported).
//
// The fact sheet is a fixed two-page layout, so the tables are recovered from word positions rather than from the
// reading order, which interleaves the columns.
import { extractWords, isSpace, pdfPages, PdfUnsupported, type PdfChar, type PdfWord } from '../lib/pdf-words.js'
import { NativeUnsupported, type NativeCtx } from '../types.js'
import { getNasdaqData, pdfHeaders, type Dict } from './helpers.js'
import { resolveNordicInstrument } from './nordic.js'

const FACTSHEET_URL = 'https://lt.morningstar.com/gj8uge2g9k/stockprofile/default.aspx'
const SHEET_TTL_MS = 6 * 3600 * 1000

const MIC_CODES: Record<string, string> = { STO: 'XSTO', CPH: 'XCSE', HEL: 'XHEL', ICE: 'XICE' }
const EXCHANGE_NAMES: [string, string][] = [
  ['stockholm', 'XSTO'],
  ['copenhagen', 'XCSE'],
  ['helsinki', 'XHEL'],
  ['iceland', 'XICE'],
]

// Any run of digits, separators, and a sign - deliberately looser than a well-formed number so that two columns
// rendered without a gap survive as one token and can be split apart on glyph positions rather than silently dropped.
const NUMBER = /^-?(?=[\p{Nd},.]*\p{Nd})[\p{Nd},.]+%?$/u

const X_TOLERANCE = 1.5
const LINE_TOLERANCE = 2.5
const PAGE_ONE_SPLIT = 360
const PAGE_TWO_LEFT = 225
const PAGE_TWO_FOOTER = 640
const AVERAGE_PERIODS = ['Current', '3 Yr Avg', '5 Yr Avg', '10 Yr Avg']
const PEER_PERIODS = ['Mkt Cap (Mil)', 'P/E', 'ROE%']
const EDGE_SLACK = 2.0

const HEADER_LABEL = /^(?:Years\b|Instrument\b)/
const HEADER_ROW = /Yr Avg|^Mkt Cap|^Instrument/

const HORIZON_PATTERNS = [/^(?:\d+ (?:Week|Month|Months|Year|Years)|YTD)$/, /^(?:Current|\d+ Yr Avg|\d+ Yr Avg\b|\d+ Yr)$/, /^Q[1-4]$/, /^\d+Y$/]

const SECTION_TITLES = ['Yearly Performance', 'Trailing Returns', 'Financials', 'Profitability and Valuation', 'Compound Annual Growth Rates', 'Profitability Analysis', 'Financial Position', 'Quarterly Results', 'Valuation Analysis']

export type SeriesRow = { section: string | null; label: string; period: string; value: string }
export type ProfileRow = { section: string; label: string; value: string }
export type DividendRow = { ex_date: string; payment_date: string; type: string; currency: string; amount: string }
export type FactSheet = { profile: ProfileRow[]; series: SeriesRow[]; dividends: DividendRow[] }

/** A header cell: a word, or several words joined. */
type Cell = { text: string; x0: number; x1: number; top: number }

const emptySheet = (): FactSheet => ({ profile: [], series: [], dividends: [] })

/** Python's `str.strip(chars)`. */
function stripChars(s: string, chars: string): string {
  let a = 0
  let b = s.length
  while (a < b && chars.includes(s[a]!)) a++
  while (b > a && chars.includes(s[b - 1]!)) b--
  return s.slice(a, b)
}

/** Python's `str.strip()`: whatever `str.isspace` calls whitespace, from both ends. */
export function pyStrip(s: string): string {
  let a = 0
  let b = s.length
  while (a < b && isSpace(s[a]!)) a++
  while (b > a && isSpace(s[b - 1]!)) b--
  return s.slice(a, b)
}

const isNumber = (text: string): boolean => NUMBER.test(text)
const textOf = (line: PdfWord[]): string => line.map((w) => w.text).join(' ')

/** The URL of the fact sheet for a listing (`build_factsheet_url`). */
export function buildFactsheetUrl(isin: string, currency: string, exchange: string): string {
  const mic = MIC_CODES[exchange.toUpperCase()] ?? exchange.toUpperCase()
  return `${FACTSHEET_URL}?LanguageId=en-GB&externalid=${isin}&BaseCurrencyId=${currency.toUpperCase()}&externalidexchange=EX%24%24%24%24${mic}&externalidtype=ISIN`
}

/** Thrown when no PDF came back (`fetch_factsheet` raising); the caller turns it into an empty sheet. */
class NoFactSheet extends Error {}

async function fetchFactsheet(ctx: NativeCtx, isin: string, currency: string, exchange: string): Promise<Uint8Array> {
  const res = await ctx.http.response(buildFactsheetUrl(isin, currency, exchange), { headers: pdfHeaders() })
  const payload = new Uint8Array(await res.arrayBuffer())
  if (!(payload.length >= 4 && payload[0] === 0x25 && payload[1] === 0x50 && payload[2] === 0x44 && payload[3] === 0x46)) throw new NoFactSheet(`No fact sheet was published for ${isin}.`)
  return payload
}

// --- words by region -----------------------------------------------------------------------------------------------

/** One page's words (x_tolerance 1.5) with the region filter and line clustering of `_lines`. */
class Page {
  private readonly words: PdfWord[]
  constructor(chars: readonly PdfChar[]) {
    this.words = extractWords(chars, { xTolerance: X_TOLERANCE })
  }

  /** Cluster the words in a rectangular region into lines, top to bottom. */
  lines(left: number, right: number, top = 0, bottom = 10_000): PdfWord[][] {
    const inside = this.words.filter((w) => left <= w.x0 && w.x0 < right && top <= w.top && w.top < bottom)
    const rows = new Map<number, PdfWord[]>()
    for (const word of [...inside].sort((a, b) => a.top - b.top)) {
      let key = word.top
      for (const k of rows.keys()) {
        if (Math.abs(k - word.top) <= LINE_TOLERANCE) {
          key = k
          break
        }
      }
      const row = rows.get(key)
      if (row) row.push(word)
      else rows.set(key, [word])
    }
    return [...rows.keys()].sort((a, b) => a - b).map((k) => [...rows.get(k)!].sort((a, b) => a.x0 - b.x0))
  }
}

/** One value per header column for a data row (`_values`), anchored on the right edge of each header cell. */
function values(words: PdfWord[], cells: { x1: number }[]): (string | null)[] {
  if (cells.length === 0) return []
  const edges = cells.map((c) => c.x1)
  const tokens = words.filter((w) => isNumber(w.text) || w.text === '-')
  const buckets: string[][] = edges.map(() => [])
  const columnOf = (position: number): number => {
    const i = edges.findIndex((edge) => position <= edge + EDGE_SLACK)
    return i < 0 ? edges.length - 1 : i
  }
  for (const word of tokens) {
    const index = columnOf(word.x1)
    if (index && word.x0 < edges[index - 1]! - EDGE_SLACK) {
      const chars = [...word.text]
      const width = (word.x1 - word.x0) / Math.max(chars.length, 1)
      chars.forEach((char, offset) => buckets[columnOf(word.x0 + width * (offset + 0.5))]!.push(char))
      continue
    }
    buckets[index]!.push(word.text)
  }
  return buckets.map((b) => pyStrip(b.join('')) || null)
}

/** Split a row into its label and its per-column values. */
function labelAndValues(line: PdfWord[], cells: { x1: number }[], labelFirst = true): [string, (string | null)[]] {
  let labelWords: PdfWord[]
  let valueWords: PdfWord[]
  if (labelFirst) {
    let n = 0
    while (n < line.length && !isNumber(line[n]!.text)) n++
    labelWords = line.slice(0, n)
    valueWords = line.slice(n)
  } else {
    let n = 0
    while (n < line.length && !isNumber(line[line.length - 1 - n]!.text)) n++
    labelWords = line.slice(line.length - n)
    valueWords = line.slice(0, line.length - n)
  }
  return [stripChars(labelWords.map((w) => w.text).join(' '), ' ,'), values(valueWords, cells)]
}

/** A readable section name, naming the bare-currency block. */
function sectionName(section: string): string | null {
  if (!section) return null
  return /^\(?[A-Z]{3}\)?$/.test(section) ? 'Market Summary' : section
}

/** The cells of a line when it reads as a calendar period header. */
function yearHeader(line: PdfWord[]): Cell[] {
  const cells = line.filter((w) => /^(?:19|20)\d{2}(?:-\d{2})?$/.test(w.text)).map(asCell)
  return cells.length >= 2 ? cells : []
}

const asCell = (w: PdfWord): Cell => ({ text: w.text, x0: w.x0, x1: w.x1, top: w.top })

/** Join adjacent words into one cell spanning their combined extent. */
const join = (words: Cell[]): Cell => ({ text: words.map((w) => w.text).join(' '), x0: words[0]!.x0, x1: words[words.length - 1]!.x1, top: words[0]!.top })

/** Group the words of a header line into cells matching a period pattern: '1 Week', '3 Yr Avg' and 'Q3' are separate words. */
function mergeCells(line: PdfWord[], pattern: RegExp): Cell[] {
  const cells: Cell[] = []
  let current: Cell[] = []
  for (const word of line.map(asCell)) {
    if (current.length > 0 && word.x0 - current[current.length - 1]!.x1 > 4) {
      cells.push(join(current))
      current = []
    }
    current.push(word)
  }
  if (current.length > 0) cells.push(join(current))
  return cells.filter((c) => pattern.test(c.text))
}

function horizonHeader(line: PdfWord[]): Cell[] {
  for (const pattern of HORIZON_PATTERNS) {
    const cells = mergeCells(line, pattern)
    if (cells.length >= 2) return cells
  }
  return []
}

const periodHeader = (line: PdfWord[]): Cell[] => {
  const years = yearHeader(line)
  return years.length > 0 ? years : horizonHeader(line)
}

/** Every labelled period series in one vertical band of a page (`_parse_banded`). */
function parseBanded(page: Page, left: number, right: number, labelFirst: boolean): SeriesRow[] {
  const rows: SeriesRow[] = []
  let section = ''
  let subsection = ''
  let cells: Cell[] = []
  let periods: string[] = []
  for (const line of page.lines(left, right)) {
    const text = textOf(line)
    const title = SECTION_TITLES.find((t) => text.startsWith(t))
    if (title && periodHeader(line).length === 0) {
      section = title
      subsection = ''
      cells = []
      periods = []
      continue
    }
    const header = periodHeader(line)
    if (header.length > 0) {
      cells = header
      periods = header.map((w) => w.text)
      const trailing = line.filter((w) => w.x0 > header[header.length - 1]!.x1 + 4)
      const leading = line.filter((w) => w.x1 < header[0]!.x0 - 4)
      if (trailing.length > 0 && labelFirst === false) section = stripChars(textOf(trailing), ' ,')
      else if (leading.length > 0 && labelFirst) {
        const heading = stripChars(textOf(leading), ' ,')
        subsection = HEADER_LABEL.test(heading) ? '' : heading
      }
      continue
    }
    if (cells.length === 0) continue
    const [found, vals] = labelAndValues(line, cells, labelFirst)
    const label = found || subsection || section
    if (!label || !vals.some((v) => v)) continue
    periods.forEach((period, i) => {
      const value = vals[i]
      if (i < vals.length && value !== null && value !== undefined) rows.push({ section: sectionName(section), label: subsection && subsection !== label ? `${subsection}: ${label}` : label, period, value })
    })
  }
  return rows
}

/** The profile block from the right-hand column of page one (`_parse_key_stats`). */
function parseKeyStats(page: Page): ProfileRow[] {
  const rows: ProfileRow[] = []
  let capture = false
  for (const line of page.lines(PAGE_ONE_SPLIT, 9999)) {
    const text = textOf(line)
    if (text.startsWith('Key Stats')) {
      capture = true
      continue
    }
    if (text.startsWith('Yearly Performance') || text.startsWith('Dividends') || text.startsWith('Source:')) capture = false
    if (!capture || line.length < 2) continue
    let split = -1
    for (let i = 1; i < line.length; i++) if (line[i]!.x0 - line[i - 1]!.x1 > 6) split = i
    if (split < 0) continue
    const label = stripChars(line.slice(0, split).map((w) => w.text).join(' '), ' ,')
    const value = pyStrip(line.slice(split).map((w) => w.text).join(' '))
    if (label && value) rows.push({ section: 'Key Stats', label, value })
  }
  return rows
}

/** Column anchors from the first data row carrying every column (`_anchor_edges`). */
function anchorEdges(lines: PdfWord[][], count: number): { x1: number }[] {
  for (const line of lines) {
    const tokens = line.filter((w) => isNumber(w.text))
    if (tokens.length === count) return tokens.map((w) => ({ x1: w.x1 }))
  }
  return []
}

/** A block whose columns are fixed and whose header does not tokenize (`_parse_fixed_table`). */
function parseFixedTable(lines: PdfWord[][], periods: string[], section: string): SeriesRow[] {
  const cells = anchorEdges(lines, periods.length)
  if (cells.length === 0) return []
  const rows: SeriesRow[] = []
  for (const line of lines) {
    const [label, vals] = labelAndValues(line, cells, true)
    if (!label || !vals.some((v) => v) || HEADER_ROW.test(label)) continue
    periods.forEach((period, i) => {
      const value = vals[i]
      if (i < vals.length && value !== null && value !== undefined) rows.push({ section, label, period, value })
    })
  }
  return rows
}

/** One Current / 3 Yr / 5 Yr / 10 Yr average block (`_parse_averages`). */
function parseAverages(page: Page, title: string, left: number, right: number): SeriesRow[] {
  const lines = page.lines(left, right)
  const start = lines.findIndex((ln) => textOf(ln).startsWith(title))
  if (start < 0) return []
  const block: PdfWord[][] = []
  for (const line of lines.slice(start + 1)) {
    const text = textOf(line)
    if (text.startsWith('Financial Position') || text.startsWith('Quarterly Results') || text.startsWith('Nasdaq Disclaimer')) break
    block.push(line)
  }
  return parseFixedTable(block, AVERAGE_PERIODS, title)
}

/** The industry peer table from the foot of page two (`_parse_peers`). */
function parsePeers(page: Page): SeriesRow[] {
  const lines = page.lines(396, 9999, PAGE_TWO_FOOTER, 760)
  const block = lines.filter((ln) => !(textOf(ln).startsWith('Industry') || textOf(ln).startsWith('Mkt')))
  return parseFixedTable(block, PEER_PERIODS, 'Industry Peers')
}

/** The derivative availability flags from the foot of page two (`_parse_options_futures`). */
function parseOptionsFutures(page: Page): ProfileRow[] {
  const rows: ProfileRow[] = []
  for (const line of page.lines(0, 225, PAGE_TWO_FOOTER, 745)) {
    const text = textOf(line)
    if (!(text.startsWith('Options ') || text.startsWith('Forwards ') || text.startsWith('Futures '))) continue
    const at = text.indexOf(' ')
    const label = text.slice(0, at)
    const value = text.slice(at + 1)
    if (value !== 'Yes' && value !== 'No') continue
    rows.push({ section: 'Options & Futures', label, value })
  }
  return rows
}

/** The company profile prose from the head of page one (`_parse_description`). */
function parseDescription(page: Page): ProfileRow[] {
  const lines = page.lines(PAGE_ONE_SPLIT, 9999)
  const start = lines.findIndex((ln) => textOf(ln).startsWith('Company Profile'))
  if (start < 0) return []
  const prose: string[] = []
  for (const line of lines.slice(start + 1)) {
    const text = textOf(line)
    if (text.startsWith('Key Stats')) break
    prose.push(text)
  }
  const body = pyStrip(prose.join(' '))
  return body ? [{ section: 'Company Profile', label: 'Description', value: body }] : []
}

/** The declared dividend table from the right of page one (`_parse_dividends`). */
function parseDividends(page: Page): DividendRow[] {
  const lines = page.lines(PAGE_ONE_SPLIT, 9999)
  const start = lines.findIndex((ln) => textOf(ln).startsWith('Ex Date'))
  if (start < 0) return []
  const rows: DividendRow[] = []
  for (const line of lines.slice(start + 1)) {
    const cells = line.map((w) => w.text)
    if (cells.length < 5 || !/^\d{2}\/\d{2}\/\d{4}$/.test(cells[0]!)) break
    rows.push({ ex_date: cells[0]!, payment_date: cells[1]!, type: cells[2]!, currency: cells[3]!, amount: cells[cells.length - 1]! })
  }
  return rows
}

/** Parse a Morningstar fact sheet into long-format records (`parse_factsheet`). */
export function parseFactsheet(payload: Uint8Array): FactSheet {
  let pages
  try {
    pages = pdfPages(payload)
  } catch (err) {
    if (err instanceof PdfUnsupported) throw new NativeUnsupported(`nasdaq fact sheet: ${err.message}`)
    throw err
  }
  // pdfplumber's `pdf.pages[1]` raises on a shorter file; a file this reader sees fewer pages in is one it may not read.
  if (pages.length < 2) throw new NativeUnsupported('nasdaq fact sheet: fewer than two pages found')
  const first = new Page(pages[0]!.chars)
  const second = new Page(pages[1]!.chars)

  const profile = [...parseDescription(first), ...parseKeyStats(first), ...parseOptionsFutures(second)]
  const dividends = parseDividends(first)
  const series = [
    ...parseBanded(first, 0, PAGE_ONE_SPLIT, true),
    ...parseBanded(second, 0, PAGE_TWO_LEFT, true),
    ...parseBanded(second, PAGE_TWO_LEFT, 9999, false),
    ...parseAverages(second, 'Profitability Analysis', 0, PAGE_TWO_LEFT),
    ...parseAverages(second, 'Valuation Analysis', 225, 396),
    ...parsePeers(second),
  ]
  const seen = new Set<string>()
  const unique: SeriesRow[] = []
  for (const row of series) {
    const key = JSON.stringify([row.section, row.label, row.period])
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(row)
  }
  return { profile, series: unique, dividends }
}

/** Resolve a Nasdaq Nordic symbol and parse its Morningstar fact sheet (`get_instrument_factsheet`); empty sections when none is published. */
export async function getInstrumentFactsheet(ctx: NativeCtx, symbol: string): Promise<FactSheet> {
  const instrument = await resolveNordicInstrument(ctx, symbol)
  if (!instrument.isin) return emptySheet()
  const info: Dict | null = await getNasdaqData(ctx, `nordic/instruments/${instrument.orderbook_id}/info?assetClass=${instrument.asset_class}&lang=en`)
  const header: Dict = (info ?? {}).qdHeader || {}
  const exchange = String(header.exchange || '').toLowerCase()
  const mic = EXCHANGE_NAMES.find(([name]) => exchange.includes(name))?.[1] ?? 'XSTO'
  const currency = String(header.currency || 'SEK')
  try {
    return await ctx.cache(`nasdaq:factsheet:${instrument.isin}:${currency.toUpperCase()}:${mic}`, SHEET_TTL_MS, async () => {
      let payload: Uint8Array
      try {
        payload = await fetchFactsheet(ctx, instrument.isin!, currency, mic)
      } catch (err) {
        if (ctx.signal?.aborted) throw err
        throw new NoFactSheet(err instanceof Error ? err.message : String(err))
      }
      return parseFactsheet(payload)
    })
  } catch (err) {
    if (err instanceof NoFactSheet) return emptySheet()
    throw err
  }
}
