// Overnight index fixing histories from their administrators: one fetcher per publisher and `getFixings`, which picks
// the fetcher of an index and returns its fixings over a window as decimals by effective date. Ported from
// openbb_cftc/utils/fixings.py (OpenBB Platform 5.0.0, Apache-2.0); modified: requests go through ctx.http, the
// on-disk day store is replaced by ctx.cache around the full-history download, xlrd and openpyxl are replaced by
// lib/xls.ts and lib/xlsx.ts (which give date cells as ISO strings), and the regular expressions that scrape HTML are the same ones Python uses.
import { parseCsv } from '../../lib/csv.js'
import { readXls } from '../../lib/xls.js'
import { excelSerialToIso, readXlsx, type Cell, type Sheet } from '../../lib/xlsx.js'
import { openZip } from '../../lib/zip-entries.js'
import { NativeHttpError, type RequestOptions } from '../../http.js'
import { NativeUnsupported, type NativeCtx } from '../../types.js'
import { addDays, diffDays, parseIso } from './dates.js'
import { FIXING_SOURCES } from './fixings-data.js'

export const NYFED_API_URL = 'https://markets.newyorkfed.org/api/rates'
export const BOE_IADB_URL = 'https://www.bankofengland.co.uk/boeapps/database/_iadb-FromShowColumns.asp'
export const BOC_VALET_URL = 'https://www.bankofcanada.ca/valet/observations/group/CORRA/json'
export const ECB_ESTR_URL = 'https://data-api.ecb.europa.eu/service/data/EST/B.EU000A2X2A25.WT'
export const BOJ_CGI_URL = 'https://www.stat-search.boj.or.jp/ssi/cgi-bin/famecgi2'
export const BANXICO_SERIES_URL = 'https://www.banxico.org.mx/SieInternet/consultarDirectorioInternetAction.do?accion=consultarSeries'
export const BCB_SGS_URL = 'https://api.bcb.gov.br/dados/serie/bcdata.sgs'
export const SNB_DATA_PORTAL_URL = 'https://data.snb.ch/api/cube/zirepo/data/json/en'
export const MAS_DIR_URL = 'https://eservices.mas.gov.sg/statistics/dir/domesticinterestrates.aspx'
export const FBIL_URL = 'https://www.fbil.org.in/wasdm/ovnmibor/fetchgraphdata'
export const BANREP_URL = 'https://suameca.banrep.gov.co/estadisticas-economicas-back/rest/estadisticaEconomicaRestService/consultaInformacionSerie'
export const SARB_RATEREFORM_URL = 'https://www.resbank.co.za/bin/sarb/ratereform'
export const SARB_TIMESERIES_URL = 'https://custom.resbank.co.za/SarbWebApi/WebIndicators/Shared/GetTimeseriesObservations'
export const BCCH_TIB_URL = 'https://si3.bcentral.cl/estadisticas/Inmediato1/SerieTIB.xls'
export const THAIBMA_THOR_URL = 'https://www.thaibma.or.th/api/thor/download-all'
export const BOI_SDMX_URL = 'https://edge.boi.gov.il/FusionEdgeServer/sdmx/v2/data/dataflow/BOI.STATISTICS/BR/1.0/'
export const RBNZ_B2_URL = 'https://www.rbnz.govt.nz/-/media/project/sites/rbnz/files/statistics/series/b/b2/hb2-daily-close.xlsx'
export const BBK_DOWNLOAD_URL = 'https://api.statistiken.bundesbank.de/rest/download'
export const CNB_PRIBOR_URL = 'https://www.cnb.cz/en/financial-markets/money-market/pribor/fixing-of-interest-rates-on-interbank-deposits-pribor/year.txt'
export const CNB_MAX_YEARS = 10
export const BNM_MARKETS_URL = 'https://financialmarkets.bnm.gov.my'
export const RBA_F01D_URL = 'https://www.rba.gov.au/statistics/tables/xls/f01d.xlsx'
export const HKMA_LIQUIDITY_URL = 'https://api.hkma.gov.hk/public/market-data-and-statistics/daily-monetary-statistics/daily-figures-interbank-liquidity'
export const HKMA_PAGE_SIZE = 100
export const BOK_ECOS_URL = 'https://ecos.bok.or.kr/serviceEndpoint/httpService/request.json'
export const BOK_ECOS_TRX = 'OSUUA02R01'
export const BOK_ECOS_ITEM_GROUP = 'G11950'
export const BOK_ECOS_PAGE = 100000
export const GPW_DELAYED_URL = 'https://gpwbenchmark.pl/delayed_data'
export const GPW_MAX_ATTEMPTS = 10
export const GPW_RETRY_SECONDS = 3.0
export const FINWIRE_SERIES_URL = 'https://public-api.finwire.pl/v1/series/interest-rate'
export const FINWIRE_MAX_DAYS = 36500
export const CFETS_FRR_URL = 'https://www.chinamoney.com.cn/r/cms/www/chinamoney/data/currency/frr-chrt.csv'
export const CFETS_SHIBOR_URL = 'https://www.chinamoney.com.cn/ags/ms/cm-u-bk-shibor/ShiborChrt'
export const TAIBOR_BASE_URL = 'https://www.ba.org.tw/taiborDaily'
export const TAIBOR_MAX_ARCHIVES = 40
export const MNB_BUBOR_URL = 'https://www.mnb.hu/letoltes/bubor2.xls'
export const MNB_DATA_ROW = 2
export const FULL_HISTORY_START = '2000-01-01'

/** `openbb_cftc.utils.search.SEARCH_USER_AGENT`. */
export const SEARCH_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const CHROME_126_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

/** How long a downloaded history is reused: fixings are published once a day. */
const HISTORY_TTL_MS = 4 * 3600 * 1000

/** Python's OpenBBError: the upstream answered with something that is not the series. */
class OpenBBError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OpenBBError'
  }
}
/** Python's ValueError, which the fetchers catch where Python does. */
class ValueError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ValueError'
  }
}

const unexpected = (url: string): OpenBBError => new OpenBBError(`Unexpected fixings response from ${url}.`)

// ---- Python's builtins, as the fetchers use them ------------------------------------------------------------------

const FLOAT_RE = /^[+-]?(?:(?:\d+(?:_\d+)*)?\.\d+(?:_\d+)*|\d+(?:_\d+)*\.?)(?:[eE][+-]?\d+(?:_\d+)*)?$/
const SPECIAL_FLOAT_RE = /^([+-]?)(inf|infinity|nan)$/i

