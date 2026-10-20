// imf/portwatch/{country_activity,monthly_trade,container_metrics,disruption_events,disruptions_map,disruption_sankey},
// provider imf. Ported from openbb_imf/models/{country_activity,monthly_trade,container_metrics,disruption_events,
// disruption_sankey}.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows through the model tables in models.ts.
import { flag, text } from '../lib/params.js'
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { CONTAINER_METRICS, COUNTRY_ACTIVITY, DISRUPTION_EVENTS, DISRUPTION_SANKEY, MONTHLY_TRADE, validateModel } from './models.js'
import { containerMetrics, countryDailyActivity, disruptionEvents, disruptionSankeyEdges, monthlyTrade } from './portwatch-helpers.js'

export async function countryActivity(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const rows = await countryDailyActivity(ctx, text(params, 'country_code') ?? 'USA', text(params, 'start_date'), text(params, 'end_date'))
  return rows.map((r) => validateModel(COUNTRY_ACTIVITY, r))
}

export async function monthlyTradeNow(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const rows = await monthlyTrade(ctx, text(params, 'code') ?? 'USA', text(params, 'start_date'), text(params, 'end_date'))
  return rows.map((r) => validateModel(MONTHLY_TRADE, r))
}

export async function containerMetricsByPort(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const portIds = text(params, 'port_ids') ?? 'TOP10'
  const tokens = portIds.replace(/\+/g, ',').split(',').map((p) => p.trim().toUpperCase()).filter(Boolean)
  const useTop10 = tokens.length === 0 || tokens.includes('TOP10')
  const all = await containerMetrics(ctx, text(params, 'metric') ?? 'portcalls', text(params, 'start_date'), text(params, 'end_date'))
  if (!useTop10) {
    const keep = new Set(tokens)
    return all.filter((r) => keep.has(r.portid as string)).map((r) => validateModel(CONTAINER_METRICS, r))
  }
  // The ten ports with the most volume over the window.
  const totals = new Map<string, number>()
  for (const r of all) {
    const pid = r.portid as string | undefined
    if (!pid) continue
    totals.set(pid, (totals.get(pid) ?? 0) + (Number(r.value) || 0))
  }
  const top10 = new Set([...totals].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([pid]) => pid))
  return all.filter((r) => top10.has(r.portid as string)).map((r) => validateModel(CONTAINER_METRICS, r))
}

export async function disruptionEventsList(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const alertlevel = text(params, 'alertlevel') ?? 'ALL'
  const rows = await disruptionEvents(ctx, {
    iso3: text(params, 'country'),
    eventtype: text(params, 'eventtype'),
    alertlevel: ['', 'ALL'].includes(alertlevel.toUpperCase()) ? undefined : alertlevel,
    activeOnly: flag(params, 'active_only', false),
    startDate: text(params, 'start_date'),
    endDate: text(params, 'end_date'),
  })
  return rows.map((r) => validateModel(DISRUPTION_EVENTS, r))
}

export async function disruptionSankey(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const eventId = text(params, 'event_id') ?? 'LATEST'
  let resolved: number
  if (eventId.toUpperCase() === 'LATEST') {
    const events = await disruptionEvents(ctx)
    if (events.length === 0) throw new Error('No disruption events available.')
    resolved = Math.trunc(Number(events[0]!.eventid))
  } else {
    if (!/^\s*[+-]?\d+\s*$/.test(eventId)) throw new Error(`invalid literal for int() with base 10: '${eventId}'`)
    resolved = Number(eventId)
  }
  const rows = await disruptionSankeyEdges(ctx, resolved)
  return rows.map((r) => validateModel(DISRUPTION_SANKEY, r))
}
