// equity/screener, provider nasdaq. Ported from openbb_nasdaq/models/equity_screener.py (OpenBB Platform 5.0.0,
// Apache-2.0); modified: plain rows instead of pydantic models.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { countryName } from './countries.js'
import { BASE_URL, compact, listParam, pyFloat, textHeaders, type Dict } from './helpers.js'

const EXCHANGE_CHOICES = ['all', 'nasdaq', 'nyse', 'amex']
const EXSUBCATEGORY_CHOICES = ['all', 'ngs', 'ngm', 'ncm', 'adr']
const MKT_CAP_CHOICES = ['all', 'mega', 'large', 'mid', 'small', 'micro']
const RECOMMENDATION_CHOICES = ['all', 'strong_buy', 'buy', 'hold', 'sell', 'strong_sell']
const SECTOR_CHOICES = ['all', 'energy', 'basic_materials', 'industrials', 'consumer_staples', 'consumer_discretionary', 'health_care', 'financial_services', 'technology', 'communication_services', 'utilities', 'real_estate']
const REGION_CHOICES = ['all', 'africa', 'asia', 'australia_and_south_pacific', 'caribbean', 'europe', 'middle_east', 'north_america', 'south_america']
const COUNTRY_CHOICES = ['all', 'argentina', 'armenia', 'australia', 'austria', 'belgium', 'bermuda', 'brazil', 'canada', 'cayman_islands', 'chile', 'colombia', 'costa_rica', 'curacao', 'cyprus', 'denmark', 'finland', 'france', 'germany', 'greece', 'guernsey', 'hong_kong', 'india', 'indonesia', 'ireland', 'isle_of_man', 'israel', 'italy', 'japan', 'jersey', 'luxembourg', 'macau', 'mexico', 'monaco', 'netherlands', 'norway', 'panama', 'peru', 'philippines', 'puerto_rico', 'russia', 'singapore', 'south_africa', 'south_korea', 'spain', 'sweden', 'switzerland', 'taiwan', 'turkey', 'united_kingdom', 'united_states', 'usa']

/** A filter param as the model's validator leaves it: the valid items joined by commas, or "all". */
function filterItems(params: NativeParams, name: string, choices: string[], normalize?: (item: string) => string): string {
  const items: string[] = []
  for (const raw of listParam(params, name).join(',').split(',')) {
    if (raw === 'all') continue
    const item = normalize ? normalize(raw) : raw
    if (choices.includes(item)) items.push(item)
    // anything else is ignored with a warning
  }
  return items.length ? items.join(',') : 'all'
}

/** A country name, code or snake_case name as the screener spells it. */
function normalizeCountry(item: string): string {
  if (COUNTRY_CHOICES.includes(item)) return item
  const name = countryName(item)
  return name === undefined ? item : name.toLowerCase().replaceAll(' ', '_').replaceAll('-', '_')
}

/** `validate_numbers`: percentages become fractions, currency marks and placeholders are stripped. */
function screenerNumber(v: unknown): unknown {
  if (typeof v !== 'string') return v
  if (v.includes('%')) {
    const n = pyFloat(v.replaceAll('%', ''))
    if (n === null) throw new Error(`could not convert string to float: '${v}'`)
    return n / 100
  }
  const s = v.replaceAll('$', '').replaceAll(',', '').replaceAll('UNCH', '').replaceAll('--', '').replaceAll('NA', '')
  return s || null
}

function asFloat(v: unknown): number | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'number') return v
  const n = pyFloat(String(v))
  if (n === null) throw new Error(`Input should be a valid number, unable to parse string as a number: '${String(v)}'`)
  return n
}

export async function equityScreener(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const exchange = filterItems(params, 'exchange', EXCHANGE_CHOICES).split(',')
  const exsubcategory = filterItems(params, 'exsubcategory', EXSUBCATEGORY_CHOICES).split(',')
  const marketcap = filterItems(params, 'mktcap', MKT_CAP_CHOICES).split(',')
  const recommendation = filterItems(params, 'recommendation', RECOMMENDATION_CHOICES).split(',')
  const sector = filterItems(params, 'sector', SECTOR_CHOICES).replaceAll('communications_services', 'telecommunications').replaceAll('financial_services', 'finance').split(',')
  const region = filterItems(params, 'region', REGION_CHOICES).split(',')
  const country = filterItems(params, 'country', COUNTRY_CHOICES, normalizeCountry).split(',')
  const pick = (items: string[], upper = false): string | null => (items.includes('all') ? null : upper ? items.join('|').toUpperCase() : items.join('|'))
  const query: [string, string | null][] = [
    ['exchange', pick(exchange, true)],
    ['exsubcategory', pick(exsubcategory, true)],
    ['marketcap', pick(marketcap)],
    ['recommendation', pick(recommendation)],
    ['sector', pick(sector)],
    ['region', pick(region)],
    ['country', pick(country)],
  ]
  const querystring = query.filter(([, v]) => v !== null).map(([k, v]) => `${k}=${v}`).join('&')
  const url = `${BASE_URL}/screener/stocks?download=true&${querystring ? `&${querystring}` : ''}`
  let data: Dict
  try {
    data = await ctx.http.json<Dict>(url, { headers: textHeaders() })
  } catch (error) {
    throw new Error(`Failed to get data from Nasdaq -> ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  if (!data || !Object.keys(data).length) return [] // EmptyDataError
  const d: Dict = data.data ?? {}
  const rows: Dict[] | undefined = (d.rows && d.rows.length ? d.rows : undefined) ?? (d.table ?? {}).rows
  if (!rows || !rows.length) return [] // EmptyDataError

  const key = (r: Dict): string => (r.pctchange ? String(r.pctchange) : '')
  const sorted = [...rows].sort((a, b) => (key(a) < key(b) ? 1 : key(a) > key(b) ? -1 : 0))
  const results: Row[] = sorted.map((raw) => {
    const { url: _url, deltaIndicator: _delta, ...rest } = raw
    const row: Dict = {}
    const aliases: Record<string, string> = { lastsale: 'last_price', netchange: 'change', pctchange: 'change_percent', marketCap: 'market_cap', ipoyear: 'ipo_year' }
    for (const [k, v] of Object.entries(rest)) row[aliases[k] ?? k] = v
    for (const k of ['last_price', 'change', 'change_percent', 'market_cap', 'volume', 'ipo_year']) {
      if (!(k in row)) continue
      const v = screenerNumber(row[k])
      row[k] = k === 'ipo_year' ? (v === null || v === undefined ? null : Math.trunc(asFloat(v)!)) : asFloat(v)
    }
    return compact(row)
  })
  return typeof params.limit === 'number' && params.limit ? results.slice(0, params.limit) : results
}