/** `float(text)` for a string, or null where Python raises ValueError. */
function tryFloat(text: string): number | null {
  const t = text.trim()
  if (FLOAT_RE.test(t)) return Number(t.replace(/_/g, ''))
  const special = SPECIAL_FLOAT_RE.exec(t)
  if (special) return special[2]!.toLowerCase() === 'nan' ? NaN : special[1] === '-' ? -Infinity : Infinity
  return null
}

/** `float(text)`: a ValueError for a string that is not a number. */
function pyFloat(text: string): number {
  const n = tryFloat(text)
  if (n === null) throw new ValueError(`could not convert string to float: '${text}'`)
  return n
}

/** `float(value)` of a JSON value: numbers and numeric strings (and booleans), a TypeError for anything else. */
function jsonFloat(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'string') return pyFloat(value)
  if (typeof value === 'boolean') return value ? 1 : 0
  throw new TypeError(`float() argument must be a string or a real number, not '${value === null ? 'NoneType' : typeof value}'`)
}

/** Python truthiness of a parsed JSON value. */
function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0
  if (value !== null && typeof value === 'object') return Object.keys(value).length > 0
  return Boolean(value)
}

type Dict = Record<string, unknown>
const isDict = (value: unknown): value is Dict => value !== null && typeof value === 'object' && !Array.isArray(value)
/** `value` as a dict whose `.get` the fetcher calls: an AttributeError for anything else. */
function dict(value: unknown): Dict {
  if (!isDict(value)) throw new TypeError(`'${value === null ? 'NoneType' : Array.isArray(value) ? 'list' : typeof value}' object has no attribute 'get'`)
  return value
}
/** `(value or default).get(key)` for a parsed JSON value. */
const getOr = (value: unknown, key: string): unknown => (truthy(value) ? dict(value)[key] : undefined)
/** `(row.get(key) or "").strip()`. */
function strField(row: Dict, key: string): string {
  const value = row[key]
  if (!truthy(value)) return ''
  if (typeof value !== 'string') throw new TypeError(`'${typeof value}' object has no attribute 'strip'`)
  return value.trim()
}
/** `for item in value` over a parsed JSON array. */
function items(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`'${typeof value}' object is not iterable`)
  return value
}
const isNull = (value: unknown): boolean => value === null || value === undefined

/** `text.splitlines()`. */
function splitLines(text: string): string[] {
  // eslint-disable-next-line no-control-regex
  const lines = text.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/)
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MONTHS = MONTH_ABBR.map((m) => m.toLowerCase())
const STRPTIME_FIELDS: Record<string, string> = {
  d: '(?<d>3[0-1]|[1-2]\\d|0[1-9]|[1-9]| [1-9])',
  m: '(?<m>1[0-2]|0[1-9]|[1-9])',
  Y: '(?<Y>\\d\\d\\d\\d)',
  y: '(?<y>\\d\\d)',
  b: `(?<b>${MONTHS.join('|')})`,
}
const pad2 = (n: number): string => String(n).padStart(2, '0')

/** `datetime.strptime(text, format).date().isoformat()` for the %d %m %y %Y %b formats the fixings use. */
function strptime(text: string, format: string): string {
  let pattern = ''
  for (let i = 0; i < format.length; i++) {
    const ch = format[i]!
    if (ch === '%') {
      const field = STRPTIME_FIELDS[format[++i] ?? '']
      if (!field) throw new Error(`unsupported strptime directive %${format[i] ?? ''}`)
      pattern += field
    } else pattern += /\s/.test(ch) ? '\\s+' : ch.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')
  }
  const m = new RegExp(`^${pattern}$`, 'i').exec(text)
  if (!m) throw new ValueError(`time data '${text}' does not match format '${format}'`)
  const g = m.groups!
  let year = 1900
  if (g.Y) year = Number(g.Y)
  else if (g.y) year = Number(g.y) <= 68 ? 2000 + Number(g.y) : 1900 + Number(g.y)
  const month = g.b ? MONTHS.indexOf(g.b.toLowerCase()) + 1 : g.m ? Number(g.m) : 1
  const day = g.d ? Number(g.d) : 1
  if (day > new Date(Date.UTC(year, month, 0)).getUTCDate()) throw new ValueError('day is out of range for month')
  return `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`
}

/** `datetime.strptime(day, "%Y-%m-%d").strftime(format)` for the two bounds the APIs take. */
function formatBound(day: string, style: 'boe' | 'bcb'): string {
  const iso = strptime(day, '%Y-%m-%d')
  const [y, m, d] = [iso.slice(0, 4), Number(iso.slice(5, 7)), iso.slice(8, 10)]
  if (style === 'bcb') return `${d}/${pad2(m)}/${y}`
  return `${d}/${MONTH_ABBR[m - 1]}/${y}`
}

