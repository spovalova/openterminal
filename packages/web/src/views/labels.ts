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

export function columnLabel(column: string): string {
  return COLUMN_LABEL[column] ?? column.replace(/_/g, ' ')
}
