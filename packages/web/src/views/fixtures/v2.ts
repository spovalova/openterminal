/**
 * v2 fixtures (PLAN.md section 17): one widget per new preset, with frames shaped as the v2 runner stamps them
 * (`meta.fields` from the annotations, a `lineage`). Built the way `packages/core/test/presets.test.ts` builds
 * its frames; the numbers are synthetic but plausible.
 */
import { parseAnyWidget, type Column, type FieldConfig, type Frame, type WidgetV2, type WidgetV2Input } from '@terminal/core'

export type FixtureV2 = { id: string; note: string; widget: WidgetV2; frames: Record<string, Frame>; frame: Frame }

/** 2026-10-16 09:30 ET, the morning every fixture was "recorded". */
const FETCHED_AT = Date.UTC(2026, 9, 16, 13, 30)
const r2 = (n: number) => Math.round(n * 100) / 100

function frame(columns: [string, Column['type']][], rows: unknown[][], fields: Record<string, FieldConfig> = {}, lineage: Record<string, unknown> = {}): Frame {
  return { columns: columns.map(([name, type]) => ({ name, type })), rows, meta: { connector: 'fixture', fetchedAt: FETCHED_AT, ttl: 600_000, fields, lineage } }
}

function fixture(id: string, note: string, widget: WidgetV2Input, frames: Record<string, Frame>): FixtureV2 {
  const w = parseAnyWidget(widget)
  return { id, note, widget: w, frames, frame: frames.main ?? Object.values(frames)[0]! }
}

/** `n` NYSE-style business days ending 2026-10-15 (Thursday), at 13:30 UTC, oldest first. */
function businessDays(n: number): number[] {
  const out: number[] = []
  const d = new Date(Date.UTC(2026, 9, 15, 13, 30))
  while (out.length < n) {
    const dow = d.getUTCDay()
    if (dow !== 0 && dow !== 6) out.unshift(d.getTime())
    d.setUTCDate(d.getUTCDate() - 1)
  }
  return out
}

/** A deterministic random walk: `n` closes from `start` with daily moves of about `vol`, a drift, and a wobble. */
function walk(start: number, n: number, vol: number, drift = 0, seed = 1): number[] {
  const out: number[] = []
  let p = start
  let s = seed
  for (let i = 0; i < n; i++) {
    s = (s * 9301 + 49297) % 233280
    const u = s / 233280 - 0.5
    p = Math.max(1, p * (1 + drift + vol * u + 0.004 * Math.sin(i / 9)))
    out.push(r2(p))
  }
  return out
}

/** OHLCV rows [symbol, time, open, high, low, close, volume] from a close path. */
function bars(symbol: string, times: number[], closes: number[], baseVolume: number): unknown[][] {
  return closes.map((close, i) => {
    const open = i === 0 ? r2(close * 0.995) : closes[i - 1]!
    const hi = Math.max(open, close)
    const lo = Math.min(open, close)
    return [symbol, times[i]!, open, r2(hi * 1.008), r2(lo * 0.992), close, Math.round(baseVolume * (0.7 + ((i * 7) % 7) / 10))]
  })
}

const OHLCV: [string, Column['type']][] = [
  ['symbol', 'string'],
  ['time', 'time'],
  ['open', 'number'],
  ['high', 'number'],
  ['low', 'number'],
  ['close', 'number'],
  ['volume', 'number'],
]
const OHLCV_FIELDS: Record<string, FieldConfig> = { close: { unit: 'usd', priority: 1 }, open: { unit: 'usd' }, high: { unit: 'usd' }, low: { unit: 'usd' }, volume: { unit: 'shares', format: 'integer', priority: 3 } }

// ---- price: line on close, volume pane, earnings markers, a level and an earnings-window band ------------------

