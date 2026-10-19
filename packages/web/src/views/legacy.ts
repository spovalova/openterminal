/**
 * The v1 kind tables (formats, column priority, default sort, stat labels and secondary lines) as field config.
 * A v1 frame carries no `meta.fields`, so until phase 3 removes kinds these tables stand in for the annotations:
 * `legacyFieldConfig(kind, columns)` is the annotations layer `mergeFieldConfig` folds under the widget's own
 * overrides. Nothing else reads a kind.
 */
import { STAT_KEY_COLUMN, fieldLabel, type Column, type FieldOverrides, type Kind, type StatKind } from '@terminal/core'
import type { CellFormat } from '@terminal/ui'

export type SortSpec = { column: string; dir: 'asc' | 'desc' }

/**
 * Typed cell formats per kind; columns not listed render as text.
 * `change` is for signed moves (coloured up/down), `percent` for levels such as margins, yields, IV
 * and weights, `compact` for large amounts (market cap, statement lines, shares), `integer` for volumes.
 */
export const KIND_FORMATS: Record<Kind, Record<string, CellFormat>> = {
  search: {},
  quote: { price: 'price', change_pct: 'change', volume: 'integer', extended_price: 'price', extended_change_pct: 'change' },
  ohlcv: { time: 'time', open: 'price', high: 'price', low: 'price', close: 'price', volume: 'integer' },
  news: { time: 'time', url: 'link' },
  earnings: { date: 'date', eps_estimate: 'price' },
  profile: { market_cap: 'compact', employees: 'integer', beta: 'price' },
  metrics: {
    market_cap: 'compact',
    pe: 'price',
    forward_pe: 'price',
    peg: 'price',
    ev_ebitda: 'price',
    ps: 'price',
    pb: 'price',
    gross_margin: 'percent',
    operating_margin: 'percent',
    profit_margin: 'percent',
    revenue_growth: 'change',
    earnings_growth: 'change',
    roe: 'percent',
    debt_to_equity: 'price',
    dividend_yield: 'percent',
  },
  financials: {
    period_ending: 'date',
    revenue: 'compact',
    gross_profit: 'compact',
    operating_income: 'compact',
    net_income: 'compact',
    eps: 'price',
    operating_cash_flow: 'compact',
    capex: 'compact',
    free_cash_flow: 'compact',
    cash: 'compact',
    debt: 'compact',
    shares: 'compact',
  },
  estimates: { analysts: 'integer', target_low: 'price', target_consensus: 'price', target_high: 'price', upside_pct: 'change', eps_estimate_q: 'price', eps_estimate_y: 'price', eps_growth_y: 'change' },
  eps_history: { date: 'date', eps_actual: 'price', eps_estimate: 'price', surprise_pct: 'change' },
  dividends: { ex_date: 'date', amount: 'price' },
  insiders: { date: 'date', shares: 'compact', price: 'price', value: 'compact', url: 'link' },
  institutions: { date: 'date', shares: 'compact', change_pct: 'change', value: 'compact' },
  short_interest: { date: 'date', short_interest: 'compact', change_pct: 'change', avg_volume: 'integer', days_to_cover: 'price' },
  options: { expiration: 'date', strike: 'price', bid: 'price', ask: 'price', last: 'price', volume: 'integer', open_interest: 'integer', iv: 'percent', delta: 'price', gamma: 'price', theta: 'price', vega: 'price', underlying_price: 'price', dte: 'integer' },
  volatility: { iv30: 'percent', iv30_high: 'percent', iv30_low: 'percent', iv_rank: 'price', hv30: 'percent', hv30_high: 'percent', hv30_low: 'percent', year_high: 'price', year_low: 'price' },
  calendar: { time: 'time' },
  ipos: { date: 'date', price: 'price', offer_amount: 'compact' },
  movers: { price: 'price', change_pct: 'change', volume: 'integer' },
  holdings: { weight: 'percent' },
  macro: { time: 'time', value: 'price' },
  yield_curve: { date: 'date', years: 'price', rate: 'percent' },
}

/**
 * Column priority per kind, most important first. The first three always show; each later column needs the
 * widget body about 60px wider. Columns not listed come after the listed ones in frame order.
 */
