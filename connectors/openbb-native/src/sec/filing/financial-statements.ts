// FinancialStatements, provider sec: one filing's XBRL (MetaLinks, schema, linkbases, instance), item sections,
// exhibits and the lookups behind the filing routes. Ported from openbb_sec/models/sec_financials.py (OpenBB
// Platform 5.0.0, Apache-2.0); modified: an async `create` instead of the constructor, `lru_cache` is ctx.cache,
// plain objects instead of pydantic models and pandas frames (the as-filed statements are in ./statement.ts), and
// bs4 is ../markdown/soup.ts.
import { fetchCompanyFilings } from '../company-filings.js'
import { ASC_SECTIONS, ASC_SUBTOPICS, ASC_TOPICS, DEI_FIELDS } from '../definitions.js'
import { parse as parseSoup } from '../markdown/soup.js'
import { TaxonomyStyle, XBRLParser, getLabelUrlForImport, type XBRLNode } from '../taxonomy/xbrl-parser.js'
import { tostring } from '../taxonomy/xml-element.js'
import type { NativeCtx, NativeParams, Row } from '../../types.js'
import { Filing, LazyDict, type FilingDocument } from './filing.js'
import { fmtDate, parseDate } from './pydate.js'
import { cleanHtmlToText } from './markdown.js'
import { initializeNonXbrl } from './non-xbrl.js'
import { pyStrip } from './pandas-lite.js'
import { extractItemSections, extractSectionHtml, extractViaCrossReference, reflowPlainText, splitBoldSections, type ItemSection } from './sections.js'

type Dict = Record<string, any>

const EXHIBIT_TITLES: Record<string, string> = {
  '1': 'Underwriting Agreement',
  '2': 'Plan of Acquisition, Reorganization, Arrangement, Liquidation or Succession',
  '3': 'Articles of Incorporation and Bylaws',
  '4': 'Instruments Defining the Rights of Security Holders',
  '5': 'Opinion re Legality',
  '8': 'Opinion re Tax Matters',
  '9': 'Voting Trust Agreement',
  '10': 'Material Contracts',
  '11': 'Statement re Computation of Per Share Earnings',
  '12': 'Statement re Computation of Ratios',
  '13': 'Annual Report to Security Holders',
  '14': 'Code of Ethics',
  '15': 'Letter re Unaudited Interim Financial Information',
  '16': 'Letter re Change in Certifying Accountant',
  '18': 'Letter re Change in Accounting Principles',
  '21': 'Subsidiaries of the Registrant',
  '22': 'Published Report re Matters Submitted to a Vote',
  '23': 'Consents of Experts and Counsel',
  '24': 'Power of Attorney',
  '25': 'Statement of Eligibility of Trustee',
  '27': 'Financial Data Schedule',
  '31': 'Rule 13a-14(a)/15d-14(a) Certifications',
  '32': 'Section 1350 Certifications',
  '95': 'Mine Safety Disclosures',
  '99': 'Additional Exhibits',
  '101': 'Interactive Data Files (XBRL)',
  '104': 'Cover Page Interactive Data File',
}

/** Return the standard Regulation S-K title for an exhibit type (e.g. EX-21). */
function exhibitTitle(exhibitType: string): string {
  const m = /EX-?(\d+)/.exec(exhibitType.toUpperCase())
  return m ? (EXHIBIT_TITLES[m[1]!] ?? '') : ''
}

/** Tidy exhibit descriptions that filers split into per-character spans ("202 6", "16 ,"). */
function cleanExhibitText(textIn: string): string {
  let text = pyStrip(textIn.replace(/\s+/g, ' '))
  text = text.replace(/\s+([,.;:)])/g, '$1')
  return text.replace(/(?<=\d) (?=\d)/g, '')
}

/** `dict.get(key, default)`: the default only when the key is missing (a stored None stays None). */
const pyGet = (d: Dict, key: string, fallback: unknown): unknown => (key in d ? d[key] : fallback)

const PY_EMPTY = (v: unknown): boolean => v === undefined || v === null || v === '' || v === 0 || v === false || (Array.isArray(v) && v.length === 0) || (typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 0)

export type ExhibitChoice = { value: string; label: string }

export class FinancialStatements extends Filing {
  _tags: Dict = {}
  _resources: Dict = {}
  _xsd: Dict = {}
  _calcs: Dict = {}
  _labels: Dict = {}
  _presentation: XBRLNode[] = []
  _metalinks: Dict = {}
  _stdRef: Dict = {}
  _instance: Dict = {}
  _xbrlUnits: Dict = {}
  _textBlocks: Dict = {}
  _disclosuresStore: Dict = {}
  _periodContext: Dict = {}
  _periodEnd1 = ''
  _periodEnd2 = ''
  _toc: Dict = {}
  _nonXbrlStatements: Dict = {}
  _nonXbrlTextBlocks: Dict = {}
  _nonXbrlInitialized = false
  _itemsReflowed = false
  private _xbrlLoaded = false
  private _xbrlPromise: Promise<void> | undefined
  private _itemSectionsPromise: Promise<Dict> | undefined

  protected async initializeNonXbrl(): Promise<void> {
    await initializeNonXbrl(this)
  }

  protected override async afterInit(): Promise<void> {
    await this.downloadMetalinks()
    if (!(this._resourceCount() > 1)) await this.initializeNonXbrl()
  }

  private _resourceCount(): number {
    return Object.keys(this._resources).length
  }

  /** `is_xbrl`: whether this filing contains XBRL data. */
  get isXbrl(): boolean {
    const hasMetalinks = !PY_EMPTY(this._metalinks)
    const hasResources = this._resourceCount() > 1
    const hasTags = !PY_EMPTY(this._tags)
    const hasInstance = !PY_EMPTY(this._instance)
    return hasMetalinks || hasResources || hasTags || hasInstance
  }