const DAYS_120 = businessDays(120)
const NVDA = walk(118, 120, 0.028, 0.0035, 7)
const PRICE = fixture(
  'v2-price',
  'price · volume pane, earnings markers with the reaction, a 200 level, the last report window shaded · lg',
  {
    id: 'v2-price',
    title: 'NVDA, 6 months with earnings',
    size: 'lg',
    data: {
      main: { recipe: 'ohlcv', params: { symbols: ['NVDA'], interval: '1d', range: '6mo' } },
      events: { recipe: 'eps_history', params: { symbols: ['NVDA'], limit: 4 } },
    },
    view: { preset: 'price', volume: true, events: 'events', levels: [200], band: [DAYS_120[98]!, DAYS_120[103]!] },
  },
  {
    main: frame(OHLCV, bars('NVDA', DAYS_120, NVDA, 180_000_000), OHLCV_FIELDS, { recipe: 'ohlcv', connector: 'yahoo', route: 'chart' }),
    events: frame(
      [
        ['symbol', 'string'],
        ['date', 'time'],
        ['label', 'string'],
        ['kind', 'string'],
        ['eps_actual', 'number'],
        ['eps_estimate', 'number'],
        ['surprise_pct', 'number'],
        ['reaction_pct', 'number'],
      ],
      [
        ['NVDA', DAYS_120[37]!, 'Q1 FY27 report', 'earnings', 0.96, 0.93, 3.2, 4.8],
        ['NVDA', DAYS_120[100]!, 'Q2 FY27 report', 'earnings', 1.08, 1.01, 6.9, -3.1],
      ],
      { eps_actual: { unit: 'usd', label: 'EPS' }, eps_estimate: { unit: 'usd', label: 'Est.' }, surprise_pct: { unit: 'percent', format: 'change', label: 'Surprise' }, reaction_pct: { unit: 'percent', format: 'change', label: 'Reaction' } },
      { recipe: 'eps_history', connector: 'openbb', route: 'equity/fundamental/historical_eps' },
    ),
  },
)

// ---- compare: three sector ETFs rebased, legend labels from the view ------------------------------------------

const DAYS_60 = businessDays(60)
const COMPARE = fixture(
  'v2-compare',
  'compare · three sector ETFs indexed to 100, legend labels from the view · md',
  {
    id: 'v2-compare',
    title: 'Tech vs energy vs financials, 3 months',
    size: 'md',
    data: { main: { recipe: 'ohlcv', params: { symbols: ['XLK', 'XLE', 'XLF'], interval: '1d', range: '3mo' } } },
    view: { preset: 'compare', normalize: true, labels: { XLK: 'Tech', XLE: 'Energy', XLF: 'Financials' } },
  },
  {
    main: frame(
      OHLCV,
      [...bars('XLK', DAYS_60, walk(268, 60, 0.012, 0.0022, 3), 6_000_000), ...bars('XLE', DAYS_60, walk(91, 60, 0.014, -0.0012, 5), 14_000_000), ...bars('XLF', DAYS_60, walk(52, 60, 0.009, 0.0008, 11), 30_000_000)],
      OHLCV_FIELDS,
      { recipe: 'ohlcv' },
    ),
  },
)

// ---- curve: the Treasury curve today against a month ago, on a numeric axis (maturity in years) ----------------

const TENORS: [string, number][] = [
  ['1M', 1 / 12],
  ['3M', 0.25],
  ['6M', 0.5],
  ['1Y', 1],
  ['2Y', 2],
  ['3Y', 3],
  ['5Y', 5],
  ['7Y', 7],
  ['10Y', 10],
  ['20Y', 20],
  ['30Y', 30],
]
const TODAY = [4.12, 4.05, 3.94, 3.72, 3.51, 3.49, 3.6, 3.78, 4.02, 4.6, 4.68]
const AGO = [4.3, 4.24, 4.11, 3.9, 3.62, 3.58, 3.66, 3.83, 4.07, 4.64, 4.72]
const CURVE = fixture(
  'v2-curve',
  'curve · Treasury par curve today and a month ago, maturity in years on the x-axis · md',
  {
    id: 'v2-curve',
    title: 'Treasury curve',
    size: 'md',
    data: { main: { recipe: 'yield_curve', params: {} } },
    view: { preset: 'curve' },
  },
  {
    main: frame(
      [
        ['series', 'string'],
        ['maturity', 'string'],
        ['maturity_years', 'number'],
        ['rate', 'number'],
      ],
      [...TENORS.map(([m, y], i) => ['today', m, r2(y), TODAY[i]!]), ...TENORS.map(([m, y], i) => ['a month ago', m, r2(y), AGO[i]!])],
      { rate: { unit: 'percent', label: 'Rate' }, maturity_years: { role: 'x', unit: 'years', label: 'Maturity' } },
      { recipe: 'yield_curve', connector: 'openbb', route: 'fixedincome/government/treasury_rates' },
    ),
  },
)

// ---- indicator: AMD with SMA 50, volume, RSI 14 and MACD panes from a transform ----------------------------------

