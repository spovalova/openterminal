// sec/filing_headers and the base of every filing route, provider sec. Ported from openbb_sec/models/sec_filing.py
// (OpenBB Platform 5.0.0, Apache-2.0); modified: an async `Filing.create` instead of a constructor that runs async
// code, plain objects instead of pydantic models, bs4 and pandas.read_html replaced by node-html-parser and
// ./pandas-lite.ts, and the XBRL zip is read with fflate.
import { unzipSync } from 'fflate'
import { parse } from 'node-html-parser'
import type { NativeCtx, Row } from '../../types.js'
import { NativeHttpError } from '../../http.js'
import { DEFAULT_EXPIRE_S, SEC_HEADERS, cachedRequest, cikMap, decodeLatin1, secResponse } from '../helpers.js'
import { elementText, isEmpty, nrows, pyStrCell, pyStrip, readHtml, type Frame } from './pandas-lite.js'
import { fmtDate, parseDate } from './pydate.js'

/** One `<DOCUMENT>` of the filing, as the index headers describe it. */
export type FilingDocument = { type: string; sequence: string; filename: string; description?: string; content?: string; url: string }

/** What `Data` models give a filing's cover page: the dei facts by label. */
export type CoverPage = Record<string, unknown>

const PRIMARY_DOC_TYPES = ['10-K', '10-Q', '10-K/A', '10-Q/A', '20-F', '40-F', '8-K', '6-K']

/** `IndexError`: the one error the cover page parser lets pass. */
class PyIndexError extends Error {}

