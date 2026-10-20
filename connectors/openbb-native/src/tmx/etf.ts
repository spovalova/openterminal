// etf/info, etf/search, etf/holdings, etf/sectors and etf/countries, provider tmx. Ported from openbb_tmx/models/
// {etf_info,etf_search,etf_holdings,etf_sectors,etf_countries}.py and utils/{helpers,choices}.py (OpenBB Platform
// 5.0.0, Apache-2.0); modified: plain rows instead of DataFrames and pydantic models.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { ETF_CHOICES } from './choices-data.js'
import { applyAliases, boolParam, cached, compact, getJson, listParam, normalizeUrl, oneOf, optFloat, strParam, TmxError, toFloat, truthy, withoutRouteDefaults } from './helpers.js'

const ETFS_URL = 'https://dgr53wu9i7rmp.cloudfront.net/etfs/etfs.json'
const ETF_TTL_MS = 4 * 3600 * 1000

const COLUMNS_DICT: Record<string, string> = {
  symbol: 'symbol',
  shortname: 'short_name',
  longname: 'name',
  fundfamily: 'fund_family',
  regions: 'regions',
  sectors: 'sectors',
  currency: 'currency',
  inceptiondate: 'inception_date',
  unitprice: 'unit_price',
  prevClose: 'prev_close',
  close: 'close',
  esg: 'esg',
  investmentstyle: 'investment_style',
  avgdailyvolume: 'volume_avg_daily',
  totalreturn1month: 'return_1m',
  totalreturn3month: 'return_3m',
  totalreturn1year: 'return_1y',
  totalreturn3year: 'return_3y',
  totalreturn5year: 'return_5y',
  totalreturnytd: 'return_ytd',
  totalreturnsinceinception: 'return_from_inception',
  distributionyeld: 'distribution_yield',
  dividendfrequency: 'dividend_frequency',
  pricetoearnings: 'pe_ratio',
  pricetobook: 'pb_ratio',
  assetclass: 'asset_class_id',
  prospectobjective: 'investment_objectives',
  avgvol30days: 'volume_avg_30d',
  aum: 'aum',
  top10holdings: 'holdings_top10',
  top10holdingsummary: 'holdings_top10_summary',
  totalreturn6month: 'return_6m',
  totalreturn10year: 'return_10y',
  managementfee: 'management_fee',
  altData: 'additional_data',
  ...Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`beta${i + 1}y`, `beta_${i + 1}y`])),
}

const DROPPED_BETAS = [2, 4, 6, 7, 8, 9, 11, 12, 13, 14, 16, 17, 18, 19].map((y) => `beta_${y}y`)

/** `replace_values_in_list_of_dicts`: "NA" and "-" become missing, in nested dicts and lists too. */
function replaceMissing(data: Row[]): Row[] {
  for (const d of data) {
    for (const [k, v] of Object.entries(d)) {
      if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) {
          const item = v[i] as unknown
          if (item !== null && typeof item === 'object' && !Array.isArray(item)) replaceMissing([item as Row])
          else if (item === 'NA' || item === '-') v[i] = null
        }
      } else if (v !== null && typeof v === 'object') replaceMissing([v as Row])
      else if (v === 'NA' || v === '-') d[k] = null
    }
  }
  return data
}

/** `purge_nulls`: the source's placeholders are missing values. */
function purgeRow(row: Row): Row {
  const out: Row = {}
  for (const [k, v] of Object.entries(row)) out[k] = v === 'N/A' || v === '-' || v === '' || (typeof v === 'number' && Number.isNaN(v)) ? null : v
  return out
}

/** `get_all_etfs`: the TMX ETF universe, one record per ETF with the columns OpenBB names. */
export function allEtfs(ctx: NativeCtx, useCache: boolean): Promise<Row[]> {
  return cached(ctx, useCache, 'tmx:etfs', ETF_TTL_MS, async () => {
    const response = await getJson<Row[]>(ctx, ETFS_URL)
    if (!Array.isArray(response) || response.length === 0) throw new TmxError('There was a problem with the request. Could not get ETFs.')
    const renamed = replaceMissing(response).map((d) => {
      const row: Row = {}
      for (const [k, v] of Object.entries(d)) row[COLUMNS_DICT[k] ?? k] = v
      for (const c of DROPPED_BETAS) delete row[c]
      const extra = (row.additional_data as Row | null | undefined) ?? {}
      row.fund_family = extra.fundfamilyen ?? null
      row.website = extra.websitefactsheeten ?? null
      row.mer = extra.mer ?? null
      row.asset_class = extra.assetclassen ?? null
      row.region = extra.regionen ?? null
      row.index_fund = extra.indexfunden ?? null
      return purgeRow(row)
    })
    return renamed
  })
}