function ema(values: number[], n: number): number[] {
  const k = 2 / (n + 1)
  const out: number[] = []
  let prev = values[0] ?? 0
  for (const v of values) {
    prev = v * k + prev * (1 - k)
    out.push(prev)
  }
  return out
}
function rsi(values: number[], n: number): (number | null)[] {
  const out: (number | null)[] = []
  let gain = 0
  let loss = 0
  for (let i = 0; i < values.length; i++) {
    if (i === 0) {
      out.push(null)
      continue
    }
    const d = values[i]! - values[i - 1]!
    const g = Math.max(d, 0)
    const l = Math.max(-d, 0)
    if (i <= n) {
      gain += g / n
      loss += l / n
      out.push(i < n ? null : r2(100 - 100 / (1 + gain / (loss || 1e-9))))
    } else {
      gain = (gain * (n - 1) + g) / n
      loss = (loss * (n - 1) + l) / n
      out.push(r2(100 - 100 / (1 + gain / (loss || 1e-9))))
    }
  }
  return out
}
const AMD = walk(162, 120, 0.03, 0.0018, 17)
const AMD_BARS = bars('AMD', DAYS_120, AMD, 42_000_000)
const MACD = ema(AMD, 12).map((v, i) => v - ema(AMD, 26)[i]!)
const SIGNAL = ema(MACD, 9)
const SMA50 = AMD.map((_, i) => (i < 49 ? null : r2(AMD.slice(i - 49, i + 1).reduce((a, b) => a + b, 0) / 50)))
const RSI14 = rsi(AMD, 14)
const INDICATOR = fixture(
  'v2-indicator',
  'indicator · AMD close with SMA 50, volume, RSI 14 with 30/70 levels, MACD with a signed histogram · lg',
  {
    id: 'v2-indicator',
    title: 'AMD with RSI and MACD',
    size: 'lg',
    data: {
      price: { recipe: 'ohlcv', params: { symbols: ['AMD'], interval: '1d', range: '6mo' } },
      main: { inputs: { price: { recipe: 'ohlcv', params: { symbols: ['AMD'], interval: '1d', range: '6mo' } } }, code: 'result = ot.macd(ot.rsi(price, 14))' },
    },
    view: { preset: 'indicator', rsi: 14, macd: true, volume: true },
  },
  {
    price: frame(OHLCV, AMD_BARS, OHLCV_FIELDS, { recipe: 'ohlcv' }),
    main: frame(
      [...OHLCV, ['sma_50', 'number'], ['rsi', 'number'], ['macd', 'number'], ['macd_signal', 'number'], ['macd_hist', 'number']],
      AMD_BARS.map((row, i) => [...row, SMA50[i], RSI14[i], r2(MACD[i]!), r2(SIGNAL[i]!), r2(MACD[i]! - SIGNAL[i]!)]),
      { ...OHLCV_FIELDS, sma_50: { unit: 'usd', label: 'SMA 50' }, rsi: { label: 'RSI 14' }, macd: { label: 'MACD' }, macd_signal: { label: 'Signal' }, macd_hist: { label: 'Histogram' } },
      { code: 'result = ot.macd(ot.rsi(price, 14))', inputs: { price: { recipe: 'ohlcv' } } },
    ),
  },
)

// ---- table: a compare table, metrics by symbol with best and worst marked, NVDA highlighted ---------------------

const METRICS_FIELDS: Record<string, FieldConfig> = {
  symbol: { priority: 1 },
  pe: { unit: 'ratio', label: 'P/E', priority: 2 },
  forward_pe: { unit: 'ratio', label: 'Fwd P/E', priority: 3 },
  revenue_growth: { unit: 'percent', format: 'change', label: 'Rev growth', priority: 4 },
  gross_margin: { unit: 'percent', label: 'Gross margin', priority: 5 },
  fcf_margin: { unit: 'percent', label: 'FCF margin', priority: 6 },
  debt_to_equity: { unit: 'ratio', label: 'Debt/equity', priority: 7 },
  market_cap: { unit: 'usd', format: 'compact', label: 'Mkt cap', priority: 8 },
}
const METRIC_COLUMNS: [string, Column['type']][] = [
  ['symbol', 'string'],
  ['market_cap', 'number'],
  ['pe', 'number'],
  ['forward_pe', 'number'],
  ['revenue_growth', 'number'],
  ['gross_margin', 'number'],
  ['fcf_margin', 'number'],
  ['debt_to_equity', 'number'],
]
const TABLE_COMPARE = fixture(
  'v2-table-compare',
  'table · metrics by symbol sorted by P/E, best and worst marked per column, NVDA highlighted · md',
  {
    id: 'v2-table-compare',
    title: 'Neoclouds and NVDA, valuation and margins',
    size: 'md',
    data: { main: { recipe: 'metrics', params: { symbols: ['NVDA', 'CRWV', 'NBIS', 'IREN', 'APLD'] } } },
    view: { preset: 'table', sort: { column: 'pe', dir: 'asc' }, highlight: 'NVDA', extremes: true },
  },
  {
    main: frame(
      METRIC_COLUMNS,
      [
        ['NVDA', 4_452_000_000_000, 51.2, 32.4, 55.6, 72.4, 46.1, 0.41, null],
        ['CRWV', 68_000_000_000, null, 142.0, 206.7, 74.0, -61.3, 3.9, null],
        ['NBIS', 31_000_000_000, null, 88.5, 625.0, 58.2, -89.7, 0.2, null],
        ['IREN', 11_000_000_000, 38.7, 22.1, 172.5, 83.1, -12.4, 0.6, null],
        ['APLD', 7_000_000_000, null, 61.3, 84.2, 31.5, -48.0, 2.7, null],
      ].map((r) => r.slice(0, 8)),
      METRICS_FIELDS,
      { recipe: 'metrics', connector: 'yahoo', route: 'quoteSummary' },
    ),
  },
)