export const KIND_PRIORITY: Partial<Record<Kind, string[]>> = {
  search: ['symbol', 'name', 'exchange', 'query'],
  quote: ['symbol', 'price', 'change_pct', 'volume', 'market_state', 'extended_price', 'extended_change_pct'],
  ohlcv: ['symbol', 'time', 'close', 'volume', 'open', 'high', 'low'],
  news: ['headline', 'time', 'source', 'symbol', 'url'],
  earnings: ['symbol', 'date', 'eps_estimate', 'session'],
  profile: ['symbol', 'name', 'sector', 'market_cap', 'industry', 'exchange', 'employees', 'beta', 'description'],
  metrics: ['symbol', 'pe', 'forward_pe', 'market_cap', 'ps', 'ev_ebitda', 'peg', 'pb', 'gross_margin', 'operating_margin', 'profit_margin', 'revenue_growth', 'earnings_growth', 'roe', 'debt_to_equity', 'dividend_yield'],
  financials: ['symbol', 'period_ending', 'revenue', 'net_income', 'eps', 'gross_profit', 'operating_income', 'free_cash_flow', 'operating_cash_flow', 'capex', 'cash', 'debt', 'shares'],
  estimates: ['symbol', 'target_consensus', 'upside_pct', 'recommendation', 'analysts', 'target_low', 'target_high', 'eps_estimate_q', 'eps_estimate_y', 'eps_growth_y'],
  eps_history: ['symbol', 'date', 'eps_actual', 'eps_estimate', 'surprise_pct'],
  dividends: ['symbol', 'ex_date', 'amount'],
  insiders: ['symbol', 'name', 'action', 'date', 'value', 'shares', 'price', 'title', 'url'],
  institutions: ['symbol', 'holder', 'value', 'change_pct', 'shares', 'date'],
  short_interest: ['symbol', 'date', 'short_interest', 'days_to_cover', 'change_pct', 'avg_volume'],
  options: ['strike', 'type', 'bid', 'ask', 'iv', 'open_interest', 'volume', 'last', 'delta', 'expiration', 'dte', 'symbol', 'gamma', 'theta', 'vega', 'underlying_price'],
  volatility: ['symbol', 'iv30', 'iv_rank', 'hv30', 'iv30_high', 'iv30_low', 'hv30_high', 'hv30_low', 'year_high', 'year_low'],
  calendar: ['event', 'time', 'actual', 'consensus', 'previous', 'country'],
  ipos: ['symbol', 'name', 'date', 'price', 'offer_amount', 'exchange', 'status'],
  movers: ['symbol', 'change_pct', 'price', 'name', 'volume'],
  holdings: ['symbol', 'weight', 'name', 'etf'],
  macro: ['series', 'time', 'value'],
  yield_curve: ['maturity', 'rate', 'date', 'years'],
}

/** Default sort per kind; `undefined` keeps the connector's row order. */
export const KIND_DEFAULT_SORT: Record<Kind, SortSpec | undefined> = {
  search: undefined,
  quote: { column: 'symbol', dir: 'asc' },
  ohlcv: { column: 'time', dir: 'desc' },
  news: { column: 'time', dir: 'desc' },
  earnings: { column: 'date', dir: 'asc' },
  profile: { column: 'symbol', dir: 'asc' },
  metrics: { column: 'symbol', dir: 'asc' },
  financials: undefined,
  estimates: { column: 'symbol', dir: 'asc' },
  eps_history: undefined,
  dividends: undefined,
  insiders: { column: 'date', dir: 'desc' },
  institutions: { column: 'value', dir: 'desc' },
  short_interest: undefined,
  options: undefined,
  volatility: { column: 'symbol', dir: 'asc' },
  calendar: { column: 'time', dir: 'asc' },
  ipos: { column: 'date', dir: 'asc' },
  movers: undefined,
  holdings: { column: 'weight', dir: 'desc' },
  macro: { column: 'time', dir: 'desc' },
  yield_curve: undefined,
}

export const EMPTY_HINT: Record<Kind, string> = {
  search: 'No symbols matched the query.',
  quote: 'No quotes came back for these symbols.',
  ohlcv: 'No price bars came back for this range.',
  news: 'No headlines in this window.',
  earnings: 'No earnings dates in this window.',
  profile: 'No profile came back for these symbols.',
  metrics: 'No metrics came back for these symbols.',
  financials: 'No statements came back for these symbols.',
  estimates: 'No analyst estimates for these symbols.',
  eps_history: 'No reported earnings for these symbols.',
  dividends: 'No dividends on record for these symbols.',
  insiders: 'No insider transactions on record.',
  institutions: 'No institutional holders on record.',
  short_interest: 'No short interest reports for these symbols.',
  options: 'No contracts matched this expiration and strike window.',
  volatility: 'No volatility data for these symbols.',
  calendar: 'No scheduled releases in this window.',
  ipos: 'No IPOs in this window.',
  movers: 'No movers right now.',
  holdings: 'No holdings reported for this fund.',
  macro: 'No observations in this range.',
  yield_curve: 'No curve for this date.',
}

