// deribit/reference/{currencies,instruments,expirations,combos,announcements}, provider deribit. Ported from
// openbb_deribit/models/{currencies,instruments,expirations,combos,announcements}.py (OpenBB Platform 5.0.0,
// Apache-2.0); modified: plain rows instead of pydantic models.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { expirationDate, fromTimestamp, gather, isRecord, request, toTimestamp } from './client.js'
import { getCurrencies, getExpirations, getInstruments, normalizeCurrency, PERPETUAL_EXPIRATION, rejectOptionsBySettlement } from './helpers.js'
import { by, items, pyStr, shape } from './model.js'

/** deribit/reference/currencies. */
export async function currencies(_params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const data = await getCurrencies(ctx)
  if (!data || data.length === 0) throw new Error('Deribit listed no currencies.')
  return [...data].sort(by((d) => pyStr(d.currency))).map((r) => shape(r))
}

/** deribit/reference/instruments. */
export async function instruments(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const currency = String(params.currency ?? 'any')
  const kind = params.kind === undefined || params.kind === '' ? undefined : String(params.kind)
  const symbol = items(params.symbol)
  // Options are listed by their underlying, not by a currency that only settles them.
  if (symbol.length === 0) rejectOptionsBySettlement(currency, kind)

  let data: Row[]
  if (symbol.length > 0) {
    const results = await gather(ctx, symbol.map((s) => ['get_instrument', { instrument_name: s.toUpperCase() }]))
    data = results.filter((r): r is Row => isRecord(r) && Object.keys(r).length > 0)
  } else data = await getInstruments(ctx, currency, kind, params.expired === true)
  if (data.length === 0) throw new Error('Deribit lists no instrument matching the query.')

  const timestamp = (v: unknown): unknown => (!v || Number(v) === PERPETUAL_EXPIRATION ? null : fromTimestamp(v))
  return [...data]
    .sort(by((d) => pyStr(d.kind), (d) => Number(d.expiration_timestamp || 0), (d) => pyStr(d.instrument_name)))
    .map((r) => shape(r, { symbol: 'instrument_name' }, { creation_timestamp: timestamp, expiration_timestamp: timestamp }))
}

/** deribit/reference/expirations. */
export async function expirations(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const currency = String(params.currency ?? 'grouped')
  const data = await getExpirations(ctx, currency, String(params.kind ?? 'any'), params.currency_pair === undefined || params.currency_pair === '' ? undefined : String(params.currency_pair))
  if (!data || Object.keys(data).length === 0) throw new Error('Deribit lists no expirations matching the query.')

  const byCurrency: Record<string, Record<string, string[]>> = Object.values(data).every((v) => Array.isArray(v)) ? { [currency]: data } : data
  const records: { currency: string; kind: string; code: string; expiration: string | null }[] = []
  for (const [cur, kinds] of Object.entries(byCurrency)) {
    for (const [kind, codes] of Object.entries(kinds)) {
      for (const code of codes) records.push({ currency: cur.toUpperCase(), kind, code, expiration: code === 'PERPETUAL' ? null : expirationDate(code) })
    }
  }
  if (records.length === 0) throw new Error('Deribit lists no expirations matching the query.')
  return records.sort(by((d) => d.currency, (d) => d.kind, (d) => d.expiration ?? '9999-12-31')).map((r) => shape(r))
}

/** deribit/reference/combos. */
export async function combos(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const ids = items(params.combo_id)
  let data: Row[]
  if (ids.length > 0) {
    const results = await gather(ctx, ids.map((c) => ['get_combo_details', { combo_id: c }]))
    data = results.filter((r): r is Row => isRecord(r) && Object.keys(r).length > 0)
  } else data = await request<Row[]>(ctx, 'get_combos', { currency: normalizeCurrency(String(params.currency ?? 'BTC')) })
  if (!data || data.length === 0) throw new Error('Deribit lists no combo matching the query.')

  const records: Row[] = []
  for (const combo of data) {
    for (const leg of (combo.legs as Row[] | undefined) ?? []) {
      records.push({
        combo_id: combo.id,
        instrument_id: combo.instrument_id,
        state: combo.state,
        leg: leg.instrument_name,
        amount: leg.amount,
        creation_timestamp: combo.creation_timestamp,
        state_timestamp: combo.state_timestamp,
      })
    }
  }
  const timestamp = (v: unknown): unknown => (v ? fromTimestamp(v) : null)
  return records.sort(by((d) => pyStr(d.combo_id), (d) => pyStr(d.leg))).map((r) => shape(r, {}, { creation_timestamp: timestamp, state_timestamp: timestamp }))
}

/** deribit/reference/announcements. */
export async function announcements(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const data = await request<Row[]>(ctx, 'get_announcements', {
    start_timestamp: params.start_date ? toTimestamp(params.start_date) : undefined,
    count: Number(params.limit ?? 50),
  })
  if (!data || data.length === 0) throw new Error('Deribit published no announcements over the span.')
  return [...data]
    .sort((a, b) => Number(b.publication_timestamp || 0) - Number(a.publication_timestamp || 0))
    .map((r) => shape(r, { date: 'publication_timestamp' }, { date: fromTimestamp }))
}
