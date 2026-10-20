// equity/ownership/insider_trading, provider sec. Ported from openbb_sec/models/insider_trading.py and
// openbb_sec/utils/form4.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of DataFrames and
// pydantic models (the validators are coerce* functions below), xmltodict is fast-xml-parser, and the filings of a
// batch are collected in URL order (OpenBB's depend on which download finishes first).
import type { NativeCtx, NativeParams, Row } from '../../types.js'
import { fetchCompanyFilings } from '../company-filings.js'
import { pause, secResponse } from '../helpers.js'
import { xmlToDict } from './xmltodict.js'

// The Form 4 downloads send this identity, not the one the other SEC requests send.
const FORM4_HEADERS = { 'User-Agent': 'Jesus Window Washing jesus@stainedglass.com' }

const FIELD_MAP: Record<string, string> = {
  filing_date: 'filing_date',
  symbol: 'symbol',
  form: 'form',
  owner: 'owner_name',
  owner_cik: 'owner_cik',
  issuer: 'company_name',
  issuer_cik: 'company_cik',
  isDirector: 'director',
  isOfficer: 'officer',
  isTenPercentOwner: 'ten_percent_owner',
  isOther: 'other',
  otherText: 'other_text',
  officerTitle: 'owner_title',
  securityTitle: 'security_type',
  transactionDate: 'transaction_date',
  footnote: 'footnote',
  transactionShares: 'securities_transacted',
  transactionPricePerShare: 'transaction_price',
  transactionTotalValue: 'transaction_value',
  transactionCode: 'transaction_type',
  transactionAcquiredDisposedCode: 'acquisition_or_disposition',
  sharesOwnedFollowingTransaction: 'securities_owned',
  valueOwnedFollowingTransaction: 'value_owned',
  transactionTimeliness: 'transaction_timeliness',
  directOrIndirectOwnership: 'ownership_type',
  natureOfOwnership: 'nature_of_ownership',
  conversionOrExercisePrice: 'conversion_exercise_price',
  exerciseDate: 'exercise_date',
  expirationDate: 'expiration_date',
  deemedExecutionDate: 'deemed_execution_date',
  underlyingSecurityTitle: 'underlying_security_title',
  underlyingSecurityShares: 'underlying_security_shares',
  underlyingSecurityValue: 'underlying_security_value',
}

const TRANSACTION_CODE_MAP: Record<string, string> = {
  A: 'Grant, award or other acquisition pursuant to Rule 16b-3(d)',
  C: 'Conversion of derivative security',
  D: 'Disposition to the issuer of issuer equity securities pursuant to Rule 16b-3(e)',
  E: 'Expiration of short derivative position',
  F: 'Payment of exercise price or tax liability by delivering or withholding securities incident to the receipt, exercise or vesting of a security issued in accordance with Rule 16b-3',
  G: 'Bona fide gift',
  H: 'Expiration (or cancellation) of long derivative position with value received',
  I: 'Discretionary transaction in accordance with Rule 16b-3(f) resulting in acquisition or disposition of issuer securities',
  J: 'Other acquisition or disposition (describe transaction)',
  L: 'Small acquisition under Rule 16a-6',
  M: 'Exercise or conversion of derivative security exempted pursuant to Rule 16b-3',
  O: 'Exercise of out-of-the-money derivative security',
  P: 'Open market or private purchase of non-derivative or derivative security',
  S: 'Open market or private sale of non-derivative or derivative security',
  U: 'Disposition pursuant to a tender of shares in a change of control transaction',
  W: 'Acquisition or disposition by will or the laws of descent and distribution',
  X: 'Exercise of in-the-money or at-the-money derivative security',
  Z: 'Deposit into or withdrawal from voting trust',
}

const TIMELINESS_MAP: Record<string, string> = { E: 'Early', L: 'Late', Empty: 'On-time' }

type Any = any
type Dict = Record<string, Any>