/** Rows of a CSV as csv.DictReader gives them: the first row names the columns, absent fields are undefined. */
function dictRows(text: string): Record<string, string | undefined>[] {
  const [header, ...rows] = parseCsv(text)
  if (!header) return []
  return rows.map((row) => {
    const out: Record<string, string | undefined> = {}
    header.forEach((name, i) => {
      out[name] = row[i]
    })
    return out
  })
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
type Fixings = Record<string, number>

/** The cells of a table row scraped as GPW and BNM are: tags removed, `&nbsp;` as a space, trimmed. */
function htmlTableRows(page: string): string[][] {
  const rows: string[][] = []
  for (const row of page.matchAll(/<tr[^>]*>(.*?)<\/tr>/gis)) {
    rows.push([...row[1]!.matchAll(/<td[^>]*>(.*?)<\/td>/gis)].map((cell) => cell[1]!.replace(/<[^>]+>/g, '').replaceAll('&nbsp;', ' ').trim()))
  }
  return rows
}

// ---- Fetchers: one per publisher, each over [start, end] --------------------------------------------------------------

/** A New York Fed reference rate series over a window. */
async function fetchNyfed(ctx: NativeCtx, path: string, start: string, end: string): Promise<Fixings> {
  const url = `${NYFED_API_URL}/${path}/search.json?type=rate&startDate=${start}&endDate=${end}`
  const response = await ctx.http.json<unknown>(url)
  const rows = truthy(response) && isDict(response) ? response.refRates : undefined
  if (isNull(rows)) throw unexpected(url)
  const out: Fixings = {}
  for (const item of items(rows)) {
    const row = dict(item)
    if (!isNull(row.percentRate)) out[strField(row, 'effectiveDate')] = jsonFloat(row.percentRate) / 100.0
  }
  return out
}

/** CORRA from the Bank of Canada Valet API. */
async function fetchCorra(ctx: NativeCtx, start: string, end: string): Promise<Fixings> {
  const url = `${BOC_VALET_URL}?start_date=${start}&end_date=${end}`
  const response = await ctx.http.json<unknown>(url)
  const rows = truthy(response) && isDict(response) ? response.observations : undefined
  if (isNull(rows)) throw unexpected(url)
  const out: Fixings = {}
  for (const item of items(rows)) {
    const row = dict(item)
    const day = strField(row, 'd')
    const value = getOr(row['AVG.INTWO'], 'v')
    if (day && !isNull(value)) out[day] = jsonFloat(value) / 100.0
  }
  return out
}

/** The euro short-term rate from the ECB data API, served as CSV. */
async function fetchEstr(ctx: NativeCtx, start: string, end: string): Promise<Fixings> {
  const url = `${ECB_ESTR_URL}?format=csvdata&startPeriod=${start}&endPeriod=${end}`
  const payload = await ctx.http.text(url)
  if (!payload.includes('TIME_PERIOD')) throw unexpected(url)
  const out: Fixings = {}
  for (const row of dictRows(payload)) {
    const day = (row.TIME_PERIOD ?? '').trim()
    const value = (row.OBS_VALUE ?? '').trim()
    if (day && value) out[day] = pyFloat(value) / 100.0
  }
  return out
}

/** A Bank of England IADB series, served as CSV. */
async function fetchBoe(ctx: NativeCtx, series: string, start: string, end: string): Promise<Fixings> {
  const url = `${BOE_IADB_URL}?csv.x=yes&Datefrom=${formatBound(start, 'boe')}&Dateto=${formatBound(end, 'boe')}&SeriesCodes=${series}&CSVF=TN&UsingCodes=Y&VPD=Y&VFD=N`
  const payload = await ctx.http.text(url, { headers: { 'User-Agent': SEARCH_USER_AGENT } })
  if (!payload.includes('DATE,')) throw unexpected(url)
  const out: Fixings = {}
  for (const line of splitLines(payload).slice(1)) {
    const parts = line.split(',')
    if (parts.length === 2 && parts[1]!.trim()) out[strptime(parts[0]!.trim(), '%d %b %Y')] = pyFloat(parts[1]!) / 100.0
  }
  return out
}

/** A Bank of Japan series through the stat-search CGI's two-step POST then GET CSV flow. */
async function fetchBoj(ctx: NativeCtx, series: string, start: string, end: string): Promise<Fixings> {
  const yearFrom = String(Number(strptime(start, '%Y-%m-%d').slice(0, 4)))
  const yearTo = String(Number(strptime(end, '%Y-%m-%d').slice(0, 4)))
  const headers = { 'User-Agent': SEARCH_USER_AGENT }
  const jar = new CookieJar()

  const resultPage = await jar.text(ctx, BOJ_CGI_URL, {
    method: 'POST',
    headers,
    form: {
      cgi: '$nme_r000_en',
      obj_name: series.split("'")[0]!,
      txtYyyyFrom: yearFrom,
      txtYyyyTo: yearTo,
      cmbFREQ: 'NONE',
      cmbFREQ_OPTION: 'NONE',
      lstCode: series,
    },
  })
  if (!resultPage.includes('DLform_DD')) throw new OpenBBError(`Unexpected fixings response from ${BOJ_CGI_URL}.`)

  const downloadPage = await jar.text(ctx, BOJ_CGI_URL, {
    method: 'POST',
    headers,
    form: {
      cgi: '$nme_r030_en',
      chkfrq: 'DD',
      rdoheader: 'SIMPLE',
      rdodelimitar: 'COMMA',
      hdnYyyyFrom: yearFrom,
      hdnYyyyTo: yearTo,
      hdncode: series,
      sw_freq: 'NONE',
      sw_yearend: 'NONE',
      sw_observed: 'NONE',
    },
  })
  const match = /href="(\/ssi\/html\/[^"]+\.csv)"/.exec(downloadPage)
  if (!match) throw new OpenBBError(`Unexpected fixings response from ${BOJ_CGI_URL}.`)
  const payload = await jar.text(ctx, `https://www.stat-search.boj.or.jp${match[1]}`, { headers })

  const out: Fixings = {}
  for (const line of splitLines(payload)) {
    const at = line.indexOf(',')
    if (at < 0) continue
    const day = line.slice(0, at)
    if (!/^\d{4}\/\d{2}\/\d{2}$/.test(day)) continue
    const value = line.slice(at + 1).trim()
    if (value && value !== 'NA') out[strptime(day, '%Y/%m/%d')] = pyFloat(value) / 100.0
  }
  return out
}

/** A Banco de Mexico SIE series export, served as CSV. */
async function fetchBanxico(ctx: NativeCtx, series: string, start: string, end: string): Promise<Fixings> {
  const yearFrom = Number(strptime(start, '%Y-%m-%d').slice(0, 4))
  const yearTo = Number(strptime(end, '%Y-%m-%d').slice(0, 4))
  const payload = await ctx.http.text(BANXICO_SERIES_URL, {
    method: 'POST',
    form: {
      locale: 'en',
      idCuadro: 'CA51',
      sector: '18',
      version: '3',
      series,
      anoInicial: String(yearFrom),
      anoFinal: String(yearTo),
      tipoInformacion: '4,1',
      formatoHorizontal: 'false',
      metadatosWeb: 'false',
      'formatoCSV.x': '1',
      'formatoCSV.y': '1',
    },
  })
  if (!payload.includes(series)) throw unexpected(BANXICO_SERIES_URL)
  const out: Fixings = {}
  for (const line of splitLines(payload)) {
    const parts = line.split(',')
    if (parts.length !== 2 || !/^\d{2}\/\d{2}\/\d{4}$/.test(parts[0]!)) continue
    const value = parts[1]!.trim()
    if (value) out[strptime(parts[0]!, '%m/%d/%Y')] = pyFloat(value) / 100.0
  }
  return out
}

/** A Banco Central do Brasil SGS series, served as JSON. */
async function fetchBcb(ctx: NativeCtx, series: string, start: string, end: string): Promise<Fixings> {
  const url = `${BCB_SGS_URL}.${series}/dados?formato=json&dataInicial=${formatBound(start, 'bcb')}&dataFinal=${formatBound(end, 'bcb')}`
  const response = await ctx.http.json<unknown>(url, { timeoutMs: 120_000 })
  if (!Array.isArray(response)) throw unexpected(url)
  const out: Fixings = {}
  for (const item of response) {
    const row = dict(item)
    const day = strField(row, 'data')
    const value = row.valor
    if (day && !isNull(value)) out[strptime(day, '%d/%m/%Y')] = jsonFloat(value) / 100.0
  }
  return out
}

