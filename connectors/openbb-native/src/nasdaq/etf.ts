// etf/holdings, etf/equity_exposure, etf/info and etf/search, provider nasdaq. Ported from
// openbb_nasdaq/models/{etf_holdings,etf_equity_exposure,etf_info,etf_search}.py (OpenBB Platform 5.0.0, Apache-2.0);
// modified: plain rows instead of pydantic models, page fetches bounded to 8 at a time.
import { NativeUnsupported, type NativeCtx, type NativeParams, type Row } from '../types.js'
import { ETF_ASSET_CLASS_MAP, ETF_FUND_FAMILY_MAP, ETF_PERFORMANCE_MAP, ETF_REGION_MAP, ETF_SECTOR_MAP } from './filters.js'
import { cleanValue, compact, getNasdaqData, listParam, mapLimit, resolveAssetClass, rowsFromTable, symbolsOf, toDate, toNumber, toPercent, truthy, type Dict } from './helpers.js'

const oneSymbol = (params: NativeParams): string => listParam(params, 'symbol').join(',').toUpperCase()

// --- etf/holdings ----------------------------------------------------------------------------------------------

export async function etfHoldings(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const symbol = oneSymbol(params)
  const assetClass = await resolveAssetClass(ctx, symbol)
  let data: Dict[]
  if (assetClass === 'mutualfunds') {
    const section = await getNasdaqData(ctx, `funds/section/${symbol}`)
    data = rowsFromTable(((section ?? {}).TopTenHoldings ?? {}).topTenHoldingsTable)
  } else {
    const holdings = await getNasdaqData(ctx, `company/${symbol.toLowerCase()}/holdings?assetclass=${assetClass}`)
    data = ((holdings ?? {}).holdings ?? {}).rows ?? []
  }
  if (!data.length) return [] // EmptyDataError
  return data.map((row) =>
    compact({
      symbol: row.symbol,
      name: truthy(row.companyname) ? row.companyname : row.name,
      weight: toPercent(truthy(row.weighting) ? row.weighting : row.assets),
    }),
  )
}

// --- etf/equity_exposure ---------------------------------------------------------------------------------------

export async function etfEquityExposure(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const symbol = oneSymbol(params)
  const assetClass = await resolveAssetClass(ctx, symbol)
  const holdings = await getNasdaqData(ctx, `company/${symbol.toLowerCase()}/holdings?assetclass=${assetClass}`)
  const data: Dict[] = ((holdings ?? {}).holdings ?? {}).rows ?? []
  if (!data.length) return [] // EmptyDataError
  return data.map((row) => {
    // "+5.28 (+12.78%)": `str.partition("(")`, the percent with its closing bracket removed
    const text = String(row.priceChange100Day || '')
    const at = text.indexOf('(')
    const change = at < 0 ? text : text.slice(0, at)
    const percent = at < 0 ? '' : text.slice(at + 1)
    return compact({
      equity_symbol: symbol,
      etf_symbol: row.symbol,
      etf_name: row.companyname,
      weight: toPercent(row.weighting),
      price_change_100_day: toNumber(change),
      price_change_100_day_percent: toPercent(percent.replace(/\)+$/, '')),
    })
  })
}

// --- etf/info --------------------------------------------------------------------------------------------------

const KEY_DATA_FIELDS: Record<string, string> = {
  aum: 'AUM',
  expense_ratio: 'ExpenseRatio',
  market_cap: 'MarketCap',
  previous_close: 'PreviousClose',
  volume: 'ShareVolume',
  alpha: 'Alpha',
  weighted_alpha: 'WeightedAlpha',
  beta: 'Beta',
  standard_deviation: 'StandardDeviation',
  volume_avg_20d: 'AvgDailyVol20Days',
  volume_avg_50d: 'FiftyDayAvgDailyVol',
  volume_avg_65d: 'AvgDailyVol65Days',
}