const isDict = (v: unknown): v is Dict => v !== null && typeof v === 'object' && !Array.isArray(v)
/** Python truthiness of an xmltodict value. */
const truthy = (v: unknown): boolean => (Array.isArray(v) ? v.length > 0 : isDict(v) ? Object.keys(v).length > 0 : Boolean(v))
/** `dict.get(key, default)`: the default only when the key is absent (a present null stays null). */
const get = (d: Dict, key: string, dflt?: Any): Any => (key in d ? d[key] : dflt)
/** `x.get(key)` on a value that Python would fail on when it is not a dict. */
const getFrom = (v: Any, key: string, dflt?: Any): Any => {
  if (!isDict(v)) throw new TypeError(`'${v === null ? 'NoneType' : typeof v}' object has no attribute 'get'`)
  return get(v, key, dflt)
}

/** `clean_xml`: drop backslashes and signature slashes, escape bare ampersands. */
function cleanXml(xml: string): string {
  return xml.replace(/\\/g, '').replaceAll('/s/ ', '').replace(/&(?!amp;|lt;|gt;|quot;|apos;)/g, '&amp;')
}

/** `get_form_4_data`: one Form 4 document as the `ownershipDocument` dict ({} when it does not parse). */
async function getForm4Data(ctx: NativeCtx, url: string): Promise<Dict> {
  const res = await secResponse(ctx, url, { headers: FORM4_HEADERS, timeoutMs: 30_000 })
  if (res.status >= 400) throw new Error(`SEC request failed with HTTP ${res.status}: ${url}`)
  const responseText = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(await res.arrayBuffer()))
  if (responseText.includes('Traffic Limit')) throw new Error("You've exceeded the SEC's traffic limit. Access will be limited for 10 minutes. Reduce the number of requests by using a more specific date range.")
  let xmlData: Dict
  try {
    xmlData = xmlToDict(cleanXml(responseText))
  } catch (err) {
    ctx.log(`Error parsing XML from ${url}: ${err instanceof Error ? err.message : String(err)}`)
    return {}
  }
  return xmlData.ownershipDocument ? (xmlData.ownershipDocument as Dict) : {}
}

/** The footnote lookup `parse_form_4_data` rebinds as it goes: a dict by id, or the joined text it turned into. */
type Footnotes = Dict | string | null

