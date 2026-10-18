/**
 * Hand-written, recorded-shape fixture frames: one per widget row in PLAN.md section 5
 * (A1–A5, B1–B4, C1–C4), one `search` frame, and one per v1.2 kind with a view worth looking at
 * (options on the chain view, macro on the series view, the rest on tables).
 * Columns come straight from `KINDS` so they always match the catalog.
 */
import { KINDS, parseWidget, type Frame, type Kind, type Widget, type WidgetInput } from '@terminal/core'

export type Fixture = { id: string; note: string; widget: Widget; frame: Frame }

/** 2026-10-16 09:30 ET, the morning every fixture was "recorded". */
export const FETCHED_AT = Date.UTC(2026, 9, 16, 13, 30)

function frame(kind: Kind, rows: unknown[][]): Frame {
  const def = KINDS[kind]
  const ttl = typeof def.ttl === 'number' ? def.ttl : 60_000
  return { columns: def.columns, rows, meta: { connector: 'fixture', fetchedAt: FETCHED_AT, ttl } }
}

/** Daily bar timestamp: US regular session open, 13:30 UTC. */
const day = (m: number, d: number) => Date.UTC(2026, m - 1, d, 13, 30)
/** 5-minute bar timestamps on 2026-10-16 from 13:30 UTC. */
const fiveMin = (i: number) => Date.UTC(2026, 9, 16, 13, 30) + i * 5 * 60_000

const OCT_DAYS = [day(10, 6), day(10, 7), day(10, 8), day(10, 9), day(10, 12), day(10, 13), day(10, 14), day(10, 15)]
const INTRADAY = Array.from({ length: 8 }, (_, i) => fiveMin(i))

/**
 * ohlcv rows for one symbol from a close path: open is the prior close, high/low bracket the body.
 * Rows are [symbol, time, open, high, low, close, volume], sorted by time ascending.
 */
function bars(symbol: string, times: number[], closes: number[], baseVolume: number): unknown[][] {
  return closes.map((close, i) => {
    const open = i === 0 ? r(close * 0.995) : closes[i - 1]!
    const hi = Math.max(open, close)
    const lo = Math.min(open, close)
    const volume = Math.round(baseVolume * (1 + ((i * 7) % 5) / 10))
    return [symbol, times[i]!, open, r(hi * 1.006), r(lo * 0.994), close, volume]
  })
}
const r = (n: number) => Math.round(n * 100) / 100

function ohlcv(groups: [symbol: string, times: number[], closes: number[], baseVolume: number][]): Frame {
  return frame('ohlcv', groups.flatMap(([s, t, c, v]) => bars(s, t, c, v)))
}

function widget(w: WidgetInput): Widget {
  return parseWidget(w)
}

// ---- A. "What's happening with memory?" ------------------------------------------------------

const A1: Fixture = {
  id: 'A1',
  note: 'ohlcv 1d 3mo basket · series, normalize · lg',
  widget: widget({
    id: 'a1',
    title: 'Memory names, 3 months rebased',
    size: 'lg',
    query: { kind: 'ohlcv', params: { symbols: ['MU', 'SNDK', 'WDC', 'STX'], interval: '1d', range: '3mo' } },
    view: { type: 'series', normalize: true },
  }),
  frame: ohlcv([
    ['MU', OCT_DAYS, [181.2, 184.9, 188.35, 186.1, 192.4, 195.8, 193.25, 199.6], 18_400_000],
    ['SNDK', OCT_DAYS, [96.4, 98.1, 101.7, 100.2, 105.9, 109.3, 107.8, 112.45], 4_100_000],
    ['WDC', OCT_DAYS, [104.8, 103.9, 106.2, 107.5, 109.1, 108.4, 110.9, 112.3], 6_300_000],
    ['STX', OCT_DAYS, [228.5, 226.1, 231.4, 229.8, 235.2, 238.9, 236.4, 241.7], 2_900_000],
  ]),
}

const A2: Fixture = {
  id: 'A2',
  note: 'ohlcv 1d 6mo MU · series, candle · md',
  widget: widget({
    id: 'a2',
    title: 'MU daily',
    size: 'md',
    query: { kind: 'ohlcv', params: { symbols: ['MU'], interval: '1d', range: '6mo' } },
    view: { type: 'series', candle: true },
  }),
  frame: ohlcv([
    [
      'MU',
      [day(10, 1), day(10, 2), ...OCT_DAYS],
      [176.3, 179.8, 181.2, 184.9, 188.35, 186.1, 192.4, 195.8, 193.25, 199.6],
      18_400_000,
    ],
  ]),
}

