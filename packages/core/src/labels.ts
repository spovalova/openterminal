/**
 * Display names for raw identifiers (taste round, change 11): a column name, a series name, an enum value or a
 * recipe id never reaches the UI as typed. `fieldLabel` turns `eps_actual` into "EPS actual", `spread_10y_2y`
 * into "Spread 10Y 2Y", `trailingPE` into "Trailing PE", `num_estimates` into "Estimates"; `enumLabel` turns
 * `after-hours` into "After the close", `not-supplied` into an em dash and `buy` into "Buy". Annotated labels
 * (field config) always win; these are the fallbacks for everything nobody labelled.
 */

/** Tokens kept in their conventional case, by lowercase token. */
const TOKENS: Record<string, string> = {
  pct: '%',
  percent: '%',
  eps: 'EPS',
  pe: 'P/E',
  peg: 'PEG',
  ps: 'P/S',
  pb: 'P/B',
  ev: 'EV',
  ebitda: 'EBITDA',
  iv: 'IV',
  hv: 'HV',
  iv30: 'IV30',
  hv30: 'HV30',
  roe: 'ROE',
  roa: 'ROA',
  ttm: 'TTM',
  ytd: 'YTD',
  cagr: 'CAGR',
  usd: 'USD',
  id: 'ID',
  ipo: 'IPO',
  etf: 'ETF',
  oi: 'OI',
  yoy: 'YoY',
  qoq: 'QoQ',
  mkt: 'Mkt',
  avg: 'Avg',
  fcf: 'FCF',
  dte: 'DTE',
  atm: 'ATM',
  itm: 'ITM',
  otm: 'OTM',
  rsi: 'RSI',
  macd: 'MACD',
  sma: 'SMA',
  ema: 'EMA',
  vwap: 'VWAP',
  bps: 'bps',
  cpi: 'CPI',
  ppi: 'PPI',
  gdp: 'GDP',
  fomc: 'FOMC',
  'p/e': 'P/E',
  sp: 'S&P',
  moodys: "Moody's",
  cusip: 'CUSIP',
  isin: 'ISIN',
  url: 'URL',
  '52w': '52w',
}

/** Leading tokens that add nothing to a label ("num estimates", "number of analysts"). */
const DROP_LEADING = new Set(['num', 'number', 'of', 'n'])

/** Split a raw name into words: underscores, dashes, dots and spaces, then camelCase boundaries. */
export function splitName(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_.-]+/)
    .filter(Boolean)
}

function wordOf(token: string, first: boolean): string {
  const lower = token.toLowerCase()
  if (TOKENS[lower]) return TOKENS[lower]
  // A tenor or a period: 10y, 2y, 3m, 30d, 1mo, 52w
  if (/^\d+(y|m|d|w|mo)$/i.test(token)) return token.toUpperCase().replace(/MO$/, 'mo').replace(/W$/, 'w')
  // An acronym the author already upper-cased (PE, NDX) stays; everything else is lower, the first word capitalised.
  if (/^[A-Z0-9]{2,}$/.test(token)) return token
  const word = lower
  return first ? word.charAt(0).toUpperCase() + word.slice(1) : word
}

/** Flag columns with a conventional short header (taste round 2, change 8: "Conv.", not "Is convertible"). */
const FLAG_LABELS: Record<string, string> = { is_convertible: 'Conv.', is_callable: 'Callable', is_144a: '144A', is_etf: 'ETF', is_active: 'Active' }

/** The display name for a column, series or param name that nobody labelled. */
export function fieldLabel(name: string): string {
  const flag = FLAG_LABELS[String(name).toLowerCase()]
  if (flag) return flag
  const raw = splitName(String(name))
  let words = raw
  // "num_estimates" → "Estimates", "number_of_analysts" → "Analysts"; never empty.
  while (words.length > 1 && DROP_LEADING.has(words[0]!.toLowerCase())) words = words.slice(1)
  if (words.length === 0) return String(name)
  const out = words.map((w, i) => wordOf(w, i === 0))
  // "Surprise %" reads better than "Surprise % " and "Change % 1d" than "Change %1d": tokens are joined by spaces.
  return out.join(' ').replace(/\s+%/g, ' %').trim()
}

/** Enum values with a conventional reading. */
const ENUMS: Record<string, string> = {
  'after-hours': 'After the close',
  after_hours: 'After the close',
  'post-market': 'After the close',
  post_market: 'After the close',
  amc: 'After the close',
  'pre-market': 'Before the open',
  pre_market: 'Before the open',
  bmo: 'Before the open',
  'not-supplied': '—',
  not_supplied: '—',
  'n/a': '—',
  na: '—',
  none: '—',
  null: '—',
  unknown: '—',
  regular: 'Regular session',
  'strong buy': 'Strong buy',
  strong_buy: 'Strong buy',
  'strong sell': 'Strong sell',
  strong_sell: 'Strong sell',
}

/**
 * The display text for a string cell that reads as an identifier: a known enum by its reading, else a lowercase
 * identifier (`buy`, `after_hours`, `consumer-cyclical`) in sentence case with spaces. Anything with capitals,
 * digits mixed with letters, or sentence punctuation is prose or a name and passes through as is.
 */
export function enumLabel(value: string): string {
  const v = value.trim()
  const known = ENUMS[v.toLowerCase()]
  if (known) return known
  if (/^[a-z]+([-_][a-z]+)*$/.test(v)) {
    const words = v.split(/[-_]/)
    return words.map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(' ')
  }
  return value
}