/** An SNB Data Portal repo-reference-rate series, as JSON. */
async function fetchSnb(ctx: NativeCtx, key: string, start: string, end: string): Promise<Fixings> {
  const url = `${SNB_DATA_PORTAL_URL}?fromDate=${start}&toDate=${end}`
  const response = await ctx.http.json<unknown>(url)
  const series = truthy(response) && isDict(response) ? response.timeseries : undefined
  if (isNull(series)) throw unexpected(url)
  const wanted = items(series).find((s) => {
    const metadata = dict(s).metadata
    const k = isDict(metadata) ? metadata.key : ''
    return String(k ?? '').endsWith(key)
  })
  if (wanted === undefined) throw unexpected(url)
  const out: Fixings = {}
  const values = dict(wanted).values
  for (const item of items(isNull(values) ? [] : values)) {
    const row = dict(item)
    if (!isNull(row.value)) out[String(row.date)] = jsonFloat(row.value) / 100.0
  }
  return out
}

/** SORA from MAS's Domestic Interest Rates page, through its GET then POST ASP.NET postback. */
async function fetchMas(ctx: NativeCtx, column: string, start: string, end: string): Promise<Fixings> {
  const yearFrom = Number(strptime(start, '%Y-%m-%d').slice(0, 4))
  const yearTo = Number(strptime(end, '%Y-%m-%d').slice(0, 4))
  const headers = { 'User-Agent': SEARCH_USER_AGENT }
  const jar = new CookieJar()
  const page = await jar.text(ctx, MAS_DIR_URL, { headers })
  const tokens: Record<string, string> = {}
  for (const name of ['__VIEWSTATE', '__VIEWSTATEGENERATOR', '__EVENTVALIDATION']) {
    const match = new RegExp(`id="${name}" value="([^"]*)"`).exec(page)
    if (!match) throw new OpenBBError(`Unexpected fixings response from ${MAS_DIR_URL}.`)
    tokens[name] = match[1]!
  }
  const resultPage = await jar.text(ctx, MAS_DIR_URL, {
    method: 'POST',
    headers,
    form: {
      ...tokens,
      ctl00$ContentPlaceHolder1$StartYearDropDownList: String(yearFrom),
      ctl00$ContentPlaceHolder1$EndYearDropDownList: String(yearTo),
      ctl00$ContentPlaceHolder1$StartMonthDropDownList: '1',
      ctl00$ContentPlaceHolder1$EndMonthDropDownList: '12',
      [`ctl00$ContentPlaceHolder1$ColumnsCheckBoxList$${column}`]: 'on',
      ctl00$ContentPlaceHolder1$Button1: 'Display',
    },
  })
  if (!resultPage.includes('SORA VALUE')) throw new OpenBBError(`Unexpected fixings response from ${MAS_DIR_URL}.`)

  const cell = (raw: string): string => {
    const stripped = raw.trim()
    return stripped === '&nbsp;' ? '' : stripped
  }
  const out: Fixings = {}
  let year = ''
  let month = ''
  for (const row of resultPage.matchAll(/<tr>(.*?)<\/tr>/gs)) {
    const cells = [...row[1]!.matchAll(/<td[^>]*>(.*?)<\/td>/gs)].map((c) => c[1]!)
    if (cells.length !== 5) continue
    const [yearCell, monthCell, dayCell, , valueCell] = cells.map(cell) as [string, string, string, string, string]
    year = yearCell || year
    month = monthCell || month
    if (!(year && month && dayCell && valueCell)) continue
    out[strptime(`${year}-${month}-${dayCell}`, '%Y-%b-%d')] = pyFloat(valueCell) / 100.0
  }
  return out
}

/** Overnight MIBOR from FBIL's chart-data endpoint. */
async function fetchFbil(ctx: NativeCtx, window: string, start: string, end: string): Promise<Fixings> {
  const url = `${FBIL_URL}/${window}`
  const response = await ctx.http.json<unknown>(url)
  const trend = truthy(response) && isDict(response) ? response.benchMarkTrend : undefined
  if (isNull(trend)) throw unexpected(url)
  const out: Fixings = {}
  for (const item of items(trend)) {
    const row = dict(item)
    const day = row.publishDate
    if (truthy(day) && typeof day === 'string' && start <= day && day <= end) out[day] = jsonFloat(row.rate) / 100.0
  }
  return out
}

/** Banco de la Republica's IBR series. */
async function fetchBanrep(ctx: NativeCtx, series: string, start: string, end: string): Promise<Fixings> {
  const url = `${BANREP_URL}?idSerie=${series}`
  const response = await ctx.http.json<unknown>(url)
  if (!Array.isArray(response) || response.length === 0 || !isDict(response[0])) throw unexpected(url)
  const points = response[0].data
  if (isNull(points)) throw unexpected(url)
  const out: Fixings = {}
  for (const point of items(points)) {
    const [millis, value] = items(point) as [number, unknown]
    const day = new Date(millis).toISOString().slice(0, 10)
    if (start <= day && day <= end) out[day] = jsonFloat(value) / 100.0
  }
  return out
}

/** ZARONIA from SARB's rate-reform API. */
async function fetchSarb(ctx: NativeCtx, rateType: string, start: string, end: string): Promise<Fixings> {
  const url = `${SARB_RATEREFORM_URL}?start_date=${start}&end_date=${end}&rate_type=${rateType}`
  const payload = await ctx.http.text(url)
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    parsed = null
  }
  const rows = truthy(parsed) && isDict(parsed) ? parsed.rates : undefined
  if (isNull(rows)) throw unexpected(url)
  const out: Fixings = {}
  for (const item of items(rows)) {
    const row = dict(item)
    if (truthy(row.date) && !isNull(row.rate)) out[String(row.date).slice(0, 10)] = jsonFloat(row.rate) / 100.0
  }
  return out
}

/** The day of a date cell, which lib/xls.ts and lib/xlsx.ts give as "YYYY-MM-DD" (with a time when it has one). */
function dateCell(cell: Cell | undefined): string | null {
  return typeof cell === 'string' && /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2})?$/.test(cell) ? cell.slice(0, 10) : null
}

/** `float(cell_value)` of a worksheet cell, or null where Python raises ValueError (a blank, or text that is no number). */
function cellFloat(cell: Cell | undefined): number | null {
  if (typeof cell === 'number') return cell
  if (typeof cell === 'string') return tryFloat(cell)
  if (typeof cell === 'boolean') return cell ? 1 : 0
  return null
}