const A3: Fixture = {
  id: 'A3',
  note: 'quote basket · table · md',
  widget: widget({
    id: 'a3',
    title: 'Basket snapshot',
    size: 'md',
    query: { kind: 'quote', params: { symbols: ['MU', 'SNDK', 'WDC', 'STX'] } },
    view: { type: 'table' },
  }),
  frame: frame('quote', [
    ['MU', 199.6, 3.29, 21_430_000, 'REGULAR', null, null],
    ['SNDK', 112.45, 4.31, 5_120_000, 'REGULAR', null, null],
    ['WDC', 112.3, 1.26, 7_010_000, 'REGULAR', null, null],
    ['STX', 241.7, 2.24, 3_280_000, 'REGULAR', null, null],
  ]),
}

const A4: Fixture = {
  id: 'A4',
  note: 'earnings basket next 60 days · table · sm',
  widget: widget({
    id: 'a4',
    title: 'Upcoming earnings',
    size: 'sm',
    query: { kind: 'earnings', params: { symbols: ['MU', 'SNDK', 'WDC', 'STX'], from: '2026-10-16', to: '2026-12-15' } },
    view: { type: 'table' },
  }),
  frame: frame('earnings', [
    ['MU', '2026-12-17', 'amc', 3.12],
    ['SNDK', '2026-11-05', 'amc', 0.84],
    ['WDC', '2026-10-28', 'amc', 1.56],
    ['STX', '2026-10-21', null, 2.03],
  ]),
}

const A5: Fixture = {
  id: 'A5',
  note: 'news basket · table · md',
  widget: widget({
    id: 'a5',
    title: 'Memory news',
    size: 'md',
    query: { kind: 'news', params: { symbols: ['MU', 'SNDK', 'WDC', 'STX'], limit: 20 } },
    view: { type: 'table' },
  }),
  frame: frame('news', [
    [Date.UTC(2026, 9, 16, 12, 5), 'Micron lifts HBM capacity target as hyperscaler orders firm up', 'Reuters', 'https://example.com/news/mu-hbm', 'MU'],
    [Date.UTC(2026, 9, 15, 21, 40), 'Sandisk raises NAND contract prices for Q4', 'Bloomberg', 'https://example.com/news/sndk-nand', 'SNDK'],
    [Date.UTC(2026, 9, 15, 18, 10), 'Western Digital expands enterprise HDD lineup for AI data centers', 'The Verge', 'https://example.com/news/wdc-hdd', 'WDC'],
    [Date.UTC(2026, 9, 15, 14, 25), 'Seagate guides above consensus on cloud demand', 'CNBC', 'https://example.com/news/stx-guide', 'STX'],
    [Date.UTC(2026, 9, 14, 20, 0), 'Memory pricing tracker: DRAM spot up 6% week over week', 'TrendForce', 'https://example.com/news/dram-spot', 'MU'],
  ]),
}

// ---- B. "Is NVDA's drop today news or just the market?" --------------------------------------

const B1: Fixture = {
  id: 'B1',
  note: 'ohlcv 5m 1d NVDA, SPY, SMH · series, normalize · lg',
  widget: widget({
    id: 'b1',
    title: 'NVDA vs SPY vs SMH today',
    size: 'lg',
    query: { kind: 'ohlcv', params: { symbols: ['NVDA', 'SPY', 'SMH'], interval: '5m', range: '1d' } },
    view: { type: 'series', normalize: true },
  }),
  frame: ohlcv([
    ['NVDA', INTRADAY, [184.2, 183.1, 181.9, 180.4, 179.2, 178.6, 178.9, 177.8], 2_900_000],
    ['SPY', INTRADAY, [668.4, 667.9, 667.1, 666.2, 665.8, 665.1, 665.4, 664.7], 3_100_000],
    ['SMH', INTRADAY, [312.6, 311.4, 309.9, 308.2, 307.1, 306.5, 306.8, 305.6], 420_000],
  ]),
}