const FUND_SECTION_FIELDS: Record<string, [string, string]> = {
  previous_close: ['PerformanceSummary', 'PreviousClose'],
  aum: ['PerformanceSummary', 'TotalNetAssets'],
  last_dividend: ['PerformanceSummary', 'LastDividend'],
  expense_ratio: ['FeesAndExpenses', 'totalExpenseRatio'],
  management_fee: ['FeesAndExpenses', 'managementFees'],
  distribution_fee: ['FeesAndExpenses', 'account12b1Fees'],
  other_expenses: ['FeesAndExpenses', 'otherExpenses'],
  front_load: ['FeesAndExpenses', 'frontLoad'],
  minimum_initial_investment: ['FeesAndExpenses', 'minimumInitialSubscription'],
}
const FUND_PERCENT_FIELDS = new Set(['expense_ratio', 'management_fee', 'distribution_fee', 'other_expenses', 'front_load'])

const FUND_TEXT_FIELDS: Record<string, [string, string]> = {
  investment_category: ['AboutTheFund', 'fundInvestmentCategory'],
  investment_focus: ['AboutTheFund', 'investmentFocus'],
  asset_focus: ['AboutTheFund', 'assetFocus'],
  management_style: ['AboutTheFund', 'managementStyle'],
  portfolio_type: ['AboutTheFund', 'portfolioType'],
  industry_alignment: ['AboutTheFund', 'industryAlignment'],
  country_of_issuance: ['AboutTheFund', 'countryOfIssuance'],
}

/** Split a Nasdaq 'high/low' or 'low - high' display string into [high, low] (`_split_range`). */
function splitRange(v: unknown): [number | null, number | null] {
  if (typeof v !== 'string') return [null, null]
  const separator = v.includes('/') ? '/' : v.includes(' - ') ? '-' : null
  if (separator === null) return [null, null]
  const at = v.indexOf(separator)
  const numbers = [toNumber(v.slice(0, at)), toNumber(v.slice(at + 1))].filter((n): n is number => n !== null)
  return numbers.length === 2 ? [Math.max(...numbers), Math.min(...numbers)] : [null, null]
}

export async function etfInfo(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const symbols = symbolsOf(params)
  const items = await Promise.all(
    symbols.map(async (symbol) => {
      const assetClass = await resolveAssetClass(ctx, symbol)
      try {
        if (assetClass === 'mutualfunds') {
          const [section, info] = await Promise.all([getNasdaqData(ctx, `funds/section/${symbol}`), getNasdaqData(ctx, `quote/${symbol}/info?assetclass=mutualfunds`)])
          return { symbol, section: (section ?? {}) as Dict, info: (info ?? {}) as Dict }
        }
        const [summary, info] = await Promise.all([getNasdaqData(ctx, `quote/${symbol}/summary?assetclass=${assetClass}`), getNasdaqData(ctx, `quote/${symbol}/info?assetclass=${assetClass}`)])
        return { symbol, summary: (summary ?? {}) as Dict, info: (info ?? {}) as Dict }
      } catch (err) {
        ctx.log(`No key data was returned for ${symbol}. ${err instanceof Error ? err.message : String(err)}`)
        return undefined
      }
    }),
  )
  const data = items.filter((i) => i !== undefined)
  if (!data.length) return [] // EmptyDataError
  return data.map((item) => {
    const record: Dict = { symbol: item.symbol, name: item.info.companyName }
    if ('section' in item && item.section) {
      const section = item.section
      const sectionValue = (block: string, key: string): unknown => ((section[block] ?? {})[key] ?? {}).value
      for (const [field, [block, key]] of Object.entries(FUND_SECTION_FIELDS)) {
        const raw = sectionValue(block, key)
        record[field] = FUND_PERCENT_FIELDS.has(field) ? toPercent(raw) : toNumber(raw)
      }
      for (const [field, [block, key]] of Object.entries(FUND_TEXT_FIELDS)) {
        const value = cleanValue(sectionValue(block, key))
        record[field] = value === 'Not Assigned' ? null : value
      }
      record.inception_date = toDate(sectionValue('AboutTheFund', 'inceptionDate'))
      return compact(record)
    }
    const summary: Dict = ((item as { summary: Dict }).summary ?? {}).summaryData ?? {}
    for (const [field, key] of Object.entries(KEY_DATA_FIELDS)) {
      const raw = (summary[key] ?? {}).value
      record[field] = field === 'expense_ratio' ? toPercent(raw) : toNumber(raw)
    }
    const [high, low] = splitRange((summary.FiftTwoWeekHighLow ?? {}).value)
    record.year_high = high
    record.year_low = low
    return compact(record)
  })
}

