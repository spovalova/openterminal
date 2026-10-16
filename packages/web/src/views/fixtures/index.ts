/**
 * Hand-written, recorded-shape fixture frames: one per widget row in PLAN.md section 5
 * (A1–A5, B1–B4, C1–C4) plus one `search` frame so every kind has a table fixture.
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

export const FIXTURES: Fixture[] = [A1, A2, A3, A4, A5, B1, B2, B3, B4, C1, C2, C3, C4, SEARCH]

export function fixture(id: string): Fixture {
  const f = FIXTURES.find((x) => x.id === id)
  if (!f) throw new Error(`no fixture ${id}`)
  return f
}