const B2: Fixture = {
  id: 'B2',
  note: 'ohlcv 5m 1d NVDA · series, candle · md',
  widget: widget({
    id: 'b2',
    title: 'NVDA today',
    size: 'md',
    query: { kind: 'ohlcv', params: { symbols: ['NVDA'], interval: '5m', range: '1d' } },
    view: { type: 'series', candle: true },
  }),
  frame: ohlcv([['NVDA', INTRADAY, [184.2, 183.1, 181.9, 180.4, 179.2, 178.6, 178.9, 177.8], 2_900_000]]),
}

const B3: Fixture = {
  id: 'B3',
  note: 'quote NVDA + peers + SPY + SMH · table · md',
  widget: widget({
    id: 'b3',
    title: 'Semis today',
    size: 'md',
    query: { kind: 'quote', params: { symbols: ['NVDA', 'AMD', 'AVGO', 'TSM', 'SMH', 'SPY'] } },
    view: { type: 'table' },
  }),
  frame: frame('quote', [
    ['NVDA', 177.8, -3.48, 98_200_000, 'REGULAR', null, null],
    ['AMD', 231.4, -2.11, 31_900_000, 'REGULAR', null, null],
    ['AVGO', 352.9, -1.74, 12_400_000, 'REGULAR', null, null],
    ['TSM', 298.2, -1.95, 9_800_000, 'REGULAR', null, null],
    ['SMH', 305.6, -2.24, 4_100_000, 'REGULAR', null, null],
    ['SPY', 664.7, -0.55, 38_700_000, 'REGULAR', null, null],
  ]),
}

const B4: Fixture = {
  id: 'B4',
  note: 'news NVDA 24h · table · md',
  widget: widget({
    id: 'b4',
    title: 'NVDA news, 24h',
    size: 'md',
    query: { kind: 'news', params: { symbols: ['NVDA'], limit: 20 } },
    view: { type: 'table' },
  }),
  frame: frame('news', [
    [Date.UTC(2026, 9, 16, 13, 48), 'Nvidia slides as chip stocks retreat on export licence report', 'Reuters', 'https://example.com/news/nvda-export', 'NVDA'],
    [Date.UTC(2026, 9, 16, 11, 20), 'Semis lower pre-market after Asian equities fall', 'MarketWatch', 'https://example.com/news/semis-premarket', 'NVDA'],
    [Date.UTC(2026, 9, 15, 22, 5), 'Nvidia to detail next Rubin roadmap at GTC Washington', 'The Information', 'https://example.com/news/nvda-rubin', 'NVDA'],
    [Date.UTC(2026, 9, 15, 15, 30), 'Analyst day preview: what to watch from Nvidia', 'Barron\'s', 'https://example.com/news/nvda-preview', 'NVDA'],
  ]),
}

// ---- C. "Morning check on my watchlist" -----------------------------------------------------

const C1: Fixture = {
  id: 'C1',
  note: 'quote watchlist + SPY + QQQ · table · lg',
  widget: widget({
    id: 'c1',
    title: 'Watchlist pre-market',
    size: 'lg',
    query: { kind: 'quote', params: { symbols: ['AAPL', 'MSFT', 'NVDA', 'TSLA', 'SPY', 'QQQ'] } },
    view: { type: 'table' },
  }),
  frame: frame('quote', [
    ['AAPL', 254.1, 0.42, 48_300_000, 'PRE', 255.9, 0.71],
    ['MSFT', 517.6, -0.18, 19_100_000, 'PRE', 519.2, 0.31],
    ['NVDA', 184.2, 1.05, 142_000_000, 'PRE', 181.3, -1.57],
    ['TSLA', 438.9, 2.36, 96_500_000, 'PRE', 447.5, 1.96],
    ['SPY', 668.4, 0.12, 61_200_000, 'PRE', 668.7, 0.04],
    ['QQQ', 604.3, 0.27, 37_800_000, 'PRE', 604.1, -0.03],
  ]),
}

const C2: Fixture = {
  id: 'C2',
  note: 'earnings watchlist today · table · sm',
  widget: widget({
    id: 'c2',
    title: 'Reporting today',
    size: 'sm',
    query: { kind: 'earnings', params: { symbols: ['AAPL', 'MSFT', 'NVDA', 'TSLA'], from: '2026-10-16', to: '2026-10-16' } },
    view: { type: 'table' },
  }),
  frame: frame('earnings', [['TSLA', '2026-10-16', 'amc', 0.52]]),
}

