// finra/fixedincome/bond_historical, provider finra. Ported from openbb_finra/models/bond_historical.py (OpenBB
// Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models, and "today" is the UTC date.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { openTraceSession } from './client.js'
import { HISTORY_DATASETS, HISTORY_DAYS } from './constants.js'
import { joinParam, normalizeTraceRecord, splitSymbols, traceFields } from './helpers.js'
import { resolveBonds } from './trace.js'

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

const text = (v: unknown) => String(v ?? '')

export async function bondHistorical(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const cusip = joinParam(params.cusip).toUpperCase()
  const endDate = params.end_date ? String(params.end_date) : ctx.now().toISOString().slice(0, 10)
  const startDate = params.start_date ? String(params.start_date) : addDays(endDate, -HISTORY_DAYS)
  if (startDate > endDate) throw new Error('The start date must not be after the end date.')

  const trace = await openTraceSession(ctx)
  const found = await resolveBonds(trace, splitSymbols(cusip))
  if (found.length === 0) throw new Error(`No TRACE-reported bond matched ${cusip}.`)

  // Treasuries have their own end-of-day dataset; every other product shares one.
  const groups = new Map<string, string[]>()
  for (const record of found) {
    const key = record.bondType === 'TS' ? 'TS' : 'OTHER'
    groups.set(key, [...(groups.get(key) ?? []), String(record.cusip)])
  }
  const pages = await Promise.all(
    [...groups].map(([key, cusips]) =>
      trace.query(HISTORY_DATASETS[key]!.dataset, {
        fields: HISTORY_DATASETS[key]!.fields,
        domainFilters: [{ fieldName: 'cusip', values: cusips }],
        dateRangeFilters: [{ fieldName: 'tradeDate', startDate, endDate }],
        sortFields: ['tradeDate'],
      }),
    ),
  )
  const rows = [...groups.keys()].flatMap((key, i) => pages[i]!.map((row) => normalizeTraceRecord({ ...row, ...(key === 'TS' ? { productType: 'TS' } : {}) })))
  if (rows.length === 0) throw new Error(`No end-of-day price was reported for ${cusip} between ${startDate} and ${endDate}.`)

  return rows
    .sort((a, b) => (text(a.tradeDate) < text(b.tradeDate) ? -1 : text(a.tradeDate) > text(b.tradeDate) ? 1 : text(a.cusip) < text(b.cusip) ? -1 : text(a.cusip) > text(b.cusip) ? 1 : 0))
    .map(traceFields)
}
