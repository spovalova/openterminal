// fixedincome/rate/sofr, fixedincome/rate/effr and fixedincome/rate/overnight_bank_funding, provider federal_reserve.
// Ported from openbb_federal_reserve/models/{sofr,federal_funds_rate,overnight_bank_funding_rate}.py (OpenBB Platform
// 5.0.0, Apache-2.0); modified: one function for the three NY Fed reference-rate endpoints instead of three models.
import type { NativeCtx, NativeParams, Row } from '../../types.js'
import { EmptyDataError, request, str, today } from './helpers.js'

const ALIASES: Record<string, string> = {
  effectiveDate: 'date',
  percentRate: 'rate',
  targetRateTo: 'target_range_upper',
  targetRateFrom: 'target_range_lower',
  percentPercentile1: 'percentile_1',
  percentPercentile25: 'percentile_25',
  percentPercentile75: 'percentile_75',
  percentPercentile99: 'percentile_99',
  volumeInBillions: 'volume',
  intraDayLow: 'intraday_low',
  intraDayHigh: 'intraday_high',
  stdDeviation: 'standard_deviation',
  revisionIndicator: 'revision_indicator',
}

const PERCENT = ['rate', 'target_range_upper', 'target_range_lower', 'percentile_1', 'percentile_25', 'percentile_75', 'percentile_99', 'intraday_high', 'intraday_low']

type Spec = { url: string; start: string; drop: string[] }

const SOFR: Spec = { url: 'https://markets.newyorkfed.org/api/rates/secured/sofr/search.json', start: '2018-04-02', drop: ['type', 'footnoteId', 'revisionIndicator'] }
const EFFR: Spec = { url: 'https://markets.newyorkfed.org/api/rates/unsecured/effr/search.json', start: '2016-03-01', drop: ['type', 'footnoteId'] }
const OBFR: Spec = { url: 'https://markets.newyorkfed.org/api/rates/unsecured/obfr/search.json', start: '2016-03-01', drop: ['type', 'revisionIndicator', 'footnoteId'] }

async function referenceRate(spec: Spec, params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const start = str(params, 'start_date') ?? spec.start
  const end = str(params, 'end_date') ?? today(ctx)
  const body = await ctx.http.json<{ refRates?: Row[] }>(`${spec.url}?startDate=${start}&endDate=${end}`, request())
  const raw = body.refRates ?? []
  if (raw.length === 0) throw new EmptyDataError('No data was returned for the given query.')
  const rows = raw.map((d) => {
    const out: Row = {}
    for (const [k, v] of Object.entries(d)) {
      if (spec.drop.includes(k)) continue
      const name = ALIASES[k] ?? k
      if (name === 'revision_indicator') {
        if (v !== '' && v !== "''" && v !== null) out[name] = v
      } else if (PERCENT.includes(name)) {
        // normalize_percent: SOFR also treats "", "''" and "NA" as missing.
        if (v === null || v === undefined || v === '' || v === "''" || v === 'NA') continue
        const n = Number(v)
        out[name] = n === 0 ? 0 : n / 100
      } else if (v !== null && v !== undefined) out[name] = v
    }
    return out
  })
  return rows.sort((a, b) => String(a.date).localeCompare(String(b.date)))
}

export const sofr = (params: NativeParams, ctx: NativeCtx) => referenceRate(SOFR, params, ctx)
export const effr = (params: NativeParams, ctx: NativeCtx) => referenceRate(EFFR, params, ctx)
export const obfr = (params: NativeParams, ctx: NativeCtx) => referenceRate(OBFR, params, ctx)