const C3: Fixture = {
  id: 'C3',
  note: 'news watchlist overnight · table · md',
  widget: widget({
    id: 'c3',
    title: 'Overnight news',
    size: 'md',
    query: { kind: 'news', params: { symbols: ['AAPL', 'MSFT', 'NVDA', 'TSLA'], limit: 20 } },
    view: { type: 'table' },
  }),
  frame: frame('news', [
    [Date.UTC(2026, 9, 16, 10, 15), 'Tesla deliveries beat ahead of tonight\'s report', 'Reuters', 'https://example.com/news/tsla-deliveries', 'TSLA'],
    [Date.UTC(2026, 9, 16, 7, 40), 'Apple expands iPhone production in India', 'Bloomberg', 'https://example.com/news/aapl-india', 'AAPL'],
    [Date.UTC(2026, 9, 16, 2, 10), 'Microsoft signs multi-year Azure deal with OpenAI rival', 'WSJ', 'https://example.com/news/msft-azure', 'MSFT'],
    [Date.UTC(2026, 9, 15, 23, 55), 'Nvidia supplier reports record quarter', 'Nikkei', 'https://example.com/news/nvda-supplier', 'NVDA'],
  ]),
}

const C4: Fixture = {
  id: 'C4',
  note: 'ohlcv 1d 5d SPY, QQQ · series · md',
  widget: widget({
    id: 'c4',
    title: 'SPY and QQQ, 5 days',
    size: 'md',
    query: { kind: 'ohlcv', params: { symbols: ['SPY', 'QQQ'], interval: '1d', range: '5d' } },
    view: { type: 'series' },
  }),
  frame: ohlcv([
    ['SPY', OCT_DAYS.slice(3), [664.1, 666.8, 665.3, 667.9, 668.4], 55_000_000],
    ['QQQ', OCT_DAYS.slice(3), [598.2, 601.5, 599.7, 603.1, 604.3], 32_000_000],
  ]),
}

// ---- extra: search, so every kind has a table fixture ---------------------------------------

const SEARCH: Fixture = {
  id: 'search',
  note: 'search (not a section 5 widget; agent-only kind) · table',
  widget: widget({
    id: 'search',
    title: 'Symbol lookup',
    size: 'sm',
    query: { kind: 'search', params: { q: ['micron', 'sandisk', 'western digital', 'seagate'] } },
    view: { type: 'table' },
  }),
  frame: frame('search', [
    ['micron', 'MU', 'Micron Technology, Inc.', 'NMS'],
    ['sandisk', 'SNDK', 'Sandisk Corporation', 'NMS'],
    ['western digital', 'WDC', 'Western Digital Corporation', 'NMS'],
    ['seagate', 'STX', 'Seagate Technology Holdings plc', 'NMS'],
  ]),
}

// ---- v1.2: the chain view, macro on the series view, and the new tables -----------------------

/** Standard normal CDF and PDF, for Black–Scholes prices on the fixture chain. */
function cdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x))
  const d = 0.3989423 * Math.exp((-x * x) / 2)
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))))
  return x > 0 ? 1 - p : p
}
const pdf = (x: number) => Math.exp((-x * x) / 2) / Math.sqrt(2 * Math.PI)

/**
 * One expiration of an option chain: `each` strikes on both sides of the spot, Black–Scholes quotes
 * with a put skew, a bid/ask around the model price, and volume and open interest that peak at the
 * money. Rows are calls ascending by strike, then puts ascending, as the connector returns them.
 */
function chain(symbol: string, spot: number, expiration: string, dte: number, step: number, each: number): unknown[][] {
  const T = dte / 365
  const r = 0.04
  const base = Math.ceil(spot / step) * step
  const strikes = Array.from({ length: each * 2 }, (_, i) => r2(base + (i - each) * step))
  const rows: unknown[][] = []
  for (const type of ['call', 'put'] as const) {
    strikes.forEach((K, i) => {
      const moneyness = Math.log(K / spot)
      const iv = 0.44 - 0.9 * moneyness + 2.2 * moneyness * moneyness // skew: puts below spot richer
      const d1 = (Math.log(spot / K) + (r + (iv * iv) / 2) * T) / (iv * Math.sqrt(T))
      const d2 = d1 - iv * Math.sqrt(T)
      const disc = Math.exp(-r * T)
      const call = spot * cdf(d1) - K * disc * cdf(d2)
      const price = type === 'call' ? call : call - spot + K * disc
      const delta = type === 'call' ? cdf(d1) : cdf(d1) - 1
      const gamma = pdf(d1) / (spot * iv * Math.sqrt(T))
      const vega = (spot * pdf(d1) * Math.sqrt(T)) / 100
      const thetaCall = (-(spot * pdf(d1) * iv) / (2 * Math.sqrt(T)) - r * K * disc * cdf(d2)) / 365
      const theta = type === 'call' ? thetaCall : thetaCall + (r * K * disc) / 365
      const half = Math.max(0.01, price * 0.012)
      const distance = Math.abs(i + 0.5 - each)
      const oi = Math.round(18_000 * Math.exp(-distance / 4) * (K % 5 === 0 ? 1.6 : 1)) + 350
      const vol = Math.round(oi * 0.31 * (1 + ((i * 5) % 3) / 10))
      rows.push([symbol, expiration, type, K, r2(price - half), r2(price + half), r2(price + half * (((i % 3) - 1) / 2)), vol, oi, r2(iv * 100), r2(delta), round4(gamma), r2(theta), r2(vega), spot, dte])
    })
  }
  return rows
}
const r2 = (n: number) => Math.round(n * 100) / 100
const round4 = (n: number) => Math.round(n * 10_000) / 10_000

