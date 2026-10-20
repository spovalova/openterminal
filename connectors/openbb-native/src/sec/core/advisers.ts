// sec/adviser_firms, sec/adviser_individuals, sec/adviser_documents and sec/adviser_universe, provider sec. Ported
// from openbb_sec/utils/adviser_info.py and models/adviser_search.py, adviser_documents.py and adviser_universe.py
// (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models, zip and CSV read with fflate
// and src/lib/csv.ts.
import { unzipSync } from 'fflate'
import { parseCsv } from '../../lib/csv.js'
import type { NativeCtx, NativeParams, Row } from '../../types.js'
import { HEADERS, SEC_HEADERS, cachedRequest, collapseWhitespace, urlencode } from '../helpers.js'

// ---------------------------------------------------------------------------------------------------------------
// adviser_info.py
// ---------------------------------------------------------------------------------------------------------------

const IAPD_SEARCH_URL = 'https://api.adviserinfo.sec.gov/search'
const IAPD_CACHE_SECONDS = 24 * 60 * 60
const IAPD_RESULT_LIMIT = 100

type Dict = Record<string, unknown>

/** `request_iapd`: JSON from a public IAPD search endpoint. */
function requestIapd(ctx: NativeCtx, path: string, params: Record<string, string | number>, useCache: boolean): Promise<unknown> {
  const query = urlencode(params)
  const base = `${IAPD_SEARCH_URL}/${path}`
  return cachedRequest(ctx, query ? `${base}?${query}` : base, { headers: HEADERS, useCache, expireS: IAPD_CACHE_SECONDS })
}

/** `string_dict`: an object, or the error. */
function stringDict(value: unknown, message: string): Dict {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(message)
  return value as Dict
}

/** `iapd_hits`: the source and hit objects of a validated IAPD response. */
function iapdSources(payload: unknown, context: string): Dict[] {
  const body = stringDict(payload, `Invalid IAPD ${context} response: expected a JSON object.`)
  const errorCode = cleanText(body.errorCode)
  if (errorCode !== null) throw new Error(`IAPD ${context} failed with error ${errorCode}: ${cleanText(body.errorMessage) ?? 'Unknown error'}`)
  const container = stringDict(body.hits, `Invalid IAPD ${context} response: missing the hits object.`)
  const hits = container.hits
  if (!Array.isArray(hits)) throw new Error(`Invalid IAPD ${context} response: expected hits.hits to be a list.`)
  return hits.map((hit) => {
    const record = stringDict(hit, `Invalid IAPD ${context} response: each hit must be an object.`)
    return stringDict(record._source, `Invalid IAPD ${context} response: each hit must contain a source object.`)
  })
}

function requiredText(value: unknown, field: string, context = 'search'): string {
  const cleaned = cleanText(value)
  if (cleaned === null) throw new Error(`Invalid IAPD ${context} response: adviser data is missing ${field}.`)
  return cleaned
}

/** `clean_text`: optional scalar text with its whitespace collapsed. */
function cleanText(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'boolean' || (typeof value !== 'string' && !(typeof value === 'number' && Number.isInteger(value)))) throw new Error('Invalid IAPD response: expected a scalar text value.')
  return collapseWhitespace(String(value)) || null
}

/** `clean_int`: an optional integer, from a number or numeric text. */
function cleanInt(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'number' && Number.isInteger(value)) return value
  if (typeof value === 'string' && /^\s*[+-]?\d+\s*$/.test(value)) return parseInt(value, 10)
  throw new Error('Invalid IAPD response: expected an integer value.')
}