// ---- facts: a snapshot with several numbers (the card), and a table over one row (the rule) ---------------------

const SNAPSHOT_COLUMNS: [string, Column['type']][] = [
  ['symbol', 'string'],
  ['last_price', 'number'],
  ['change_percent', 'number'],
  ['market_cap', 'number'],
  ['pe', 'number'],
  ['dividend_yield', 'number'],
  ['beta', 'number'],
  ['year_high', 'number'],
  ['year_low', 'number'],
  ['volume', 'number'],
  ['sector', 'string'],
  ['exchange', 'string'],
]
const SNAPSHOT_FIELDS: Record<string, FieldConfig> = {
  last_price: { unit: 'usd', key: true, label: 'Last', priority: 1 },
  change_percent: { unit: 'percent', format: 'change', label: 'Chg %', priority: 2 },
  market_cap: { unit: 'usd', format: 'compact', label: 'Market cap', priority: 3 },
  pe: { unit: 'ratio', label: 'P/E', priority: 4 },
  dividend_yield: { unit: 'percent', label: 'Dividend yield', priority: 5 },
  beta: { label: 'Beta', priority: 6 },
  year_high: { unit: 'usd', label: '52w high', priority: 7 },
  year_low: { unit: 'usd', label: '52w low', priority: 8 },
  volume: { unit: 'shares', format: 'integer', label: 'Volume', priority: 9 },
}
const SNAPSHOT_ROW = ['TSLA', 438.9, 2.36, 1_410_000_000_000, 248.6, 0, 2.07, 488.54, 214.25, 96_500_000, 'Consumer Cyclical', 'NMS']
const FACTS = fixture(
  'v2-facts',
  'facts · a quote snapshot as label-over-value facts wrapped to the width · md',
  {
    id: 'v2-facts',
    title: 'TSLA snapshot',
    size: 'md',
    data: { main: { connector: 'yahoo', route: 'quoteSummary', params: { symbol: ['TSLA'], modules: ['price', 'summaryDetail'] } } },
    view: { preset: 'facts' },
  },
  { main: frame(SNAPSHOT_COLUMNS, [SNAPSHOT_ROW], SNAPSHOT_FIELDS, { connector: 'yahoo', route: 'quoteSummary' }) },
)
const TABLE_ONE_ROW = fixture(
  'v2-table-one-row',
  'table over one row · renders the facts card (product rule 8), not a lonely row under twelve headers · sm',
  {
    id: 'v2-table-one-row',
    title: 'TSLA (asked as a table)',
    size: 'sm',
    data: { main: { connector: 'yahoo', route: 'quoteSummary', params: { symbol: ['TSLA'], modules: ['price', 'summaryDetail'] } } },
    view: { preset: 'table' },
  },
  { main: frame(SNAPSHOT_COLUMNS, [SNAPSHOT_ROW], SNAPSHOT_FIELDS, { connector: 'yahoo', route: 'quoteSummary' }) },
)

// ---- stat: a derived number from a transform (P/E TTM) with its change line ----------------------------------------