const OPTIONS: Fixture = {
  id: 'options',
  note: 'options NVDA, 10 strikes each side, one expiration · chain · lg',
  widget: widget({
    id: 'options',
    title: 'NVDA chain, Oct 23',
    size: 'lg',
    query: { kind: 'options', params: { symbol: 'NVDA', expiration: '2026-10-23', strikes: 10, type: 'both' } },
    view: { type: 'chain' },
  }),
  frame: frame('options', chain('NVDA', 182.43, '2026-10-23', 7, 2.5, 10)),
}

const OPTIONS_SM: Fixture = {
  id: 'options-sm',
  note: 'the same chain at sm (volume and delta dropped) · chain · sm',
  widget: widget({
    id: 'options-sm',
    title: 'NVDA chain',
    size: 'sm',
    query: { kind: 'options', params: { symbol: 'NVDA', expiration: '2026-10-23', strikes: 10, type: 'both' } },
    view: { type: 'chain' },
  }),
  frame: OPTIONS.frame,
}

/** 52 Fridays ending 2026-10-16, at the daily-series time (13:30 UTC). */
const WEEKS = Array.from({ length: 52 }, (_, i) => day(10, 16) - (51 - i) * 7 * 86_400_000)

/** A smooth path from `from` to `to` with a little weekly wobble, two decimals. */
function path(from: number, to: number, wobble: number): number[] {
  return WEEKS.map((_, i) => {
    const t = i / (WEEKS.length - 1)
    return r2(from + (to - from) * t + wobble * Math.sin(i / 3.1) + (wobble / 2) * Math.sin(i / 1.3))
  })
}
/** A policy rate: flat between cuts of 25bp at the given week indexes. */
function steps(start: number, cuts: number[]): number[] {
  return WEEKS.map((_, i) => r2(start - 0.25 * cuts.filter((c) => c <= i).length))
}

const MACRO: Fixture = {
  id: 'macro',
  note: 'macro treasury_10y, treasury_2y, fed_funds, 1y · series · lg',
  widget: widget({
    id: 'macro',
    title: 'Rates, one year',
    size: 'lg',
    query: { kind: 'macro', params: { series: ['treasury_10y', 'treasury_2y', 'fed_funds'], range: '1y' } },
    view: { type: 'series' },
  }),
  frame: frame('macro', [
    ...path(4.08, 4.21, 0.11).map((v, i) => ['treasury_10y', WEEKS[i]!, v]),
    ...path(4.02, 3.49, 0.08).map((v, i) => ['treasury_2y', WEEKS[i]!, v]),
    ...steps(4.58, [9, 22, 44, 48]).map((v, i) => ['fed_funds', WEEKS[i]!, v]),
  ]),
}