/** Banco Central de Chile's TIB series. */
async function fetchBcch(ctx: NativeCtx, sheetName: string, start: string, end: string): Promise<Fixings> {
  const content = await ctx.http.bytes(BCCH_TIB_URL)
  let sheet: Sheet
  try {
    const found = readXls(content).find((s) => s.name === sheetName)
    if (!found) throw new Error(`No sheet named <'${sheetName}'>`)
    sheet = found
  } catch {
    throw new OpenBBError(`Unexpected fixings response from ${BCCH_TIB_URL}.`)
  }
  const out: Fixings = {}
  for (const row of sheet.rows) {
    const day = dateCell(row[0])
    if (day === null || !(start <= day && day <= end)) continue
    const rate = cellFloat(row[2])
    if (rate === null) continue
    out[day] = rate / 100.0
  }
  return out
}

/** THOR from ThaiBMA's full-history CSV export. */
async function fetchThaibma(ctx: NativeCtx, tenor: string, start: string, end: string): Promise<Fixings> {
  const payload = await ctx.http.text(THAIBMA_THOR_URL)
  if (!payload.includes('As of')) throw unexpected(THAIBMA_THOR_URL)
  const out: Fixings = {}
  for (const row of dictRows(payload)) {
    const day = (row['As of'] ?? '').trim()
    const code = (row.Code ?? '').trim()
    const rowTenor = (row.Tenor ?? '').trim()
    const value = (row.Rate ?? '').trim()
    if (code === 'THOR' && rowTenor === tenor && day && value && start <= day && day <= end) out[day] = pyFloat(value) / 100.0
  }
  return out
}

/** SHIR from the Bank of Israel's SDMX v2 API (the brackets of `c[SERIES_CODE]` must be percent-encoded, as yarl sends them). */
async function fetchBoi(ctx: NativeCtx, series: string, start: string, end: string): Promise<Fixings> {
  const url = `${BOI_SDMX_URL}?c%5BSERIES_CODE%5D=${series}&startPeriod=${start}&endPeriod=${end}&format=sdmx-json&dimensionAtObservation=AllDimensions&locale=en`
  const response = await ctx.http.json<unknown>(url)
  if (!isDict(response)) throw unexpected(url)
  let observations: Dict
  let periods: unknown[]
  try {
    const data = dict(response.data)
    observations = dict(dict(items(data.dataSets)[0]).observations)
    const dimensions = items(dict(dict(data.structure).dimensions).observation)
    const period = dimensions.find((d) => dict(d).id === 'TIME_PERIOD')
    if (period === undefined) throw new TypeError('no TIME_PERIOD dimension')
    periods = items(dict(period).values)
  } catch {
    throw unexpected(url)
  }
  const out: Fixings = {}
  for (const [key, value] of Object.entries(observations)) {
    const index = Number.parseInt(key.slice(key.lastIndexOf(':') + 1), 10)
    const rate = truthy(value) ? (value as unknown[])[0] : null
    if (!isNull(rate)) out[String((periods[index] as Dict).id)] = jsonFloat(rate) / 100.0
  }
  return out
}

/** Dated TAIBOR rows out of one archive sheet. */
function taiborRows(text: string, index: number, start: string, end: string): Fixings {
  const out: Fixings = {}
  for (const line of splitLines(text)) {
    const cells = line.split(',')
    if (cells.length <= index || !/^\d{2}[A-Z]{3}\d{2}$/.test(cells[0]!.trim())) continue
    let day: string
    let rate: number
    try {
      day = strptime(cells[0]!.trim(), '%d%b%y')
      rate = pyFloat(cells[index]!.trim())
    } catch (error) {
      if (error instanceof ValueError) continue
      throw error
    }
    if (start <= day && day <= end) out[day] = rate / 100.0
  }
  return out
}

/** `bytes.decode(encoding)` with errors raised, or null where Python raises UnicodeDecodeError. */
function decodeStrict(raw: Uint8Array, labels: string[]): string | null {
  for (const label of labels) {
    try {
      return new TextDecoder(label, { fatal: true }).decode(raw)
    } catch {
      // The next encoding.
    }
  }
  return null
}

/** TAIBOR from the Bankers Association's monthly archive downloads. */
async function fetchTaibor(ctx: NativeCtx, column: string, start: string, end: string): Promise<Fixings> {
  const index = Number(column)
  const headers = { 'User-Agent': CHROME_126_UA }
  const listing = await ctx.http.text(`${TAIBOR_BASE_URL}/index`, { headers })
  const wanted: string[] = []
  for (const row of listing.matchAll(/<tr[^>]*>(.*?)<\/tr>/gis)) {
    const stamp = /(\d{4})\/(\d{2})\/(\d{2})/.exec(row[1]!)
    const link = /DownloadAll\?id=(\d+)/.exec(row[1]!)
    if (!stamp || !link) continue
    const posted = `${stamp[1]}-${stamp[2]}-${stamp[3]}`
    if (posted >= start && wanted.length < TAIBOR_MAX_ARCHIVES) wanted.push(link[1]!)
  }

  const out: Fixings = {}
  for (const archive of wanted) {
    const response = await ctx.http.response(`${TAIBOR_BASE_URL}/DownloadAll?id=${archive}`, { headers })
    if (response.status !== 200) continue
    const blob = new Uint8Array(await response.arrayBuffer())
    let bundle: ReturnType<typeof openZip>
    try {
      bundle = openZip(blob)
    } catch {
      continue
    }
    for (const entry of bundle.entries) {
      if (!entry.name.toLowerCase().endsWith('.csv')) continue
      // Python tries big5, cp950 and utf-8-sig in turn; WHATWG's big5 covers cp950's extensions.
      const text = decodeStrict(bundle.read(entry), ['big5', 'utf-8'])
      if (text !== null) Object.assign(out, taiborRows(text, index, start, end))
    }
  }
  if (Object.keys(out).length === 0) throw new OpenBBError(`Unexpected fixings response from ${TAIBOR_BASE_URL}.`)
  return out
}

/** A fixing repo rate column from the CFETS chart series. */
async function fetchCfets(ctx: NativeCtx, column: string, start: string, end: string): Promise<Fixings> {
  const index = Number(column)
  const payload = await ctx.http.text(CFETS_FRR_URL, { headers: { 'User-Agent': CHROME_126_UA, Referer: 'https://www.chinamoney.com.cn/english/bmkfrr/' } })
  const out: Fixings = {}
  for (const line of splitLines(payload)) {
    const cells = line.split(',')
    if (cells.length <= index || !DATE_RE.test(cells[0]!)) continue
    const rate = tryFloat(cells[index]!)
    if (rate === null) continue
    if (start <= cells[0]! && cells[0]! <= end) out[cells[0]!] = rate / 100.0
  }
  if (Object.keys(out).length === 0) throw new OpenBBError(`Unexpected fixings response from ${CFETS_FRR_URL}.`)
  return out
}

