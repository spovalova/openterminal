// Ported from openbb_famafrench/utils/helpers.py and missing_values.py (OpenBB Platform 5.0.0, Apache-2.0); modified:
// tables are plain arrays instead of pandas DataFrames (a DataFrame here is `Frame`: an index, columns and string
// cells), downloads go through ctx.http and ctx.cache instead of lru_cache and requests (a country or index file is
// read from its archive with range requests, not by downloading all 1.3 MB), and the pandas.read_csv call of the
// breakpoints is reproduced for the layouts the library publishes.
import { unzipSync } from 'fflate'
import { BROWSER_UA } from '../http.js'
import { zipMemberByRange } from '../lib/zip.js'
import type { NativeCtx } from '../types.js'
import {
  BASE_URL,
  BREAKPOINT_FILES,
  COUNTRY_PORTFOLIOS_URLS,
  COUNTRY_PORTFOLIO_FILES,
  DATASET_CHOICES,
  INTERNATIONAL_INDEX_PORTFOLIOS_URLS,
  INTERNATIONAL_INDEX_PORTFOLIO_FILES,
} from './constants.js'

const DAY_MS = 24 * 3600 * 1000

/** A table cell: the text of the file, or nothing where a row is shorter than the header. */
export type Cell = string | null

/** What a pandas DataFrame is to the ported code: row labels, column names (one or two levels) and the cells. */
export type Frame = {
  /** The Date of each row. */
  index: string[]
  /** The second index level some international tables carry (`Mkt`); absent otherwise. */
  mkt?: Cell[]
  /** Each column's names, outermost level first: `['Mkt-RF']`, or `['BE/ME', 'High']`. */
  columns: string[][]
  rows: Cell[][]
}

export type FrameMeta = { description: string; frequency: string; formations: string[] }

// ---------------------------------------------------------------------------------------------------------------
// Text

/** Python's `str.splitlines()`. */
export function splitLines(text: string): string[] {
  const lines = text.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/)
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Python's `str.split()`: runs of whitespace separate, no empty items. */
export const splitWords = (s: string): string[] => s.split(/\s+/).filter((w) => w !== '')

const hasDigit = (s: string): boolean => /[0-9]/.test(s)

/** UTF-8 when the bytes are valid UTF-8, else Latin-1 (every byte one character). */
export function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    let out = ''
    for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode(...bytes.subarray(i, i + 8192))
    return out
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Missing values and number parsing

/** Python's `float()` on a string, or undefined when it would raise. */
function pyFloat(s: string): number | undefined {
  const t = s.trim()
  if (t === '') return undefined
  const n = Number(t)
  return Number.isNaN(n) && !/^[+-]?nan$/i.test(t) ? undefined : n
}

/** `is_missing_value`: nothing, NaN, or a Fama-French missing-value marker (-99.99, -999), as a string or number. */
export function isMissingValue(value: unknown): boolean {
  if (value === null || value === undefined) return true
  let n: number
  if (typeof value === 'string') {
    if (!/^\s*-9/.test(value)) return false
    const f = pyFloat(value)
    if (f === undefined) return false
    n = f
  } else if (typeof value === 'number') n = value
  else return false
  return Number.isNaN(n) || n === -99.99 || n === -999
}

/** pandas `astype(float)` on a text column. */
export function toFloat(cell: Cell): number {
  if (cell === null) return Number.NaN
  const f = pyFloat(cell)
  if (f === undefined) throw new Error(`could not convert string to float: '${cell}'`)
  return f
}

// ---------------------------------------------------------------------------------------------------------------
// Downloads

async function downloadBytes(ctx: NativeCtx, url: string): Promise<Uint8Array> {
  return ctx.cache(`famafrench:${url}`, DAY_MS, () => ctx.http.bytes(url, { headers: { 'User-Agent': BROWSER_UA } }))
}