const FINANCIALS: Fixture = {
  id: 'financials',
  note: 'financials NVDA quarterly, 4 periods · table · md',
  widget: widget({
    id: 'financials',
    title: 'NVDA quarterly statements',
    size: 'md',
    query: { kind: 'financials', params: { symbols: ['NVDA'], period: 'quarter', limit: 4 } },
    view: { type: 'table' },
  }),
  frame: frame('financials', [
    ['NVDA', '2026-07-26', 46_743_000_000, 33_851_000_000, 28_440_000_000, 26_422_000_000, 1.08, 23_855_000_000, -1_306_000_000, 22_549_000_000, 56_791_000_000, 8_467_000_000, 24_420_000_000],
    ['NVDA', '2026-04-27', 44_062_000_000, 26_668_000_000, 21_638_000_000, 18_775_000_000, 0.76, 27_414_000_000, -1_227_000_000, 26_187_000_000, 53_691_000_000, 8_464_000_000, 24_460_000_000],
    ['NVDA', '2026-01-26', 39_331_000_000, 28_723_000_000, 24_034_000_000, 22_091_000_000, 0.89, 16_629_000_000, -1_077_000_000, 15_552_000_000, 43_210_000_000, 8_463_000_000, 24_530_000_000],
    ['NVDA', '2025-10-27', 35_082_000_000, 26_156_000_000, 21_869_000_000, 19_309_000_000, 0.78, 17_629_000_000, -813_000_000, 16_816_000_000, 38_487_000_000, 8_462_000_000, 24_570_000_000],
  ]),
}

const INSIDERS: Fixture = {
  id: 'insiders',
  note: 'insiders NVDA, latest 6 · table · md',
  widget: widget({
    id: 'insiders',
    title: 'NVDA insider transactions',
    size: 'md',
    query: { kind: 'insiders', params: { symbols: ['NVDA'], limit: 20 } },
    view: { type: 'table' },
  }),
  frame: frame('insiders', [
    ['NVDA', '2026-10-14', 'Jensen Huang', 'President and CEO', 'sell', 75_000, 181.92, 13_644_000, 'https://example.com/sec/nvda-huang-1014'],
    ['NVDA', '2026-10-10', 'Jensen Huang', 'President and CEO', 'sell', 75_000, 186.4, 13_980_000, 'https://example.com/sec/nvda-huang-1010'],
    ['NVDA', '2026-10-07', 'Colette Kress', 'EVP and CFO', 'sell', 40_000, 188.15, 7_526_000, 'https://example.com/sec/nvda-kress-1007'],
    ['NVDA', '2026-10-01', 'Mark Stevens', 'Director', 'sell', 300_000, 187.02, 56_106_000, 'https://example.com/sec/nvda-stevens-1001'],
    ['NVDA', '2026-09-24', 'Ajay Puri', 'EVP Worldwide Field Operations', 'grant', 120_000, null, null, 'https://example.com/sec/nvda-puri-0924'],
    ['NVDA', '2026-09-18', 'Tench Coxe', 'Director', 'sell', 500_000, 176.33, 88_165_000, 'https://example.com/sec/nvda-coxe-0918'],
  ]),
}

const CALENDAR: Fixture = {
  id: 'calendar',
  note: 'calendar US, next week · table · md',
  widget: widget({
    id: 'calendar',
    title: 'US economic calendar',
    size: 'md',
    query: { kind: 'calendar', params: { from: '2026-10-19', to: '2026-10-23', country: 'United States' } },
    view: { type: 'table' },
  }),
  frame: frame('calendar', [
    [Date.UTC(2026, 9, 19, 14, 0), 'United States', 'NAHB Housing Market Index (Oct)', null, '38', '37'],
    [Date.UTC(2026, 9, 20, 12, 30), 'United States', 'Housing Starts (Sep)', null, '1.32M', '1.31M'],
    [Date.UTC(2026, 9, 20, 12, 30), 'United States', 'Building Permits (Sep)', null, '1.34M', '1.33M'],
    [Date.UTC(2026, 9, 21, 14, 30), 'United States', 'EIA Weekly Crude Oil Stocks Change', null, '-1.2M', '3.5M'],
    [Date.UTC(2026, 9, 21, 18, 0), 'United States', 'Fed Beige Book', null, null, null],
    [Date.UTC(2026, 9, 22, 12, 30), 'United States', 'Initial Jobless Claims (week ending Oct 17)', null, '228K', '231K'],
    [Date.UTC(2026, 9, 22, 14, 0), 'United States', 'Existing Home Sales (Sep)', null, '4.05M', '4.00M'],
    [Date.UTC(2026, 9, 23, 12, 30), 'United States', 'Consumer Price Index MoM (Sep), delayed release following the federal government shutdown', null, '0.3%', '0.4%'],
    [Date.UTC(2026, 9, 23, 12, 30), 'United States', 'Core CPI YoY (Sep)', null, '3.1%', '3.1%'],
    [Date.UTC(2026, 9, 23, 13, 45), 'United States', 'S&P Global Manufacturing PMI Flash (Oct)', null, '52.0', '52.0'],
  ]),
}