/** `slugify` of the choices module. */
function slugify(name: string): string {
  return name.replace(/[^0-9a-zA-Z]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase().replace(/_+/g, '_')
}

/** Each published name under a unique slug (`_index`). */
function choiceIndex(names: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const name of names) {
    const slug = slugify(name)
    let candidate = slug
    let n = 2
    while (out.has(candidate) && out.get(candidate) !== name) candidate = `${slug}_${n++}`
    out.set(candidate, name)
  }
  return out
}

const ETF_FIELDS = ['asset_class', 'region', 'fund_family', 'investment_style'] as const
const ETF_INDEX = Object.fromEntries(ETF_FIELDS.map((f) => [f, choiceIndex(ETF_CHOICES[f] ?? [])]))

/** `etf_value`: the published ETF value a slug selects. */
function etfValue(field: string, slug: string | undefined): string | undefined {
  return slug ? ETF_INDEX[field]?.get(slug) : undefined
}

/** `float(v) / 100 if v else None`. */
const pct = (v: unknown): number | null => (truthy(v) ? toFloat(v) / 100 : null)

const INFO_COLUMNS = ['symbol', 'inception_date', 'name', 'fund_family', 'investment_style', 'asset_class', 'region', 'index_fund', 'esg', 'currency', 'unit_price', 'close', 'prev_close', 'return_1m', 'return_3m', 'return_6m', 'return_ytd', 'return_1y', 'return_3y', 'return_5y', 'return_from_inception', 'volume_avg_daily', 'volume_avg_30d', 'aum', 'pe_ratio', 'pb_ratio', 'management_fee', 'mer', 'distribution_yield', 'dividend_frequency', 'website', 'investment_objectives']
const ETF_PERCENTS = ['distribution_yield', 'return_1m', 'return_3m', 'return_6m', 'return_ytd', 'return_1y', 'return_3y', 'return_5y', 'return_10y', 'return_from_inception', 'mer', 'management_fee']

const INFO_ALIASES: Record<string, string> = { avg_volume: 'volume_avg_daily', issuer: 'fund_family', avg_volume_30d: 'volume_avg_30d', description: 'investment_objectives' }

/** etf/info. */
export async function etfInfo(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const raw = String(params.symbol).toUpperCase()
  const symbols = raw.includes(',') ? raw.split(',') : [raw]
  const etfs = await allEtfs(ctx, boolParam(params, 'use_cache', true))
  const results: Row[] = []
  for (const symbol of symbols) {
    const s = symbol.replaceAll('.TO', '').replaceAll('.TSX', '').replaceAll('-', '.')
    const etf = etfs.find((e) => e.symbol === s)
    if (!etf) continue
    const picked: Row = {}
    for (const c of INFO_COLUMNS) if (c in etf) picked[c] = etf[c]
    const row = applyAliases(picked, INFO_ALIASES)
    for (const k of ETF_PERCENTS) if (k in row) row[k] = pct(row[k])
    if ('website' in row) row.website = normalizeUrl(row.website) ?? null
    for (const k of ['unit_price', 'close', 'prev_close', 'aum', 'pe_ratio', 'pb_ratio', 'avg_volume', 'avg_volume_30d']) if (k in row) row[k] = optFloat(row[k]) ?? null
    results.push(compact(row))
  }
  return results
}

const HOLDING_COLUMNS: Record<string, string> = {
  numberofshares: 'number_of_shares',
  symbol: 'symbol',
  country: 'country',
  fundid: 'fund_id',
  excode: 'exchange',
  securityname: 'name',
  currency: 'currency',
  marketvalue: 'market_value',
  detailholdingtypeid: 'type_id',
  weighting: 'weight',
  sharepercentage: 'share_percentage',
  sharechange: 'share_change',
  shareChange: 'share_change',
}

/** etf/holdings: the ten largest holdings TMX publishes. */
export async function etfHoldings(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const symbol = String(params.symbol).replaceAll('.TO', '').replaceAll('.TSX', '').replaceAll('-', '.').toUpperCase()
  const etfs = await allEtfs(ctx, boolParam(params, 'use_cache', true))
  const matches = etfs.filter((e) => e.symbol === symbol)
  if (matches.length !== 1) return []
  const holdings = (matches[0]!.holdings_top10 as Row[] | null | undefined) ?? []
  return holdings.map((h) => {
    const renamed: Row = {}
    for (const [k, v] of Object.entries(h)) renamed[HOLDING_COLUMNS[k] ?? k] = v === 'NA' ? null : v
    const row = applyAliases(purgeRow(renamed), { shares: 'number_of_shares' })
    row.weight = pct(row.weight)
    row.share_percentage = pct(row.share_percentage)
    return compact(row)
  })
}

/** etf/sectors. */
export async function etfSectors(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const etfs = await allEtfs(ctx, boolParam(params, 'use_cache', true))
  const results: Row[] = []
  for (const symbol of listParam(params).map((s) => s.toUpperCase())) {
    const s = symbol.replaceAll('-', '.').replaceAll('.TO', '').replaceAll('.TSX', '')
    const sectors = (etfs.find((e) => e.symbol === s)?.sectors as Row[] | null | undefined) ?? []
    for (const d of sectors) results.push(compact({ symbol, sector: d.name, weight: pct(d.percent) }))
  }
  return results
}

