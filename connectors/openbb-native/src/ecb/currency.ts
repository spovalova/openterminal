// currency/price/historical and currency/reference_rates, provider ecb. Ported from
// openbb_ecb/models/{currency_historical,currency_reference_rates}.py (OpenBB Platform 5.0.0, Apache-2.0); modified:
// plain rows instead of pydantic models, the daily reference-rate XML read with fast-xml-parser.
import { parseXml } from '../lib/xml.js'
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { cachedRecords, exrKey, FREQUENCY_MAP, fetchSdmxData, flag, PLAIN_HEADERS, text } from './helpers.js'

const REFERENCE_RATES_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml'

/** Fields the standard model declares (`CurrencyReferenceRatesData`): pydantic turns their values into floats. */
const DECLARED = new Set(['EUR', 'USD', 'JPY', 'BGN', 'CZK', 'DKK', 'GBP', 'HUF', 'PLN', 'RON', 'SEK', 'CHF', 'ISK', 'NOK', 'TRY', 'AUD', 'BRL', 'CAD', 'CNY', 'HKD', 'IDR', 'ILS', 'INR', 'KRW', 'MXN', 'MYR', 'NZD', 'PHP', 'SGD', 'THB', 'ZAR'])

export async function currencyReferenceRates(_params: NativeParams, ctx: NativeCtx): Promise<Row> {
  const res = await ctx.http.response(REFERENCE_RATES_URL, { headers: PLAIN_HEADERS })
  if (res.status !== 200) throw new Error(`Failed to fetch data from ECB. -> Status Code: ${res.status}`)
  const doc = parseXml(await res.text())
  const envelope = doc.Envelope as { Cube: { Cube: { '@_time': string; Cube: { '@_currency': string; '@_rate': string }[] | { '@_currency': string; '@_rate': string } } } }
  const cube = envelope.Cube.Cube
  const cubes = Array.isArray(cube.Cube) ? cube.Cube : [cube.Cube]
  const out: Row = { date: cube['@_time'], EUR: 1 }
  for (const c of cubes) {
    const code = c['@_currency']
    out[code] = DECLARED.has(code) ? Number(c['@_rate']) : c['@_rate']
  }
  return out
}

/** `_split_pair`: EUR against the currency, or the two currencies of a six-letter pair. */
function splitPair(pair: string): [string, string] {
  if (pair.length === 3) return ['EUR', pair]
  if (pair.length !== 6) throw new Error(`Invalid currency pair '${pair}'. Use CUR1CUR2 (e.g. 'EURUSD').`)
  return [pair.slice(0, 3), pair.slice(3)]
}

export async function currencyHistorical(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  // The standard model upper-cases the symbol and drops '-'.
  const symbol = (text(params, 'symbol') ?? '').toUpperCase().replace(/-/g, '')
  const freq = FREQUENCY_MAP[text(params, 'frequency') ?? 'daily']!
  const start = text(params, 'start_date')
  const end = text(params, 'end_date')
  const useCache = flag(params, 'use_cache', true)
  const pairs = symbol.split(',').map((p) => p.trim()).filter(Boolean)

  const currencies = new Set<string>()
  for (const pair of pairs) for (const c of splitPair(pair)) if (c !== 'EUR') currencies.add(c)

  // The EXR series of each currency against EUR, by date.
  const rates = new Map<string, Map<string, number>>()
  const batches = await Promise.all(
    [...currencies].sort().map(async (currency) => {
      const records = await cachedRecords(ctx, 'exr', JSON.stringify({ currency, freq, start, end }), useCache, () => fetchSdmxData(ctx, 'EXR', exrKey(currency, freq), { startDate: start, endDate: end }))
      return [currency, records] as const
    }),
  )
  for (const [currency, records] of batches) {
    for (const record of records) {
      if (record.OBS_VALUE === null || record.OBS_VALUE === undefined) continue
      let byDate = rates.get(currency)
      if (!byDate) rates.set(currency, (byDate = new Map()))
      byDate.set(record.date as string, record.OBS_VALUE as number)
    }
  }

  const results: Row[] = []
  for (const pair of pairs) {
    const [base, quote] = splitPair(pair)
    const baseRates = rates.get(base) ?? new Map<string, number>()
    const quoteRates = rates.get(quote) ?? new Map<string, number>()
    // Without EUR on either side both series must exist on a date; with it, the other side's dates are the dates.
    const dates = base !== 'EUR' && quote !== 'EUR' ? new Set([...baseRates.keys(), ...quoteRates.keys()]) : new Set((baseRates.size ? baseRates : quoteRates).keys())
    for (const date of dates) {
      const baseVal = base === 'EUR' ? 1 : baseRates.get(date)
      const quoteVal = quote === 'EUR' ? 1 : quoteRates.get(date)
      if (!baseVal || !quoteVal) continue
      results.push({ date, symbol: pair, close: quoteVal / baseVal })
    }
  }
  if (results.length === 0) throw new Error('No exchange rate data found for the requested pair(s).')
  results.sort((a, b) => ((a.symbol as string) < (b.symbol as string) ? -1 : (a.symbol as string) > (b.symbol as string) ? 1 : (a.date as string) < (b.date as string) ? -1 : (a.date as string) > (b.date as string) ? 1 : 0))
  return results
}