const MOVERS: Fixture = {
  id: 'movers',
  note: 'movers gainers, top 10 · table · sm',
  widget: widget({
    id: 'movers',
    title: 'Top gainers',
    size: 'sm',
    query: { kind: 'movers', params: { list: 'gainers', limit: 10 } },
    view: { type: 'table' },
  }),
  frame: frame('movers', [
    ['OKLO', 'Oklo Inc.', 142.18, 18.42, 31_400_000],
    ['IONQ', 'IonQ, Inc.', 71.05, 14.9, 22_800_000],
    ['RGTI', 'Rigetti Computing, Inc.', 48.6, 12.37, 61_200_000],
    ['SMR', 'NuScale Power Corporation', 44.21, 11.08, 19_300_000],
    ['QUBT', 'Quantum Computing Inc.', 22.14, 9.71, 44_900_000],
    ['ASTS', 'AST SpaceMobile, Inc.', 79.9, 8.64, 17_600_000],
    ['CRWV', 'CoreWeave, Inc.', 141.33, 7.95, 26_100_000],
    ['SOUN', 'SoundHound AI, Inc.', 18.72, 7.4, 39_500_000],
    ['NBIS', 'Nebius Group N.V.', 128.46, 6.88, 12_700_000],
    ['APLD', 'Applied Digital Corporation', 32.19, 6.21, 28_300_000],
  ]),
}

const VOLATILITY: Fixture = {
  id: 'volatility',
  note: 'volatility NVDA, AMD, TSLA, SPY · table · md',
  widget: widget({
    id: 'volatility',
    title: 'Implied vs realized vol',
    size: 'md',
    query: { kind: 'volatility', params: { symbols: ['NVDA', 'AMD', 'TSLA', 'SPY'] } },
    view: { type: 'table' },
  }),
  frame: frame('volatility', [
    ['NVDA', 44.8, 71.2, 31.5, 33.5, 38.1, 92.4, 24.6, 212.19, 86.62],
    ['AMD', 52.3, 78.9, 36.1, 37.9, 49.7, 101.3, 29.8, 267.08, 76.48],
    ['TSLA', 58.6, 94.5, 42.2, 31.4, 54.3, 118.7, 35.1, 488.54, 214.25],
    ['SPY', 15.2, 45.3, 10.4, 13.8, 11.9, 48.6, 7.2, 673.11, 481.8],
  ]),
}

const PROFILE: Fixture = {
  id: 'profile',
  note: 'profile NVDA, AMD (long description truncates) · table · md',
  widget: widget({
    id: 'profile',
    title: 'Company profiles',
    size: 'md',
    query: { kind: 'profile', params: { symbols: ['NVDA', 'AMD'] } },
    view: { type: 'table' },
  }),
  frame: frame('profile', [
    [
      'NVDA',
      'NVIDIA Corporation',
      'NMS',
      'Technology',
      'Semiconductors',
      4_452_000_000_000,
      36_000,
      2.12,
      'NVIDIA Corporation provides graphics, compute and networking solutions in the United States, Taiwan, China, Hong Kong, and internationally. The Compute & Networking segment includes its Data Center accelerated computing platforms and AI solutions, networking, automotive platforms, Jetson for robotics and other embedded platforms, and DGX Cloud computing services.',
    ],
    [
      'AMD',
      'Advanced Micro Devices, Inc.',
      'NMS',
      'Technology',
      'Semiconductors',
      375_600_000_000,
      28_000,
      1.94,
      'Advanced Micro Devices, Inc. operates as a semiconductor company worldwide. It operates through Data Center, Client, Gaming, and Embedded segments, offering x86 microprocessors and GPUs as standalone devices or incorporated into accelerated processing units, chipsets, data center and professional GPUs, embedded processors, semi-custom SoC products, and FPGAs.',
    ],
  ]),
}

export const FIXTURES: Fixture[] = [A1, A2, A3, A4, A5, B1, B2, B3, B4, C1, C2, C3, C4, SEARCH, OPTIONS, OPTIONS_SM, MACRO, FINANCIALS, INSIDERS, CALENDAR, MOVERS, VOLATILITY, PROFILE]

export function fixture(id: string): Fixture {
  const f = FIXTURES.find((x) => x.id === id)
  if (!f) throw new Error(`no fixture ${id}`)
  return f
}