/** Python's `re.search(pattern, doc)` group 1 for a `(.*?)\n` line match; `.` takes everything but "\n". */
function lineField(doc: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}>([^\\n]*?)\\n`).exec(doc)
  return m ? m[1] : undefined
}

/** `multiplier_map` */
function multiplierMap(s: string): number {
  switch (s.toLowerCase()) {
    case 'millions':
      return 1000000
    case 'hundreds of thousands':
      return 100000
    case 'tens of thousands':
      return 10000
    case 'thousands':
      return 1000
    case 'hundreds':
      return 100
    case 'tens':
      return 10
    default:
      return 1
  }
}

export class LazyDict<T = unknown> {
  constructor(
    private readonly labelsOf: Record<string, any>,
    private readonly loader: (key: string) => T,
  ) {}
  private readonly cache = new Map<string, T>()
  keys(): string[] {
    return Object.keys(this.labelsOf)
  }
  labels(): Record<string, any> {
    return { ...this.labelsOf }
  }
  has(key: string): boolean {
    return key in this.labelsOf
  }
  get(key: string): T | undefined {
    if (!this.has(key)) return undefined
    if (!this.cache.has(key)) this.cache.set(key, this.loader(key))
    return this.cache.get(key)
  }
  get size(): number {
    return this.keys().length
  }
}

export class Filing {
  _url = ''
  _indexHeadersUrl = ''
  _fullSubmissionUrl = ''
  _indexHeadersDownload = ''
  _documentUrls: FilingDocument[] = []
  _filingDate = ''
  _periodEnding = ''
  _documentType = ''
  _name = ''
  _cik = ''
  _sic = ''
  _sicOrganizationName: string | null = ''
  _description: string | null = null
  _coverPageUrl: string | null = null
  _fiscalYearEnd = ''
  _fiscalPeriod: unknown = ''
  _coverPage: CoverPage = {}
  _tradingSymbols: string[] = []
  _useCache = true
  _items: Record<string, Row> = {}
  _sharesOutstanding: Record<string, number> = {}
  _fiscalYear: unknown = ''
  private _archive = new Map<string, Uint8Array | string>()
  private _archiveLoaded = false
  private _txtLoaded = false

  constructor(readonly ctx: NativeCtx) {}

  /** `Filing(url, use_cache)`: validates the URL, then downloads the index headers and the cover page. */
  static async create<T extends Filing>(this: new (ctx: NativeCtx) => T, ctx: NativeCtx, url: string, useCache = true): Promise<T> {
    const filing = new this(ctx)
    await filing.init(url, useCache)
    await filing.afterInit()
    return filing
  }

  /** Subclasses continue the construction here (`FinancialStatements.__init__` after `super().__init__`). */
  protected async afterInit(): Promise<void> {}

  protected async init(urlIn: string, useCache: boolean): Promise<void> {
    if (!urlIn || typeof urlIn !== 'string' || !urlIn.trim()) throw new Error('Please enter a URL.')
    let parsed: URL
    try {
      parsed = new URL(pyStrip(urlIn))
    } catch {
      throw new Error('Invalid SEC URL supplied, must use http or https scheme.')
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Invalid SEC URL supplied, must use http or https scheme.')
    const host = parsed.hostname.toLowerCase()
    if (host !== 'sec.gov' && !host.endsWith('.sec.gov')) throw new Error('Invalid SEC URL supplied, host must be sec.gov (e.g. https://www.sec.gov/...).')
    const path = parsed.pathname
    if (!path.includes('/data/')) throw new Error('Invalid SEC URL supplied, must be a filing URL.')
    const segments = path.split('/data/').slice(1).join('/data/').split('/')
    if (segments.length < 2) throw new Error('Invalid SEC URL supplied, must be a filing URL.')
    const checkVal = segments[1]!
    if (checkVal.length !== 18 || !/^\d+$/.test(checkVal)) throw new Error('Invalid SEC URL supplied, must be a filing URL.')

    const full = `${parsed.protocol}//${parsed.host}${path}`
    const cut = full.indexOf(checkVal)
    let newUrl = `${full.slice(0, cut)}${checkVal}/`
    const cikCheck = newUrl.split('/').at(-3)!
    newUrl = newUrl.replaceAll(`/${cikCheck}/`, `/${cikCheck.replace(/^0+/, '')}/`)
    this._url = newUrl
    this._useCache = useCache
    const dashed = `${checkVal.slice(0, -8)}-${checkVal.slice(-8, -6)}-${checkVal.slice(-6)}`
    this._indexHeadersUrl = `${this._url}${dashed}-index-headers.htm`
    this._fullSubmissionUrl = `${this._url}${dashed}.txt`
    await this.downloadIndexHeaders()

    for (const doc of this._documentUrls) {
      if (doc.url.endsWith('R1.htm')) {
        this._coverPageUrl = doc.url
        break
      }
    }
    if (this.hasCoverPage && Object.keys(this._coverPage).length === 0) await this.downloadCoverPage()

    if (this._tradingSymbols.length === 0) {
      const symbol = await cikMap(this.ctx, this._cik, useCache)
      if (symbol) this._tradingSymbols = [symbol]
    }
  }

  get baseUrl(): string {
    return this._url
  }
  get hasCoverPage(): boolean {
    return Boolean(this._coverPageUrl)
  }
  get documentType(): string {
    return this._documentType
  }

  /** `Filing._adownload_file`: a SEC file as `sec_callback` reads it (HTML as latin-1). */
  async downloadFile(url: string, useCache = this._useCache): Promise<unknown> {
    // sec_callback: JSON as JSON, HTML as latin-1, anything else as strict UTF-8 text (a binary file is an error, as in aiohttp).
    const load = async (): Promise<unknown> => {
      const res = await secResponse(this.ctx, url, { headers: SEC_HEADERS })
      if (res.status >= 400) throw new NativeHttpError(res.status, url, '')
      const contentType = res.headers.get('content-type') ?? ''
      const bytes = new Uint8Array(await res.arrayBuffer())
      if (contentType.includes('application/json')) return JSON.parse(Buffer.from(bytes).toString('utf8'))
      if (contentType.includes('text/html')) return decodeLatin1(bytes)
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      } catch {
        const bad = bytes.findIndex((b, i) => b >= 0x80 && !(b >= 0xc2 && b <= 0xf4 && i + 1 < bytes.length && (bytes[i + 1]! & 0xc0) === 0x80))
        throw new Error(`'utf-8' codec can't decode byte 0x${(bytes[Math.max(bad, 0)] ?? 0).toString(16).padStart(2, '0')} in position ${Math.max(bad, 0)}: invalid start byte`)
      }
    }
    try {
      return useCache ? await this.ctx.cache(`secf:${url}`, DEFAULT_EXPIRE_S * 1000, load) : await load()
    } catch (e) {
      throw new Error(`Failed to download file: ${e instanceof Error ? e.message : String(e)}`, { cause: e })
    }
  }

  /** `Filing.download_file(url, True)`: an HTML file's tables (R pages). */
  async downloadTables(url: string, useCache = this._useCache): Promise<Frame[]> {
    const text = await this.downloadFile(url, useCache)
    if (!url.endsWith('.htm') && !url.endsWith('.html')) throw new Error(`File is not a HTML file: ${url}`)
    return tryHtmlTable(String(text))
  }

  private async downloadIndexHeaders(): Promise<void> {
    try {
      if (!this._indexHeadersDownload) {
        let response: unknown
        try {
          response = await this.downloadFile(this._indexHeadersUrl)
        } catch {
          response = await this.downloadFile(this._fullSubmissionUrl)
        }
        this._indexHeadersDownload = typeof response === 'string' ? response : JSON.stringify(response)
      }
      const response = this._indexHeadersDownload
      // The <pre> element's text, entities decoded; without one the response itself.
      let text = response
      if (/<pre[\s>]/i.test(response)) {
        const pre = parse(response, { comment: false, blockTextElements: { script: true, noscript: true, style: true } }).querySelector('pre')
        if (pre) text = elementText(pre, false)
      }
      const documents = text.match(/<DOCUMENT>[\s\S]*?<\/DOCUMENT>/g) ?? []
      const dicts: FilingDocument[] = documents.map((doc) => {
        const out: FilingDocument = { type: pyStrip(lineField(doc, 'TYPE') ?? ''), sequence: pyStrip(lineField(doc, 'SEQUENCE') ?? ''), filename: pyStrip(lineField(doc, 'FILENAME') ?? ''), url: '' }
        const description = lineField(doc, 'DESCRIPTION')
        if (description !== undefined) out.description = pyStrip(description)
        const body = /<TEXT>([\s\S]*?)<\/TEXT>/.exec(doc) ?? /<TEXT>([\s\S]*)/.exec(doc)
        if (body) out.content = pyStrip(body[1]!.replace(/\s*<\/(?:TEXT|DOCUMENT)>\s*$/i, ''))
        out.url = out.filename ? this.baseUrl + out.filename : ''
        return out
      })
      if (dicts.length > 0) this._documentUrls = dicts

      let nItems = 0
      for (const line of text.split('\n')) {
        if (!line.includes(':')) continue
        const value = pyStrip(line.split(':')[1]!)
        if (nItems === 9) break
        if (line.includes('CONFORMED PERIOD OF REPORT')) {
          this._periodEnding = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}`
        } else if (line.includes('FILED AS OF DATE')) {
          this._filingDate = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}`
          nItems += 1
        } else if (line.includes('COMPANY CONFORMED NAME')) {
          this._name = value
          nItems += 1
        } else if (line.includes('CONFORMED SUBMISSION TYPE')) {
          this._documentType = value
          nItems += 1
        } else if (line.includes('CENTRAL INDEX KEY')) {
          this._cik = value
          nItems += 1
        } else if (line.includes('STANDARD INDUSTRIAL CLASSIFICATION')) {
          this._sic = value
          nItems += 1
        } else if (line.includes('ORGANIZATION NAME')) {
          this._sicOrganizationName = value
          nItems += 1
        } else if (line.includes('FISCAL YEAR END')) {
          this._fiscalYearEnd = `${value.slice(0, 2)}-${value.slice(2)}`
          nItems += 1
        } else if (line.includes('ITEM INFORMATION')) {
          // There might be two lines of ITEM INFORMATION
          this._description = this._description ? `${this._description}; ${value}` : value
          nItems += 1
        }
      }
    } catch (e) {
      throw new Error(`Failed to download and read the index headers table: ${e instanceof Error ? e.message : String(e)}`, { cause: e })
    }
  }

  /** `_download_cover_page`: R1.htm's table as the cover page, the trading symbols and the fiscal period. */
  private async downloadCoverPage(): Promise<void> {
    const symbolsList: Record<string, string>[] = []
    try {
      const response = await this.downloadTables(this._coverPageUrl!)
      if (response.length === 0) throw new Error('Failed to download cover page table')
      let df = response[0]!
      if (df.multi) df = { columns: df.columns.map((c) => (Array.isArray(c) ? c.at(-1)! : c)), multi: false, data: df.data }
      if (isEmpty(df)) throw new Error('Failed to read cover page table')
      const labels = (i: number) => df.data[i]!.values
      const ncols = df.data.length
      const col = (i: number): (typeof df.data)[number] => {
        if (i >= ncols) throw new PyIndexError('single positional indexer is out-of-bounds')
        return df.data[i]!
      }
      const rowsWhere = (c: number, test: (v: unknown) => boolean): number[] => {
        const out: number[] = []
        labels(c).forEach((v, i) => {
          if (test(v)) out.push(i)
        })
        return out
      }
      const truthy = (v: unknown): boolean => v === null || (typeof v === 'string' ? v !== '' : typeof v === 'boolean' ? v : v !== 0)
      const first = (rows: number[], c: number): unknown => {
        const cc = col(c)
        if (rows.length === 0) throw new PyIndexError('index 0 is out of bounds for axis 0 with size 0')
        return cc.values[rows[0]!]
      }

      col(0)
      const fyRows = rowsWhere(0, (v) => v === 'Document Fiscal Year Focus')
      const fiscalYear = fyRows.length > 0 ? first(fyRows, 1) : null
      if (fyRows.length > 0 && truthy(fiscalYear)) this._fiscalYear = fiscalYear
      const fpRows = rowsWhere(0, (v) => v === 'Document Fiscal Period Focus')
      const fiscalPeriod = fpRows.length > 0 ? first(fpRows, 1) : null
      if (fpRows.length > 0 && truthy(fiscalPeriod)) this._fiscalPeriod = fiscalPeriod

      const title = df.columns[0] as string
      if (title && title.includes('- shares')) {
        const sharesMultiplier = title.split(' shares in ').at(-1)!
        const multiplier = multiplierMap(sharesMultiplier)
        const first0 = df.data[0]!.values.map((v) => (v === null ? null : pyStrCell(v, df.data[0]!.dtype)))
        const soRows = first0.flatMap((s, i) => (s !== null && s.includes('Shares Outstanding') ? [i] : []))
        const so = first(soRows, 2)
        const asOf = df.columns[2]
        if (asOf === undefined) throw new PyIndexError('index 2 is out of bounds for axis 0 with size 2')
        if (asOf && truthy(so)) {
          const key = fmtDate(parseDate(String(asOf)))
          let shares: number
          if (typeof so === 'string') {
            // str * int repeats the text: an int() of a very long digit string
            const rep = so.repeat(multiplier)
            if (rep.length > 4300) throw new Error('Exceeds the limit (4300 digits) for integer string conversion')
            if (!/^\s*[-+]?\d+\s*$/.test(rep)) throw new Error(`invalid literal for int() with base 10: '${rep}'`)
            shares = Number(rep)
          } else if (typeof so === 'number') {
            if (!Number.isFinite(so)) throw new Error('cannot convert float NaN to integer')
            shares = Math.trunc(so * multiplier)
          } else {
            throw new Error('cannot convert shares outstanding to an integer')
          }
          this._sharesOutstanding = { [key]: shares }
        }
      }

      if (!isEmpty(df)) {
        const firstCol = df.data[0]!
        const firstStr = firstCol.values.map((v) => (v === null ? null : pyStrCell(v, firstCol.dtype)))
        const secondCol = col(1)
        const secondStr = secondCol.values.map((v) => (v === null ? '' : pyStrCell(v, secondCol.dtype)))
        const tradingRows = firstStr.flatMap((s, i) => (s !== null && ['trading symbol', 'no trading symbol flag'].includes(s.toLowerCase()) ? [i] : []))
        const tradingSymbols = tradingRows.map((i) => pyStrip(secondStr[i]!).replaceAll('true', 'No Trading Symbol'))
        const symbolNames = firstStr.flatMap((s, i) => (s !== null && pyStrip(s) === 'Title of 12(b) Security' ? [secondStr[i]!] : []))
        const exchangeNames = firstStr.flatMap((s, i) => (s !== null && pyStrip(s) === 'Security Exchange Name' ? [secondStr[i]!] : []))
        if (tradingSymbols.length > 0) {
          this._tradingSymbols = tradingSymbols.filter((d) => d && d !== 'No Trading Symbol').sort()
          const symbolsDict = new Map<string, string>()
          const exchangesDict = new Map<string, string>()
          const n = Math.min(symbolNames.length, tradingSymbols.length)
          for (let i = 0; i < n; i++) symbolsDict.set(symbolNames[i]!, tradingSymbols[i]!)
          for (let i = 0; i < Math.min(symbolNames.length, exchangeNames.length); i++) exchangesDict.set(symbolNames[i]!, exchangeNames[i]!)
          for (const [k, v] of symbolsDict) symbolsList.push({ Title: k, Symbol: v, Exchange: exchangesDict.get(k) ?? 'No Exchange' })
        }

        // df.iloc[:, :2].dropna(how='any'), then key -> value
        const output: CoverPage = {}
        for (let i = 0; i < nrows(df); i++) {
          const k = df.data[0]!.values[i]
          const v = df.data[1]!.values[i]
          if (k === null || k === undefined || v === null || v === undefined) continue
          output[String(k)] = v
        }
        if (!output.SIC && this._sic) {
          output.SIC = this._sic
          output['SIC Organization Name'] = this._sicOrganizationName
        }
        for (const k of ['Title of 12(b) Security', 'Trading Symbol', 'Security Exchange Name', 'No Trading Symbol Flag']) delete output[k]
        if (symbolsList.length > 0) output['12(b) Securities'] = symbolsList
        this._coverPage = output
      }
    } catch (e) {
      if (e instanceof PyIndexError) return
      throw new Error(`Failed to download and read the cover page table: ${e instanceof Error ? e.message : String(e)}`, { cause: e })
    }
  }

  /** `get_main_document_url` */
  getMainDocumentUrl(): string | null {
    if (this._documentUrls.length === 0) return null
    for (const doc of this._documentUrls) {
      const docType = (doc.type || '').toUpperCase()
      const url = doc.url || ''
      if (PRIMARY_DOC_TYPES.includes(docType) && (url.endsWith('.htm') || url.endsWith('.html'))) return url
    }
    for (const doc of this._documentUrls) {
      const url = doc.url || ''
      if ((url.endsWith('.htm') || url.endsWith('.html')) && !url.endsWith('R1.htm')) return url
    }
    return null
  }

  /** `get_main_document_content` */
  async getMainDocumentContent(): Promise<string | null> {
    const url = this.getMainDocumentUrl()
    if (url) return this.documentText(url)
    const inline = this._documentUrls.filter((d) => d.content)
    if (inline.length === 0) return null
    const primary = inline.find((d) => PRIMARY_DOC_TYPES.includes((d.type || '').toUpperCase())) ?? inline[0]!
    return primary.content!
  }

  /** `get_embedded_document`: the content of the document of a type. */
  async getEmbeddedDocument(identifier: string): Promise<string | null> {
    if (this._documentUrls.length === 0) return null
    const ident = identifier.toUpperCase()
    for (const doc of this._documentUrls) {
      if ((doc.type || '').toUpperCase() === ident) {
        if (!doc.url) continue
        return this.documentText(doc.url)
      }
    }
    return null
  }

  /** `_get_document(url)` as text (bytes decoded as utf-8; a JSON file is returned as its text). */
  async documentText(url: string): Promise<string> {
    const got = await this.getDocument(url)
    return typeof got === 'string' ? got : JSON.stringify(got)
  }

  /**
   * `_get_document`: a filing sub-document from the XBRL zip (or the complete submission), else downloaded. JSON files
   * come back parsed, everything else as text (HTML as latin-1, other files as utf-8).
   */
  async getDocument(url: string, useCache = this._useCache): Promise<unknown> {
    if (!this._archiveLoaded) await this.loadArchive()
    const filename = url.replace(/\/+$/, '').split('/').at(-1)!
    let raw = this._archive.get(filename)
    if (raw === undefined && !this._txtLoaded && this._archive.size === 0) {
      await this.loadTxtMembers()
      raw = this._archive.get(filename)
    }
    if (raw !== undefined) return materialize(filename, raw)
    const result = await this.downloadFile(url, useCache)
    if (typeof result === 'string' && filename.toLowerCase().endsWith('.json')) {
      try {
        return JSON.parse(result)
      } catch {
        return result
      }
    }
    return result
  }

  /** `_get_document(url, read_html_table=True)` */
  async getDocumentTables(url: string): Promise<Frame[]> {
    if (!this._archiveLoaded) await this.loadArchive()
    const filename = url.replace(/\/+$/, '').split('/').at(-1)!
    let raw = this._archive.get(filename)
    if (raw === undefined && !this._txtLoaded && this._archive.size === 0) {
      await this.loadTxtMembers()
      raw = this._archive.get(filename)
    }
    if (raw !== undefined) {
      const text = typeof raw === 'string' ? raw : decodeLatin1(raw)
      return tryHtmlTable(text)
    }
    return this.downloadTables(url)
  }

  private accessionDash(): string | null {
    const accession = this._url.replace(/\/+$/, '').split('/').at(-1)!
    if (accession.length !== 18 || !/^\d+$/.test(accession)) return null
    return `${accession.slice(0, 10)}-${accession.slice(10, 12)}-${accession.slice(12)}`
  }

  private async loadArchive(): Promise<void> {
    this._archiveLoaded = true
    const dash = this.accessionDash()
    if (!dash) return
    for (const [name, bytes] of await this.membersFromZip(`${this._url}${dash}-xbrl.zip`)) this._archive.set(name, bytes)
  }

  private async loadTxtMembers(): Promise<void> {
    this._txtLoaded = true
    const dash = this.accessionDash()
    if (!dash) return
    for (const [name, text] of await this.membersFromTxt(`${this._url}${dash}.txt`)) this._archive.set(name, text)
  }

  /** `_members_from_zip`: filename → bytes, empty on any failure. */
  private async membersFromZip(url: string): Promise<Map<string, Uint8Array>> {
    const out = new Map<string, Uint8Array>()
    try {
      const raw = await cachedRequest(this.ctx, url, { kind: 'bytes', headers: SEC_HEADERS, useCache: this._useCache })
      if (raw.length === 0) return out
      const files = unzipSync(raw)
      for (const [name, bytes] of Object.entries(files)) {
        if (name.endsWith('/')) continue
        out.set(name.split('/').at(-1)!, bytes)
      }
    } catch {
      return out
    }
    return out
  }

  /** `_members_from_txt`: filename → document text of a complete submission, empty on any failure. */
  private async membersFromTxt(url: string): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    try {
      const text = await cachedRequest(this.ctx, url, { kind: 'latin1', headers: SEC_HEADERS, useCache: this._useCache })
      if (!text) return out
      for (const m of text.matchAll(/<DOCUMENT>([\s\S]*?)<\/DOCUMENT>/g)) {
        const doc = m[1]!
        const name = lineField(doc, 'FILENAME')
        if (name === undefined) continue
        const body = /<TEXT>([\s\S]*?)<\/TEXT>/.exec(doc)
        out.set(pyStrip(name), body ? body[1]! : doc)
      }
    } catch {
      return out
    }
    return out
  }

  /** `exhibits`: documents of type EX-* keyed by type, the first of each kind. */
  exhibits(): LazyDict<FilingDocument> {
    const mapping: Record<string, FilingDocument> = {}
    for (const doc of this._documentUrls) {
      const dtype = (doc.type || '').toUpperCase()
      if (dtype.startsWith('EX') && !(dtype in mapping)) mapping[dtype] = doc
    }
    const labels = Object.fromEntries(Object.entries(mapping).map(([k, v]) => [k, v.description || k]))
    return new LazyDict(labels, (key) => mapping[key]!)
  }

  /** `model_dump(exclude_none=True)` of the base filing: what `sec/filing_headers` returns. */
  toRow(): Row {
    const row: Row = {
      base_url: this.baseUrl,
      name: this._name,
      cik: this._cik,
      trading_symbols: this._tradingSymbols,
      sic: this._sic,
      sic_organization_name: this._sicOrganizationName,
      filing_date: this._filingDate,
    }
    if (this._periodEnding) row.period_ending = this._periodEnding
    row.fiscal_year_end = this._fiscalYearEnd
    row.document_type = this._documentType
    row.has_cover_page = this.hasCoverPage
    row.cover_page = this._coverPage
    if (this._description !== null) row.description = this._description
    row.document_urls = this._documentUrls
    return row
  }
}

/** `Filing.try_html_table`: `pandas.read_html`, with its errors wrapped. */
export function tryHtmlTable(text: string): Frame[] {
  try {
    return readHtml(text)
  } catch (e) {
    throw new Error(`Failed to parse table: ${e instanceof Error ? e.message : String(e)}`, { cause: e })
  }
}

/** `_materialize`: an archive member as the type `download_file` would return. */
function materialize(filename: string, raw: Uint8Array | string): unknown {
  const name = filename.toLowerCase()
  if (name.endsWith('.json')) return JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8'))
  if (typeof raw === 'string') return raw
  return name.endsWith('.htm') || name.endsWith('.html') ? decodeLatin1(raw) : Buffer.from(raw).toString('utf8')
}
