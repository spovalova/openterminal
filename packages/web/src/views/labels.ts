import { fieldLabel } from '@openterminal/core'

/**
 * Human labels for columns the annotations did not label (a transform's output, a route nobody annotated yet):
 * the common financial column names, else the column name with spaces. A field config `label` always wins.
 */
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

/** Field labels a card would wrap, as a trader writes them (taste round 2: "Median move", "Universe", "Median P/E"). */
const SHORT_LABEL: Record<string, string> = {
  'median next-day move': 'Median move',
  'average next-day move': 'Avg move',
  'avg next-day move': 'Avg move',
  'mean next-day move': 'Avg move',
  'large-cap tech universe': 'Universe',
  'number of estimates': 'Estimates',
  'num estimates': 'Estimates',
  'previous report date': 'Last report',
  'period ending': 'Period',
  'buy and hold return': 'B&H return',
}

/**
 * A card's field label short enough for one line (taste round 2, change 2: labels never wrap). Known long labels have
 * a trader's short form; past 16 characters an "of …" tail goes when two words or more stand before it ("Median P/E
 * of passers" is "Median P/E") and then a parenthetical ("Realized vol (1mo)" is "Realized vol"). What is still long
 * keeps its words and its pair takes two columns (FieldGrid).
 */
export function shortLabel(label: string): string {
  const known = SHORT_LABEL[label.trim().toLowerCase()]
  if (known) return known
  let out = label.trim()
  if (out.length > 16) {
    const m = /^(.+?)\s+of\s+.+$/i.exec(out)
    if (m && m[1]!.trim().split(/\s+/).length >= 2) out = m[1]!.trim()
  }
  if (out.length > 16) out = out.replace(/\s*\([^)]*\)\s*$/, '').trim() || out
  return out
}

export function columnLabel(column: string): string {
  const known = COLUMN_LABEL[column]
  // Sentence case everywhere (taste round, changes 5 and 11): the known labels keep their acronyms, anything else reads through fieldLabel.
  if (known) return known.charAt(0).toUpperCase() + known.slice(1)
  return fieldLabel(column)
}
