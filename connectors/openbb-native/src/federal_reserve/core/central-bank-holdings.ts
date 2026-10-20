// economy/central_bank_holdings, provider federal_reserve. Ported from openbb_federal_reserve/models/central_bank_holdings.py
// and the SomaHoldings class of utils/ny_fed_api.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead
// of pydantic models.
import type { NativeCtx, NativeParams, Row } from '../../types.js'
import { dropNil, EmptyDataError, request, snakeCase, str } from './helpers.js'

const BASE_URL = 'https://markets.newyorkfed.org/api'
const AGENCY_HOLDING_TYPES: Record<string, string> = { all: 'all', agency_debts: 'agency%20debts', mbs: 'mbs', cmbs: 'cmbs' }
const TREASURY_HOLDING_TYPES = ['all', 'bills', 'notesbonds', 'frn', 'tips']

/** `__alias_dict__` of the data model: NY Fed key → OpenBB field. */
const ALIASES: Record<string, string> = {
  asOfDate: 'date',
  notesbonds: 'notes_and_bonds',
  securityDescription: 'description',
  currentFaceValue: 'face_value',
  isAggregated: 'is_aggregated',
  securityTypes: 'security_type',
  tipsInflationCompensation: 'tips_inflation_compensation',
  changeFromPriorWeek: 'change_prior_week',
  changeFromPriorYear: 'change_prior_year',
  inflationCompensation: 'tips_inflation_compensation',
}

const STRING_FIELDS = new Set(['security_type', 'description', 'is_aggregated', 'cusip', 'issuer', 'term', 'maturity_date', 'date'])
const FLOAT_FIELDS = new Set(['face_value', 'par_value', 'coupon', 'spread', 'percent_outstanding', 'bills', 'frn', 'notes_and_bonds', 'tips', 'mbs', 'cmbs', 'agencies', 'total', 'tips_inflation_compensation', 'change_prior_week', 'change_prior_year'])

async function fetchSoma(ctx: NativeCtx, url: string): Promise<{ soma?: Record<string, unknown> }> {
  return ctx.http.json(url, request({ timeoutMs: 30_000 }))
}

/** `get_nearest_date`: the as-of date closest to the target (the first one in the list on a tie). */
function nearestDate(dates: string[], target: string): string {
  const t = Date.parse(`${target}T00:00:00Z`)
  let best = dates[0]!
  let bestDiff = Math.abs(Date.parse(`${best}T00:00:00Z`) - t)
  for (const d of dates) {
    const diff = Math.abs(Date.parse(`${d}T00:00:00Z`) - t)
    if (diff < bestDiff) {
      best = d
      bestDiff = diff
    }
  }
  return best
}

async function asOfDates(ctx: NativeCtx): Promise<string[]> {
  const body = await fetchSoma(ctx, `${BASE_URL}/soma/asofdates/list.json`)
  const dates = (body.soma?.asOfDates as string[] | undefined) ?? []
  if (dates.length === 0) throw new Error('Error requesting dates. Please try again later.')
  return dates
}

async function holdingsOf(ctx: NativeCtx, url: string): Promise<Row[]> {
  const holdings = ((await fetchSoma(ctx, url)).soma?.holdings as Row[] | undefined) ?? []
  if (holdings.length === 0) throw new EmptyDataError('No data was returned for the given query.')
  return holdings
}

type Fetch = { asOf?: string; cusip?: string; holdingType?: string; wam?: boolean; monthly?: boolean }

async function agencyHoldings(ctx: NativeCtx, o: Fetch): Promise<Row[]> {
  const dates = await asOfDates(ctx)
  const asOf = o.asOf !== undefined ? nearestDate(dates, o.asOf) : dates[0]!
  if (o.wam) {
    const body = await fetchSoma(ctx, `${BASE_URL}/soma/agency/wam/agency%20debts/asof/${asOf}.json`)
    return [(body.soma ?? {}) as Row]
  }
  let url = `${BASE_URL}/soma/agency/get/asof/${asOf}.json`
  if (o.holdingType !== undefined) {
    if (!(o.holdingType in AGENCY_HOLDING_TYPES)) throw new Error("Invalid choice. Choose from: ['all', 'agency debts', 'mbs', 'cmbs']")
    url = `${BASE_URL}/soma/agency/get/${AGENCY_HOLDING_TYPES[o.holdingType]}/asof/${asOf}.json`
  }
  if (o.cusip !== undefined) url = `${BASE_URL}/soma/agency/get/cusip/${o.cusip}.json`
  return holdingsOf(ctx, url)
}

