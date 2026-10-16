import type { Column, Step } from '@terminal/core'

export const quoteColumns: Column[] = [
  { name: 'symbol', type: 'string' },
  { name: 'price', type: 'number' },
  { name: 'change_pct', type: 'number' },
  { name: 'volume', type: 'number' },
  { name: 'market_state', type: 'string' },
  { name: 'extended_price', type: 'number' },
  { name: 'extended_change_pct', type: 'number' },
]

export const quoteRows: unknown[][] = [
  ['MU', 178.42, 3.12, 24_310_552, 'REGULAR', null, null],
  ['SNDK', 96.1, -1.07, 3_904_118, 'REGULAR', 96.3, 0.21],
  ['WDC', 112.77, 0.0, 6_112_004, 'REGULAR', null, null],
  ['STX', 141.05, -2.44, 2_210_990, 'PRE', 140.2, -0.6],
  ['SPY', 612.33, 0.42, 51_220_118, 'REGULAR', 612.9, 0.09],
  ['QQQ', 548.19, 0.77, 32_118_004, 'REGULAR', null, null],
]

export const newsColumns: Column[] = [
  { name: 'time', type: 'time' },
  { name: 'headline', type: 'string' },
  { name: 'source', type: 'string' },
  { name: 'url', type: 'string' },
  { name: 'symbol', type: 'string' },
]

const now = Date.now()
export const newsRows: unknown[][] = [
  [now - 35 * 60_000, 'Micron raises HBM capacity guidance as hyperscaler demand outpaces supply', 'Reuters', 'https://www.reuters.com/technology/micron-hbm', 'MU'],
  [now - 3 * 3_600_000, 'Western Digital to spin off flash unit on schedule, CFO says', 'Bloomberg', 'https://www.bloomberg.com/news/wdc-flash', 'WDC'],
  [now - 26 * 3_600_000, 'Seagate ships first 40TB HAMR drives to cloud customers', 'The Register', 'https://www.theregister.com/stx-hamr', 'STX'],
  [now - 2 * 86_400_000, 'Sandisk guides Q1 above consensus on contract pricing', 'CNBC', 'https://www.cnbc.com/sndk-guide', 'SNDK'],
]

export const earningsColumns: Column[] = [
  { name: 'symbol', type: 'string' },
  { name: 'date', type: 'string' },
  { name: 'session', type: 'string' },
  { name: 'eps_estimate', type: 'number' },
]
export const earningsRows: unknown[][] = [
  ['MU', '2026-12-17', 'amc', 3.21],
  ['SNDK', '2026-11-06', 'amc', 0.84],
  ['WDC', '2026-10-30', null, 1.52],
  ['STX', '2026-10-28', 'amc', 2.05],
]

export const steps: Step[] = [
  { tool: 'query', args: { kind: 'search', params: { q: ['MU', 'SNDK', 'WDC', 'STX'] } }, summary: 'search MU, SNDK, WDC, STX · 4 rows', ms: 412 },
  { tool: 'query', args: {}, summary: 'ohlcv MU, SNDK, WDC, STX 1d 3mo · 252 rows', ms: 1830 },
  { tool: 'query', args: {}, summary: 'quote MU, SNDK, WDC, STX · 4 rows', ms: 640 },
  { tool: 'query', args: {}, summary: 'news MU, SNDK, WDC, STX limit 20', ms: 2210, error: 'finnhub: 429 Too Many Requests' },
  { tool: 'query', args: {}, summary: 'earnings MU, SNDK, WDC, STX 2026-10-16 → 2026-12-15 · 4 rows', ms: 905 },
  { tool: 'set_workspace', args: {}, summary: 'Memory · 5 widgets', ms: 38 },
]

/** Deterministic random walk so the preview is stable between reloads. */
export function walk(seed: number, n: number, start: number, vol: number): number[] {
  let s = seed
  const rnd = () => {
    s = (s * 1664525 + 1013904223) % 4294967296
    return s / 4294967296
  }
  const out: number[] = []
  let v = start
  for (let i = 0; i < n; i++) {
    v = v * (1 + (rnd() - 0.48) * vol)
    out.push(Number(v.toFixed(2)))
  }
  return out
}

/** Daily bars ending today, as UTC seconds for lightweight-charts. */
export function dailyTimes(n: number): number[] {
  const day = 86_400
  const end = Math.floor(Date.now() / 1000 / day) * day
  const times: number[] = []
  let t = end
  while (times.length < n) {
    const dow = new Date(t * 1000).getUTCDay()
    if (dow !== 0 && dow !== 6) times.unshift(t)
    t -= day
  }
  return times
}