/** Human labels for the columns a stat or a facts card is likely to show; anything else is the column name with spaces. */
export const COLUMN_LABEL: Record<string, string> = {
  price: 'price',
  change_pct: 'day change',
  volume: 'volume',
  extended_price: 'extended price',
  market_cap: 'market cap',
  pe: 'P/E',
  forward_pe: 'forward P/E',
  peg: 'PEG',
  ev_ebitda: 'EV/EBITDA',
  ps: 'P/S',
  pb: 'P/B',
  gross_margin: 'gross margin',
  operating_margin: 'operating margin',
  profit_margin: 'profit margin',
  revenue_growth: 'revenue growth',
  earnings_growth: 'earnings growth',
  roe: 'ROE',
  debt_to_equity: 'debt to equity',
  dividend_yield: 'dividend yield',
  iv30: 'IV30',
  iv30_high: 'IV30 high',
  iv30_low: 'IV30 low',
  iv_rank: 'IV rank',
  hv30: 'HV30',
  hv30_high: 'HV30 high',
  hv30_low: 'HV30 low',
  year_high: '52w high',
  year_low: '52w low',
  analysts: 'analysts',
  target_low: 'low target',
  target_consensus: 'consensus target',
  target_high: 'high target',
  upside_pct: 'upside',
  eps_estimate_q: 'EPS est. (Q)',
  eps_estimate_y: 'EPS est. (Y)',
  eps_growth_y: 'EPS growth',
  employees: 'employees',
  beta: 'beta',
  short_interest: 'shares short',
  avg_volume: 'avg volume',
  days_to_cover: 'days to cover',
}

export function columnLabel(column: string): string {
  const known = COLUMN_LABEL[column]
  // Sentence case everywhere (taste round, change 5 and 11): the known labels keep their acronyms, anything else reads through fieldLabel.
  if (known) return known.charAt(0).toUpperCase() + known.slice(1)
  return fieldLabel(column)
}

/**
 * The line under a stat's number, per kind: a signed move where the kind has one, else the column a trader
 * reads next to the key column. Skipped when it is the column already on display.
 */
export const STAT_SECONDARY: Record<StatKind, { column: string; label?: string }> = {
  quote: { column: 'change_pct' },
  metrics: { column: 'forward_pe', label: 'forward' },
  volatility: { column: 'iv_rank', label: 'IV rank' },
  estimates: { column: 'upside_pct', label: 'upside' },
  profile: { column: 'sector' },
  short_interest: { column: 'change_pct', label: 'vs prior report' },
}

/** Macro series that are dollar amounts rather than rates. */
export const MACRO_AMOUNTS: ReadonlySet<string> = new Set(['m2'])

/** A format for every column of the frame: the kind's typed formats, text for the rest. */
export function formatsFor(kind: Kind, columns: Column[]): Record<string, CellFormat> {
  const out: Record<string, CellFormat> = {}
  for (const c of columns) out[c.name] = KIND_FORMATS[kind][c.name] ?? 'text'
  return out
}

export function defaultSortFor(kind: Kind): SortSpec | undefined {
  return KIND_DEFAULT_SORT[kind]
}

/**
 * The v1 kind tables as the annotations layer of field config: the typed format, the priority (1 for the first
 * listed column, up to 9; unlisted columns keep the default), the stat key column, a human label where one is
 * known, and the unit the format implies (percent for percent and change, usd for prices).
 */
export function legacyFieldConfig(kind: Kind, columns: Column[]): FieldOverrides {
  const out: FieldOverrides = {}
  const listed = KIND_PRIORITY[kind] ?? []
  const key = (STAT_KEY_COLUMN as Partial<Record<Kind, string>>)[kind]
  for (const c of columns) {
    const cfg: FieldOverrides[string] = {}
    const format = KIND_FORMATS[kind][c.name]
    if (format) {
      cfg.format = format
      if (format === 'percent' || format === 'change') cfg.unit = 'percent'
      else if (format === 'price' && c.type === 'number' && /price|close|open|high|low|target|bid|ask|last|strike|amount|eps/.test(c.name)) cfg.unit = 'usd'
    }
    const rank = listed.indexOf(c.name)
    if (rank >= 0) cfg.priority = Math.min(9, rank + 1)
    if (key && c.name === key) cfg.key = true
    if (COLUMN_LABEL[c.name]) cfg.label = COLUMN_LABEL[c.name]!
    if (Object.keys(cfg).length > 0) out[c.name] = cfg
  }
  return out
}