/** `download_file`: the first member of a library file, as text. */
export async function downloadFile(ctx: NativeCtx, dataset: string): Promise<string> {
  const labels = new Map(DATASET_CHOICES)
  const label = dataset.replace(/_/g, ' ')
  if (!labels.has(label) && !DATASET_CHOICES.some(([, file]) => file === dataset)) {
    throw new Error(`Dataset ${dataset} not found in available datasets: [${[...labels.keys()].map((k) => `'${k}'`).join(', ')}]`)
  }
  const url = dataset.endsWith('.zip') ? BASE_URL + dataset : BASE_URL + labels.get(label)!
  const zip = await downloadBytes(ctx, url)
  const files = unzipSync(zip)
  const first = Object.keys(files)[0]
  if (first === undefined) throw new Error('There is no item named in the archive')
  return decodeText(files[first]!)
}

// ---------------------------------------------------------------------------------------------------------------
// The .csv files: US, regional and factor datasets

/** `apply_date`: YYYYMM, YYYYMMDD and YYYY as YYYY-MM-DD (month start, as given, year end). */
export function applyDate(x: string): string {
  const date = x.replace(/ /g, '')
  if (date.length === 6) {
    const text = `${date.slice(0, 4)}-${date.slice(4)}`
    const month = Number(date.slice(4))
    if (!/^\d{4}-\d{2}$/.test(text) || month < 1 || month > 12) throw new Error(`time data '${text}' does not match format '%Y-%m'`)
    return `${text}-01`
  }
  if (date.length === 8) return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}`
  if (date.length === 4) return `${date}-12-31`
  return date
}

type CsvTable = { meta: string; headers: string[]; rows: string[][] }

/** `read_csv_file`: the tables of a CSV file with their titles, and the description at its top. */
export function readCsvFile(data: string): { tables: CsvTable[]; description: string } {
  const lines = splitLines(data)
  const tables: CsvTable[] = []
  let general: string[] = []

  // The general description is everything before the first table header or data row.
  let descriptionEnd = 0
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx]!
    if (line.trim().startsWith(',') || /^\s*\d{4,6}/.test(line)) {
      descriptionEnd = idx
      break
    }
    if (line.trim()) general.push(line.trim())
  }

  // The last line of the description may title the first table.
  let tableMeta = ''
  const last = general[general.length - 1]
  if (last !== undefined && (last.includes('Monthly') || last.includes('Annual') || last.includes('Returns'))) {
    tableMeta = last
    general = general.slice(0, -1)
  }

  let i = descriptionEnd
  while (i < lines.length) {
    while (i < lines.length && !lines[i]!.trim()) i++
    if (i >= lines.length) break

    if (lines[i]!.trim().startsWith(',')) {
      // The title is the nearest non-blank line above the header.
      let meta = tableMeta
      for (let j = i - 1; j >= descriptionEnd; j--) {
        if (lines[j]!.trim()) {
          meta = lines[j]!.trim()
          break
        }
      }
      const headers = ['Date', ...lines[i]!.trim().split(',').slice(1)]
      i++
      const rows: string[][] = []
      while (i < lines.length) {
        const line = lines[i]!.trim()
        if (!line) break
        rows.push(line.split(',').map((d) => d.trim()))
        i++
      }
      if (rows.length > 0) tables.push({ meta, headers, rows })
    } else if (lines[i]!.includes('--') && ['Daily', 'Monthly', 'Annual', 'Weekly'].some((d) => lines[i]!.includes(d))) {
      // A title for the table that follows.
      tableMeta = lines[i]!.trim()
      i++
    } else i++
  }
  return { tables, description: general.join('\n') }
}

/** A DataFrame built from ragged rows: the widest row sets the columns, shorter rows are padded. */
function widen(rows: string[][]): { width: number; padded: Cell[][] } {
  const width = Math.max(...rows.map((r) => r.length))
  return { width, padded: rows.map((r) => Array.from({ length: width }, (_, c) => r[c] ?? null)) }
}

/** `process_csv_tables`: frames indexed by Date (sorted), and what the frame is about. */
export function processCsvTables(tables: CsvTable[], description = ''): { frames: Frame[]; metas: FrameMeta[] } {
  const frames: Frame[] = []
  const metas: FrameMeta[] = []
  for (const table of tables) {
    if (table.rows.length === 0) continue
    const headers = [...table.headers]
    const { width, padded } = widen(table.rows)
    if (headers.length < width) for (let c = headers.length; c < width; c++) headers.push(`Column_${c}`)
    if (width === 0) continue
    const names = headers.slice(0, width)

    // Dates: if any one fails to parse, the column is kept as text.
    let dates: string[]
    try {
      dates = padded.map((r) => applyDate(String(r[0])))
    } catch {
      dates = padded.map((r) => String(r[0]))
    }
    const order = dates.map((_, r) => r).sort((a, b) => (dates[a]! < dates[b]! ? -1 : dates[a]! > dates[b]! ? 1 : 0))
    frames.push({ index: order.map((r) => dates[r]!), columns: names.slice(1).map((n) => [n]), rows: order.map((r) => padded[r]!.slice(1)) })

    const meta = table.meta.trim()
    metas.push({ description: `### ${meta}\n\n${description.replace(/\n/g, ' ')}\n\n`, frequency: meta.includes('Annual') ? 'annual' : 'monthly', formations: headers.slice(1) })
  }
  return { frames, metas }
}

