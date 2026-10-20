// sec/risk_factors, legal_proceedings, exhibit, disclosures, company_overview, segment_revenue and financial_statements,
// provider sec. Ported from openbb_sec/models/sec_risk_factors.py, sec_legal_proceedings.py, sec_exhibit.py,
// sec_disclosures.py, sec_company_overview.py, sec_segment_revenue.py and sec_as_filed_statements.py (OpenBB Platform
// 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models.
import type { NativeCtx, NativeHandler, NativeParams, Row } from '../../types.js'
import { financialStatementsFor, noFilingMessage, resolveSectionUrl, sectionQuery } from './financial-statements.js'
import { pyStrip } from './pandas-lite.js'
import { downloadStatement } from './statement.js'

/** `EmptyDataError` */
export class EmptyDataError extends Error {}

async function loadFiling(ctx: NativeCtx, params: NativeParams, annualDefault: boolean) {
  const query = sectionQuery(params)
  const url = await resolveSectionUrl(ctx, query, annualDefault)
  if (!url) throw new EmptyDataError(noFilingMessage(query.symbol ?? ''))
  return { query, statements: await financialStatementsFor(ctx, url, query.use_cache) }
}

export async function riskFactors(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const { query, statements } = await loadFiling(ctx, params, true)
  const factors = await statements.riskFactors()
  if (factors.length === 0) throw new EmptyDataError(`No Risk Factors section found for ${query.symbol}.`)
  return factors
}

export async function legalProceedings(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const { query, statements } = await loadFiling(ctx, params, true)
  const item = await statements.legalProceedings()
  if (!item || !pyStrip(item.text || '')) throw new EmptyDataError(`No Legal Proceedings section found for ${query.symbol}.`)
  return [{ name: item.name || 'Legal Proceedings', item_num: item.item_num ?? null, text: item.text }]
}

export async function exhibit(params: NativeParams, ctx: NativeCtx): Promise<Row> {
  const { query, statements } = await loadFiling(ctx, params, false)
  const choices = await statements.exhibitChoices()
  if (choices.length === 0) throw new EmptyDataError(`No exhibits are attached to the filing for ${query.symbol}.`)
  const requested = params.exhibit === '' || params.exhibit === undefined ? undefined : String(params.exhibit)
  const identifier = requested || choices[0]!.value
  const content = await statements.getExhibit(identifier)
  if (!content) throw new EmptyDataError(`Exhibit ${identifier} was not found in the filing for ${query.symbol}.`)
  return { content }
}

export async function disclosures(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const { query, statements } = await loadFiling(ctx, params, false)
  const all = await statements.disclosures()
  const results: Row[] = []
  for (const key of all.keys()) {
    const info = all.get(key)
    if (!info || typeof info !== 'object' || Array.isArray(info)) continue
    const text = info.text || ''
    if (!text) continue
    results.push({ key, name: info.name || info.long_name || key, text, tables: info.tables ?? null })
  }
  if (results.length === 0) throw new EmptyDataError(`No disclosures found in the filing for ${query.symbol}.`)
  return results
}

export async function companyOverview(params: NativeParams, ctx: NativeCtx): Promise<Row> {
  const query = sectionQuery(params)
  const noPeriod = { ...query }
  delete noPeriod.calendar_period
  let url = await resolveSectionUrl(ctx, noPeriod)
  if (!url && query.calendar_year !== undefined) {
    const noYear = { ...noPeriod }
    delete noYear.calendar_year
    url = await resolveSectionUrl(ctx, noYear)
  }
  if (!url) throw new EmptyDataError(noFilingMessage(query.symbol ?? ''))
  const statements = await financialStatementsFor(ctx, url, query.use_cache)
  const content = await statements.business()
  if (!content) throw new EmptyDataError(`No Business section found for ${query.symbol}.`)
  return { content }
}

export async function segmentRevenue(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const { query, statements } = await loadFiling(ctx, params, false)
  const results = await statements.segmentRevenue()
  if (results.length === 0) throw new EmptyDataError(`No segment or geographic revenue data found for ${query.symbol}.`)
  return results
}

export async function financialStatements(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const { query, statements } = await loadFiling(ctx, params, false)
  const statementType = typeof params.statement_type === 'string' && params.statement_type ? params.statement_type : 'income'
  const data = await downloadStatement(statements, statementType)
  if (data.length === 0) throw new EmptyDataError(`No ${statementType} statement found for ${query.symbol}.`)
  return data
}

/** The OpenBB API answers an EmptyDataError with HTTP 204 and no body, which is no rows. */
export function noRowsWhenEmpty(handler: (params: NativeParams, ctx: NativeCtx) => Promise<Row | Row[]>): NativeHandler {
  return async (params, ctx) => {
    try {
      return await handler(params, ctx)
    } catch (e) {
      if (e instanceof EmptyDataError) return []
      throw e
    }
  }
}