/** A SHIBOR tenor from the CFETS benchmark chart service. */
async function fetchShibor(ctx: NativeCtx, tenor: string, start: string, end: string): Promise<Fixings> {
  const payload = JSON.parse(await ctx.http.text(CFETS_SHIBOR_URL, { method: 'POST', headers: { 'User-Agent': CHROME_126_UA, Referer: 'https://www.chinamoney.com.cn/english/bmkshb/' } })) as unknown
  const data = dict(payload).data
  const body = truthy(data) ? dict(data) : {}
  const columns = truthy(body.columns) ? items(body.columns) : []
  const out: Fixings = {}
  const index = columns.indexOf(tenor)
  if (index >= 0) {
    const csv = truthy(body.csv) ? String(body.csv) : ''
    for (const line of splitLines(csv)) {
      const cells = line.split(',')
      if (cells.length <= index || !DATE_RE.test(cells[0]!)) continue
      const rate = tryFloat(cells[index]!)
      if (rate === null) continue
      if (start <= cells[0]! && cells[0]! <= end) out[cells[0]!] = rate / 100.0
    }
  }
  if (Object.keys(out).length === 0) throw new OpenBBError(`Unexpected fixings response from ${CFETS_SHIBOR_URL}.`)
  return out
}

/** A Polish benchmark series from the finwire public data API. */
async function fetchFinwire(ctx: NativeCtx, indicator: string, start: string, end: string): Promise<Fixings> {
  const span = diffDays(end, start) + 1
  const days = Math.min(Math.max(span, 1), FINWIRE_MAX_DAYS)
  const url = `${FINWIRE_SERIES_URL}/${indicator}?days=${days}`
  const payload = JSON.parse(await ctx.http.text(url)) as unknown
  const data = getOr(payload, 'data')
  const points = truthy(data) ? dict(data).points : undefined
  const out: Fixings = {}
  for (const item of truthy(points) ? items(points) : []) {
    const point = dict(item)
    const day = strField(point, 'date')
    const value = point.value
    if (day.length === 10 && !isNull(value) && start <= day && day <= end) out[day] = jsonFloat(value) / 100.0
  }
  if (Object.keys(out).length === 0) throw unexpected(url)
  return out
}

/** A POLSTR column from the GPW Benchmark delayed data table. */
async function fetchGpw(ctx: NativeCtx, column: string, start: string, end: string): Promise<Fixings> {
  const index = Number(column)
  const headers = { 'User-Agent': CHROME_126_UA }
  let payload = ''
  for (let attempt = 0; attempt < GPW_MAX_ATTEMPTS; attempt++) {
    try {
      payload = await ctx.http.text(GPW_DELAYED_URL, { headers })
      break
    } catch (error) {
      if (attempt === GPW_MAX_ATTEMPTS - 1 || ctx.signal?.aborted) throw error
      await ctx.sleep(GPW_RETRY_SECONDS * 1000)
    }
  }
  const out: Fixings = {}
  for (const cells of htmlTableRows(payload)) {
    if (cells.length <= index || !DATE_RE.test(cells[0]!)) continue
    const rate = tryFloat(cells[index]!.replaceAll(',', ''))
    if (rate === null) continue
    if (start <= cells[0]! && cells[0]! <= end) out[cells[0]!] = rate / 100.0
  }
  if (Object.keys(out).length === 0) throw new OpenBBError(`Unexpected fixings response from ${GPW_DELAYED_URL}.`)
  return out
}

/** A BUBOR tenor from the MNB workbook's per-year fixing sheets. */
async function fetchMnb(ctx: NativeCtx, column: string, start: string, end: string): Promise<Fixings> {
  const index = Number(column)
  const content = await ctx.http.bytes(MNB_BUBOR_URL)
  const out: Fixings = {}
  for (const sheet of readXls(content)) {
    const name = sheet.name
    if (!/^\d+$/.test(name) || !(start.slice(0, 4) <= name && name <= end.slice(0, 4))) continue
    // xlrd's `sheet.ncols`: the width of the widest row.
    const ncols = Math.max(0, ...sheet.rows.map((r) => r.length))
    for (let r = MNB_DATA_ROW; r < sheet.rows.length; r++) {
      const row = sheet.rows[r]!
      const stamp = row[0]
      const value = index < ncols ? row[index] : null
      // `isinstance(stamp, float)`: a number, or a date-formatted cell (an ISO string here).
      let day = dateCell(stamp)
      if (day === null) {
        if (typeof stamp !== 'number' || stamp <= 0) continue
        day = excelSerialToIso(stamp).slice(0, 10)
      }
      const rate = cellFloat(value)
      if (rate === null) continue
      if (start <= day && day <= end) out[day] = rate / 100.0
    }
  }
  if (Object.keys(out).length === 0) throw new OpenBBError(`Unexpected fixings response from ${MNB_BUBOR_URL}.`)
  return out
}

/** A Bank of Korea ECOS daily series by statistic table and item code. */
async function fetchBok(ctx: NativeCtx, series: string, start: string, end: string): Promise<Fixings> {
  const slash = series.indexOf('/')
  const table = slash < 0 ? series : series.slice(0, slash)
  const item = slash < 0 ? '' : series.slice(slash + 1)
  const request = {
    header: {
      guidSeq: 1,
      trxCd: BOK_ECOS_TRX,
      scrId: 'IECOSPCM02',
      sysCd: '03',
      fstChnCd: 'WEB',
      langDvsnCd: 'EN',
      envDvsnCd: 'D',
      sndRspnDvsnCd: 'S',
      sndDtm: end.replaceAll('-', ''),
      usrId: 'IECOSPC',
      pageNum: 1,
      pageCnt: BOK_ECOS_PAGE,
    },
    data: {
      statSrchDsList: [{ dsId: table, dsItmId1: 'ACC_ITEM', dsItmGrpId1: BOK_ECOS_ITEM_GROUP, dsItmVal1: item }],
      statSrchFreqList: [{ freq: 'D', vlidStDtm: start.replaceAll('-', ''), vlidEndDtm: end.replaceAll('-', '') }],
      statTyp: 'E',
      statDataCvsnCdList: ['00'],
      viewType: '01',
      holidayYn: 'Y',
    },
  }
  const payload = JSON.parse(
    await ctx.http.text(BOK_ECOS_URL, {
      method: 'POST',
      headers: { 'User-Agent': CHROME_126_UA, 'Content-Type': 'application/json', Referer: 'https://ecos.bok.or.kr/' },
      body: JSON.stringify(request),
    }),
  ) as unknown
  const data = getOr(payload, 'data')
  const content = truthy(data) ? dict(data).jsonCtnt : undefined
  if (!truthy(content)) throw new OpenBBError('Unexpected fixings response from ECOS.')
  const out: Fixings = {}
  for (const item of items(JSON.parse(content as string))) {
    for (const [key, value] of Object.entries(dict(item))) {
      if (!/^\d{8}$/.test(key) || value === null || value === undefined || value === '') continue
      let rate: number
      if (typeof value === 'number') rate = value
      else if (typeof value === 'string') {
        const parsed = tryFloat(value)
        if (parsed === null) continue
        rate = parsed
      } else if (typeof value === 'boolean') rate = value ? 1 : 0
      else continue
      out[`${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6)}`] = rate / 100.0
    }
  }
  if (Object.keys(out).length === 0) throw new OpenBBError('Unexpected fixings response from ECOS.')
  return out
}

