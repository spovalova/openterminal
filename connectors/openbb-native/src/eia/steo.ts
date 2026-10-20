// commodity/short_term_energy_outlook, provider eia. Ported from openbb_us_eia/models/short_term_energy_outlook.py
// (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of a DataFrame and pydantic models; series
// requests capped at 6 in flight; warnings (series with no data among others that have) are not reported.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { API_BASE, apiKey, getJson } from './api.js'
import { parsePeriod } from './catalog.js'
import { STEO_TABLE_MAP, STEO_TABLE_NAMES } from './constants.js'
import { text } from './dataset.js'

type Json = Record<string, any>

const FREQUENCIES: Record<string, { name: string; format: string }> = {
  month: { name: 'monthly', format: 'YYYY-MM' },
  quarter: { name: 'quarterly', format: 'YYYY-"Q"Q' },
  annual: { name: 'annual', format: 'YYYY' },
}
const CHUNK = 10
const PAGE = 5000
const MAX_IN_FLIGHT = 6

/** Python's `repr` of a list of strings, as it lands in the error message. */
const pyList = (items: string[]): string => `[${items.map((s) => `'${s}'`).join(', ')}]`

/** The series to read, upper-cased and without repeats: the symbols asked for, else the table's. */
function seriesFor(symbol: string | undefined, table: string): string[] {
  const list = symbol ? symbol.toUpperCase().split(',') : (STEO_TABLE_MAP[table] ?? []).map((d) => d.toUpperCase())
  return [...new Set(list)]
}

function periodBound(date: string, frequency: string): string {
  const [y, m] = date.split('-') as [string, string]
  if (frequency === 'monthly') return `${y}-${m}`
  if (frequency === 'quarterly') return `${y}-Q${Math.floor((Number(m) - 1) / 3) + 1}`
  return y
}

export async function shortTermEnergyOutlook(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const key = apiKey(ctx)
  const table = text(params, 'table') ?? '01'
  if (!(table in STEO_TABLE_NAMES)) throw new Error(`table: Input should be one of ${Object.keys(STEO_TABLE_NAMES).join(', ')} (got ${table})`)
  const frequencyId = text(params, 'frequency') ?? 'month'
  const freq = FREQUENCIES[frequencyId]
  if (!freq) throw new Error(`frequency: Input should be 'month', 'quarter' or 'annual' (got ${frequencyId})`)
  const symbolText = text(params, 'symbol')
  const startDate = text(params, 'start_date')
  const endDate = text(params, 'end_date')

  const base = `${API_BASE}/steo/data/?api_key=${key}&frequency=${freq.name}&data[0]=value`
  const start = startDate ? `&start=${periodBound(startDate, freq.name)}` : ''
  const end = endDate ? `&end=${periodBound(endDate, freq.name)}` : ''
  const symbols = seriesFor(symbolText, table)

  const urls: string[] = []
  for (let i = 0; i < symbols.length; i += CHUNK) {
    const facets = symbols.slice(i, i + CHUNK).map((s) => `&facets[seriesId][]=${s.toUpperCase()}`).join('')
    urls.push(`${base}${facets}${start}${end}&offset=0&length=${PAGE}`)
  }

  const results: Json[] = []
  const messages: string[] = []
  const getOne = async (url: string) => {
    const res = await getJson(ctx, url)
    const data = ((res.response ?? {}) as Json).data ?? []
    if (data.length === 0) {
      const seriesId = ((((res.request ?? {}) as Json).params ?? {}) as Json).facets?.seriesId ?? []
      messages.push(`No data returned for ${seriesId.length > 0 ? pyList(seriesId) : url.replace(key, 'API_KEY')}`)
    } else results.push(...data)
    const total = Math.trunc(Number(((res.response ?? {}) as Json).total ?? 0))
    let nResults = data.length
    if (total > PAGE && nResults === PAGE) {
      // The rest of a long series, page by page (OpenBB asks for these without the error handling of the first page).
      let offset = PAGE
      let next = url.replace('&offset=0', `&offset=${offset}`)
      while (nResults < total) {
        const additional = await getJson(ctx, next).catch(() => ({}) as Json)
        const more = ((additional.response ?? {}) as Json).data ?? []
        if (more.length === 0) {
          messages.push(`No additional data returned for ${next.replace(key, 'API_KEY')}`)
          break
        }
        results.push(...more)
        nResults += more.length
        next = next.replace(`&offset=${offset}`, `&offset=${offset + PAGE}`)
        offset += PAGE
      }
    }
  }
  try {
    let at = 0
    const worker = async () => {
      for (let i = at++; i < urls.length; i = at++) await getOne(urls[i]!)
    }
    await Promise.all(Array.from({ length: Math.min(MAX_IN_FLIGHT, urls.length) }, worker))
  } catch (err) {
    throw new Error(`Error fetching data from the EIA API -> ${err instanceof Error ? err.message : String(err)}`, { cause: err })
  }
  if (results.length === 0 && messages.length === 0) throw new Error('The request was returned empty with no error messages.')
  if (results.length === 0) throw new Error(messages.join('\n'))

  // transform_data: dates, then the series in the order asked for within each period.
  const rank = new Map(symbols.map((s, i) => [s, i]))
  const parsed = results.map((raw) => ({ raw, period: parsePeriod(String(raw.period), freq.format) }))
  parsed.sort((a, b) => a.period.time - b.period.time || (rank.get(a.raw.seriesId) ?? Infinity) - (rank.get(b.raw.seriesId) ?? Infinity))

  const label = `STEO - ${table[0] === '0' ? table.replaceAll('0', '') : table}: ${STEO_TABLE_NAMES[table]}`
  const seen = new Map<number, number>()
  return parsed.map(({ raw, period }) => {
    const { period: _period, seriesId, seriesDescription, value, ...rest } = raw
    const row: Row = { date: period.iso }
    if (!symbolText) {
      const order = (seen.get(period.time) ?? 0) + 1
      seen.set(period.time, order)
      row.table = label
      row.order = order
    }
    row.symbol = seriesId
    row.title = seriesDescription
    const number = typeof value === 'string' ? Number(value) : value
    if (number !== null && number !== undefined && !Number.isNaN(number)) row.value = number
    return { ...row, ...rest }
  })
}
