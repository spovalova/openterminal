// usda/agricultural_exchange_rates files. Ported from openbb_government_us/usda/utils/ers_agricultural_exchange_rates.py (OpenBB Platform 5.0.0, Apache-2.0); modified: generated as data.
// Generated from the Python constants (OpenBB Platform 5.0.0, Apache-2.0).

export const MONTH_ORDER: Record<string, number> = {
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

export const EXCHANGE_RATE_FILES: Record<string, { media: string; kind: 'index' | 'bilateral'; frequency: 'annual' | 'monthly'; label: string }> = {
  real_index_annual: {
    media: '/media/5447/real-annual-commodity-trade-weighted-exchange-rate-indexes.csv',
    kind: 'index',
    frequency: 'annual',
    label: 'Real trade-weighted index (annual)',
  },
  real_index_monthly: {
    media: '/media/5449/real-monthly-commodity-trade-weighted-exchange-rate-indexes.csv',
    kind: 'index',
    frequency: 'monthly',
    label: 'Real trade-weighted index (monthly)',
  },
  real_bilateral_annual: {
    media: '/media/5457/annual-real-exchange-rates-local-currency-per-usd.csv',
    kind: 'bilateral',
    frequency: 'annual',
    label: 'Real bilateral rate, local currency per USD (annual)',
  },
  real_bilateral_monthly: {
    media: '/media/5451/monthly-real-exchange-rates-local-currency-per-usd.csv',
    kind: 'bilateral',
    frequency: 'monthly',
    label: 'Real bilateral rate, local currency per USD (monthly)',
  },
  nominal_bilateral_annual: {
    media: '/media/5453/annual-nominal-exchange-rates-local-currency-per-usd.csv',
    kind: 'bilateral',
    frequency: 'annual',
    label: 'Nominal bilateral rate, local currency per USD (annual)',
  },
  nominal_bilateral_monthly: {
    media: '/media/5455/monthly-nominal-exchange-rates-local-currency-per-usd.csv',
    kind: 'bilateral',
    frequency: 'monthly',
    label: 'Nominal bilateral rate, local currency per USD (monthly)',
  },
}

export const INDEX_WEIGHTS: string[] = ['U.S. competitors (country export weights)', 'U.S. markets (U.S. export weights)', 'U.S. suppliers (U.S. import weights)']

export const BILATERAL_REGIONS: string[] = ['Central America', 'Europe', 'Middle East', 'North Africa', 'North America', 'Northeast Asia', 'Oceania', 'South America', 'South Asia', 'Southeast Asia', 'Sub-Saharan Africa', 'The Caribbean']