/** `get_portfolio_data`: the tables of a library file for a frequency and a measure. */
export async function getPortfolioData(ctx: NativeCtx, dataset: string, frequency?: string | null, measure?: string | null): Promise<{ frames: Frame[]; metas: FrameMeta[] }> {
  if (frequency && !['monthly', 'annual', 'daily'].includes(frequency.toLowerCase())) {
    throw new Error(`Frequency ${frequency} not supported. Choose from 'monthly', 'annual', or 'daily'.`)
  }
  if (measure && !['value', 'equal', 'number_of_firms', 'firm_size'].includes(measure)) {
    throw new Error(`Measure ${measure} not supported. Choose from 'value', 'equal', 'number_of_firms', or 'firm_size'.`)
  }
  if ((measure === 'number_of_firms' || measure === 'firm_size') && frequency === 'annual') throw new Error(`Measure '${measure}' is only available for monthly frequency.`)
  if (dataset.includes('Factor')) measure = null

  const { tables, description } = readCsvFile(await downloadFile(ctx, dataset))
  let { frames, metas } = processCsvTables(tables, description)

  const keep = (test: (m: FrameMeta) => boolean): void => {
    const at = metas.map((m, i) => (test(m) ? i : -1)).filter((i) => i >= 0)
    frames = at.map((i) => frames[i]!)
    metas = at.map((i) => metas[i]!)
  }
  if (frequency) keep((m) => m.frequency.toLowerCase() === frequency.toLowerCase())
  if (measure) {
    if (measure === 'value' || measure === 'equal') keep((m) => m.description.includes('--') && m.description.split(' -- ')[0]!.toLowerCase().includes(measure!.toLowerCase()))
    else if (measure === 'number_of_firms') keep((m) => m.description.includes('Number of Firms'))
    else keep((m) => m.description.includes('Average Firm Size'))
  }
  return { frames, metas }
}

// ---------------------------------------------------------------------------------------------------------------
// The .dat files: international countries and indices

type DatTable = { meta: string; spanners: string; headers: string[]; rows: string[][] }

const COMMA_LINE = /^\s*,/

