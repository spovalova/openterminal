// federal_reserve/atlanta/market_probability, provider federal_reserve. Ported from
// openbb_federal_reserve/models/regional/atlanta_market_probability.py (OpenBB Platform 5.0.0, Apache-2.0); modified: the
// workbook URL (the Atlanta Fed moved it to research-and-data/data/market-probability-tracker; the Python URL answers with a
// 404 page), plain arrays instead of pandas frames.
import type { NativeCtx, NativeParams, Row } from '../../../types.js'
import { numberOrNull, readFrame, toDate } from '../workbook.js'
import { ATLANTA_DOCS, dateParam, downloadWorkbook, emptyData } from './helpers.js'

const URL = `${ATLANTA_DOCS}/research-and-data/data/market-probability-tracker/mpt_histdata.xlsx`
const BIN_PATTERN = /^Prob: (\d+)bps - (\d+)bps$/

export async function marketProbability(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const bytes = await downloadWorkbook(ctx, 'market_probability', URL)
  const start = dateParam(params, 'start_date')
  const end = dateParam(params, 'end_date')
  const frame = readFrame(bytes, 'DATA')
  const col = (name: string): number => {
    const i = frame.columns.indexOf(name)
    if (i < 0) throw new Error(`'${name}'`)
    return i
  }
  const [dateAt, startAt, fieldAt, valueAt] = [col('date'), col('reference_start'), col('field'), col('value')] as [number, number, number, number]

  let rows = frame.rows
    .map((row) => ({ row, date: toDate(row[dateAt]), meeting: toDate(row[startAt]) }))
    .filter((r): r is { row: (typeof frame.rows)[number]; date: string; meeting: string } => r.date !== undefined && r.meeting !== undefined)
  if (start) rows = rows.filter((r) => r.date >= start)
  if (end) rows = rows.filter((r) => r.date <= end)
  if (rows.length === 0) emptyData()

  const latest = rows.reduce((m, r) => (r.date > m ? r.date : m), rows[0]!.date)
  rows = rows.filter((r) => r.date === latest)
  const meetings = [...new Set(rows.filter((r) => BIN_PATTERN.test(String(r.row[fieldAt]))).map((r) => r.meeting))].sort()
  if (meetings.length === 0) emptyData()

  let meeting: string | undefined
  if (typeof params.meeting === 'string' && params.meeting) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(params.meeting)) throw new Error(`Invalid isoformat string: '${params.meeting}'`)
    if (meetings.includes(params.meeting)) meeting = params.meeting
  }
  if (meeting === undefined) {
    const today = ctx.now().toISOString().slice(0, 10)
    meeting = meetings.find((m) => m >= today) ?? meetings[0]!
  }

  const bins = new Map<string, Row>()
  const order = new Map<string, number>()
  for (const { row, meeting: m } of rows) {
    if (m !== meeting) continue
    const match = BIN_PATTERN.exec(String(row[fieldAt]))
    if (!match) continue
    const low = Number(match[1])
    const high = Number(match[2])
    const label = `${(low / 100).toFixed(2)}–${(high / 100).toFixed(2)}%`
    order.set(label, low)
    bins.set(label, { target_range: label, probability: numberOrNull(row[valueAt]) })
  }
  return [...bins.keys()].sort((a, b) => order.get(a)! - order.get(b)!).map((label) => bins.get(label)!)
}