// --- etf/search ------------------------------------------------------------------------------------------------

const MAX_CONCURRENCY = 8
const MAX_ATTEMPTS = 3
const RETRY_BACKOFF_MS = 500
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function filterValue(map: Record<string, string>, params: NativeParams, name: string, fallback: string): string {
  const key = String(params[name] ?? fallback)
  const v = map[key]
  if (v === undefined) throw new NativeUnsupported(`nasdaq has no ${name} filter ${key}`)
  return v
}

export async function etfSearch(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const filters: [string, string][] = [
    ['fundfamily', filterValue(ETF_FUND_FAMILY_MAP, params, 'fund_family', 'all_funds')],
    ['sector', filterValue(ETF_SECTOR_MAP, params, 'sector', 'all_sectors')],
    ['assetclass', filterValue(ETF_ASSET_CLASS_MAP, params, 'asset_class', 'all_asset_classes')],
    ['region', filterValue(ETF_REGION_MAP, params, 'region', 'all_region')],
    ['performance', filterValue(ETF_PERFORMANCE_MAP, params, 'performance', 'all_performance')],
  ]
  const querystring = filters.filter(([, v]) => v !== 'all').map(([k, v]) => `${k}=${v}`).join('&')
  const base = `screener/etf?tableonly=true&limit=10000${querystring ? `&${querystring}` : ''}`
  const pageRows = (payload: Dict | null | undefined): Dict[] => (((payload ?? {}).records ?? {}).data ?? {}).rows ?? []

  const first: Dict = (await getNasdaqData(ctx, `${base}&offset=0`)) ?? {}
  const rows = pageRows(first)
  const records: Dict = first.records ?? {}
  const total = Math.trunc(Number(records.totalrecords || rows.length))
  const pageSize = Math.trunc(Number(records.limit || rows.length || 1))
  if (pageSize && total > rows.length) {
    const offsets: number[] = []
    for (let offset = pageSize; offset < total; offset += pageSize) offsets.push(offset)
    const pages = await mapLimit(offsets, MAX_CONCURRENCY, async (offset) => {
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        try {
          return pageRows(await getNasdaqData(ctx, `${base}&offset=${offset}`))
        } catch {
          await sleep(RETRY_BACKOFF_MS * (attempt + 1))
        }
      }
      return []
    })
    for (const page of pages) rows.push(...page)
  }
  if (!rows.length) return [] // EmptyDataError

  let results = rows
    .filter((row) => truthy(row.symbol))
    .map((row) =>
      compact({
        symbol: row.symbol,
        name: row.companyName,
        last_price: toNumber(row.lastSalePrice),
        change_percent: toPercent(row.percentageChange),
        one_year_percent: toPercent(truthy(row.oneYearPercentage) ? row.oneYearPercentage : row.oneYearPercentagechange),
      }),
    )
  const q = params.query === undefined ? '' : String(params.query)
  if (q) {
    const needle = q.toLowerCase()
    results = results.filter((r) => String(r.symbol ?? '').toLowerCase().includes(needle) || String(r.name ?? '').toLowerCase().includes(needle))
  }
  return results
}