/** `read_dat_file`: the tables of a whitespace-separated international file (see the Python for the layout rules). */
export function readDatFile(data: string): DatTable[] {
  const lines = splitLines(data)
  const tables: DatTable[] = []
  let table: DatTable | undefined
  let i = 0
  while (i < lines.length) {
    // A separator or the title line of the next table ends the current one.
    if (COMMA_LINE.test(lines[i]!) || (i > 1 && lines[i]!.includes('Data') && table !== undefined && table.rows.length > 0)) {
      if (table !== undefined && table.rows.length > 0) tables.push(table)
      if (COMMA_LINE.test(lines[i]!)) {
        i++
        continue
      }
    }

    // A new table: its title lines run up to the spanner line (or a Firms header).
    table = { meta: '', spanners: '', headers: [], rows: [] }
    const metaLines: string[] = []
    while (i < lines.length) {
      const line = lines[i]!.trim()
      // The Python expression `A or B and C if cond else D or E or F` reads as `(A or (B and C)) if cond else (D or E or F)`.
      const stop =
        i + 1 < lines.length
          ? line.includes('--') || (splitWords(line).includes('Firms') && hasDigit(lines[i + 1]!))
          : line === '' || line === ' ' || (line !== '' && /[0-9]/.test(line[0]!) && splitWords(line).length > 2)
      if (stop) break
      if (line) metaLines.push(line)
      i++
    }
    table.meta = metaLines.join('\n')

    if (i < lines.length && lines[i]!.includes('--')) {
      table.spanners = lines[i]!
      i++
    }

    if (i < lines.length) {
      const header = lines[i]!.trim()
      if (splitWords(header).includes('Firms') || (header !== '' && !/[0-9]/.test(header[0]!))) {
        table.headers = ['Date', ...splitWords(header)]
        i++
      } else if (table.meta.includes('Firms')) {
        table.headers = ['Date', 'Firms', 'B/M', 'E/P', 'CE/P', 'Yld']
      } else {
        // Malformed: skip to the next separator or title.
        while (i < lines.length && !(COMMA_LINE.test(lines[i]!) || lines[i]!.includes('Data'))) i++
        continue
      }
    }

    while (i < lines.length && !(COMMA_LINE.test(lines[i]!) || lines[i]!.includes('Data'))) {
      const line = lines[i]!
      if (line.trim() && !line.trim().startsWith('Copyright') && !line.includes('©') && hasDigit(line)) table.rows.push(splitWords(line))
      i++
    }
  }
  if (table !== undefined && table.rows.length > 0) tables.push(table)
  return tables
}

/** `process_international_portfolio_data`: frames with spanner and column names as two column levels. */
export function processInternationalPortfolioData(tables: DatTable[], dividends = true): { frames: Frame[]; metas: FrameMeta[] } {
  const frames: Frame[] = []
  const metas: FrameMeta[] = []
  for (const table of tables) {
    const spanners = splitWords(table.spanners.replace(/-/g, ''))
    if (table.rows.length === 0) continue
    const { width, padded } = widen(table.rows)
    // Without a name for every column the frame has no `Date` column: pandas fails on it.
    if (table.headers.length !== width) throw new Error("'Date'")
    const headers = table.headers
    const hasFirms = headers.includes('Firms')

    let dates: string[]
    try {
      dates = padded.map((r) => applyDate(String(r[0])))
    } catch {
      dates = padded.map((r) => String(r[0]))
    }

    const mktAt = headers.includes('Mkt') && !hasFirms ? headers.indexOf('Mkt') : -1
    const dropped = mktAt >= 0 ? [0, mktAt] : [0]
    const remaining = headers.filter((_, c) => !dropped.includes(c))
    const cells = padded.map((r) => r.filter((_, c) => !dropped.includes(c)))

    let columns: string[][] = remaining.map((h) => [h])
    if (!hasFirms && spanners.length > 0 && remaining.length > 0) {
      const perGroup = Math.floor(remaining.length / spanners.length)
      const top: string[] = []
      for (const group of spanners) for (let k = 0; k < perGroup; k++) top.push(group)
      const zero = remaining.indexOf('Zero')
      if (zero >= 0) {
        const yld = spanners.find((g) => g.toLowerCase() === 'yld')
        if (yld !== undefined) {
          while (top.length <= zero) top.push('')
          top[zero] = yld
        }
      }
      if (top.length === remaining.length) columns = remaining.map((h, c) => [top[c]!, h])
    }
    frames.push({ index: dates, ...(mktAt >= 0 ? { mkt: padded.map((r) => r[mktAt]!) } : {}), columns, rows: cells })

    let description = table.meta.trim().replace(/\n/g, ' - ')
    if (dividends === false) description += ' - Ex-Dividends'
    description = description.replace(/\s{2,}/g, ' ')
    metas.push({ description, frequency: dates[0]!.slice(-2) === '31' ? 'annual' : 'monthly', formations: hasFirms ? headers.filter((d) => d !== 'Firms') : spanners })
  }
  return { frames, metas }
}

