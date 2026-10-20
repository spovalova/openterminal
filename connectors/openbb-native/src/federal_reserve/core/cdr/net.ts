// FFIEC Central Data Repository (CDR) access: the report router, ASP.NET postback pages and the bulk downloads.
// Ported from openbb_federal_reserve/utils/{cdr,ubpr_report}.py (OpenBB Platform 5.0.0, Apache-2.0); modified: a
// cookie-keeping session over ctx.http instead of a curl_cffi session (the CDR answers plain requests), ctx.cache
// instead of the on-disk cache.
import type { RequestOptions } from '../../../http.js'
import type { NativeCtx } from '../../../types.js'
import { DAY_MS, request } from '../helpers.js'

export const CDR_URL = 'https://cdr.ffiec.gov/public/PWS/DownloadBulkData.aspx'
const ROUTER = 'https://cdr.ffiec.gov/Public/router/Search'
const ROUTER_HEADERS = { 'Content-Type': 'application/json;charset=UTF-8', Accept: '*/*', Referer: 'https://cdr.ffiec.gov/Public/Reports/UbprReport.html' }
const PREFIX = 'ctl00$MainContentHolder$'

export const PRODUCTS: Record<string, string> = {
  call_single: 'ReportingSeriesSinglePeriod',
  call_four: 'ReportingSeriesSubsetSchedulesFourPeriods',
  ubpr_ratio_single: 'PerformanceReportingSeriesSinglePeriod',
  ubpr_ratio_four: 'PerformanceReportingSeriesFourPeriods',
  ubpr_rank: 'PerformanceReportingSeriesRank',
  ubpr_stats: 'PerformanceReportingSeriesStats',
}

/** Requests that keep their cookies, as a `requests.Session` does. */
export class CdrSession {
  private readonly jar = new Map<string, string>()
  constructor(private readonly ctx: NativeCtx) {}

  async response(url: string, opts: RequestOptions = {}): Promise<Response> {
    const cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ')
    const res = await this.ctx.http.response(url, request({ ...opts, headers: { ...(cookie ? { Cookie: cookie } : {}), ...opts.headers } }))
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';')
      const i = pair!.indexOf('=')
      if (i > 0) this.jar.set(pair!.slice(0, i), pair!.slice(i + 1))
    }
    return res
  }

  async text(url: string, opts: RequestOptions = {}): Promise<string> {
    return (await this.response(url, opts)).text()
  }

  /** A router request on this session, so that the server-side state it sets (a custom peer group) stays with it. */
  async router(requestorId: string, criteria: Record<string, unknown>): Promise<unknown> {
    const res = await this.response(ROUTER, { method: 'POST', body: JSON.stringify({ RequestorID: requestorId, Criteria: criteria }), headers: ROUTER_HEADERS, timeoutMs: 90_000 })
    return res.json()
  }

  async bytes(url: string, opts: RequestOptions = {}): Promise<Uint8Array> {
    return new Uint8Array(await (await this.response(url, opts)).arrayBuffer())
  }
}

/** POST a router request and return the parsed JSON body. */
export async function post(ctx: NativeCtx, requestorId: string, criteria: Record<string, unknown>): Promise<unknown> {
  return ctx.http.json(ROUTER, request({ method: 'POST', body: JSON.stringify({ RequestorID: requestorId, Criteria: criteria }), headers: ROUTER_HEADERS, timeoutMs: 90_000 }))
}

export type Row_ = Record<string, unknown>
const asRows = (v: unknown): Row_[] => (Array.isArray(v) ? (v.filter((x) => x && typeof x === 'object' && !Array.isArray(x)) as Row_[]) : [])

export type Cycle = { reportingcycleid: string; enddateformatted: string }

/** `report_cycles`: the reporting cycles, newest first. */
export function reportCycles(ctx: NativeCtx): Promise<Cycle[]> {
  return ctx.cache('fed:cdr:cycles', DAY_MS, async () => {
    const rows = asRows(await post(ctx, 'PeriodsEndDateList', {})).filter((r) => r.reportingcycleid) as unknown as Cycle[]
    const time = (r: Cycle) => {
      const [m, d, y] = r.enddateformatted.split('/')
      return Date.UTC(Number(y), Number(m) - 1, Number(d))
    }
    return rows.sort((a, b) => time(b) - time(a))
  })
}

export type Section = { pageid: string; pagetitle: string; [key: string]: unknown }

/** `report_sections`: the section (page) list of a report type. */
export function reportSections(ctx: NativeCtx, reportTypeId = 283): Promise<Section[]> {
  return ctx.cache(`fed:cdr:sections:${reportTypeId}`, DAY_MS, async () => asRows(await post(ctx, 'UbprReportPagesList', { ReportTypeID: reportTypeId })).filter((r) => r.pageid) as Section[])
}

/** `_section_id`: a section title (or page id) as its (page id, title). */
export async function sectionId(ctx: NativeCtx, section: string | undefined, reportTypeId = 283): Promise<[string, string]> {
  const sections = await reportSections(ctx, reportTypeId)
  if (sections.length === 0) throw new Error('The report section list could not be retrieved.')
  const target = (section ?? '').trim().toLowerCase()
  for (const row of sections) if (!target || row.pageid === target || row.pagetitle.toLowerCase() === target) return [row.pageid, row.pagetitle]
  throw new Error(`Unknown report section '${section}'.`)
}

