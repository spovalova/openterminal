// index/available, index/constituents, index/sectors and index/snapshots, provider tmx. Ported from
// openbb_tmx/models/{available_indices,index_constituents,index_sectors,index_snapshots}.py and utils/helpers.py
// (OpenBB Platform 5.0.0, Apache-2.0); modified: plain rows instead of pydantic models.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { INDEX_CONSTITUENTS, QUOTE_FOR_SYMBOLS } from './gql.js'
import { applyAliases, boolParam, cached, compact, DAY_MS, getJson, gql, oneOf, optFloat, pyRound, TmxError, toFloat, truthy } from './helpers.js'

const INDICES_URL = 'https://tmxinfoservices.com/files/indices/sptsx-indices.json'

/** The index file TMX publishes after each close: every S&P/TSX index with its sectors, weights and performance. */
function indexFile(ctx: NativeCtx, useCache: boolean): Promise<Row> {
  return cached(ctx, useCache, 'tmx:sptsx-indices', DAY_MS, () => getJson<Row>(ctx, INDICES_URL))
}

/** index/available: the S&P/TSX indices with their category, market value and documents. */
export async function availableIndices(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const data = await indexFile(ctx, boolParam(params, 'use_cache', true))
  if (!data || Object.keys(data).length === 0) return []

  const categories = new Map<string, string[]>()
  for (const [category, symbols] of Object.entries(data.groups as Record<string, string[]>)) {
    for (const symbol of symbols) categories.set(symbol, [...(categories.get(symbol) ?? []), category])
  }
  const indices = data.indices as Record<string, Row>
  return Object.keys(indices).map((symbol) => {
    const index = indices[symbol]!
    let overview = index.overview_en as string | null | undefined
    if (overview) {
      overview = overview.replace(/<.*?>/g, '').replace(/\r|\n|amp;/g, '')
    }
    const nameEn = String(index.name_en ?? '')
    const category = categories.get(symbol)
    if (!category) throw new TmxError(`${symbol} is in none of the index groups.`)
    const value = index.quotedmarketvalue as Row | undefined
    return compact({
      symbol,
      name: index.name_en,
      currency: nameEn.includes('(USD)') ? 'USD' : 'CAD',
      category: category.join(', '),
      market_value: value && Object.keys(value).length > 0 ? value.total : undefined,
      num_constituents: index.nb_constituents,
      overview: index.overview !== '' ? overview : undefined,
      methodology: index.methodology !== '' ? index.methodology : undefined,
      factsheet: index.factsheet !== '' ? index.factsheet : undefined,
    })
  })
}

/** index/constituents: the companies of an index with their market value and weight. */
export async function indexConstituents(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const symbol = String(params.symbol)
  const response = await cached(ctx, boolParam(params, 'use_cache', true), `tmx:index-constituents:${symbol}`, DAY_MS, () => gql<Row>(ctx, 'getIndexConstituents', INDEX_CONSTITUENTS, { symbol }))
  const constituents = response?.constituents as Row[] | null | undefined
  if (constituents === null || constituents === undefined) throw new TmxError(`Index ${symbol} was not found. Check the symbol.`)
  const published = new Set(['symbol', 'longName', 'exchange', 'quotedMarketValue', 'weight'])
  return constituents.map((entry) => {
    const kept = Object.fromEntries(Object.entries(entry).filter(([k]) => published.has(k)))
    const row = applyAliases(kept, { name: 'longName', market_value: 'quotedMarketValue' })
    row.weight = truthy(row.weight) ? toFloat(row.weight) / 100 : null
    if ('market_value' in row) row.market_value = optFloat(row.market_value) ?? null
    return compact(row)
  })
}

/** index/sectors: the sector weights of an index. */
export async function indexSectors(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const symbol = String(params.symbol).toUpperCase()
  const data = await indexFile(ctx, boolParam(params, 'use_cache', true))
  if (!data || Object.keys(data).length === 0) return []
  const index = (data.indices as Record<string, Row>)[symbol]
  const sectors = (index?.sectors as Row[] | undefined) ?? []
  return sectors.map((d) => compact({ sector: d.name, weight: truthy(d.weight) ? toFloat(d.weight) / 100 : null }))
}