  /** `get_main_document_url` as `FinancialStatements` overrides it. */
  override getMainDocumentUrl(): string | null {
    if (this._documentUrls.length === 0) return null
    for (const doc of this._documentUrls) {
      const docType = (doc.type || '').toUpperCase()
      if (['10-K', '10-Q', '10-K/A', '10-Q/A'].includes(docType)) return doc.url
    }
    for (const doc of this._documentUrls) {
      const url = doc.url || ''
      if (url.endsWith('.htm') || url.endsWith('.html')) return url
    }
    return null
  }

  /** `_clean_html_to_text` */
  cleanHtmlToText(html: string | Uint8Array, keepTables = false): string {
    return cleanHtmlToText(html, this._url, keepTables)
  }

  // -----------------------------------------------------------------------------------------------------------
  // statements and disclosures
  // -----------------------------------------------------------------------------------------------------------

  /** `_get_statements_info`: statement key → { name, url } (XBRL) or { name, data, meta } (parsed from HTML). */
  getStatementsInfo(): Dict {
    if (!PY_EMPTY(this._resources)) {
      const statements: Dict = {}
      for (const v of Object.values<Dict>(this._resources)) {
        if (v.group === 'statement') statements[v.short_name] = { name: pyGet(v, 'long_name', v.short_name), url: v.url }
      }
      if (Object.keys(statements).length > 0) return statements
    }
    if (!PY_EMPTY(this._nonXbrlStatements)) {
      return Object.fromEntries(Object.entries<Dict>(this._nonXbrlStatements).map(([k, v]) => [k, { name: pyGet(v, 'name', k), data: v.data, meta: v.meta }]))
    }
    return {}
  }

  /** `_get_disclosures_info`: disclosure key → data, the XBRL resources joined with their text blocks. */
  async getDisclosuresInfo(): Promise<Dict> {
    await this.ensureXbrl()
    if (!PY_EMPTY(this._resources)) {
      const disclosures: Dict = {}
      for (const rval of Object.values<Dict>(this._resources)) {
        if (!rval || typeof rval !== 'object' || rval.group !== 'disclosure') continue
        const tag = rval.anchor_tag || rval.name
        if (!tag) continue
        disclosures[tag] = { name: pyGet(rval, 'long_name', pyGet(rval, 'short_name', tag)), short_name: rval.short_name, url: rval.url, text: '' }
      }

      if (Object.keys(disclosures).length > 0 && !PY_EMPTY(this._textBlocks)) {
        const dkByLocal: Record<string, string> = {}
        for (const dk of Object.keys(disclosures)) {
          const local = dk.includes('_') ? dk.split('_').slice(1).join('_') : dk
          dkByLocal[local.toLowerCase()] = dk
        }
        const append = (dk: string, text: string): void => {
          const existing = disclosures[dk].text ?? ''
          disclosures[dk].text = existing ? `${existing}\n\n${text}` : text
        }

        for (const [tbKey, tbVal] of Object.entries<Dict>(this._textBlocks)) {
          const text = tbVal.value ?? ''
          if (!text || text === '\nNone.') continue

          // 1) Direct key match
          if (tbKey in disclosures) {
            disclosures[tbKey].text = text
            continue
          }

          // 2) Match via presentation roles → disclosure local names
          let matched = false
          for (const role of tbVal.presentation ?? []) {
            const roleLower = String(role).toLowerCase()
            if (roleLower in dkByLocal) {
              append(dkByLocal[roleLower]!, text)
              matched = true
              break
            }
            // Partial match: role is substring of key or vice-versa
            for (const [dl, dk] of Object.entries(dkByLocal)) {
              if (dl.includes(roleLower) || roleLower.includes(dl)) {
                append(dk, text)
                matched = true
                break
              }
            }
            if (matched) break
          }

          // 3) If still unmatched, try local name match against disclosure keys
          if (!matched) {
            const tbLocal = tbKey.includes('_') ? tbKey.split('_').slice(1).join('_').toLowerCase() : tbKey.toLowerCase()
            for (const [dl, dk] of Object.entries(dkByLocal)) {
              if (dl.includes(tbLocal) || tbLocal.includes(dl)) {
                append(dk, text)
                break
              }
            }
          }
        }
      }
      if (Object.keys(disclosures).length > 0) return disclosures
    }

    // Non-XBRL fallbacks
    if (!PY_EMPTY(this._disclosuresStore)) return this._disclosuresStore
    if (!PY_EMPTY(this._items)) return this._items as Dict
    return {}
  }

  /** `disclosures`: a lazy dictionary of the notes to the financial statements. */
  async disclosures(): Promise<LazyDict<Dict>> {
    const info = await this.getDisclosuresInfo()
    const labels = Object.fromEntries(Object.entries<any>(info).map(([k, v]) => [k, v && typeof v === 'object' && !Array.isArray(v) ? pyGet(v, 'name', pyGet(v, 'long_name', k)) : k]))
    return new LazyDict<Dict>(labels, (key) => info[key])
  }

  /** `tags` */
  async tags(): Promise<Dict> {
    await this.ensureXbrl()
    return this._tags
  }

  /** `_ensure_xbrl`: parse the XBRL taxonomy and instance on first access (expensive). */
  ensureXbrl(): Promise<void> {
    if (this._xbrlPromise) return this._xbrlPromise
    this._xbrlLoaded = true
    this._xbrlPromise = (async () => {
      if (this._resourceCount() > 1) {
        await this.buildSchemaFromXml()
        await this.downloadXbrlInstance()
        this.enrichCoverPageFromInstance()
      }
    })()
    return this._xbrlPromise
  }

  get xbrlLoaded(): boolean {
    return this._xbrlLoaded
  }

  // -----------------------------------------------------------------------------------------------------------
  // item sections
  // -----------------------------------------------------------------------------------------------------------