// ---------------------------------------------------------------------------------------------------------------
// The bulk-data page (ASP.NET postbacks)

function field(html: string, name: string): string {
  return new RegExp(`id="${name}"[^>]*value="([^"]*)"`).exec(html)?.[1] ?? ''
}

export const viewState = (html: string): Record<string, string> => ({ __VIEWSTATE: field(html, '__VIEWSTATE'), __VIEWSTATEGENERATOR: field(html, '__VIEWSTATEGENERATOR') })

async function selectProduct(session: CdrSession, value: string, radio = 'TSVRadioButton'): Promise<{ state: Record<string, string>; periods: [string, string][] }> {
  const html = await session.text(CDR_URL, { timeoutMs: 60_000 })
  const select = { ...viewState(html), __EVENTTARGET: `${PREFIX}ListBox1`, __EVENTARGUMENT: '', [`${PREFIX}ListBox1`]: value, [`${PREFIX}FormatType`]: radio, AjaxScriptManager_HiddenField: '' }
  const refreshed = await session.text(CDR_URL, { method: 'POST', form: select, timeoutMs: 120_000 })
  const block = /DatesDropDownList[^>]*>(.*?)<\/select>/s.exec(refreshed)
  const periods = block ? [...block[1]!.matchAll(/<option[^>]*value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map((m) => [m[1]!, m[2]!.trim()] as [string, string]) : []
  return { state: viewState(refreshed), periods }
}

/** `fetch_bulk`: a product's bulk ZIP for a reporting period (`MM/DD/YYYY`), the latest by default. */
export function fetchBulk(ctx: NativeCtx, product: string, period?: string, fmt: 'xbrl' | 'tsv' = 'xbrl'): Promise<Uint8Array> {
  return ctx.cache(`fed:cdr:bulk:${product}:${period ?? 'latest'}:${fmt}`, DAY_MS, async () => {
    const session = new CdrSession(ctx)
    const radio = fmt === 'xbrl' ? 'XBRLRadiobutton' : 'TSVRadioButton'
    const value = PRODUCTS[product]!
    const { state, periods } = await selectProduct(session, value, radio)
    if (periods.length === 0) return new Uint8Array(0)
    const dateId = (periods.find(([, text]) => text === period) ?? periods[0]!)[0]
    const download = { ...state, __EVENTTARGET: '', __EVENTARGUMENT: '', [`${PREFIX}ListBox1`]: value, [`${PREFIX}DatesDropDownList`]: dateId, [`${PREFIX}FormatType`]: radio, [`${PREFIX}TabStrip1$Download_0`]: 'Download', AjaxScriptManager_HiddenField: '' }
    return session.bytes(CDR_URL, { method: 'POST', form: download, timeoutMs: 400_000 })
  })
}

/** `fetch_taxonomy`: a product's XBRL taxonomy ZIP (for Call Reports, one form type's). */
export function fetchTaxonomy(ctx: NativeCtx, product: string, formType?: string): Promise<Uint8Array> {
  return ctx.cache(`fed:cdr:taxonomy:${product}:${formType ?? ''}`, DAY_MS, async () => {
    const session = new CdrSession(ctx)
    const value = PRODUCTS[product]!
    const html = await session.text(CDR_URL, { timeoutMs: 60_000 })
    const select = { ...viewState(html), __EVENTTARGET: `${PREFIX}ListBox1`, __EVENTARGUMENT: '', [`${PREFIX}ListBox1`]: value, [`${PREFIX}FormatType`]: 'XBRLRadiobutton', AjaxScriptManager_HiddenField: '' }
    const refreshed = await session.text(CDR_URL, { method: 'POST', form: select, timeoutMs: 120_000 })
    const block = /DatesDropDownList[^>]*>(.*?)<\/select>/s.exec(refreshed)
    const periods = block ? [...block[1]!.matchAll(/<option[^>]*value="([^"]*)"/g)].map((m) => m[1]!) : []
    const download = { ...viewState(refreshed), __EVENTTARGET: '', __EVENTARGUMENT: '', [`${PREFIX}ListBox1`]: value, [`${PREFIX}DatesDropDownList`]: periods[0] ?? '', [`${PREFIX}FormatType`]: 'XBRLRadiobutton', [`${PREFIX}TabStrip1$Download_Taxonomy_1`]: 'Download Taxonomy', AjaxScriptManager_HiddenField: '' }
    const response = await session.response(CDR_URL, { method: 'POST', form: download, timeoutMs: 300_000 })
    if (formType === undefined) return new Uint8Array(await response.arrayBuffer())
    const panel = await response.text()
    const pick = { ...viewState(panel), __EVENTTARGET: `${PREFIX}FormTypeControl1$LinkButton${formType}`, __EVENTARGUMENT: '', AjaxScriptManager_HiddenField: '' }
    return session.bytes(CDR_URL, { method: 'POST', form: pick, timeoutMs: 300_000 })
  })
}

/** `list_periods`: the periods a bulk product offers, as (date id, date text). */
export function listPeriods(ctx: NativeCtx, product: string): Promise<{ date_id: string; date: string }[]> {
  return ctx.cache(`fed:cdr:periods:${product}`, DAY_MS, async () => {
    const { periods } = await selectProduct(new CdrSession(ctx), PRODUCTS[product]!)
    return periods.map(([date_id, date]) => ({ date_id, date }))
  })
}