const NASDAQ_INDEX_SYMBOLS = [
  '^ADRAI', '^ADRDI', '^ADREI', '^ASRN', '^ASRX', '^AVSPY', '^BIXR', '^BIXX',
  '^BKX', '^BSCBK', '^BSCBL', '^BSCBM', '^BSCBN', '^BSCBO', '^BSCBP', '^BSJKK',
  '^BSJKL', '^BSJKM', '^BSJKN', '^BXN', '^CELS', '^CEXX', '^CHXN', '^CIX100',
  '^CND', '^COMPX', '^CVXLF', '^DFX', '^DIVQ', '^DOT', '^DTEC', '^DVQT',
  '^DWAFIR', '^DWANQFF', '^EMCLOUD', '^EPX', '^ABAQ', '^EVSPY', '^GESPY', '^GOOSY',
  '^GVSPY', '^HAUL', '^HGX', '^IBMSY', '^ILTI', '^INTSY', '^ISRQ', '^ISRX',
  '^IVSPY', '^IXBK', '^IXCO', '^IXF', '^IXFN', '^IXHC', '^IXID', '^IXIS',
  '^IXTC', '^IXTR', '^JVSPY', '^KRX', '^LVSPY', '^MFX', '^MRKSY', '^MSH',
  '^MXZ', '^NBI', '^NBIE', '^NBIJR', '^NCI', '^NDX', '^NDXE', '^NDXT',
  '^NDXX', '^NEUX', '^NGX', '^NQ7HANDLTL', '^NQCICLER', '^NQCIGCER', '^NQCIHGER', '^NQCINGER',
  '^NQCISIER', '^NQCYBRT', '^NQGM', '^NQGS', '^NQH2O', '^NQMGUSL', '^NQVWLCCT', '^NQVWLCT',
  '^NQVWLDCT', '^NQX', '^NVSPY', '^NXTQ', '^OMXB10', '^OMXC20', '^OMXH25', '^OMXN40',
  '^OMXS30', '^ONEQI', '^OSX', '^PRFEI', '^PRFFI', '^PRFGI', '^PRFHI', '^PRFMI',
  '^PRFNI', '^PRFQI', '^PRFSI', '^PRFUI', '^PRFZI', '^QAGR', '^QCLNI', '^QCOL',
  '^QGLD', '^QGRI', '^QIRL', '^QIV', '^QMEA', '^QMI', '^QNET', '^QOMX',
  '^QQEWI', '^NOCO', '^QQXTI', '^QSTL', '^QTECI', '^QWND', '^RCMP', '^RXS',
  '^SHX', '^SOX', '^SRVRSCPR', '^SVO', '^TRAN', '^TVSPY', '^UTY', '^UVSPY',
  '^VOLNDX', '^VOLQ', '^WMTSY', '^WVSPY', '^XAU', '^XCM', '^XEX', '^XND',
]

const SNAPSHOT_ALIASES: Record<string, string> = {
  name: 'longname',
  prev_close: 'prevClose',
  change: 'priceChange',
  change_percent: 'previousday',
  year_high: 'weeks52high',
  year_low: 'weeks52low',
  return_mtd: 'monthtodate',
  return_qtd: 'quartertodate',
  return_ytd: 'yeartodate',
  total_market_value: 'total',
  constituent_average_market_value: 'average',
  constituent_median_market_value: 'median',
  constituent_top10_market_value: 'sumtop10',
  constituent_largest_market_value: 'largest',
  constituent_largest_weight: 'largestweight',
  constituent_smallest_market_value: 'smallest',
  constituent_smallest_weight: 'smallestweight',
}

const SNAPSHOT_PERCENTS = ['return_mtd', 'return_qtd', 'return_ytd', 'change_percent', 'constituent_largest_weight', 'constituent_smallest_weight']
const SNAPSHOT_ROUNDED = ['year_high', 'year_low', 'price', 'prev_close', 'change']
const SNAPSHOT_FLOATS = ['total_market_value', 'number_of_constituents', 'constituent_average_market_value', 'constituent_median_market_value', 'constituent_top10_market_value', 'constituent_largest_market_value', 'constituent_smallest_market_value', 'volume']

/** index/snapshots: the S&P/TSX indices (`ca`) or the NASDAQ ones (`us`) with their latest level and performance. */
export async function indexSnapshots(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const region = oneOf(params, 'region', ['ca', 'us'] as const, 'ca')
  let results: Row[]

  if (region === 'ca') {
    const data = await indexFile(ctx, boolParam(params, 'use_cache', true))
    if (!data || Object.keys(data).length === 0) return []
    const indices = data.indices as Record<string, Row>
    const symbols = Object.keys(indices)
    results = symbols.map((symbol) => {
      const index = indices[symbol]!
      return {
        symbol,
        name: index.name_en,
        currency: String(index.name_en ?? '').includes('(USD)') ? 'USD' : 'CAD',
        ...((index.performance as Row | undefined) ?? {}),
        ...((index.quotedmarketvalue as Row | undefined) ?? {}),
      }
    })
    const response = await gql<Row>(ctx, 'getQuoteForSymbols', QUOTE_FOR_SYMBOLS, { symbols })
    const quotes = response?.getQuoteForSymbols as Row[] | undefined
    if (quotes && quotes.length > 0) {
      for (const row of results) {
        delete row.longname
        delete row.percentChange
      }
      results = results.map((d1) => ({ ...d1, ...(quotes.find((d2) => d2.symbol === d1.symbol) ?? {}) }))
    }
  } else {
    const response = await gql<Row>(ctx, 'getQuoteForSymbols', QUOTE_FOR_SYMBOLS, { symbols: NASDAQ_INDEX_SYMBOLS.map((s) => `${s}:US`) })
    const quotes = (response?.getQuoteForSymbols as Row[] | undefined) ?? []
    results = quotes.filter((item) => item.price !== null && item.price !== undefined).map((item) => ({ ...item }))
    for (const item of results) {
      item.change_percent = item.percentChange ?? null
      delete item.percentChange
    }
  }

  return results
    .filter((d) => 'price' in d && d.price !== null && d.price !== undefined)
    .map((d) => {
      const clean: Row = {}
      for (const [k, v] of Object.entries(d)) clean[k === 'percentChange' ? 'change_percent' : k] = v === '' || v === 0 || v === false ? null : v
      const row = applyAliases(clean, SNAPSHOT_ALIASES)
      for (const k of SNAPSHOT_PERCENTS) if (k in row) row[k] = truthy(row[k]) ? pyRound(toFloat(row[k]) / 100, 6) : null
      for (const k of SNAPSHOT_ROUNDED) if (k in row) row[k] = truthy(row[k]) ? pyRound(toFloat(row[k]), 2) : null
      for (const k of SNAPSHOT_FLOATS) if (k in row) row[k] = optFloat(row[k]) ?? null
      return compact(row)
    })
}