/** `parse_form_4_data`: the transactions of one Form 4 as flat rows, keyed by the Form 4 element names. */
function parseForm4Data(data: Dict): Dict[] {
  const owner = get(data, 'reportingOwner', {})
  let owners = ''
  let ciks = ''
  if (Array.isArray(owner)) {
    const join = (field: string) =>
      owner
        .map((d) => {
          const v = getFrom(get(d, 'reportingOwnerId', {}), field)
          if (typeof v !== 'string') throw new TypeError('sequence item: expected str instance')
          return v
        })
        .join(';')
    owners = join('rptOwnerName')
    ciks = join('rptOwnerCik')
  }
  const issuer = get(data, 'issuer', {})
  const ownerRelationship: Dict = isDict(owner) ? get(owner, 'reportingOwnerRelationship', {}) : Array.isArray(owner) ? getFrom(owner[0], 'reportingOwnerRelationship', {}) : {}
  const signatureData = data.ownerSignature
  let signatureDate: Any = null
  if (truthy(signatureData) && isDict(signatureData)) signatureDate = get(signatureData, 'signatureDate')
  else if (truthy(signatureData) && Array.isArray(signatureData)) signatureDate = getFrom(signatureData[0], 'signatureDate')

  let footnotes: Footnotes = get(data, 'footnotes', {})
  if (truthy(footnotes)) {
    let items = getFrom(footnotes, 'footnote')
    if (isDict(items)) items = [items]
    footnotes = Object.fromEntries((items as Dict[]).map((item) => [item['@id'], item['#text']]))
  }
  const fn = (): Dict => footnotes as Dict

  const symbolRaw = get(issuer, 'issuerTradingSymbol', '')
  if (typeof symbolRaw !== 'string') throw new TypeError("'NoneType' object has no attribute 'upper'")
  const metadata: Dict = {
    filing_date: truthy(signatureDate) ? signatureDate : get(data, 'periodOfReport'),
    symbol: symbolRaw.toUpperCase(),
    form: get(data, 'documentType'),
    owner: owners ? owners : getFrom(get(owner, 'reportingOwnerId', {}), 'rptOwnerName'),
    owner_cik: ciks ? ciks : getFrom(get(owner, 'reportingOwnerId', {}), 'rptOwnerCik'),
    issuer: get(issuer, 'issuerName'),
    issuer_cik: get(issuer, 'issuerCik'),
    ...ownerRelationship,
  }
  const results: Dict[] = []

  const nd = data.nonDerivativeTable
  if (truthy(nd) && (truthy(nd.nonDerivativeTransaction) || truthy(nd.nonDerivativeHolding))) {
    let tables: Any = truthy(nd.nonDerivativeTransaction) ? nd.nonDerivativeTransaction : nd.nonDerivativeHolding
    if (isDict(tables)) tables = [tables]
    for (const table of tables as Any[]) {
      if (typeof table === 'string') continue
      const newRow: Dict = { ...metadata }
      for (const [key, value] of Object.entries(table as Dict)) {
        if (key === 'transactionCoding') {
          newRow.transaction_type = getFrom(value, 'transactionCode')
          newRow.form = getFrom(value, 'transactionFormType') || metadata.form
        } else if (isDict(value)) {
          if ('footnoteId' in value) {
            if (Array.isArray(value.footnoteId)) {
              const ids = value.footnoteId.map((item: Dict) => item['@id'])
              footnotes = isDict(footnotes) ? ids.map((id: string) => get(fn(), id, '')).join('; ') : footnotes
              newRow.footnote = footnotes
            } else {
              const footnoteId = value.footnoteId['@id']
              newRow.footnote = truthy(footnotes) ? (typeof footnotes === 'string' ? footnotes : get(fn(), footnoteId, null)) : null
            }
          }
          for (const [k, v] of Object.entries(value)) {
            if (k === 'value') newRow[key] = v
            if (isDict(v)) {
              if ('footnoteId' in v) {
                if (Array.isArray(v.footnoteId)) {
                  const ids = v.footnoteId.map((item: Dict) => item['@id'])
                  footnotes = typeof footnotes === 'string' ? footnotes : truthy(footnotes) ? ids.map((id: string) => get(fn(), id, '')).join('; ') : null
                  newRow.footnote = footnotes
                } else {
                  const footnoteId = v.footnoteId['@id']
                  newRow.footnote = truthy(footnotes) ? (typeof footnotes === 'string' ? footnotes : get(fn(), footnoteId, null)) : null
                }
              }
              for (const [k1, v1] of Object.entries(v)) if (k1 === 'value') newRow[k] = v1
            }
          }
        }
      }
      if (Object.keys(newRow).length) results.push(newRow)
    }
  }

  const dt = data.derivativeTable
  if ((truthy(dt) && truthy(dt.derivativeTransaction)) || truthy(data.derivativeSecurity)) {
    let tables: Any = truthy(data.derivativeSecurity) ? data.derivativeSecurity : dt.derivativeTransaction
    if (isDict(tables)) tables = [tables]
    for (const table of tables as Any[]) {
      if (typeof table === 'string') continue
      const newRow: Dict = { ...metadata }
      for (const [key, value] of Object.entries(table as Dict)) {
        if (key === 'transactionCoding') {
          newRow.transaction_type = getFrom(value, 'transactionCode')
          newRow.form = getFrom(value, 'transactionFormType') || metadata.form
        } else if (isDict(value)) {
          for (const [k, v] of Object.entries(value)) {
            if (k === 'value') newRow[key] = v
            if (isDict(v)) for (const [k1, v1] of Object.entries(v)) if (k1 === 'value') newRow[k] = v1
          }
        }
      }
      const tValue = newRow.transactionValue
      delete newRow.transactionValue
      if (truthy(tValue)) newRow.transactionTotalValue = tValue
      results.push(newRow)
    }
  }
  return results
}