  /** `get_item_sections`: filing item sections (Item 1, 1A, 3, ...) keyed by item id, with text. */
  getItemSections(): Promise<Dict> {
    this._itemSectionsPromise ??= (async () => {
      if (PY_EMPTY(this._items)) {
        const content = await this.getMainDocumentContent()
        if (!content) return {}
        const markdown = this.cleanHtmlToText(content, true)
        this._items = extractItemSections(markdown)
        if (PY_EMPTY(this._items)) this._items = extractViaCrossReference(markdown)
        if (PY_EMPTY(this._items)) this._items = extractItemSections(content)
      }
      if (!PY_EMPTY(this._items) && !this._itemsReflowed) {
        const force = !this.isXbrl
        for (const item of Object.values<any>(this._items)) {
          if (item && typeof item === 'object' && item.text) item.text = reflowPlainText(item.text, force)
        }
        this._itemsReflowed = true
      }
      return this._items as Dict
    })()
    return this._itemSectionsPromise
  }

  /** `get_item`: the first item section matching any of the given item numbers. */
  async getItem(...itemNums: string[]): Promise<ItemSection | null> {
    const targets = new Set(itemNums.map((n) => n.toUpperCase()))
    const items = await this.getItemSections()
    for (const value of Object.values<any>(items)) {
      if (value && typeof value === 'object' && targets.has((value.item_num || '').toUpperCase())) return value
    }
    for (const [key, value] of Object.entries<any>(items)) {
      if (targets.has(key.split('_').at(-1)!.toUpperCase()) && value && typeof value === 'object') return value
    }
    return null
  }

  /** `_item_by_name`: the first item section whose name contains a keyword. */
  async itemByName(needle: string): Promise<ItemSection | null> {
    for (const value of Object.values<any>(await this.getItemSections())) {
      if (value && typeof value === 'object' && (value.name || '').toLowerCase().includes(needle)) return value
    }
    return null
  }

  /** `risk_factors`: Risk Factors (Item 1A) split into individual factors by bold sub-heading. */
  async riskFactors(): Promise<Row[]> {
    const docType = (this.documentType || '').toUpperCase()
    const item = docType.startsWith('20-F') || docType.startsWith('40-F') ? ((await this.itemByName('risk factor')) ?? (await this.getItem('3D', '3'))) : ((await this.itemByName('risk factor')) ?? (await this.getItem('1A')))
    if (item) {
      const content = await this.getMainDocumentContent()
      const sectionHtml = content ? extractSectionHtml(content, item.item_num || '1A') : ''
      let blocks = sectionHtml ? splitBoldSections(sectionHtml, 'risk_factor') : []
      blocks = blocks.filter((b) => b.risk_factor)
      if (blocks.length > 0) return blocks
      const text = pyStrip(item.text || '')
      if (text) return [{ risk_factor: item.name, text }]
    }
    return this.legacyRiskFactors()
  }

  /** `_legacy_risk_factors`: risk factors of pre-2005 filings, which predate Item 1A. */
  private async legacyRiskFactors(): Promise<Row[]> {
    const mda = (await this.getItem('7')) ?? (await this.itemByName('discussion and analysis'))
    const text = (mda ? mda.text : '') || ''
    const matches = [...text.matchAll(/^\**Factors\s+That\s+May\s+Affect\s+Future\s+Results[^\n]*$/gim)]
    if (matches.length === 0) return []
    const last = matches.at(-1)!
    const body = pyStrip(text.slice(last.index! + last[0].length))
    if (!body) return []
    return [{ risk_factor: 'Factors That May Affect Future Results and Financial Condition', text: body }]
  }