/** A SARB web-indicator timeseries by its code. */
async function fetchSarbSeries(ctx: NativeCtx, series: string, start: string, end: string): Promise<Fixings> {
  const url = `${SARB_TIMESERIES_URL}/${series}`
  const rows = JSON.parse(await ctx.http.text(url)) as unknown
  if (!Array.isArray(rows)) throw unexpected(url)
  const out: Fixings = {}
  for (const item of rows) {
    const row = dict(item)
    const day = truthy(row.Period) ? String(row.Period).slice(0, 10) : ''
    const value = row.Value
    if (day && !isNull(value) && start <= day && day <= end) out[day] = jsonFloat(value) / 100.0
  }
  if (Object.keys(out).length === 0) throw unexpected(url)
  return out
}

/** A HIBOR fixing from the HKMA daily interbank liquidity series, one page after another. */
async function fetchHkma(ctx: NativeCtx, field: string, start: string, end: string): Promise<Fixings> {
  const out: Fixings = {}
  for (let offset = 0; ; offset += HKMA_PAGE_SIZE) {
    const url = `${HKMA_LIQUIDITY_URL}?from=${start}&to=${end}&pagesize=${HKMA_PAGE_SIZE}&offset=${offset}`
    const payload = JSON.parse(await ctx.http.text(url)) as unknown
    const result = getOr(payload, 'result')
    const found = truthy(result) ? dict(result).records : undefined
    const records = truthy(found) ? items(found) : []
    for (const item of records) {
      const record = dict(item)
      const day = strField(record, 'end_of_date')
      const value = record[field]
      if (day && !isNull(value) && start <= day && day <= end) out[day] = jsonFloat(value) / 100.0
    }
    if (records.length < HKMA_PAGE_SIZE) break
  }
  if (Object.keys(out).length === 0) throw new OpenBBError(`Unexpected fixings response from ${HKMA_LIQUIDITY_URL}.`)
  return out
}

/** A rate column from a Bank Negara financial markets table. */
async function fetchBnm(ctx: NativeCtx, table: string, start: string, end: string): Promise<Fixings> {
  const bar = table.indexOf('|')
  const page = bar < 0 ? table : table.slice(0, bar)
  const index = Number(bar < 0 ? '' : table.slice(bar + 1))
  const url = `${BNM_MARKETS_URL}/${page}`
  const payload = await ctx.http.text(url)
  const out: Fixings = {}
  for (const cells of htmlTableRows(payload)) {
    if (cells.length <= index || !/^\d{2}\/\d{2}\/\d{4}$/.test(cells[0]!)) continue
    const [day, month, year] = cells[0]!.split('/')
    const stamp = `${year}-${month}-${day}`
    const rate = tryFloat(cells[index]!.replaceAll(',', ''))
    if (rate === null) continue
    if (start <= stamp && stamp <= end) out[stamp] = rate / 100.0
  }
  if (Object.keys(out).length === 0) throw unexpected(url)
  return out
}

/** A PRIBOR tenor from the CNB's yearly interbank fixing tables. */
async function fetchCnb(ctx: NativeCtx, column: string, start: string, end: string): Promise<Fixings> {
  const index = Number(column)
  const lastYear = Number(end.slice(0, 4))
  const firstYear = Math.max(Number(start.slice(0, 4)), lastYear - CNB_MAX_YEARS)
  const out: Fixings = {}
  for (let year = firstYear; year <= lastYear; year++) {
    const response = await ctx.http.response(`${CNB_PRIBOR_URL}?year=${year}`)
    if (response.status !== 200) continue
    const payload = await response.text()
    for (const line of splitLines(payload)) {
      const parts = line.split('|')
      if (parts.length <= index) continue
      let day: string
      let rate: number
      try {
        day = strptime(parts[0]!.trim(), '%d %b %Y')
        rate = pyFloat(parts[index]!.trim())
      } catch (error) {
        if (error instanceof ValueError) continue
        throw error
      }
      if (start <= day && day <= end) out[day] = rate / 100.0
    }
  }
  if (Object.keys(out).length === 0) throw unexpected(CNB_PRIBOR_URL)
  return out
}

/** A Bundesbank daily money-market series from its CSV download. */
async function fetchBbk(ctx: NativeCtx, series: string, start: string, end: string): Promise<Fixings> {
  const url = `${BBK_DOWNLOAD_URL}/${series}?format=csv&lang=en`
  const text = await ctx.http.text(url)
  if (!text.includes(',')) throw unexpected(url)
  const out: Fixings = {}
  for (const row of parseCsv(text)) {
    if (row.length < 2 || !DATE_RE.test(row[0]!.trim())) continue
    const value = row[1]!.trim()
    if (!value) continue
    const rate = tryFloat(value)
    if (rate === null) continue
    const day = row[0]!.trim()
    if (start <= day && day <= end) out[day] = rate / 100.0
  }
  if (Object.keys(out).length === 0) throw unexpected(url)
  return out
}

/** The ISO date of an xlsx date cell (readXlsx gives date-formatted cells as ISO strings), or null for anything else. */
function xlsxDay(cell: unknown): string | null {
  return typeof cell === 'string' && /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2})?$/.test(cell) ? cell.slice(0, 10) : null
}

/** `float(cell)` of an xlsx cell value. */
function xlsxFloat(cell: string | number | boolean): number {
  return typeof cell === 'number' ? cell : jsonFloat(cell)
}

/** A column of the first sheet named "Data" whose header row holds `series`, as openpyxl would find it. */
function dataColumn(content: Uint8Array, url: string, headerRow: number, series: string): { rows: Cell[][]; column: number } {
  try {
    const sheet = readXlsx(content).find((s) => s.name === 'Data')
    if (!sheet) throw new Error('Worksheet Data does not exist.')
    const header = sheet.rows[headerRow - 1] ?? []
    const width = Math.max(0, ...sheet.rows.map((r) => r.length))
    for (let col = 0; col < width; col++) if (header[col] === series) return { rows: sheet.rows, column: col }
    return { rows: sheet.rows, column: -1 }
  } catch {
    throw unexpected(url)
  }
}