const STAT = fixture(
  'v2-stat',
  'stat · P/E (TTM) from a transform, the key field, with the change since the last report under it · sm',
  {
    id: 'v2-stat',
    title: 'NVDA P/E (TTM)',
    size: 'sm',
    data: { main: { inputs: { price: { recipe: 'ohlcv', params: { symbols: ['NVDA'], interval: '1d', range: '2y' } }, eps: { recipe: 'eps_history', params: { symbols: ['NVDA'], limit: 12 } } }, code: 'result = pe_ttm(price, eps)' } },
    view: { preset: 'stat' },
  },
  {
    main: frame(
      [
        ['symbol', 'string'],
        ['pe', 'number'],
        ['pe_change_pct', 'number'],
      ],
      [['NVDA', 42.1, -6.4]],
      { pe: { unit: 'ratio', key: true, label: 'P/E (TTM)' }, pe_change_pct: { unit: 'percent', format: 'change', label: 'vs last report' } },
      { code: 'result = pe_ttm(price, eps)', inputs: { price: { recipe: 'ohlcv' }, eps: { recipe: 'eps_history' } } },
    ),
  },
)

// ---- heatmap: a correlation matrix (wide frame melted) and sector returns by month ---------------------------------

const MAG7 = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA']
const CORR: number[][] = [
  [1, 0.72, 0.58, 0.66, 0.69, 0.61, 0.38],
  [0.72, 1, 0.64, 0.71, 0.74, 0.66, 0.35],
  [0.58, 0.64, 1, 0.55, 0.57, 0.6, 0.41],
  [0.66, 0.71, 0.55, 1, 0.7, 0.68, 0.4],
  [0.69, 0.74, 0.57, 0.7, 1, 0.73, 0.33],
  [0.61, 0.66, 0.6, 0.68, 0.73, 1, 0.37],
  [0.38, 0.35, 0.41, 0.4, 0.33, 0.37, 1],
]
const HEATMAP = fixture(
  'v2-heatmap',
  'heatmap · Mag 7 correlation matrix from a transform, diverging scale with a legend · md',
  {
    id: 'v2-heatmap',
    title: 'Mag 7 correlation, 6 months',
    size: 'md',
    data: { main: { inputs: { price: { recipe: 'ohlcv', params: { symbols: MAG7, interval: '1d', range: '6mo' } } }, code: 'result = ot.returns(price).pivot(columns="symbol", values="ret").corr().reset_index()' } },
    view: { preset: 'heatmap' },
  },
  {
    main: frame(
      [['symbol', 'string'], ...MAG7.map((s): [string, Column['type']] => [s, 'number'])],
      MAG7.map((s, i) => [s, ...CORR[i]!]),
      {},
      { code: 'corr', inputs: { price: { recipe: 'ohlcv' } } },
    ),
  },
)
const SECTORS: [string, number[]][] = [
  ['Tech', [3.8, 1.2, 5.1, -2.4]],
  ['Energy', [-4.1, 2.6, -1.8, 6.2]],
  ['Financials', [1.9, 0.4, 2.2, -0.9]],
  ['Health care', [-0.6, -2.1, 1.4, 0.8]],
  ['Utilities', [2.2, 3.1, -0.4, 1.1]],
  ['Industrials', [1.1, -0.8, 2.9, -1.6]],
]
const HEATMAP_RETURNS = fixture(
  'v2-heatmap-returns',
  'heatmap · sector returns by month (percent), wide frame melted by the name column · sm',
  {
    id: 'v2-heatmap-returns',
    title: 'Sector returns by month',
    size: 'sm',
    data: { main: { inputs: { price: { recipe: 'ohlcv', params: { symbols: ['XLK', 'XLE', 'XLF', 'XLV', 'XLU', 'XLI'], interval: '1d', range: '6mo' } } }, code: 'result = monthly_returns(price)' } },
    view: { preset: 'heatmap' },
  },
  {
    main: frame(
      [
        ['name', 'string'],
        ['Jul', 'number'],
        ['Aug', 'number'],
        ['Sep', 'number'],
        ['Oct', 'number'],
      ],
      SECTORS.map(([name, v]) => [name, ...v]),
      { Jul: { unit: 'percent' }, Aug: { unit: 'percent' }, Sep: { unit: 'percent' }, Oct: { unit: 'percent' } },
      { code: 'monthly_returns', inputs: { price: { recipe: 'ohlcv' } } },
    ),
  },
)

export const V2_FIXTURES: FixtureV2[] = [PRICE, COMPARE, CURVE, INDICATOR, TABLE_COMPARE, FACTS, TABLE_ONE_ROW, STAT, HEATMAP, HEATMAP_RETURNS]