  /** `business`: the Business section (Item 1) as formatted markdown. */
  async business(): Promise<string | null> {
    const stripExecOfficers = (text: string): string => text.split(/^\s*#{1,6}\s*EXECUTIVE\s+OFFICERS\s+OF\s+THE\s+REGISTRANT\s*$/im)[0]!.replace(/\s+$/, '')
    const sliceForeignBusiness = (text: string): string => {
      const startMatch = /^\s*B\.\s*Business(?:\s+Overview)?\b/im.exec(text)
      if (!startMatch) return text
      const start = startMatch.index
      const endCandidates: number[] = []
      for (const pattern of [/^\s*C\.\s*Organizational\s+Structure\b/im, /^\s*D\.\s*Property\b/im, /^\s*ITEM\s*4A\b/im, /^\s*4A\.\b/im, /^\s*ITEM\s*5\b/im]) {
        const m = pattern.exec(text.slice(start))
        if (m) endCandidates.push(start + m.index)
      }
      const end = endCandidates.length > 0 ? Math.min(...endCandidates) : text.length
      return pyStrip(text.slice(start, end))
    }

    const docType = (this.documentType || '').toUpperCase()
    const foreign = docType.startsWith('20-F') || docType.startsWith('40-F')
    let item: ItemSection | null
    if (docType.startsWith('10-K')) item = await this.getItem('1')
    else if (foreign) {
      item = (await this.getItem('4', '4A', '4B')) ?? (await this.itemByName('information on the company'))
      if (!item) item = await this.itemByName('business')
    } else item = await this.itemByName('business')
    if (!item) return null
    const content = await this.getMainDocumentContent()
    const itemNum = item.item_num
    if (content && itemNum) {
      const sectionHtml = extractSectionHtml(content, String(itemNum))
      if (sectionHtml) {
        const sectionText = this.cleanHtmlToText(sectionHtml, false)
        if (sectionText) {
          let cleaned = stripExecOfficers(sectionText)
          if (foreign) cleaned = sliceForeignBusiness(cleaned)
          return cleaned || null
        }
      }
    }
    const text = pyStrip(item.text || '')
    let cleaned = stripExecOfficers(text)
    if (foreign) cleaned = sliceForeignBusiness(cleaned)
    return cleaned || null
  }

  // -----------------------------------------------------------------------------------------------------------
  // exhibits
  // -----------------------------------------------------------------------------------------------------------

  /** `_parse_exhibit_index`: the hyperlinked exhibit index of a filing's main document. */
  private async parseExhibitIndex(): Promise<ExhibitChoice[]> {
    const content = await this.getMainDocumentContent()
    if (!content || !content.includes('-sec-extract:exhibit')) return []
    const base = this.getMainDocumentUrl() || ''
    const soup = parseSoup(content, 'html.parser')
    const exhibits: ExhibitChoice[] = []
    const seen = new Set<string>()
    for (const anchor of soup.findAll('a')) {
      if (!(anchor.getStr('style', '') || '').includes('-sec-extract:exhibit')) continue
      const href = anchor.get('href')
      if (typeof href !== 'string' || !href) continue
      if (href.startsWith('#') || seen.has(href)) continue
      seen.add(href)
      let number = ''
      let description = anchor.getText(' ', true)
      const row = anchor.findParent('tr')
      if (row) {
        const cells = row.findAll(['td', 'th']).map((c) => c.getText(' ', true)).filter((c) => c)
        if (cells.length > 0) {
          number = cells[0]!.replace(/[*\s]+$/, '')
          const rowDesc = cleanExhibitText(cells.slice(1).join(' '))
          if (rowDesc.length > description.length) description = rowDesc
        }
      }
      if (description.length < 4) continue
      const label = number ? `${number} - ${description}` : description
      let value: string
      try {
        value = new URL(href, base).href
      } catch {
        value = href
      }
      exhibits.push({ value, label })
    }
    return exhibits
  }

  /** `exhibit_choices`: filing exhibits as `{value, label}` options. */
  async exhibitChoices(): Promise<ExhibitChoice[]> {
    const index = await this.parseExhibitIndex()
    if (index.length > 0) return index
    const options: ExhibitChoice[] = []
    const docs = [...this._documentUrls].sort((a, b) => Number(a.sequence || 0) - Number(b.sequence || 0))
    for (const doc of docs) {
      const dtype = (doc.type || '').toUpperCase()
      if (!dtype.startsWith('EX') || ['EX-100', 'EX-101', 'EX-104'].some((p) => dtype.startsWith(p))) continue
      let description = pyStrip(doc.description || '')
      if (!description || /^(?:exhibit|ex)[-\s.]*[\d.\-a-z]*$/i.test(description)) description = exhibitTitle(dtype)
      options.push({ value: dtype, label: description ? `${dtype} - ${description}` : dtype })
    }
    return options
  }

  /** `get_exhibit`: a filing exhibit's content rendered as markdown. */
  async getExhibit(identifier: string): Promise<string | null> {
    let url: string | undefined
    let inline: string | undefined
    if (identifier.startsWith('http')) url = identifier
    else {
      const doc = this._documentUrls.find((d) => (d.type || '').toUpperCase() === identifier.toUpperCase())
      if (!doc) return null
      url = doc.url
      inline = doc.content
    }
    let content: string | undefined
    if (url) content = await this.documentText(url)
    if (!content) content = inline
    if (!content) return null
    if (/<TEXT>/i.test(content.slice(0, 600))) {
      // `re.split(r"<TEXT>", content, maxsplit=1)[-1]`: everything after the first <TEXT>
      const m = /<TEXT>/i.exec(content)!
      content = content.slice(m.index + m[0].length)
    }
    if (/<html|<body/i.test(content.slice(0, 2000))) return this.cleanHtmlToText(content, true) || null
    return reflowPlainText(content, true) || content
  }

  /** `legal_proceedings`: Item 3 for a 10-K, Part II Item 1 for a 10-Q, with the referenced note appended when needed. */
  async legalProceedings(): Promise<Dict | null> {
    let item: Dict | null = (await this.itemByName('legal proceeding')) ?? (await this.getItem('3'))
    if (!item) return null
    const text = pyStrip(item.text || '')
    if (isLegalRedirect(text)) {
      const note = await this.legalContingenciesNote()
      if (note) item = { ...item, text: `${text}\n\n${note}` }
    }
    return item
  }

  /** `_legal_contingencies_note`: text of the legal/contingencies note from the disclosures, if present. */
  private async legalContingenciesNote(): Promise<string> {
    const wanted = ['contingenc', 'legal proceeding', 'legal matter', 'litigation']
    const skip = ['(details)', '(tables)', '(policies)', 'additional information']
    const disclosures = await this.disclosures()
    const labels = disclosures.labels()
    for (const key of disclosures.keys()) {
      const name = (labels[key] || key).toLowerCase()
      if (!wanted.some((w) => name.includes(w)) || skip.some((s) => name.includes(s))) continue
      const info = disclosures.get(key)
      const text = info && typeof info === 'object' ? pyStrip(info.text || '') : ''
      if (text) return text
    }
    return ''
  }

  /** `segment_revenue`: segment, geographic and revenue-disaggregation disclosures with their tables. */
  async segmentRevenue(): Promise<Row[]> {
    const wanted = ['segment', 'geographic', 'disaggregat', 'revenue']
    const skip = ['(details)', '(tables)', '(policies)', 'additional information']
    const disclosures = await this.disclosures()
    const labels = disclosures.labels()
    const results: Row[] = []
    for (const key of disclosures.keys()) {
      const name = labels[key] || key
      const lower = name.toLowerCase()
      if (!wanted.some((w) => lower.includes(w)) || skip.some((s) => lower.includes(s))) continue
      const info = disclosures.get(key)
      const text = info && typeof info === 'object' ? pyStrip(info.text || '') : ''
      if (text) results.push({ name: cleanDisclosureName(name), text })
    }
    return results
  }

  // -----------------------------------------------------------------------------------------------------------
  // XBRL
  // -----------------------------------------------------------------------------------------------------------

  /** `_enrich_cover_page_from_instance`: supplement the cover page with data from XBRL instance facts. */
  private enrichCoverPageFromInstance(): void {
    if (PY_EMPTY(this._instance)) return
    for (const [instKey, instData] of Object.entries<Dict>(this._instance)) {
      const local = instKey.includes('_') ? instKey.split('_').slice(1).join('_') : instKey
      if (!(local in DEI_FIELDS)) continue
      const coverKey = DEI_FIELDS[local]!
      if (this._coverPage[coverKey]) continue
      const contextList: Dict[] = instData.context ?? []
      if (contextList.length === 0) continue

      let val: string | null = null
      let valDate: string | null = null
      for (const ctx of contextList) {
        if (!PY_EMPTY(ctx.dimensions)) continue
        const v = ctx.value
        if (v && v !== '' && v !== '0' && v !== 'false') {
          const end = ctx.end ?? ''
          if (val === null || (end && (valDate === null || end > valDate))) {
            val = v
            valDate = end
          }
        }
      }
      if (!val) continue

      this._coverPage[coverKey] = val
      if (local === 'TradingSymbol' && !this._tradingSymbols.includes(val)) this._tradingSymbols.push(val)
      else if (local === 'EntityCommonStockSharesOutstanding') {
        const shares = Math.trunc(Number(val))
        if (Number.isFinite(shares)) {
          let dateKey = valDate || this._periodEnding || 'unknown'
          try {
            dateKey = fmtDate(parseDate(dateKey))
          } catch {
            // keep the text
          }
          this._sharesOutstanding[dateKey] = shares
        }
      } else if (local === 'DocumentFiscalYearFocus') {
        if (!this._fiscalYear) this._fiscalYear = val
      } else if (local === 'DocumentFiscalPeriodFocus' && !this._fiscalPeriod) this._fiscalPeriod = val
    }
  }

  /** `_enrich_std_ref`: add human-readable names and a formatted reference to a std_ref entry. */
  private static enrichStdRef(entry: Dict): Dict {
    const topic = entry.Topic ?? ''
    const subtopic = entry.SubTopic ?? ''
    const section = entry.Section ?? ''
    const paragraph = entry.Paragraph ?? ''

    const topicName = ASC_TOPICS[topic] ?? ''
    const subtopicName = ASC_SUBTOPICS[subtopic] ?? subtopic
    const sectionName = ASC_SECTIONS[section] ?? section

    const refParts = [topic, subtopic, section, paragraph].filter((p) => p)
    const refCode = refParts.join('-')

    const enriched: Dict = { ...entry }
    if (topicName) enriched.topic_name = topicName
    if (subtopicName && subtopicName !== subtopic) enriched.subtopic_name = subtopicName
    if (sectionName && sectionName !== section) enriched.section_name = sectionName
    if (refCode) {
      let label = `ASC ${refCode}`
      if (topicName) label += ` (${topicName})`
      enriched.reference = label
    }
    return enriched
  }

  /** `_download_metalinks`: the filing's MetaLinks.json: its reports (R pages) and tags. */
  private async downloadMetalinks(): Promise<void> {
    const metalinksUrl = this._documentUrls.find((d) => (d.url || '').endsWith('MetaLinks.json'))?.url ?? ''
    if (!metalinksUrl) return

    if (PY_EMPTY(this._metalinks)) {
      const fullRes = (await this.getDocument(metalinksUrl)) as Dict
      this._metalinks = { ...(fullRes.instance ?? {}) }
      this._stdRef = fullRes.std_ref ?? {}
    }
    const res = { ...this._metalinks }

    const statementItems: Dict = this._resources
    const tags: Dict = this._tags
    try {
      for (const key of Object.keys(res)) {
        for (const item of Object.keys(res[key].report)) {
          if (!item) continue
          const rep: Dict | undefined = res[key].report[item]
          if (rep && Object.keys(rep).length > 0) {
            const anchor: Dict | undefined = rep.uniqueAnchor || rep.firstAnchor
            const subgroup = rep.subGroupType
            const menucat = rep.menuCat
            statementItems[item[0] === 'R' ? item.replaceAll('R', 'r') : item] = {
              short_name: rep.shortName ?? null,
              long_name: rep.longName ?? null,
              group: rep.groupType ?? null,
              sub_group: subgroup && subgroup !== "''" ? subgroup : null,
              menu_category: menucat && menucat !== "''" ? menucat : null,
              anchor_tag: anchor ? String(anchor.name ?? '').replaceAll(':', '_') : null,
              order: rep.order ?? null,
              unit_ref: anchor ? (anchor.unitRef ?? null) : null,
              xsi_nil: anchor && anchor.xsiNil ? anchor.xsiNil === 'true' : null,
              decimals: anchor ? (anchor.decimals ?? null) : null,
              ancestors: anchor ? (anchor.ancestors ?? []) : null,
              context_ref: anchor ? (anchor.contextRef ?? null) : null,
              id: anchor ? (anchor.id ?? null) : null,
              base_ref: anchor ? (anchor.baseRef ?? null) : null,
              url: item[0] === 'R' ? `${this._url}${item}.htm` : null,
            }
          }
        }

        for (const item of Object.keys(res[key].tag)) {
          const it: Dict | undefined = res[key].tag[item]
          if (it && Object.keys(it).length > 0) {
            const role: Dict = (it.lang?.['en-US']?.role && !PY_EMPTY(it.lang['en-US'].role) ? it.lang['en-US'].role : undefined) || it.lang?.['en-us']?.role || {}
            const calculation: Dict = it.calculation ?? {}
            const calcs: Dict = {}
            for (const k of Object.keys(calculation)) {
              calcs.calculation = k.split('role/').at(-1)
              Object.assign(calcs, calculation[k])
            }
            const presentation = (it.presentation ?? []).map((d: string) => d.split('role/').at(-1))
            const authRefs: string[] | undefined = it.auth_ref
            const enrichedRefs = (authRefs ?? []).filter((id) => id in this._stdRef).map((id) => FinancialStatements.enrichStdRef(this._stdRef[id]))
            tags[item] = {
              xbrl_type: it.xbrltype ?? null,
              name: it.localname ?? null,
              presentation,
              crdr: it.crdr ?? null,
              ...calcs,
              ...role,
              auth_ref: enrichedRefs.length > 0 ? enrichedRefs : (authRefs ?? null),
            }
          }
        }
      }

      for (const [k, v] of Object.entries<Dict>({ ...statementItems })) {
        if (PY_EMPTY(v)) continue
        if (v.short_name === 'Cover Page' || v.short_name === 'Document And Entity Information' || v.menu_category === 'Cover') this._coverPageUrl = v.url || this._coverPageUrl
        const tag = v.anchor_tag ?? ''
        if (tag && tag in tags) {
          const update: Dict = {}
          for (const [tk, tv] of Object.entries(tags[tag])) if (tk !== 'tag') update[tk] = tv
          Object.assign(statementItems[k], update)
        }
      }
      Object.assign(this._resources, statementItems)
      Object.assign(this._tags, tags)
    } catch (e) {
      throw new Error(`Failed to parse MetaLinks.json: ${e instanceof Error ? e.message : String(e)}`, { cause: e })
    }
  }

  /** `_fetch_external_taxonomy_labels`: labels from imported standard taxonomies (us-gaap, srt, dei, …). */
  private async fetchExternalTaxonomyLabels(imports: Dict[]): Promise<void> {
    for (const imp of imports) {
      const schemaLocation = imp.schemaLocation ?? ''
      const labelUrl = getLabelUrlForImport(schemaLocation)
      if (!labelUrl) continue

      const load = async (): Promise<Dict> => {
        const content = await this.documentText(labelUrl)
        const parser = new XBRLParser()
        const style = labelUrl.includes('fasb.org') ? TaxonomyStyle.FASB_STANDARD : TaxonomyStyle.SEC_EMBEDDED
        return parser.parseLabelLinkbase(Buffer.from(content, 'utf8'), style)
      }
      let externalLabels: Dict
      try {
        // a failed download or parse is not kept, as with the Python disk cache
        externalLabels = this._useCache ? await this.ctx.cache(`sec:xbrl-labels:${labelUrl}`, 7 * 24 * 3600 * 1000, load) : await load()
      } catch {
        continue
      }
      if (PY_EMPTY(externalLabels)) continue

      for (const [elementId, labelRoles] of Object.entries<Dict>(externalLabels)) {
        if (!(elementId in this._labels)) this._labels[elementId] = {}
        for (const [role, value] of Object.entries(labelRoles)) if (!(role in this._labels[elementId])) this._labels[elementId][role] = value
      }
    }
  }

  /** `_build_schema_from_xml`: the schema from the filing's xsd, label, presentation and calculation linkbases. */
  private async buildSchemaFromXml(): Promise<void> {
    const tags: Dict = this._tags
    let items: Dict[] = []

    const docs: FilingDocument[] = this._documentUrls
    const xsdUrl = docs.filter((d) => (d.url || '').endsWith('.xsd') || (d.type || '') === 'EX-101.SCH').map((d) => d.url)

    if (xsdUrl.length > 0) {
      if (PY_EMPTY(this._xsd)) {
        const xsdContent = await this.documentText(xsdUrl[0]!)
        const parser = new XBRLParser()
        const [elements, roles, embeddedLinkbase, imports] = parser.parseSchema(Buffer.from(xsdContent, 'utf8'))
        this._xsd = { elements, roles, imports }

        for (const [elemId, elemData] of Object.entries(elements)) {
          if (!(elemId in tags)) tags[elemId] = elemData
          else Object.assign(tags[elemId], elemData)
        }

        const docNums = new Set<string>()
        for (const role of roles) {
          const docNum = role.document_number ?? ''
          if (docNum && !docNums.has(docNum)) {
            docNums.add(docNum)
            items.push(role as Dict)
          }
        }

        if (embeddedLinkbase !== null) {
          try {
            const embeddedParser = new XBRLParser()
            const embeddedLabels = embeddedParser.parseLabelLinkbase(Buffer.from(tostring(embeddedLinkbase), 'utf8'), TaxonomyStyle.SEC_EMBEDDED)
            for (const [elementId, labelRoles] of Object.entries(embeddedLabels)) {
              if (!(elementId in this._labels)) this._labels[elementId] = {}
              Object.assign(this._labels[elementId], labelRoles)
            }
          } catch {
            // an embedded label linkbase that does not parse is skipped
          }
        }

        await this.fetchExternalTaxonomyLabels(imports as Dict[])
      } else {
        for (const [elemId, elemData] of Object.entries<Dict>(this._xsd.elements ?? {})) {
          if (!(elemId in tags)) tags[elemId] = elemData
          else Object.assign(tags[elemId], elemData)
        }
        const docNums = new Set<string>()
        for (const role of this._xsd.roles ?? []) {
          const docNum = role.document_number ?? ''
          if (docNum && !docNums.has(docNum)) {
            docNums.add(docNum)
            items.push(role)
          }
        }
      }

      items = items.sort((a, b) => {
        const x = a.document_number ?? ''
        const y = b.document_number ?? ''
        return x < y ? -1 : x > y ? 1 : 0
      })

      const statementItems: Dict = this._resources
      items.forEach((item, i) => {
        const rNum = i + 1
        item.url = `${this._url}R${rNum}.htm`
        if (PY_EMPTY(statementItems[`r${rNum}`])) statementItems[`r${rNum}`] = item
      })
      Object.assign(this._resources, statementItems)
    }

    const linkbaseUrl = docs.filter((d) => (d.description || '').endsWith('LABEL LINKBASE DOCUMENT') || (d.url || '').endsWith('_lab.xml') || (d.type || '') === 'EX-101.LAB').map((d) => d.url)
    if (linkbaseUrl.length > 0) {
      const content = await this.documentText(linkbaseUrl[0]!)
      const parser = new XBRLParser()
      try {
        const linkbaseLabels = parser.parseLabelLinkbase(Buffer.from(content, 'utf8'), TaxonomyStyle.FASB_STANDARD)
        for (const [elementId, roles] of Object.entries(linkbaseLabels)) {
          if (!(elementId in this._labels)) this._labels[elementId] = {}
          for (const [role, value] of Object.entries(roles)) if (!(role in this._labels[elementId])) this._labels[elementId][role] = value
        }
      } catch {
        // labels that do not parse are skipped
      }
    }

    for (const [elementId, roles] of Object.entries<Dict>(this._labels)) if (elementId in tags) Object.assign(tags[elementId], roles)

    // Presentation via XBRLParser
    const presentationUrl = docs.filter((d) => (d.description || '').endsWith('PRESENTATION LINKBASE DOCUMENT') || (d.url || '').endsWith('_pre.xml') || (d.type || '') === 'EX-101.PRE').map((d) => d.url)
    if (presentationUrl.length > 0) {
      try {
        const content = await this.documentText(presentationUrl[0]!)
        const parser = new XBRLParser()
        const roots = parser.parsePresentation(Buffer.from(content, 'utf8'), TaxonomyStyle.FASB_STANDARD)
        const flattenTree = (nodes: XBRLNode[], parentId: string | null = null): void => {
          for (const node of nodes) {
            const tag = node.element_id
            if (!(tag in tags)) tags[tag] = {}
            tags[tag].order = String(pyNumStr(node.order))
            if (parentId) tags[tag].parent_tag = parentId
            if (node.preferred_label) tags[tag].preferred_label = node.preferred_label.split('/').at(-1)
            flattenTree(node.children, tag)
          }
        }
        flattenTree(roots)
        this._presentation = roots
      } catch {
        // a presentation linkbase that does not parse is skipped
      }
    }

    // Calculations
    const calcsUrl = docs.filter((d) => (d.description || '').endsWith('CALCULATION LINKBASE DOCUMENT') || (d.url || '').endsWith('_cal.xml') || (d.type || '') === 'EX-101.CAL').map((d) => d.url)
    if (calcsUrl.length > 0) {
      try {
        const content = await this.documentText(calcsUrl[0]!)
        const parser = new XBRLParser()
        const calcData = parser.parseCalculation(Buffer.from(content, 'utf8'), TaxonomyStyle.FASB_STANDARD)
        for (const [elementId, calcInfo] of Object.entries(calcData)) {
          if (elementId in tags) {
            tags[elementId].order = calcInfo.order
            tags[elementId].weight = calcInfo.weight
            tags[elementId].parent_tag = calcInfo.parent_tag || tags[elementId].parent_tag
          } else tags[elementId] = calcInfo
        }
        this._calcs = calcData
      } catch {
        // a calculation linkbase that does not parse is skipped
      }
    }
    Object.assign(this._tags, tags)
  }

  /** `_download_xbrl_instance`: the XBRL instance document, its facts, and the text blocks among them. */
  private async downloadXbrlInstance(): Promise<void> {
    const instanceUrl = this._documentUrls.filter((d) => (d.description || '').endsWith('INSTANCE DOCUMENT') || (d.type || '') === 'EX-101.INS' || (d.url || '').endsWith('_htm.xml')).map((d) => d.url)
    if (instanceUrl.length === 0) return

    const instanceContent = await this.documentText(instanceUrl[0]!)
    const parser = new XBRLParser(undefined, this.ctx)
    const [contexts, units, facts] = await parser.parseInstance(Buffer.from(instanceContent, 'utf8'), this._url)
    if (Object.keys(contexts).length === 0 && Object.keys(facts).length === 0) return

    this._periodContext = contexts
    this._xbrlUnits = units

    const newInstanceDict: Dict = {}
    for (const [tag, factList] of Object.entries(facts)) newInstanceDict[tag] = { context: factList }
    Object.assign(this._instance, newInstanceDict)

    // Supplement self._tags with label/documentation from enriched facts where tags are missing that metadata.
    for (const [tag, factList] of Object.entries(facts)) {
      if (factList.length === 0) continue
      const first = factList[0]!
      if (!(tag in this._tags)) this._tags[tag] = {}
      const tagData = this._tags[tag]
      if (!tagData.label && first.label && first.label !== tag) tagData.label = first.label
      if (!tagData.documentation && first.documentation) tagData.documentation = first.documentation
    }

    const findTagData = (tagKey: string): Dict => {
      if (tagKey in this._tags) {
        const tagData = this._tags[tagKey]
        if (tagData && typeof tagData === 'object') return { ...tagData }
      }
      if (tagKey.includes('_')) {
        const localName = tagKey.split('_').slice(1).join('_')
        for (const [tk, tv] of Object.entries<Dict>(this._tags)) {
          if (tk.includes('_') && tk.split('_').slice(1).join('_') === localName && tv && typeof tv === 'object') return { ...tv }
        }
      }
      return {}
    }

    for (const [k, v] of Object.entries<Dict>(newInstanceDict)) {
      if (k.includes('TextBlock') && v.context && v.context.length > 0) {
        const tag = findTagData(k)
        const contextList: Dict[] = v.context
        if (contextList.length > 0 && contextList[0]!.value) {
          const textBlock = this.cleanHtmlToText(contextList[0]!.value, true)
          tag.value = textBlock
          this._textBlocks[k] = Object.fromEntries(Object.entries(tag).filter(([tk]) => !['xsi_nil', 'balance_type', 'order', 'xbrl_type'].includes(tk)))
        }
      }
    }
  }
}

function pyNumStr(n: number): string {
  return Number.isInteger(n) ? `${n}.0` : String(n)
}

/** Strip the SEC '<id> - Disclosure - ' prefix from a disclosure label. */
export function cleanDisclosureName(name: string): string {
  const parts = name.split(' - Disclosure - ')
  return parts.length >= 2 ? pyStrip(parts.slice(1).join(' - Disclosure - ')) : name
}

/** Whether an Item 3 section merely points to a note. */
export function isLegalRedirect(text: string): boolean {
  if (text.length > 1500) return false
  return /incorporated\s+(?:herein\s+)?by\s+reference/i.test(text) || (/\bnotes?\s+\d+/i.test(text) && /financial statements/i.test(text))
}

// ---------------------------------------------------------------------------------------------------------------
// Filing lookup (get_form10_urls_by_symbol, resolve_filing_url, resolve_section_url)
// ---------------------------------------------------------------------------------------------------------------

const FILING_FORMS = '10-K,10-Q,20-F,40-F'
const ANNUAL_FORMS = ['10-K', '20-F', '40-F']

const isAmendment = (filingType: unknown): boolean => String(filingType ?? '').toUpperCase().endsWith('/A')
const isAnnualForm = (filingType: unknown): boolean => {
  const ft = String(filingType ?? '').toUpperCase()
  return ANNUAL_FORMS.some((f) => ft.startsWith(f)) && !isAmendment(ft)
}

/** A friendly message when a symbol has no supported annual/quarterly filing. */
export function noFilingMessage(symbol: string): string {
  return `No 10-K, 10-Q, 20-F, or 40-F filing was found for '${symbol}'. It may be a foreign private issuer that files only 6-K interim reports, or a company that does not file these forms with the SEC.`
}

const calendarQuarter = (periodEnding: unknown): number => {
  const pe = String(periodEnding ?? '')
  if (pe.length < 7 || !/^\d{2}$/.test(pe.slice(5, 7))) return 0
  return Math.floor((Number(pe.slice(5, 7)) - 1) / 3) + 1
}

/** `get_form10_urls_by_symbol` */
async function getForm10UrlsBySymbol(ctx: NativeCtx, symbol: string, useCache: boolean): Promise<Row[]> {
  const filings = await fetchCompanyFilings(ctx, { symbol: symbol.toUpperCase(), form_type: FILING_FORMS, use_cache: useCache })
  return filings.map((f) => ({ filing_date: f.filing_date, period_ending: f.report_date, filing_type: f.report_type, url: f.report_url }))
}

/** `resolve_filing_url`: a symbol to a single filing URL by calendar year and period. */
export async function resolveFilingUrl(ctx: NativeCtx, symbol: string, calendarYear: number | undefined, calendarPeriod: string | undefined, useCache: boolean, annualDefault: boolean): Promise<string> {
  let filings = await getForm10UrlsBySymbol(ctx, symbol, useCache)
  const s = (v: unknown): string => (v === undefined || v === null ? '' : String(v))
  // sorted(key=(period_ending, not amendment, filing_date), reverse=True) is stable for equal keys
  filings = filings
    .map((f, i) => ({ f, i }))
    .sort((a, b) => {
      const ka: [string, number, string] = [s(a.f.period_ending), isAmendment(a.f.filing_type) ? 0 : 1, s(a.f.filing_date)]
      const kb: [string, number, string] = [s(b.f.period_ending), isAmendment(b.f.filing_type) ? 0 : 1, s(b.f.filing_date)]
      for (let k = 0; k < 3; k++) if (ka[k]! !== kb[k]!) return ka[k]! < kb[k]! ? 1 : -1
      return a.i - b.i
    })
    .map((x) => x.f)

  if (calendarYear) filings = filings.filter((f) => s(f.period_ending).slice(0, 4) === String(calendarYear))
  if (calendarPeriod) {
    const quarter = Number(String(calendarPeriod).slice(-1))
    filings = filings.filter((f) => calendarQuarter(f.period_ending) === quarter)
  } else if (annualDefault) {
    filings = filings.filter((f) => isAnnualForm(f.filing_type))
  }
  return filings.length > 0 ? s(filings[0]!.url) : ''
}

/** The query every filing-section route takes (`FilingSectionQueryParams`), validators applied. */
export type SectionQuery = { symbol?: string; url?: string; calendar_year?: number; calendar_period?: string; use_cache: boolean; [key: string]: unknown }

export function sectionQuery(params: NativeParams): SectionQuery {
  const emptyToUndefined = (v: unknown): unknown => (v === '' || v === null ? undefined : v)
  const symbol = typeof params.symbol === 'string' ? params.symbol.toUpperCase() : undefined
  const year = emptyToUndefined(params.calendar_year)
  const period = emptyToUndefined(params.calendar_period)
  const url = emptyToUndefined(params.url)
  return {
    ...(symbol !== undefined ? { symbol } : {}),
    ...(typeof url === 'string' ? { url } : {}),
    ...(year !== undefined ? { calendar_year: Number(year) } : {}),
    ...(typeof period === 'string' ? { calendar_period: period } : {}),
    use_cache: params.use_cache === undefined ? true : Boolean(params.use_cache),
  }
}

/** `resolve_section_url`: an explicit url, or the filing resolved from the symbol. */
export async function resolveSectionUrl(ctx: NativeCtx, query: SectionQuery, annualDefault = true): Promise<string> {
  if (query.url) return query.url
  if (!query.symbol) return ''
  return resolveFilingUrl(ctx, query.symbol, query.calendar_year, query.calendar_period, query.use_cache, annualDefault)
}

/**
 * `FinancialStatements.from_url`: Python keeps the last 32 parsed filings (`lru_cache`); here every call parses its
 * own, because a parsed filing holds the ctx of the call that built it and the downloads below it are cached anyway.
 */
export function financialStatementsFor(ctx: NativeCtx, url: string, useCache: boolean): Promise<FinancialStatements> {
  return FinancialStatements.create(ctx, url, useCache)
}