// ---------------------------------------------------------------------------------------------------------------
// The data model's validators (pydantic, lax mode)
// ---------------------------------------------------------------------------------------------------------------

function coerceFloat(v: Any, field: string): number | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'number') return v
  if (typeof v === 'string' && /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/.test(v)) return Number(v)
  throw new Error(`Input should be a valid number for ${field}: ${JSON.stringify(v)}`)
}

function coerceBool(v: Any, field: string): boolean | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'boolean') return v
  const s = typeof v === 'string' ? v.trim().toLowerCase() : v
  if (['1', 'true', 't', 'y', 'yes', 'on', 1].includes(s)) return true
  if (['0', 'false', 'f', 'n', 'no', 'off', 0].includes(s)) return false
  throw new Error(`Input should be a valid boolean for ${field}: ${JSON.stringify(v)}`)
}

function coerceStr(v: Any, field: string): string | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'string') return v
  throw new Error(`Input should be a valid string for ${field}: ${JSON.stringify(v)}`)
}

/** pydantic's `date` from text: "YYYY-MM-DD", with an optional midnight time. */
function coerceDate(v: Any, field: string): string | null {
  if (v === null || v === undefined) return null
  const m = typeof v === 'string' ? /^(\d{4}-\d{2}-\d{2})(?:[T ]00:00:00(?:\.0+)?)?$/.exec(v.trim()) : null
  if (!m) throw new Error(`Input should be a valid date for ${field}: ${JSON.stringify(v)}`)
  return m[1]!
}

/** `date_validate`: `parser.isoparse(str(v))`, a date at midnight and otherwise a datetime. */
function isoDateOrDatetime(v: Any): string | null {
  if (!truthy(v)) return null
  const s = String(v)
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?)(Z|[+-]\d{2}:?\d{2})?)?$/.exec(s)
  if (!m) throw new Error(`ISO string too short or malformed: ${s}`)
  if (!m[2] || /^00:00(:00(\.0+)?)?$/.test(m[2])) return m[1]!
  return `${m[1]}T${m[2].length === 5 ? `${m[2]}:00` : m[2]}${m[3] ?? ''}`
}

function validateRow(raw: Dict): Row {
  const row: Row = {}
  for (const [key, v] of Object.entries(raw)) {
    if (v === null || v === undefined) continue
    switch (key) {
      case 'symbol':
        row[key] = truthy(v) ? String(v).toUpperCase() : null
        break
      case 'company_cik':
        row[key] = typeof v === 'number' ? String(v) : coerceStr(v, key)
        break
      case 'filing_date':
      case 'transaction_date':
        row[key] = isoDateOrDatetime(v)
        break
      case 'exercise_date':
      case 'expiration_date':
      case 'deemed_execution_date':
        row[key] = coerceDate(v, key)
        break
      case 'director':
      case 'officer':
      case 'ten_percent_owner':
      case 'other':
        row[key] = coerceBool(v, key)
        break
      case 'securities_owned':
      case 'securities_transacted':
      case 'transaction_price':
      case 'underlying_security_shares':
      case 'underlying_security_value':
      case 'conversion_exercise_price':
      case 'transaction_value':
      case 'value_owned':
        row[key] = coerceFloat(v, key)
        break
      case 'ownership_type': {
        const s = coerceStr(v, key)
        row[key] = !s ? null : s.trim() === 'D' ? 'Direct' : s.trim() === 'I' ? 'Indirect' : s
        break
      }
      case 'acquisition_or_disposition': {
        const s = coerceStr(v, key)
        row[key] = !s ? null : s.trim() === 'A' ? 'Acquisition' : s.trim() === 'D' ? 'Disposition' : s
        break
      }
      case 'transaction_type': {
        const s = coerceStr(v, key)
        row[key] = s ? (TRANSACTION_CODE_MAP[s] ?? s) : null
        break
      }
      case 'transaction_timeliness': {
        const s = coerceStr(v, key)
        row[key] = s ? (TIMELINESS_MAP[s] ?? s) : null
        break
      }
      case 'form':
      case 'owner_cik':
        row[key] = typeof v === 'string' || typeof v === 'number' ? v : (coerceStr(v, key) as string)
        break
      default:
        row[key] = typeof v === 'string' ? v : isDict(v) || Array.isArray(v) ? (coerceStr(v, key) as string) : v
    }
  }
  return row
}

