// usda/state_agricultural_trade tables. Ported from openbb_government_us/usda/utils/ers_state_agricultural_trade.py (OpenBB Platform 5.0.0, Apache-2.0); modified: generated as data.
// Generated from the Python constants (OpenBB Platform 5.0.0, Apache-2.0).

export const TABLE_LABELS: Record<string, string> = {
  exports_by_commodity: 'Exports by commodity (state, calendar year)',
  exports_by_state: 'Exports by state (commodity, calendar year)',
  top_exports: 'Top export commodities (state, fiscal year)',
  top_imports: 'Top import commodities (state, fiscal year)',
}

export const TABLE_UNITS: Record<string, string> = {
  exports_by_commodity: 'Million dollars',
  exports_by_state: 'Million dollars',
  top_exports: 'Dollars',
  top_imports: 'Dollars',
}

export const STATE_CODE_TO_NAME: Record<string, string> = {
  US: 'United States',
  AL: 'Alabama',
  AK: 'Alaska',
  AZ: 'Arizona',
  AR: 'Arkansas',
  CA: 'California',
  CO: 'Colorado',
  CT: 'Connecticut',
  DE: 'Delaware',
  DC: 'District of Columbia',
  FL: 'Florida',
  GA: 'Georgia',
  HI: 'Hawaii',
  ID: 'Idaho',
  IL: 'Illinois',
  IN: 'Indiana',
  IA: 'Iowa',
  KS: 'Kansas',
  KY: 'Kentucky',
  LA: 'Louisiana',
  ME: 'Maine',
  MD: 'Maryland',
  MA: 'Massachusetts',
  MI: 'Michigan',
  MN: 'Minnesota',
  MS: 'Mississippi',
  MO: 'Missouri',
  MT: 'Montana',
  NE: 'Nebraska',
  NV: 'Nevada',
  NH: 'New Hampshire',
  NJ: 'New Jersey',
  NM: 'New Mexico',
  NY: 'New York',
  NC: 'North Carolina',
  ND: 'North Dakota',
  OH: 'Ohio',
  OK: 'Oklahoma',
  OR: 'Oregon',
  PA: 'Pennsylvania',
  PR: 'Puerto Rico',
  RI: 'Rhode Island',
  SC: 'South Carolina',
  SD: 'South Dakota',
  TN: 'Tennessee',
  TX: 'Texas',
  UT: 'Utah',
  VT: 'Vermont',
  VA: 'Virginia',
  VI: 'Virgin Islands',
  WA: 'Washington',
  WV: 'West Virginia',
  WI: 'Wisconsin',
  WY: 'Wyoming',
}

export const COMMODITIES: string[] = ['Total agricultural exports', 'Total animal products', 'Total plant products', 'Beef and veal', 'Broiler meat', 'Corn', 'Cotton', 'Dairy products', 'Feeds and other feed grains', 'Fruits, fresh', 'Fruits, processed', 'Grain products', 'Hides and skins', 'Other livestock products', 'Other oilseeds and products', 'Other plant products', 'Other poultry products', 'Pork', 'Rice', 'Soybean meal', 'Soybeans', 'Tobacco', 'Tree nuts', 'Vegetable oils', 'Vegetables, fresh', 'Vegetables, processed', 'Wheat']

export const DATASET_A_STATE_NAMES: string[] = ['United States', 'Alabama', 'Alaska', 'Arizona', 'Arkansas', 'California', 'Colorado', 'Connecticut', 'Delaware', 'Florida', 'Georgia', 'Hawaii', 'Idaho', 'Illinois', 'Indiana', 'Iowa', 'Kansas', 'Kentucky', 'Louisiana', 'Maine', 'Maryland', 'Massachusetts', 'Michigan', 'Minnesota', 'Mississippi', 'Missouri', 'Montana', 'Nebraska', 'Nevada', 'New Hampshire', 'New Jersey', 'New Mexico', 'New York', 'North Carolina', 'North Dakota', 'Ohio', 'Oklahoma', 'Oregon', 'Pennsylvania', 'Rhode Island', 'South Carolina', 'South Dakota', 'Tennessee', 'Texas', 'Utah', 'Vermont', 'Virginia', 'Washington', 'West Virginia', 'Wisconsin', 'Wyoming']

export const DATASET_B_STATE_NAMES: string[] = ['United States', 'Alabama', 'Alaska', 'Arizona', 'Arkansas', 'California', 'Colorado', 'Connecticut', 'Delaware', 'District of Columbia', 'Florida', 'Georgia', 'Hawaii', 'Idaho', 'Illinois', 'Indiana', 'Iowa', 'Kansas', 'Kentucky', 'Louisiana', 'Maine', 'Maryland', 'Massachusetts', 'Michigan', 'Minnesota', 'Mississippi', 'Missouri', 'Montana', 'Nebraska', 'Nevada', 'New Hampshire', 'New Jersey', 'New Mexico', 'New York', 'North Carolina', 'North Dakota', 'Ohio', 'Oklahoma', 'Oregon', 'Pennsylvania', 'Puerto Rico', 'Rhode Island', 'South Carolina', 'South Dakota', 'Tennessee', 'Texas', 'Utah', 'Vermont', 'Virgin Islands', 'Virginia', 'Washington', 'West Virginia', 'Wisconsin', 'Wyoming']
