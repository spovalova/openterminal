// equity/estimates/price_target and equity/estimates/consensus, provider nasdaq. Ported from
// openbb_nasdaq/models/{price_target,price_target_consensus}.py (OpenBB Platform 5.0.0, Apache-2.0); modified: plain
// rows instead of pydantic models.
import type { NativeCtx, NativeParams, Row } from '../types.js'
import { compact, getNasdaqData, symbolsOf, toDate, toNumber, truthy, type Dict } from './helpers.js'

const EPOCH = '1900-01-01'
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** The first of `a` and `b` that Python would call true (`a or b`). */
const either = (a: unknown, b: unknown): unknown => (truthy(a) ? a : b)

export async function priceTarget(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const symbols = symbolsOf(params)
  const batches = await Promise.all(
    symbols.map(async (symbol) => {
      try {
        const data = await getNasdaqData(ctx, `analyst/${symbol}/ratings`)
        return ((data ?? {}).upgradesDowngrades ?? []).map((row: Dict) => ({ ...row, symbol }))
      } catch (err) {
        ctx.log(`No analyst ratings were returned for ${symbol}. ${messageOf(err)}`)
        return []
      }
    }),
  )
  const data: Dict[] = batches.flat()
  // EmptyDataError: Nasdaq only publishes recent upgrades and downgrades, and the list is often empty.
  if (!data.length) return []
  const results = data.map((row) =>
    compact({
      symbol: row.symbol,
      published_date: toDate(row.date),
      analyst_firm: either(row.company, row.firm),
      rating_current: either(row.toRating, row.rating),
      rating_previous: row.fromRating,
      action: row.action,
      price_target: toNumber(either(row.toPT, row.priceTarget)),
      price_target_previous: toNumber(row.fromPT),
    }),
  )
  // newest first; Python's reverse sort keeps equal dates in their original order
  const sorted = results.sort((a, b) => {
    const x = (a.published_date as string | undefined) ?? EPOCH
    const y = (b.published_date as string | undefined) ?? EPOCH
    return x < y ? 1 : x > y ? -1 : 0
  })
  return typeof params.limit === 'number' ? sorted.slice(0, params.limit) : sorted
}

export async function priceTargetConsensus(params: NativeParams, ctx: NativeCtx): Promise<Row[]> {
  const symbols = symbolsOf(params)
  const items = await Promise.all(
    symbols.map(async (symbol) => {
      const [target, ratings] = await Promise.allSettled([getNasdaqData(ctx, `analyst/${symbol}/targetprice`), getNasdaqData(ctx, `analyst/${symbol}/ratings`)])
      if (target.status === 'rejected' || !truthy(target.value)) {
        ctx.log(`No price target was returned for ${symbol}.`)
        return undefined
      }
      return { symbol, target: target.value as Dict, ratings: (ratings.status === 'rejected' ? {} : (ratings.value ?? {})) as Dict }
    }),
  )
  const data = items.filter((i) => i !== undefined)
  if (!data.length) return [] // EmptyDataError
  return data.map((item) => {
    const overview: Dict = item.target.consensusOverview ?? {}
    return compact({
      symbol: item.symbol,
      target_high: toNumber(overview.highPriceTarget),
      target_low: toNumber(overview.lowPriceTarget),
      target_consensus: toNumber(overview.priceTarget),
      buy_ratings: toNumber(overview.buy),
      hold_ratings: toNumber(overview.hold),
      sell_ratings: toNumber(overview.sell),
      consensus_rating: item.ratings.meanRatingType,
    })
  })
}