async function treasuryHoldings(ctx: NativeCtx, o: Fetch): Promise<Row[]> {
  const dates = await asOfDates(ctx)
  const asOf = o.asOf !== undefined ? nearestDate(dates, o.asOf) : dates[0]!
  if (o.wam) {
    const body = await fetchSoma(ctx, `${BASE_URL}/soma/tsy/wam/all/asof/${asOf}.json`)
    return [(body.soma ?? {}) as Row]
  }
  let url = ''
  if (o.holdingType !== undefined) {
    if (!TREASURY_HOLDING_TYPES.includes(o.holdingType)) throw new Error(`Invalid choice. Choose from: ${TREASURY_HOLDING_TYPES.join(', ')}`)
    url = `${BASE_URL}/soma/tsy/get/${o.holdingType}/asof/${asOf}.json`
  }
  if (o.monthly) url = `${BASE_URL}/soma/tsy/get/monthly.json`
  if (o.cusip !== undefined) url = `${BASE_URL}/soma/tsy/get/cusip/${o.cusip}.json`
  return holdingsOf(ctx, url)
}

async function summary(ctx: NativeCtx): Promise<Row[]> {
  const rows = ((await fetchSoma(ctx, `${BASE_URL}/soma/summary.json`)).soma?.summary as Row[] | undefined) ?? []
  if (rows.length === 0) throw new EmptyDataError('There was an error with the request and was returned empty.')
  return rows
}

/** The data model's validators: empty strings cleared, percents as fractions, floats from strings. */
function validate(raw: Row): Row {
  const out: Row = {}
  for (const [key, value] of Object.entries(raw)) {
    // empty_strings (model_validator, before): "''", "" and "0" become None.
    let v: unknown = value === "''" || value === '' || value === '0' ? null : value
    const alias = ALIASES[key]
    const snake = snakeCase(key)
    const name = alias ?? (STRING_FIELDS.has(snake) || FLOAT_FIELDS.has(snake) ? snake : key)
    if (name === 'security_type') {
      if (!v) continue
      v = Array.isArray(v) ? v.join(',') : v
    } else if (name === 'coupon' || name === 'spread') {
      v = v && v !== "''" ? Number(v) / 100 : null
    } else if (FLOAT_FIELDS.has(name) && typeof v === 'string') v = Number(v)
    if (v !== null && v !== undefined) out[name] = v
  }
  return dropNil(out)
}

export async function centralBankHoldings(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const holdingType = str(params, 'holding_type') ?? 'all_treasury'
  const holdType = holdingType.includes('all') ? 'all' : holdingType
  const date = str(params, 'date')
  const cusip = str(params, 'cusip')
  const wam = params.wam === true || params.wam === 'true'
  const monthly = params.monthly === true || params.monthly === 'true'
  const summaryOnly = params.summary === true || params.summary === 'true'
  const securityType = holdingType === 'all_agency' || holdingType in AGENCY_HOLDING_TYPES ? 'agency' : 'treasury'

  let raw: Row[]
  if (cusip !== undefined) {
    raw = securityType === 'agency' ? await agencyHoldings(ctx, { cusip, ...(date ? { asOf: date } : {}) }) : await treasuryHoldings(ctx, { cusip, ...(date ? { asOf: date } : {}) })
  } else if (summaryOnly) raw = await summary(ctx)
  else if (monthly) raw = await treasuryHoldings(ctx, { monthly: true, holdingType: holdType })
  else if (securityType === 'treasury' && wam) raw = await treasuryHoldings(ctx, { wam: true, ...(date ? { asOf: date } : {}) })
  else if (securityType === 'agency' && wam) raw = await agencyHoldings(ctx, { wam: true, ...(date ? { asOf: date } : {}) })
  else raw = securityType === 'agency' ? await agencyHoldings(ctx, { holdingType: holdType, ...(date ? { asOf: date } : {}) }) : await treasuryHoldings(ctx, { holdingType: holdType, ...(date ? { asOf: date } : {}) })
  return raw.map(validate)
}