/** etf/countries. */
export async function etfCountries(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const etfs = await allEtfs(ctx, boolParam(params, 'use_cache', true))
  const raw = String(params.symbol).toUpperCase()
  const symbols = raw.includes(',') ? raw.split(',') : [raw]
  const results: Row[] = []
  for (let symbol of symbols) {
    if (symbol.includes('.TO')) symbol = symbol.replaceAll('.TO', '')
    const regions = (etfs.find((e) => e.symbol === symbol)?.regions as Row[] | null | undefined) ?? []
    for (const d of regions) results.push(compact({ symbol, country: d.name, weight: pct(d.percent) }))
  }
  return results
}

const SEARCH_ALIASES: Record<string, string> = { issuer: 'fund_family', avg_volume: 'volume_avg_daily', avg_volume_30d: 'volume_avg_30d' }
const SEARCH_DROPPED = ['sectors', 'regions', 'holdings_top10_summary', 'holdings_top10', 'additional_data', 'website', 'asset_class_id', 'investment_objectives']
const SORTS = ['aum', 'return_1m', 'return_3m', 'return_6m', 'return_1y', 'return_3y', 'return_ytd', 'beta_1y', 'volume_avg_daily', 'management_fee', 'distribution_yield', 'pb_ratio', 'pe_ratio'] as const
const DIV_FREQS = ['monthly', 'quarterly', 'annually', 'semi-annually', 'unspecified'] as const

/** `Series.str.contains(pattern, case=False)`: a regular expression, missing values never match. */
function containsAny(row: Row, columns: string[], pattern: RegExp): boolean {
  return columns.some((c) => typeof row[c] === 'string' && pattern.test(row[c] as string))
}

/** etf/search: the ETF universe filtered and sorted. */
export async function etfSearch(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  // The fund family, asset class and region defaults ("all_funds", …) are other providers'; OpenBB drops them.
  const given = withoutRouteDefaults(params, { fund_family: 'all_funds', asset_class: 'all_asset_classes', region: 'all_region' })
  const query = strParam(given, 'query')
  const divFreq = given.div_freq !== undefined ? oneOf(given, 'div_freq', DIV_FREQS, 'monthly') : undefined
  const currency = given.currency !== undefined ? oneOf(given, 'currency', ['CAD', 'USD'] as const, 'CAD') : undefined
  const sortBy = given.sort_by !== undefined ? oneOf(given, 'sort_by', SORTS, 'aum') : undefined
  const esg = given.esg === undefined ? undefined : given.esg === true || given.esg === 'true'

  let data = await allEtfs(ctx, boolParam(params, 'use_cache', true))
  if (query) {
    let pattern: RegExp
    try {
      pattern = new RegExp(query, 'i')
    } catch {
      throw new TmxError(`Invalid regular expression: ${query}`)
    }
    data = data.filter((row) => containsAny(row, ['name', 'short_name', 'investment_style', 'investment_objectives', 'symbol'], pattern))
  }
  if (divFreq) data = data.filter((row) => String(row.dividend_frequency ?? 'None').toLowerCase() === divFreq.toLowerCase())
  if (currency) data = data.filter((row) => String(row.currency ?? 'None') === currency)
  if (esg !== undefined) data = data.filter((row) => truthy(row.esg) === esg)
  for (const field of ETF_FIELDS) {
    const value = etfValue(field, strParam(given, field))
    if (value) data = data.filter((row) => String(row[field] ?? 'None') === value)
  }
  if (sortBy) {
    // sort_values(ascending=False): missing values last.
    const present = data.filter((row) => row[sortBy] !== null && row[sortBy] !== undefined).sort((a, b) => cmpDesc(a[sortBy], b[sortBy]))
    data = [...present, ...data.filter((row) => row[sortBy] === null || row[sortBy] === undefined)]
  }

  return data.map((d) => {
    const kept: Row = {}
    for (const [k, v] of Object.entries(d)) if (!SEARCH_DROPPED.includes(k)) kept[k] = v
    const row = applyAliases(kept, SEARCH_ALIASES)
    for (const k of ETF_PERCENTS) if (k in row) row[k] = pct(row[k])
    for (const k of ['unit_price', 'close', 'prev_close', 'aum', 'pe_ratio', 'pb_ratio', 'beta_1y', 'beta_3y', 'beta_5y', 'beta_10y', 'beta_15y', 'avg_volume', 'avg_volume_30d']) if (k in row) row[k] = optFloat(row[k]) ?? null
    return compact(row)
  })
}

function cmpDesc(a: unknown, b: unknown): number {
  const x = typeof a === 'number' ? a : toFloat(a)
  const y = typeof b === 'number' ? b : toFloat(b)
  return y - x
}