/** `get_international_portfolio_data`: the text of one country's or index's file. */
async function getInternationalPortfolioData(ctx: NativeCtx, index: string | undefined, country: string | undefined, dividends: boolean): Promise<string> {
  if (!index && !country) throw new Error('Please provide either an index or a country.')
  if (index && country) throw new Error('Please provide either an index or a country, not both at the same time.')
  let url = ''
  let member: string | undefined
  if (index) {
    // OpenBB looks for "Ind_Scandinavia.Dat"; the archive's member is spelled "Ind_Scandanavia.Dat".
    member = index === 'scandinavia' ? 'Ind_Scandanavia.Dat' : INTERNATIONAL_INDEX_PORTFOLIO_FILES[index]
    if (!member) throw new Error(`Index ${String(member)} not found in available indexes: ${JSON.stringify(INTERNATIONAL_INDEX_PORTFOLIO_FILES)}`)
    url = BASE_URL + INTERNATIONAL_INDEX_PORTFOLIOS_URLS[dividends ? 'dividends' : 'ex']
  } else if (country) {
    const name = country.replace(/[A-Za-z]+/g, (w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase()).replace(/_/g, ' ')
    if (!(name in COUNTRY_PORTFOLIO_FILES)) throw new Error(`Country ${name} not found in available countries: ${JSON.stringify(COUNTRY_PORTFOLIO_FILES)}`)
    url = BASE_URL + COUNTRY_PORTFOLIOS_URLS[dividends ? 'dividends' : 'ex']
    member = COUNTRY_PORTFOLIO_FILES[name]
  }
  // The archives hold a file per country or index (1.3 MB together); only the one asked for is fetched.
  const wanted = member!
  return ctx.cache(`famafrench:${url}#${wanted}`, DAY_MS, async () => {
    const bytes = await zipMemberByRange(async (range) => {
      const res = await ctx.http.response(url, { headers: { 'User-Agent': BROWSER_UA, Range: range } })
      return { status: res.status, body: new Uint8Array(await res.arrayBuffer()) }
    }, wanted)
    if (bytes === undefined) throw new Error(`Index ${wanted} not found in available indexes: the archive has no such file`)
    return decodeText(bytes)
  })
}

export type InternationalOptions = {
  index?: string
  country?: string
  dividends?: boolean
  frequency?: string
  measure?: string
  allDataItemsRequired?: boolean
}

/** `get_international_portfolio`: the tables of a country or index file for a frequency and a measure. */
export async function getInternationalPortfolio(ctx: NativeCtx, o: InternationalOptions): Promise<{ frames: Frame[]; metas: FrameMeta[] }> {
  const measure = o.measure !== undefined ? o.measure.toLowerCase() : 'usd'
  const dividends = o.dividends ?? true
  const data = await getInternationalPortfolioData(ctx, o.index, o.country, dividends)
  let { frames, metas } = processInternationalPortfolioData(readDatFile(data), dividends)

  if (measure && !['usd', 'local', 'ratios'].includes(measure)) throw new Error(`Measure ${measure} not supported. Choose from 'usd', 'local', or 'ratios'.`)
  if (o.frequency === 'monthly' && measure === 'ratios') throw new Error("Only annual frequency is available for 'ratios' measure.")

  const keep = (test: (m: FrameMeta) => boolean): void => {
    const at = metas.map((m, i) => (test(m) ? i : -1)).filter((i) => i >= 0)
    frames = at.map((i) => frames[i]!)
    metas = at.map((i) => metas[i]!)
  }
  if (o.frequency) keep((m) => m.frequency === o.frequency)
  if (measure === 'local') keep((m) => m.description.includes('Local'))
  else if (measure === 'usd') keep((m) => m.description.includes('Dollar'))
  else if (measure === 'ratios') keep((m) => m.description.includes('Ratios'))

  if (o.allDataItemsRequired === false && measure !== 'ratios') {
    // Python filters the frames on "Not Reqd" being absent, but the metadata on the description ending with it.
    const notRequired = metas.map((m) => !m.description.includes('Not Reqd'))
    frames = frames.filter((_, i) => notRequired[i])
    metas = metas.filter((m) => m.description.endsWith('Not Reqd'))
  } else if (o.allDataItemsRequired === true) keep((m) => m.description.includes('Required'))
  return { frames, metas }
}

// ---------------------------------------------------------------------------------------------------------------
// Breakpoints

const PERCENTILES = Array.from({ length: 20 }, (_, k) => `percentile_${(k + 1) * 5}`)
const RATIO_BREAKPOINTS = ['be-me', 'e-p', 'cf-p', 'd-p']

export type BreakpointRow = Record<string, string | number>

/** The last day of a YYYYMM month. */
function monthEnd(yyyymm: string): string {
  const year = Number(yyyymm.slice(0, 4))
  const month = Number(yyyymm.slice(4))
  if (!/^\d{6}$/.test(yyyymm) || month < 1 || month > 12) throw new Error(`time data "${yyyymm}" doesn't match format "%Y%m"`)
  return `${yyyymm.slice(0, 4)}-${yyyymm.slice(4)}-${String(new Date(Date.UTC(year, month, 0)).getUTCDate()).padStart(2, '0')}`
}

/**
 * `get_breakpoint_data`. pandas.read_csv(skiprows, header=0, names, skipfooter=1, engine="python") drops the rows it
 * skips, then the file's last line, then blank lines, and takes the first row left as the header that `names`
 * replaces. So the first data row of every file is lost; OpenBB's answer lacks it too.
 */
export async function getBreakpointData(ctx: NativeCtx, type: string): Promise<{ rows: BreakpointRow[]; metadata: string }> {
  const file = await downloadFile(ctx, BREAKPOINT_FILES[type]!)
  const all = splitLines(file)
  let metadata = ''
  for (const line of all.slice(0, 3)) {
    if (!line.trim() || line.trim().startsWith('19')) break
    metadata += `${line.trim()} `
  }
  metadata = metadata.trim()

  const names = RATIO_BREAKPOINTS.includes(type) ? ['num_firms_less_than_0', 'num_firms_greater_than_0', ...PERCENTILES] : ['num_firms', ...PERCENTILES]
  const lines = all.slice(type === 'me' ? 1 : 3)
  lines.pop()
  const records = lines.filter((l) => l.trim() !== '')
  records.shift()

  const rows = records.map((line) => {
    const fields = line.split(',').map((f) => f.trim())
    // One field more than names: the first is the index (index_col=None leaves pandas to infer it).
    if (fields.length !== names.length + 1) throw new Error(`Expected ${names.length + 1} fields in line, saw ${fields.length}`)
    const date = fields[0]!
    const row: BreakpointRow = { date: date.length === 6 ? monthEnd(date) : `${date}-12-31` }
    names.forEach((n, k) => {
      const v = Number(fields[k + 1])
      if (fields[k + 1] === '' || Number.isNaN(v)) throw new Error(`could not convert string to float: '${fields[k + 1]}'`)
      row[n] = v
    })
    return row
  })
  return { rows, metadata }
}
