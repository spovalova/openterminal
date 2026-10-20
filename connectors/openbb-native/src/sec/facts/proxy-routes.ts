// sec/executive_compensation, sec/beneficial_ownership, sec/management_profiles and sec/pay_versus_performance, provider sec.
// Ported from openbb_sec/models/sec_executive_compensation.py, sec_beneficial_ownership.py, sec_management_profiles.py and
// sec_pay_versus_performance.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models, and
// an EmptyDataError (which the OpenBB API answers with HTTP 204) is no rows.
import type { NativeCtx, NativeHandler, NativeParams, Row } from '../../types.js'
import { SEC_HEADERS, cachedRequest } from '../helpers.js'
import { financialStatementsFor, noFilingMessage, resolveSectionUrl } from '../filing/financial-statements.js'
import { beneficialOwnersTable, managementInformationFromProxy, payVersusPerformance, resolveProxyUrl, summaryCompensationTable } from './proxy.js'
import { pyStrip } from './py.js'

/** `EmptyDataError` */
class EmptyDataError extends Error {}

/** The OpenBB API answers an EmptyDataError with HTTP 204 and no body, which is no rows. */
function noRowsWhenEmpty(handler: (params: NativeParams, ctx: NativeCtx) => Promise<Row | Row[]>): NativeHandler {
  return async (params, ctx) => {
    try {
      return await handler(params, ctx)
    } catch (e) {
      if (e instanceof EmptyDataError) return []
      throw e
    }
  }
}

/** The query every proxy route takes: the symbol upper-cased, an empty calendar year as none. */
function proxyQuery(params: NativeParams): { symbol: string; calendarYear: number | null; useCache: boolean } {
  const year = params.calendar_year
  return {
    symbol: typeof params.symbol === 'string' ? params.symbol.toUpperCase() : '',
    calendarYear: year === undefined || year === null || year === '' ? null : Number(year),
    useCache: params.use_cache === undefined ? true : Boolean(params.use_cache),
  }
}

/** `Filing._adownload_file`: a filing document, HTML decoded as latin-1. */
async function downloadFile(ctx: NativeCtx, url: string, useCache: boolean): Promise<string> {
  const html = await cachedRequest(ctx, url, { kind: 'sec', headers: SEC_HEADERS, useCache })
  return typeof html === 'string' ? html : ''
}

/** The proxy statement HTML for a symbol: the requested year's, else the latest. */
async function proxyHtml(ctx: NativeCtx, q: { symbol: string; calendarYear: number | null; useCache: boolean }): Promise<string> {
  let url = await resolveProxyUrl(ctx, q.symbol, q.calendarYear, q.useCache)
  if (!url && q.calendarYear !== null) url = await resolveProxyUrl(ctx, q.symbol, null, q.useCache)
  if (!url) throw new EmptyDataError(`No proxy statement (DEF 14A) was found for ${q.symbol}.`)
  return downloadFile(ctx, url, q.useCache)
}

async function executiveCompensation(params: NativeParams, ctx: NativeCtx): Promise<Row> {
  const q = proxyQuery(params)
  const content = summaryCompensationTable(await proxyHtml(ctx, q))
  if (!content) throw new EmptyDataError(`No Summary Compensation Table was found in the proxy statement for ${q.symbol}.`)
  return { content }
}

async function beneficialOwnership(params: NativeParams, ctx: NativeCtx): Promise<Row> {
  const q = proxyQuery(params)
  const content = beneficialOwnersTable(await proxyHtml(ctx, q))
  if (!content) throw new EmptyDataError(`No beneficial ownership table was found in the proxy statement for ${q.symbol}.`)
  return { content }
}

async function payVersusPerformanceRows(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const q = proxyQuery(params)
  const rows = payVersusPerformance(await proxyHtml(ctx, q))
  if (rows.length === 0) throw new EmptyDataError(`No Pay Versus Performance disclosure was found in the proxy statement for ${q.symbol}.`)
  // The model leaves a missing value out: a fact that is not a number (null) is no value.
  return rows.map((r) => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== null && v !== undefined && !(typeof v === 'number' && Number.isNaN(v)))))
}

/** `len()` of a Python string: code points, not UTF-16 units. */
const codePoints = (s: string): number => [...s].length

async function managementProfiles(params: NativeParams, ctx: NativeCtx): Promise<Row> {
  const q = proxyQuery(params)
  const section = (calendarYear: number | null) => ({ symbol: q.symbol, ...(calendarYear !== null ? { calendar_year: calendarYear } : {}), use_cache: q.useCache })

  let url = await resolveSectionUrl(ctx, section(q.calendarYear), true)
  if (!url && q.calendarYear !== null) url = await resolveSectionUrl(ctx, section(null), true)
  if (!url) throw new EmptyDataError(noFilingMessage(q.symbol))

  const statements = await financialStatementsFor(ctx, url, q.useCache)
  const docType = (statements.documentType || '').toUpperCase()
  const foreign = docType.startsWith('20-F') || docType.startsWith('40-F')
  let item = null
  if (foreign) item = await statements.getItem('6')
  else if (docType.startsWith('10-K')) item = await statements.getItem('10')
  if (!item) item = await statements.itemByName('senior management')
  if (!item) item = await statements.itemByName('executive officer')
  if (!item) item = await statements.itemByName('director')

  let content: string = (item && item.text) || ''
  if (foreign && content) {
    const start = /^\s*A\.\s*Directors\s+and\s+Senior\s+Management\b/im.exec(content)
    if (start) {
      const sectionText = content.slice(start.index)
      const end = /^\s*B\.\s*Compensation\b/im.exec(sectionText)
      content = pyStrip(end ? sectionText.slice(0, end.index) : sectionText)
    }
  }

  if (/proxy\s+statement/i.test(content)) {
    let proxyUrl = await resolveProxyUrl(ctx, q.symbol, q.calendarYear, q.useCache)
    if (!proxyUrl && q.calendarYear !== null) proxyUrl = await resolveProxyUrl(ctx, q.symbol, null, q.useCache)
    if (proxyUrl) {
      const proxyContent = managementInformationFromProxy(await downloadFile(ctx, proxyUrl, q.useCache))
      if (proxyContent && (content.toLowerCase().includes('incorporated by reference') || codePoints(proxyContent) > codePoints(content))) content = proxyContent
    }
  }

  if (!content) throw new EmptyDataError(`No management section was found in an annual filing for ${q.symbol}.`)
  return { content }
}

export const secExecutiveCompensation = noRowsWhenEmpty(executiveCompensation)
export const secBeneficialOwnership = noRowsWhenEmpty(beneficialOwnership)
export const secPayVersusPerformance = noRowsWhenEmpty(payVersusPerformanceRows)
export const secManagementProfiles = noRowsWhenEmpty(managementProfiles)
