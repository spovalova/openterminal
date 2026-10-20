// usda/agricultural_trade tables. Ported from openbb_government_us/usda/utils/ers_fatus_trade.py (OpenBB Platform 5.0.0, Apache-2.0); modified: generated as data.
// Generated from the Python constants (OpenBB Platform 5.0.0, Apache-2.0).

export const TRADE_TABLES: Record<string, string> = {
  summary: 'U.S. agricultural trade, fiscal years, calendar years, year-to-date, and current month',
  monthly: 'Total value of U.S. agricultural trade and trade balance, monthly',
  exports_ytd: 'U.S. agricultural exports, year-to-date and current months',
  imports_ytd: 'U.S. agricultural imports, year-to-date and current months',
  top_export_markets: 'Top 10 U.S. export markets for soybeans, corn, wheat, and cotton, by volume',
  top_import_sources: 'Top 10 sources of U.S. imports of fruits and vegetables, by value',
}

export const DIRECTIONS: Record<string, string> = {
  Exports: 'exports',
  Imports: 'imports',
  'Trade balance (exports minus imports)': 'balance',
}

export const VALUE_TYPES: Record<string, string> = {
  'Customs value': 'value',
  Volume: 'volume',
  'Cost, insurance, and freight (c.i.f.)': 'cif',
}

export const TABLE_MEASURES: Record<string, string[]> = {
  summary: ['value'],
  monthly: ['value'],
  exports_ytd: ['value', 'volume'],
  imports_ytd: ['value', 'volume', 'cif'],
  top_export_markets: ['volume'],
  top_import_sources: ['value'],
}

export const SPREAD_DIMENSION: Record<string, string> = {
  summary: 'direction',
  monthly: 'direction',
  exports_ytd: 'commodity',
  imports_ytd: 'commodity',
  top_export_markets: 'country',
  top_import_sources: 'country',
}

export const DIRECTION_LABELS: Record<string, string> = {
  exports: 'Exports',
  imports: 'Imports',
  balance: 'Balance',
}

export const MONTH_INDEX: Record<string, number> = {
  January: 1,
  February: 2,
  March: 3,
  April: 4,
  May: 5,
  June: 6,
  July: 7,
  August: 8,
  September: 9,
  October: 10,
  November: 11,
  December: 12,
}

export const LABEL_FIXES: Record<string, string> = {
  'Korea, South': 'South Korea',
  'Cotton, ex linters': 'Cotton, excluding linters',
}

export const FISCAL_MONTH_ORDER: Record<string, number> = {
  October: 1,
  November: 2,
  December: 3,
  January: 4,
  February: 5,
  March: 6,
  April: 7,
  May: 8,
  June: 9,
  July: 10,
  August: 11,
  September: 12,
}

export const PERIOD_BASIS_ORDER: string[] = ['Fiscal year', 'Calendar year', 'Fiscal year-to-date', 'Calendar year-to-date', 'Monthly']