/** `datetime.strptime(text, format).date()` for the two formats IAPD uses, as "YYYY-MM-DD". */
function strptimeDate(text: string, format: string): string | undefined {
  const m = format === '%m/%d/%Y' ? /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text) : /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text)
  if (!m) return undefined
  const [y, mo, d] = format === '%m/%d/%Y' ? [Number(m[3]), Number(m[1]), Number(m[2])] : [Number(m[1]), Number(m[2]), Number(m[3])]
  const check = new Date(Date.UTC(y, mo - 1, d))
  if (y < 1 || mo < 1 || mo > 12 || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return undefined
  return `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/** `clean_date`: an optional date in one of the accepted source formats. */
function cleanDate(value: unknown, ...formats: string[]): string | null {
  const cleaned = cleanText(value)
  if (cleaned === null) return null
  for (const format of formats.length ? formats : ['%Y-%m-%d']) {
    const d = strptimeDate(cleaned, format)
    if (d) return d
  }
  throw new Error('Invalid IAPD response: expected a valid date value.')
}

/** `embedded_object`: a JSON object embedded in an IAPD string field. */
function embeddedObject(value: unknown, field: string): Dict {
  if (value === null || value === undefined || value === '') return {}
  if (typeof value === 'object' && !Array.isArray(value)) return value as Dict
  if (typeof value !== 'string') throw new Error(`Invalid IAPD response: ${field} must be an object.`)
  let decoded: unknown
  try {
    decoded = JSON.parse(value)
  } catch {
    throw new Error(`Invalid IAPD response: invalid JSON in ${field}.`)
  }
  return stringDict(decoded, `Invalid IAPD response: ${field} must be an object.`)
}

// ---------------------------------------------------------------------------------------------------------------
// adviser_search.py
// ---------------------------------------------------------------------------------------------------------------

type SearchQuery = { query: string; limit: number; useCache: boolean }

function searchQuery(params: NativeParams): SearchQuery {
  const query = String(params.query ?? '').trim()
  if (!query) throw new Error('query must not be blank')
  const limit = params.limit === undefined ? 20 : Number(params.limit)
  if (!Number.isInteger(limit) || limit < 1 || limit > IAPD_RESULT_LIMIT) throw new Error(`limit must be between 1 and ${IAPD_RESULT_LIMIT}`)
  return { query, limit, useCache: params.use_cache === undefined ? true : Boolean(params.use_cache) }
}

async function searchIapd(ctx: NativeCtx, entity: 'firm' | 'individual', query: SearchQuery): Promise<Dict[]> {
  const payload = await requestIapd(ctx, entity, { query: query.query, nrows: IAPD_RESULT_LIMIT }, query.useCache)
  return iapdSources(payload, 'search')
}

function firmRecord(source: Dict): Row | null {
  const secNumber = cleanText(source.firm_ia_full_sec_number)
  const status = cleanText(source.firm_ia_scope)
  if (secNumber === null && status === null) return null
  const crd = requiredText(source.firm_source_id, 'firm CRD')
  const name = requiredText(source.firm_name, 'firm name')
  const addressDetails = embeddedObject(source.firm_ia_address_details, 'firm address details')
  const officeValue = addressDetails.officeAddress
  const office = officeValue === null || officeValue === undefined ? {} : stringDict(officeValue, 'Invalid IAPD search response: firm office address must be an object.')
  return {
    crd,
    sec_number: secNumber,
    name,
    status,
    branch_count: cleanInt(source.firm_branches_count),
    address_line_1: cleanText(office.street1),
    address_line_2: cleanText(office.street2),
    city: cleanText(office.city),
    state: cleanText(office.state),
    postal_code: cleanText(office.postalCode),
    country: cleanText(office.country),
  }
}

export async function adviserFirms(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const query = searchQuery(params)
  const sources = await searchIapd(ctx, 'firm', query)
  const records = sources.map(firmRecord).filter((r): r is Row => r !== null)
  if (!records.length) throw new Error(`No investment adviser firms were found for '${query.query}'.`)
  return records.slice(0, query.limit)
}

function individualRecords(source: Dict): Row[] {
  const status = cleanText(source.ind_ia_scope)
  if (status === null || status.toLowerCase() === 'notinscope') return []
  const record: Row = {
    crd: requiredText(source.ind_source_id, 'individual CRD'),
    first_name: requiredText(source.ind_firstname, 'first name'),
    middle_name: cleanText(source.ind_middlename),
    last_name: requiredText(source.ind_lastname, 'last name'),
    suffix: cleanText(source.ind_namesuffix),
    status,
    broker_dealer_status: cleanText(source.ind_bc_scope),
    industry_start_date: cleanDate(source.ind_industry_cal_date_iapd),
    industry_days: cleanInt(source.ind_industry_days_iapd),
    employment_count: cleanInt(source.ind_employments_count),
    finra_registration_count: cleanInt(source.ind_approved_finra_registration_count),
  }
  const employments = source.ind_ia_current_employments
  if (employments === null || employments === undefined || (Array.isArray(employments) && employments.length === 0)) return [record]
  if (!Array.isArray(employments)) throw new Error('Invalid IAPD search response: current employments must be a list.')
  const records: Row[] = []
  const seen = new Set<string>()
  for (const item of employments) {
    const employment = stringDict(item, 'Invalid IAPD search response: current employment must be an object.')
    const firmCrd = requiredText(employment.firm_id, 'current firm CRD')
    const firmName = requiredText(employment.firm_name, 'current firm name')
    const iaSec = cleanText(employment.firm_ia_full_sec_number)
    const bdSec = cleanText(employment.firm_bd_full_sec_number)
    const key = JSON.stringify([firmCrd, firmName, iaSec, bdSec])
    if (seen.has(key)) continue
    seen.add(key)
    records.push({ ...record, current_firm_crd: firmCrd, current_firm_name: firmName, current_firm_ia_sec_number: iaSec, current_firm_bd_sec_number: bdSec })
  }
  return records.length ? records : [record]
}

export async function adviserIndividuals(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const query = searchQuery(params)
  const sources = await searchIapd(ctx, 'individual', query)
  const records: Row[] = []
  for (const source of sources) {
    records.push(...individualRecords(source))
    if (records.length >= query.limit) break
  }
  if (!records.length) throw new Error(`No investment adviser individuals were found for '${query.query}'.`)
  return records.slice(0, query.limit)
}

// ---------------------------------------------------------------------------------------------------------------
// adviser_documents.py
// ---------------------------------------------------------------------------------------------------------------

const ADV_REPORT_URL = 'https://reports.adviserinfo.sec.gov/reports/ADV'
const BROCHURE_URL = 'https://files.adviserinfo.sec.gov/IAPD/Content/Common/crd_iapd_Brochure.aspx'

/** `_get_adviser_firm`: one IAPD firm profile by CRD. */
async function getAdviserFirm(ctx: NativeCtx, crd: string, useCache: boolean): Promise<Dict> {
  const payload = await requestIapd(ctx, `firm/${crd}`, {}, useCache)
  const sources = iapdSources(payload, 'firm profile')
  if (!sources.length) throw new Error(`No investment adviser firm was found for CRD ${crd}.`)
  for (const source of sources) {
    const content = source.iacontent
    if (typeof content !== 'string') throw new Error('Invalid IAPD firm profile response: iacontent must be JSON text.')
    let parsed: unknown
    try {
      parsed = JSON.parse(content)
    } catch {
      throw new Error('Invalid IAPD firm profile response: iacontent contains invalid JSON.')
    }
    const firm = stringDict(parsed, 'Invalid IAPD firm profile response: iacontent must be an object.')
    const basic = stringDict(firm.basicInformation, 'Invalid IAPD firm profile response: missing basic information.')
    if (cleanText(basic.firmId) === crd) return firm
  }
  throw new Error(`No investment adviser firm was found for CRD ${crd}.`)
}

function profileSection(firm: Dict, name: string, required = true): Dict {
  const value = firm[name]
  if ((value === null || value === undefined) && !required) return {}
  return stringDict(value, `Invalid IAPD firm profile response: ${name} must be an object.`)
}

function objectList(value: unknown, field: string): Dict[] {
  if (value === null || value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`Invalid IAPD firm profile response: ${field} must be a list.`)
  return value.map((item) => stringDict(item, `Invalid IAPD firm profile response: ${field} entries must be objects.`))
}

function yesNo(value: unknown): boolean | null {
  const cleaned = cleanText(value)
  if (cleaned === null) return null
  if (cleaned === 'Y') return true
  if (cleaned === 'N') return false
  throw new Error('Invalid IAPD firm profile response: expected a Y/N flag.')
}

function documentRecords(firm: Dict): Row[] {
  const basic = profileSection(firm, 'basicInformation')
  const crd = requiredText(basic.firmId, 'firm CRD', 'firm profile')
  const name = requiredText(basic.firmName, 'firm name', 'firm profile')
  const records: Row[] = []
  if (yesNo(basic.hasPdf) === true) {
    records.push({ crd, firm_name: name, document_type: 'Form ADV', document_id: null, title: 'Form ADV', filing_date: cleanDate(basic.advFilingDate, '%m/%d/%Y'), url: `${ADV_REPORT_URL}/${crd}/PDF/${crd}.pdf` })
  }
  const brochures = profileSection(firm, 'brochures', false)
  for (const brochure of objectList(brochures.brochuredetails, 'brochuredetails')) {
    const versionId = requiredText(brochure.brochureVersionID, 'brochure version ID', 'firm profile')
    records.push({
      crd,
      firm_name: name,
      document_type: 'Brochure',
      document_id: versionId,
      title: requiredText(brochure.brochureName, 'brochure name', 'firm profile'),
      filing_date: cleanDate(brochure.dateSubmitted, '%m/%d/%Y'),
      url: `${BROCHURE_URL}?${urlencode({ BRCHR_VRSN_ID: versionId })}`,
    })
  }
  return records
}

export async function adviserDocuments(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const crd = String(params.crd ?? '')
  if (!/^\d+$/.test(crd)) throw new Error('crd must be digits only')
  const useCache = params.use_cache === undefined ? true : Boolean(params.use_cache)
  const records = documentRecords(await getAdviserFirm(ctx, crd, useCache))
  if (!records.length) throw new Error(`No regulatory documents were found for adviser CRD ${crd}.`)
  return records
}

// ---------------------------------------------------------------------------------------------------------------
// adviser_universe.py
// ---------------------------------------------------------------------------------------------------------------

const ADVISER_DATASET_TITLE = 'Information About Registered Investment Advisers and Exempt Reporting Advisers'
const CATALOG_CACHE_SECONDS = 24 * 60 * 60
const REPORT_CACHE_SECONDS = 35 * 24 * 60 * 60
const REPORT_MONTH = /([A-Z][a-z]+ \d{4})/
const REQUIRED_COLUMNS = ['Organization CRD#', 'SEC#', 'Firm Type', 'Primary Business Name', 'Legal Name', 'SEC Current Status', 'Latest ADV Filing Date']

const COLUMN_NAMES: Record<string, string> = {
  'Organization CRD#': 'crd',
  'Additional CRD Number': 'additional_crd',
  'Total number of additional CRD numbers': 'additional_crd_count',
  'SEC#': 'sec_number',
  'Total number of relying advisers': 'relying_adviser_count',
  'Total number of CIK numbers': 'cik_count',
  'Main Office Street Address 1': 'main_office_address_line_1',
  'Main Office Street Address 2': 'main_office_address_line_2',
  'Main Office Private Residence Flag': 'main_office_private_residence',
  'Main Office Telephone Number': 'main_office_phone',
  'Main Office Facsimile Number': 'main_office_fax',
  'Total number of offices, other than your Principal Office and place of business': 'other_office_count',
  'Mail Office Street Address 1': 'mail_office_address_line_1',
  'Mail Office Street Address 2': 'mail_office_address_line_2',
  'Mail Office Private Residence Flag': 'mail_office_private_residence',
  'SEC Current Status': 'status',
  'SEC Status Effective Date': 'status_effective_date',
  'Website Address': 'website',
  'Total Number of Website Addresses': 'website_count',
  'Total Number of Books and Records Locations': 'books_and_records_location_count',
  'Total Number of Acquired Firms': 'acquired_firm_count',
  '5A': 'employee_count',
  '5F(2)(a)': 'discretionary_aum',
  '5F(2)(b)': 'non_discretionary_aum',
  '5F(2)(c)': 'regulatory_assets_under_management',
  '5F(2)(d)': 'discretionary_account_count',
  '5F(2)(e)': 'non_discretionary_account_count',
  '5F(2)(f)': 'account_count',
  '5F(3)': 'non_us_clients_aum',
  'Count of IA Affiliates': 'investment_adviser_affiliate_count',
  'Count of IA/BD Affiliates': 'investment_adviser_broker_dealer_affiliate_count',
  'Count of BD Affiliates': 'broker_dealer_affiliate_count',
  'Count of Private Funds - 7B(1)': 'private_fund_count',
  'Total Gross Assets of Private Funds': 'private_fund_gross_assets',
  'Count of Private Funds - 7B(2)': 'private_fund_adviser_count',
  'Total Custody Amount': 'custody_amount',
  'Count of Control person Public Reporting Company': 'public_reporting_company_control_person_count',
}

const DATE_FIELDS = new Set(['status_effective_date', 'latest_adv_filing_date'])
const INTEGER_FIELDS = new Set([
  'additional_crd_count',
  'relying_adviser_count',
  'cik_count',
  'other_office_count',
  'website_count',
  'books_and_records_location_count',
  'acquired_firm_count',
  'employee_count',
  'discretionary_account_count',
  'non_discretionary_account_count',
  'account_count',
  'investment_adviser_affiliate_count',
  'investment_adviser_broker_dealer_affiliate_count',
  'broker_dealer_affiliate_count',
  'private_fund_count',
  'private_fund_adviser_count',
  'public_reporting_company_control_person_count',
])
const NUMBER_FIELDS = new Set(['discretionary_aum', 'non_discretionary_aum', 'regulatory_assets_under_management', 'non_us_clients_aum', 'private_fund_gross_assets', 'custody_amount'])

type AdviserReport = { registrationType: 'registered' | 'exempt'; reportDate: string; mediaType: string; url: string }

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** `_report_from_distribution`: one distribution of the SEC data catalog, if it is an adviser report. */
function reportFromDistribution(item: unknown): AdviserReport | null {
  const record = stringDict(item, 'Invalid SEC data catalog response: distributions must be objects.')
  const { title: rawTitle, mediaType: rawMedia, downloadURL: rawUrl } = record
  if (typeof rawTitle !== 'string' || typeof rawMedia !== 'string' || typeof rawUrl !== 'string') return null
  const title = rawTitle.trim()
  let registrationType: 'registered' | 'exempt'
  if (title.startsWith('Registered Investment Advisers')) registrationType = 'registered'
  else if (title.startsWith('Exempt Investment Advisers') || title.startsWith('Exempt Reporting Advisers')) registrationType = 'exempt'
  else return null
  const match = REPORT_MONTH.exec(title)
  if (!match) throw new Error(`Invalid SEC adviser report title: unable to read date from '${title}'.`)
  const [monthName, year] = match[1]!.split(' ')
  const month = MONTHS.indexOf(monthName!)
  if (month < 0) throw new Error(`Invalid SEC adviser report date in '${title}'.`)
  return { registrationType, reportDate: `${year}-${String(month + 1).padStart(2, '0')}-01`, mediaType: rawMedia.trim(), url: rawUrl.trim() }
}

/** `_latest_report`: the newest report of the requested kind in the SEC data catalog. */
function latestReport(catalog: unknown, registrationType: 'registered' | 'exempt'): AdviserReport {
  const record = stringDict(catalog, 'Invalid SEC data catalog response: expected an object.')
  const datasets = record.dataset
  if (!Array.isArray(datasets)) throw new Error('Invalid SEC data catalog response: expected a dataset list.')
  let distributions: unknown
  for (const dataset of datasets) {
    const d = stringDict(dataset, 'Invalid SEC data catalog response: dataset entries must be objects.')
    if (d.title === ADVISER_DATASET_TITLE) {
      distributions = d.distribution
      break
    }
  }
  if (!Array.isArray(distributions)) throw new Error('The SEC data catalog is missing the investment adviser dataset.')
  const reports = distributions.map(reportFromDistribution).filter((r): r is AdviserReport => r !== null && r.registrationType === registrationType)
  if (!reports.length) throw new Error(`No ${registrationType} investment adviser reports were found in the SEC data catalog.`)
  const latestDate = reports.map((r) => r.reportDate).sort().at(-1)!
  const latest = reports.filter((r) => r.reportDate === latestDate)
  if (latest.length !== 1) throw new Error(`The SEC data catalog contains multiple ${registrationType} adviser reports for ${latestDate}.`)
  const report = latest[0]!
  if (report.mediaType !== 'application/zip' || !report.url.toLowerCase().endsWith('.zip')) throw new Error(`The latest ${registrationType} adviser report uses unsupported media type '${report.mediaType || 'unknown'}'.`)
  return report
}

/** `_normalize_column_name`: an SEC heading lower-cased and joined with underscores, keeping Form ADV item numbers. */
function normalizeColumnName(value: string): string {
  let name = value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  if (name && /\d/.test(name[0]!)) name = `item_${name}`
  if (!name) throw new Error('Invalid SEC adviser report: empty column heading.')
  return name
}

function optionalText(value: string | undefined): string | null {
  if (value === undefined) return null
  return collapseWhitespace(value) || null
}

function optionalDate(value: string | undefined): string | null {
  const cleaned = optionalText(value)
  if (cleaned === null) return null
  const d = strptimeDate(cleaned, '%m/%d/%Y')
  if (!d) throw new Error('Invalid SEC adviser report: expected MM/DD/YYYY.')
  return d
}

function optionalInt(value: string | undefined): number | null {
  const cleaned = optionalText(value)?.replaceAll(',', '')
  if (cleaned === undefined) return null
  if (!/^\d+$/.test(cleaned)) throw new Error('Invalid SEC adviser report: expected an integer value.')
  return parseInt(cleaned, 10)
}

function optionalNumber(value: string | undefined): number | null {
  const cleaned = optionalText(value)?.replaceAll(',', '').replaceAll('$', '')
  if (cleaned === undefined) return null
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(cleaned)) throw new Error('Invalid SEC adviser report: expected a numeric value.')
  return Number(cleaned)
}

function fieldValue(field: string, value: string | undefined): unknown {
  if (DATE_FIELDS.has(field)) return optionalDate(value)
  if (INTEGER_FIELDS.has(field)) return optionalInt(value)
  if (NUMBER_FIELDS.has(field)) return optionalNumber(value)
  return optionalText(value)
}

function requiredField(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`Invalid SEC adviser report: ${field} is required.`)
  return value
}

/** `_parse_report`: the rows of one SEC adviser report archive (a zip holding one CSV), or just the row of a CRD. */
function parseReport(content: Uint8Array, report: AdviserReport, crd: string | undefined): Row[] {
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(content, { filter: (f) => !f.name.endsWith('/') && f.name.toLowerCase().endsWith('.csv') })
  } catch {
    throw new Error('Invalid SEC adviser report: expected a ZIP archive.')
  }
  const csvFiles = Object.values(files)
  if (csvFiles.length !== 1) throw new Error('Invalid SEC adviser report: expected exactly one CSV file.')
  const rows = parseCsv(new TextDecoder('windows-1252').decode(csvFiles[0]))
  const fieldnames = rows[0] ?? []
  const missing = REQUIRED_COLUMNS.filter((c) => !fieldnames.includes(c)).sort()
  if (missing.length) throw new Error(`Invalid SEC adviser report: missing required columns ${missing.join(', ')}.`)
  const names = fieldnames.map((c) => COLUMN_NAMES[c] ?? normalizeColumnName(c))
  if (new Set(names).size !== names.length) throw new Error('Invalid SEC adviser report: source columns map to duplicate field names.')
  const crdAt = fieldnames.indexOf('Organization CRD#')
  const records: Row[] = []
  for (const row of rows.slice(1)) {
    if (crd !== undefined && optionalText(row[crdAt]) !== crd) continue
    const record: Row = {}
    fieldnames.forEach((_, i) => {
      record[names[i]!] = fieldValue(names[i]!, row[i])
    })
    const cik = record.cik
    if (cik !== null && cik !== undefined) {
      if (typeof cik !== 'string' || !/^\d+$/.test(cik)) throw new Error('Invalid SEC adviser report: CIK must be numeric.')
      record.cik = cik.padStart(10, '0')
    }
    record.crd = requiredField(record.crd, 'Organization CRD#')
    record.sec_number = requiredField(record.sec_number, 'SEC#')
    record.primary_business_name = requiredField(record.primary_business_name, 'Primary Business Name')
    record.legal_name = requiredField(record.legal_name, 'Legal Name')
    record.firm_type = requiredField(record.firm_type, 'Firm Type')
    record.status = requiredField(record.status, 'SEC Current Status')
    record.latest_adv_filing_date = requiredField(record.latest_adv_filing_date, 'Latest ADV Filing Date')
    record.report_date = report.reportDate
    records.push(record)
    if (crd !== undefined) break
  }
  return records
}

export async function adviserUniverse(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const registrationType = params.registration_type
  if (registrationType !== 'registered' && registrationType !== 'exempt') throw new Error('registration_type must be registered or exempt')
  const crd = params.crd === undefined || params.crd === '' ? undefined : String(params.crd)
  if (crd !== undefined && !/^\d+$/.test(crd)) throw new Error('crd must be digits only')
  const useCache = params.use_cache === undefined ? true : Boolean(params.use_cache)

  const catalog = await cachedRequest(ctx, 'https://www.sec.gov/data.json', { headers: SEC_HEADERS, useCache, expireS: CATALOG_CACHE_SECONDS })
  const report = latestReport(catalog, registrationType)
  const content = (await cachedRequest(ctx, report.url, { kind: 'bytes', headers: SEC_HEADERS, useCache, expireS: REPORT_CACHE_SECONDS, timeoutMs: 180_000 })) as Uint8Array
  const records = parseReport(content, report, crd)
  if (!records.length) {
    if (crd !== undefined) throw new Error(`No ${registrationType} investment adviser with CRD ${crd} was found.`)
    throw new Error(`The ${MONTHS[Number(report.reportDate.slice(5, 7)) - 1]} ${report.reportDate.slice(0, 4)} SEC ${registrationType} adviser report was empty.`)
  }
  return records
}