/** NZIONA and BKBM from the RBNZ B2 workbook. */
async function fetchRbnz(ctx: NativeCtx, series: string, start: string, end: string): Promise<Fixings> {
  let content: Uint8Array
  try {
    content = await ctx.http.bytes(RBNZ_B2_URL, { headers: { 'User-Agent': SEARCH_USER_AGENT }, timeoutMs: 30_000 })
    if (content.length === 0) throw new Error('empty response')
  } catch (error) {
    throw new OpenBBError(`Unexpected fixings response from ${RBNZ_B2_URL} -> ${error instanceof Error ? error.message : String(error)}`)
  }
  const { rows, column } = dataColumn(content, RBNZ_B2_URL, 5, series)
  if (column < 0) throw unexpected(RBNZ_B2_URL)
  const out: Fixings = {}
  for (let r = 5; r < rows.length; r++) {
    const dayCell = rows[r]![0] ?? null
    const valueCell = rows[r]![column] ?? null
    if (dayCell === null || valueCell === null) continue
    const day = xlsxDay(dayCell)
    if (day === null) throw new TypeError(`'${typeof dayCell}' object has no attribute 'date'`)
    if (start <= day && day <= end) out[day] = xlsxFloat(valueCell) / 100.0
  }
  return out
}

/** AONIA and BBSW from the RBA's own F1 daily workbook. */
async function fetchRba(ctx: NativeCtx, series: string, start: string, end: string): Promise<Fixings> {
  const content = await ctx.http.bytes(RBA_F01D_URL)
  const { rows, column } = dataColumn(content, RBA_F01D_URL, 11, series)
  if (column < 0) throw unexpected(RBA_F01D_URL)
  const out: Fixings = {}
  for (let r = 11; r < rows.length; r++) {
    const day = xlsxDay(rows[r]![0] ?? null)
    const valueCell = rows[r]![column] ?? null
    if (day === null || valueCell === null || valueCell === '') continue
    if (start <= day && day <= end) out[day] = xlsxFloat(valueCell) / 100.0
  }
  return out
}

// ---- Cookies: aiohttp's session keeps them between the requests of one flow -----------------------------------------

/** A throwaway cookie jar: name=value pairs from Set-Cookie headers, sent back to every later request of the flow. */
class CookieJar {
  private cookies = new Map<string, string>()

  async text(ctx: NativeCtx, url: string, options: RequestOptions = {}): Promise<string> {
    const cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ')
    const response = await ctx.http.response(url, { ...options, headers: { ...options.headers, ...(cookie ? { Cookie: cookie } : {}) } })
    for (const line of response.headers.getSetCookie()) {
      const pair = line.split(';')[0]!
      const eq = pair.indexOf('=')
      if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
    }
    const body = await response.text()
    if (!response.ok) throw new NativeHttpError(response.status, url, body.slice(0, 500))
    return body
  }
}

// ---- getFixings -------------------------------------------------------------------------------------------------------

type Fetcher = (ctx: NativeCtx, path: string, start: string, end: string) => Promise<Fixings>

/** The fetcher of each source named in FIXING_SOURCES (`get_fixings`' if/elif chain; ECB is its default). */
export const FIXING_FETCHERS: Record<string, Fetcher> = {
  nyfed: fetchNyfed,
  boc: (ctx, _path, start, end) => fetchCorra(ctx, start, end),
  ecb: (ctx, _path, start, end) => fetchEstr(ctx, start, end),
  boe: fetchBoe,
  boj: fetchBoj,
  banxico: fetchBanxico,
  bcb: fetchBcb,
  snb: fetchSnb,
  mas: fetchMas,
  fbil: fetchFbil,
  banrep: fetchBanrep,
  sarb: fetchSarb,
  bcch: fetchBcch,
  thaibma: fetchThaibma,
  boi: fetchBoi,
  bbk: fetchBbk,
  cnb: fetchCnb,
  bnm: fetchBnm,
  hkma: fetchHkma,
  sarb_series: fetchSarbSeries,
  bok: fetchBok,
  mnb: fetchMnb,
  gpw: fetchGpw,
  finwire: fetchFinwire,
  cfets: fetchCfets,
  shibor: fetchShibor,
  taibor: fetchTaibor,
  rbnz: fetchRbnz,
  rba: fetchRba,
}

/**
 * An index's published fixings over [startDate, endDate], as decimals by effective date (`get_fixings`). The full
 * history from 2000 (ten years back for bcb) is downloaded once per few hours and kept with ctx.cache; the window
 * is cut from it. Days after today, and for bcb days before its ten years, have no fixing here (Python raises a
 * KeyError for them).
 */
export async function getFixings(ctx: NativeCtx, index: string, startDate: string, endDate: string): Promise<Record<string, number>> {
  if (!Object.hasOwn(FIXING_SOURCES, index)) throw new NativeUnsupported(`${index} is not a fixing index with a published source`)
  const [source, path] = FIXING_SOURCES[index]!
  if (parseIso(startDate) !== startDate || parseIso(endDate) !== endDate) throw new Error(`fixings window must be ISO dates: ${startDate}..${endDate}`)
  if (endDate < startDate) return {}

  const today = ctx.now().toISOString().slice(0, 10)
  let fetchStart = startDate < FULL_HISTORY_START ? startDate : FULL_HISTORY_START
  if (source === 'bcb') {
    const tenYearsBack = addDays(today, -3650)
    if (tenYearsBack > fetchStart) fetchStart = tenYearsBack
  }
  const fetcher = FIXING_FETCHERS[source] ?? FIXING_FETCHERS.ecb!

  let history: Fixings
  try {
    history = await ctx.cache(`fixings-${index}${fetchStart < FULL_HISTORY_START ? `-${fetchStart}` : ''}`, HISTORY_TTL_MS, async () => {
      const rates = await fetcher(ctx, path, fetchStart, today)
      // Only dated days of the downloaded range count (the Python store keeps a row per such day).
      const kept: Fixings = {}
      for (const [day, rate] of Object.entries(rates)) if (DATE_RE.test(day) && parseIso(day) === day && fetchStart <= day && day <= today) kept[day] = rate
      return kept
    })
  } catch (error) {
    if (startDate >= today) return {}
    if (error instanceof NativeUnsupported) throw error
    if (error instanceof OpenBBError) throw new Error(error.message, { cause: error })
    throw new Error(`Failed to fetch ${index} fixings -> ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }

  const out: Record<string, number> = {}
  for (const [day, rate] of Object.entries(history)) if (startDate <= day && day <= endDate) out[day] = rate
  return out
}
