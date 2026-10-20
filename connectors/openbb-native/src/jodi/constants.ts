// Ported from openbb_jodi/utils/constants.py (OpenBB Platform 5.0.0, Apache-2.0); modified: only the codes and maps
// the ported routes read (descriptions and widget options belong to the catalog).

export const OIL_TABLE_URLS = {
  primary: 'https://www.jodidata.org/_resources/files/downloads/oil-data/world_Primary_CSV.zip',
  secondary: 'https://www.jodidata.org/_resources/files/downloads/oil-data/world_Secondary_CSV.zip',
}
export const GAS_FILES_URL = 'https://api.publisher.jodidata.org/web/files/gas'
export const GAS_DOWNLOAD_URL = 'https://www.jodidata.org/jodi-publisher/gas/{publication_id}/{filename}'

export const OIL_START_YEAR = 2002
export const GAS_START_YEAR = 2009

export type OilTable = 'primary' | 'secondary'

/** Product name → [JODI item code, the table that holds it]. */
export const OIL_PRODUCTS: Record<string, [code: string, table: OilTable]> = {
  crude_oil: ['CRUDEOIL', 'primary'],
  ngl: ['NGL', 'primary'],
  other_crude: ['OTHERCRUDE', 'primary'],
  total_crude: ['TOTCRUDE', 'primary'],
  lpg: ['LPG', 'secondary'],
  naphtha: ['NAPHTHA', 'secondary'],
  gasoline: ['GASOLINE', 'secondary'],
  kerosene: ['KEROSENE', 'secondary'],
  jet_fuel: ['JETKERO', 'secondary'],
  gas_diesel_oil: ['GASDIES', 'secondary'],
  fuel_oil: ['RESFUEL', 'secondary'],
  other_products: ['ONONSPEC', 'secondary'],
  total_products: ['TOTPRODS', 'secondary'],
}
export const PRIMARY_PRODUCTS = ['crude_oil', 'ngl', 'other_crude', 'total_crude']
export const SECONDARY_PRODUCTS = Object.keys(OIL_PRODUCTS).filter((p) => !PRIMARY_PRODUCTS.includes(p))

export const OIL_UNITS: Record<string, string> = { kbd: 'KBD', kbbl: 'KBBL', kl: 'KL', ktons: 'KTONS', conversion_factor: 'CONVBBL' }
export const GAS_UNITS: Record<string, string> = { m3: 'M3', tj: 'TJ', ktons: 'KTONS' }

/** Flow code → balance-view field name, in questionnaire order. */
export const OIL_BALANCE_FIELDS: Record<string, string> = {
  INDPROD: 'production',
  REFGROUT: 'refinery_output',
  OSOURCES: 'from_other_sources',
  RECEIPTS: 'receipts',
  TOTIMPSB: 'imports',
  TOTEXPSB: 'exports',
  TRANSBAK: 'products_transferred',
  PTRANSF: 'products_transferred',
  IPTRANSF: 'interproduct_transfers',
  DIRECUSE: 'direct_use',
  STOCKCH: 'stock_change',
  STATDIFF: 'statistical_difference',
  REFINOBS: 'refinery_intake',
  TOTDEMO: 'demand',
  CLOSTLV: 'closing_stocks',
}

export const GAS_BALANCE_FIELDS: Record<string, string> = {
  INDPROD: 'production',
  OSOURCES: 'from_other_sources',
  TOTIMPSB: 'imports',
  IMPPIP: 'pipeline_imports',
  IMPLNG: 'lng_imports',
  TOTEXPSB: 'exports',
  EXPPIP: 'pipeline_exports',
  EXPLNG: 'lng_exports',
  STOCKCH: 'stock_change',
  TOTDEMC: 'demand_calculated',
  STATDIFF: 'statistical_difference',
  TOTDEMO: 'demand',
  MAINTOT: 'electricity_and_heat_generation',
  CLOSTLV: 'closing_stocks',
}

/** Product code → demand-by-product field name, in published order. */
export const OIL_PRODUCT_FIELDS: Record<string, string> = {
  LPG: 'lpg',
  NAPHTHA: 'naphtha',
  GASOLINE: 'gasoline',
  KEROSENE: 'kerosene',
  JETKERO: 'jet_fuel',
  GASDIES: 'gas_diesel_oil',
  RESFUEL: 'fuel_oil',
  ONONSPEC: 'other_products',
  TOTPRODS: 'total_products',
}

/** Country name → ISO 3166-1 alpha-2 code, as in the JODI world databases. */
export const COUNTRIES: Record<string, string> = {
  albania: 'AL', algeria: 'DZ', angola: 'AO', argentina: 'AR', armenia: 'AM', australia: 'AU', austria: 'AT', azerbaijan: 'AZ',
  bahrain: 'BH', bangladesh: 'BD', barbados: 'BB', belarus: 'BY', belgium: 'BE', belize: 'BZ', bermuda: 'BM', bolivia: 'BO',
  brazil: 'BR', brunei: 'BN', bulgaria: 'BG', canada: 'CA', chile: 'CL', china: 'CN', colombia: 'CO', costa_rica: 'CR',
  croatia: 'HR', cuba: 'CU', cyprus: 'CY', czechia: 'CZ', denmark: 'DK', dominican_republic: 'DO', ecuador: 'EC', egypt: 'EG',
  el_salvador: 'SV', equatorial_guinea: 'GQ', estonia: 'EE', eswatini: 'SZ', finland: 'FI', france: 'FR', gabon: 'GA',
  gambia: 'GM', georgia: 'GE', germany: 'DE', greece: 'GR', grenada: 'GD', guatemala: 'GT', guyana: 'GY', haiti: 'HT',
  honduras: 'HN', hong_kong: 'HK', hungary: 'HU', iceland: 'IS', india: 'IN', indonesia: 'ID', iran: 'IR', iraq: 'IQ',
  ireland: 'IE', italy: 'IT', jamaica: 'JM', japan: 'JP', kazakhstan: 'KZ', kuwait: 'KW', latvia: 'LV', libya: 'LY',
  lithuania: 'LT', luxembourg: 'LU', malaysia: 'MY', malta: 'MT', mauritius: 'MU', mexico: 'MX', moldova: 'MD', morocco: 'MA',
  myanmar: 'MM', nepal: 'NP', netherlands: 'NL', new_zealand: 'NZ', nicaragua: 'NI', niger: 'NE', nigeria: 'NG',
  north_macedonia: 'MK', norway: 'NO', oman: 'OM', panama: 'PA', papua_new_guinea: 'PG', paraguay: 'PY', peru: 'PE',
  philippines: 'PH', poland: 'PL', portugal: 'PT', qatar: 'QA', romania: 'RO', russia: 'RU', saudi_arabia: 'SA', serbia: 'RS',
  singapore: 'SG', slovakia: 'SK', slovenia: 'SI', south_africa: 'ZA', south_korea: 'KR', spain: 'ES', sudan: 'SD',
  suriname: 'SR', sweden: 'SE', switzerland: 'CH', syria: 'SY', taiwan: 'TW', tajikistan: 'TJ', thailand: 'TH',
  trinidad_and_tobago: 'TT', tunisia: 'TN', turkiye: 'TR', ukraine: 'UA', united_arab_emirates: 'AE', united_kingdom: 'GB',
  united_states: 'US', uruguay: 'UY', venezuela: 'VE', vietnam: 'VN', yemen: 'YE',
}

export const CODE_TO_COUNTRY: Record<string, string> = Object.fromEntries(Object.entries(COUNTRIES).map(([name, code]) => [code, name]))