// ---------------------------------------------------------------------------------------------------------------
// get_form_4_urls, download_data, get_form_4
// ---------------------------------------------------------------------------------------------------------------

/** `get_form_4_urls`: the raw XML URLs of a company's Form 4 filings between the dates. */
async function getForm4Urls(ctx: NativeCtx, symbol: string, startDate: string | null, endDate: string | null, useCache: boolean): Promise<string[]> {
  const form4 = await fetchCompanyFilings(ctx, { symbol, form_type: '4', limit: 0, use_cache: useCache })
  const urls: string[] = []
  for (const item of form4) {
    const filingDate = item.filing_date as string | null
    const reportDate = item.report_date as string | null
    if (!startDate || !filingDate || filingDate < startDate) continue
    if (!endDate || !reportDate || reportDate > endDate) continue
    const toReplace = `${String(item.primary_doc).split('/')[0]}/`
    const formUrl = String(item.report_url).replaceAll(toReplace, '')
    if (formUrl.endsWith('.xml')) urls.push(formUrl)
  }
  return urls
}

/** `download_data`: the parsed rows of each filing, eight downloads at a time, newest filing first. */
async function downloadData(ctx: NativeCtx, urls: string[], useCache: boolean): Promise<Dict[]> {
  const getOne = (url: string) =>
    ctx.cache(`sec:form4 ${url}`, useCache ? 24 * 3600 * 1000 : 0, async (): Promise<Dict[]> => {
      const data = await getForm4Data(ctx, url)
      const result = parseForm4Data(data)
      if (!result.length) return []
      // A DataFrame holds the union of the rows' columns (a missing one is None) and renames them.
      return result.map((r) => Object.fromEntries([...Object.entries({ ...r, filing_url: url }).map(([k, v]) => [FIELD_MAP[k] ?? k, v])]))
    })
  const results: Dict[] = []
  for (let i = 0; i < urls.length; i += 8) {
    const chunk = urls.slice(i, i + 8)
    for (const rows of await Promise.all(chunk.map(getOne))) results.push(...rows)
    await pause(ctx, 1125)
  }
  const kept = results.filter((e) => truthy(e.filing_date)).map((r, i) => ({ r, i }))
  // `sorted(reverse=True)` keeps equal dates in their original order.
  return kept.sort((a, b) => (a.r.filing_date < b.r.filing_date ? 1 : a.r.filing_date > b.r.filing_date ? -1 : a.i - b.i)).map(({ r }) => r)
}

export async function insiderTrading(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const symbols = Array.isArray(params.symbol) ? params.symbol.map(String) : String(params.symbol ?? '').split(',')
  const symbol = symbols.map((s) => s.toUpperCase()).join(',')
  const limit = params.limit === undefined || params.limit === null ? null : Number(params.limit)
  const useCache = params.use_cache === undefined ? true : Boolean(params.use_cache)
  let startDate = typeof params.start_date === 'string' && params.start_date ? params.start_date : null
  let endDate = typeof params.end_date === 'string' && params.end_date ? params.end_date : null
  if (!startDate && !endDate) {
    const now = ctx.now()
    const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    startDate = iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 120))
    endDate = iso(now)
  }
  let urls = await getForm4Urls(ctx, symbol, startDate, endDate, useCache)
  if (limit !== null) urls = urls.slice(0, limit)
  const data = await downloadData(ctx, urls, useCache)
  if (!data.length) throw new Error(`No Form 4 data was returned for ${symbol}.`)
  return data.map(validateRow)
}
