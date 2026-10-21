// OpenBB's CFTC constants (openbb_cftc/utils/constants.py, OpenBB Platform 5.0.0, Apache-2.0), generated as data.
// The helper functions that go with them are in constants.ts.

export const CDS_TENOR_TOLERANCE_YEARS = 1.0
export const DAYS_PER_YEAR = 365.25
export const MAX_CURVE_DAYS = 11176
export const OIS_PAYMENT_PERIOD_DAYS = 365
export const ZERO_RATE_BASIS = 365.0
export const SINGLE_PAYMENT_MAX_DAYS = 370
export const MAX_ABS_ZERO_RATE = 1.0
export const PPD_EARLIEST_DATE = "2023-12-29"
export const PPD_RETENTION_DAYS = 366
export const SOFR_OIS_FISN = "NA/Swap OIS USD"
export const SOFR_FIXED_FLOAT_FISN = "NA/Swap Fxd Flt USD"
export const JURISDICTION = "CFTC"
export const PPD_API_URL = "https://pddata.dtcc.com/ppd/api"

export const ASSET_CLASSES = {
  "rates": "IR",
  "credits": "CR",
  "equities": "EQ",
  "forex": "FX",
  "commodities": "CO"
} as const

export const DAY_COUNT_CODES = {
  "A001": "30/360 (ISDA)",
  "A002": "30/365",
  "A003": "30/Actual",
  "A004": "ACT/360",
  "A005": "ACT/365F",
  "A006": "ACT/ACT (ICMA)",
  "A007": "30E/360 (Eurobond)",
  "A008": "ACT/ACT (ISDA)",
  "A009": "ACT/365L",
  "A010": "ACT/ACT (AFB)",
  "A011": "30/360 (ICMA)",
  "A012": "30E2/360",
  "A013": "30E3/360",
  "A014": "ACT/365 (NL)",
  "NARR": "Narrative"
} as const

export const DAY_COUNT_BASIS = {
  "A004": 360.0,
  "A005": 365.0,
  "A009": 365.0,
  "A014": 365.0,
  "A001": 365.0,
  "A011": 365.0,
  "A006": 365.0,
  "A008": 365.0,
  "A007": 365.0
} as const

export const OIS_INDICES = {
  "USD": {
    "index": "SOFR",
    "central_bank": "Federal Reserve",
    "day_count": "A004"
  },
  "EUR": {
    "index": "ESTR",
    "central_bank": "European Central Bank",
    "day_count": "A004"
  },
  "GBP": {
    "index": "SONIA",
    "central_bank": "Bank of England",
    "day_count": "A005"
  },
  "JPY": {
    "index": "TONA",
    "central_bank": "Bank of Japan",
    "day_count": "A005"
  },
  "CAD": {
    "index": "CORRA",
    "central_bank": "Bank of Canada",
    "day_count": "A005"
  },
  "CHF": {
    "index": "SARON",
    "central_bank": "Swiss National Bank",
    "day_count": "A004"
  },
  "MXN": {
    "index": "TIIE",
    "central_bank": "Banco de Mexico",
    "day_count": "A004"
  },
  "SGD": {
    "index": "SORA",
    "central_bank": "Monetary Authority of Singapore",
    "day_count": "A005"
  },
  "INR": {
    "index": "MIBOR",
    "central_bank": "Reserve Bank of India",
    "day_count": "A005"
  },
  "COP": {
    "index": "IBR",
    "central_bank": "Banco de la Republica",
    "day_count": "A004"
  },
  "ZAR": {
    "index": "ZARONIA",
    "central_bank": "South African Reserve Bank",
    "day_count": "A005"
  },
  "CLP": {
    "index": "ICP",
    "central_bank": "Banco Central de Chile",
    "day_count": "A004"
  },
  "THB": {
    "index": "THOR",
    "central_bank": "Bank of Thailand",
    "day_count": "A005"
  },
  "ILS": {
    "index": "SHIR",
    "central_bank": "Bank of Israel",
    "day_count": "A005"
  },
  "AUD": {
    "index": "AONIA",
    "central_bank": "Reserve Bank of Australia",
    "day_count": "A005"
  },
  "NZD": {
    "index": "NZIONA",
    "central_bank": "Reserve Bank of New Zealand",
    "day_count": "A005"
  },
  "BRL": {
    "index": "CDI",
    "central_bank": "Banco Central do Brasil",
    "day_count": "A005"
  }
} as const

export const FIXED_FLOAT_CURVE_SPECS = {
  "CNY": {
    "index": "FR007",
    "central_bank": "People's Bank of China",
    "day_count": "A005",
    "fisn": "NA/Swap Fxd Flt CNY",
    "overnight_index": "SHIBOR"
  }
} as const

export const CDS_INDEX_FISNS = [
  "NA/CDS Corp Idx",
  "NA/CDS Corp Idx Tra",
  "NA/CDS Sov Idx"
] as const

export const CDS_INDEX_UNDERLIERS = [
  "CDX.NA.HY",
  "CDX.NA.IG",
  "ITRAXX EUROPE",
  "ITRAXX EUROPE CROSSOVER",
  "CDX.EM",
  "ITRAXX EUROPE SENIOR FINANCIALS",
  "CMBX.NA.BBB-",
  "IBOXX USD LIQUID LEVERAGED LOANS INDEX",
  "ITRAXX ASIA EX-JAPAN IG",
  "CMBX.NA.BB",
  "ITRAXX JAPAN",
  "ITRAXX EUROPE SUB FINANCIALS",
  "CMBX.NA.AAA",
  "CDX.FINANCIALS",
  "ITRAXX AUSTRALIA"
] as const

export const CDS_STANDARD_TENORS = [
  1.0,
  2.0,
  3.0,
  5.0,
  7.0,
  10.0
] as const

export const FX_PAIRS = {
  "EURUSD": {
    "base": "EUR",
    "quote": "USD",
    "invert": false,
    "pip": 10000.0,
    "forward_fisn": "NA/Fwd EUR USD",
    "swap_fisn": "NA/Swaps EUR USD"
  },
  "GBPUSD": {
    "base": "GBP",
    "quote": "USD",
    "invert": false,
    "pip": 10000.0,
    "forward_fisn": "NA/Fwd GBP USD",
    "swap_fisn": "NA/Swaps GBP USD"
  },
  "AUDUSD": {
    "base": "AUD",
    "quote": "USD",
    "invert": false,
    "pip": 10000.0,
    "forward_fisn": "NA/Fwd AUD USD",
    "swap_fisn": "NA/Swaps AUD USD"
  },
  "NZDUSD": {
    "base": "NZD",
    "quote": "USD",
    "invert": false,
    "pip": 10000.0,
    "forward_fisn": "NA/Fwd NZD USD",
    "swap_fisn": "NA/Swaps NZD USD"
  },
  "USDJPY": {
    "base": "JPY",
    "quote": "USD",
    "invert": true,
    "pip": 100.0,
    "forward_fisn": "NA/Fwd JPY USD",
    "swap_fisn": "NA/Swaps JPY USD"
  },
  "USDCHF": {
    "base": "CHF",
    "quote": "USD",
    "invert": true,
    "pip": 10000.0,
    "forward_fisn": "NA/Fwd CHF USD",
    "swap_fisn": "NA/Swaps CHF USD"
  },
  "USDCAD": {
    "base": "CAD",
    "quote": "USD",
    "invert": true,
    "pip": 10000.0,
    "forward_fisn": "NA/Fwd CAD USD",
    "swap_fisn": "NA/Swaps CAD USD"
  },
  "USDKRW": {
    "base": "USD",
    "quote": "KRW",
    "invert": false,
    "ndf": true,
    "pip": 100.0,
    "forward_fisn": "NA/Fwd NDF KRW USD",
    "swap_fisn": "NA/Swaps NDS KRW USD"
  },
  "USDINR": {
    "base": "USD",
    "quote": "INR",
    "invert": false,
    "ndf": true,
    "pip": 10000.0,
    "forward_fisn": "NA/Fwd NDF INR USD",
    "swap_fisn": "NA/Swaps NDS INR USD"
  },
  "USDBRL": {
    "base": "USD",
    "quote": "BRL",
    "invert": false,
    "ndf": true,
    "pip": 10000.0,
    "forward_fisn": "NA/Fwd NDF BRL USD",
    "swap_fisn": "NA/Swaps NDS BRL USD"
  },
  "USDTWD": {
    "base": "USD",
    "quote": "TWD",
    "invert": false,
    "ndf": true,
    "pip": 1000.0,
    "forward_fisn": "NA/Fwd NDF TWD USD",
    "swap_fisn": "NA/Swaps NDS TWD USD"
  },
  "USDIDR": {
    "base": "USD",
    "quote": "IDR",
    "invert": false,
    "ndf": true,
    "pip": 100.0,
    "forward_fisn": "NA/Fwd NDF IDR USD",
    "swap_fisn": "NA/Swaps NDS IDR USD"
  },
  "USDPHP": {
    "base": "USD",
    "quote": "PHP",
    "invert": false,
    "ndf": true,
    "pip": 1000.0,
    "forward_fisn": "NA/Fwd NDF PHP USD",
    "swap_fisn": "NA/Swaps NDS PHP USD"
  },
  "USDCLP": {
    "base": "USD",
    "quote": "CLP",
    "invert": false,
    "ndf": true,
    "pip": 100.0,
    "forward_fisn": "NA/Fwd NDF CLP USD",
    "swap_fisn": "NA/Swaps NDS CLP USD"
  },
  "USDCOP": {
    "base": "USD",
    "quote": "COP",
    "invert": false,
    "ndf": true,
    "pip": 100.0,
    "forward_fisn": "NA/Fwd NDF COP USD",
    "swap_fisn": "NA/Swaps NDS COP USD"
  },
  "USDCNY": {
    "base": "USD",
    "quote": "CNY",
    "invert": false,
    "ndf": true,
    "pip": 10000.0,
    "forward_fisn": "NA/Fwd NDF CNY USD",
    "swap_fisn": "NA/Swaps NDS CNY USD"
  },
  "USDPEN": {
    "base": "USD",
    "quote": "PEN",
    "invert": false,
    "ndf": true,
    "pip": 10000.0,
    "forward_fisn": "NA/Fwd NDF PEN USD",
    "swap_fisn": "NA/Swaps NDS PEN USD"
  },
  "USDMYR": {
    "base": "USD",
    "quote": "MYR",
    "invert": false,
    "ndf": true,
    "pip": 10000.0,
    "forward_fisn": "NA/Fwd NDF MYR USD",
    "swap_fisn": "NA/Swaps NDS MYR USD"
  },
  "USDHKD": {
    "base": "HKD",
    "quote": "USD",
    "invert": true,
    "ndf": false,
    "pip": 10000.0,
    "forward_fisn": "NA/Fwd HKD USD",
    "swap_fisn": "NA/Swaps HKD USD"
  },
  "USDMXN": {
    "base": "MXN",
    "quote": "USD",
    "invert": true,
    "ndf": false,
    "pip": 10000.0,
    "forward_fisn": "NA/Fwd MXN USD",
    "swap_fisn": "NA/Swaps MXN USD"
  },
  "USDTHB": {
    "base": "THB",
    "quote": "USD",
    "invert": true,
    "ndf": false,
    "pip": 1000.0,
    "forward_fisn": "NA/Fwd THB USD",
    "swap_fisn": "NA/Swaps THB USD"
  },
  "EURCHF": {
    "base": "CHF",
    "quote": "EUR",
    "invert": true,
    "ndf": false,
    "pip": 10000.0,
    "forward_fisn": "NA/Fwd CHF EUR",
    "swap_fisn": "NA/Swaps CHF EUR"
  },
  "AUDCNY": {
    "base": "AUD",
    "quote": "CNY",
    "invert": false,
    "ndf": true,
    "pip": 10000.0,
    "forward_fisn": "NA/Fwd NDF AUD CNY",
    "swap_fisn": "NA/Swaps NDS AUD CNY"
  }
} as const

export const MAJOR_FX_PAIRS = {
  "EURUSD": {
    "base": "EUR",
    "quote": "USD",
    "pip": 10000.0
  },
  "GBPUSD": {
    "base": "GBP",
    "quote": "USD",
    "pip": 10000.0
  },
  "USDJPY": {
    "base": "USD",
    "quote": "JPY",
    "pip": 100.0
  },
  "USDCHF": {
    "base": "USD",
    "quote": "CHF",
    "pip": 10000.0
  },
  "USDCAD": {
    "base": "USD",
    "quote": "CAD",
    "pip": 10000.0
  },
  "EURGBP": {
    "base": "EUR",
    "quote": "GBP",
    "pip": 10000.0
  },
  "EURJPY": {
    "base": "EUR",
    "quote": "JPY",
    "pip": 100.0
  },
  "EURCHF": {
    "base": "EUR",
    "quote": "CHF",
    "pip": 10000.0
  },
  "EURCAD": {
    "base": "EUR",
    "quote": "CAD",
    "pip": 10000.0
  },
  "GBPJPY": {
    "base": "GBP",
    "quote": "JPY",
    "pip": 100.0
  },
  "GBPCHF": {
    "base": "GBP",
    "quote": "CHF",
    "pip": 10000.0
  },
  "CADJPY": {
    "base": "CAD",
    "quote": "JPY",
    "pip": 100.0
  },
  "CHFJPY": {
    "base": "CHF",
    "quote": "JPY",
    "pip": 100.0
  },
  "USDBRL": {
    "base": "USD",
    "quote": "BRL",
    "pip": 10000.0,
    "ndf": true
  },
  "USDKRW": {
    "base": "USD",
    "quote": "KRW",
    "pip": 100.0,
    "ndf": true
  },
  "USDINR": {
    "base": "USD",
    "quote": "INR",
    "pip": 10000.0,
    "ndf": true
  },
  "USDTWD": {
    "base": "USD",
    "quote": "TWD",
    "pip": 1000.0,
    "ndf": true
  },
  "USDCOP": {
    "base": "USD",
    "quote": "COP",
    "pip": 100.0,
    "ndf": true
  }
} as const

export const FX_TENOR_BUCKETS = [
  [
    "SPOT",
    0,
    2
  ],
  [
    "1W",
    3,
    9
  ],
  [
    "2W",
    10,
    20
  ],
  [
    "1M",
    21,
    45
  ],
  [
    "2M",
    46,
    75
  ],
  [
    "3M",
    76,
    110
  ],
  [
    "6M",
    111,
    200
  ],
  [
    "9M",
    201,
    290
  ],
  [
    "1Y",
    291,
    400
  ],
  [
    "2Y",
    401,
    800
  ]
] as const

export const BENCHMARK_TENORS = [
  [
    "1W",
    7
  ],
  [
    "2W",
    14
  ],
  [
    "1M",
    30
  ],
  [
    "2M",
    61
  ],
  [
    "3M",
    91
  ],
  [
    "4M",
    122
  ],
  [
    "6M",
    182
  ],
  [
    "9M",
    273
  ],
  [
    "1Y",
    365
  ],
  [
    "18M",
    548
  ],
  [
    "2Y",
    730
  ],
  [
    "3Y",
    1095
  ],
  [
    "4Y",
    1461
  ],
  [
    "5Y",
    1826
  ],
  [
    "6Y",
    2191
  ],
  [
    "7Y",
    2556
  ],
  [
    "8Y",
    2922
  ],
  [
    "9Y",
    3287
  ],
  [
    "10Y",
    3652
  ],
  [
    "12Y",
    4383
  ],
  [
    "15Y",
    5478
  ],
  [
    "20Y",
    7305
  ],
  [
    "25Y",
    9131
  ],
  [
    "30Y",
    10957
  ]
] as const

export const SLICE_HEADERS = [
  "Dissemination Identifier",
  "Original Dissemination Identifier",
  "Action type",
  "Event type",
  "Event timestamp",
  "Amendment indicator",
  "Asset Class",
  "Product name",
  "Cleared",
  "Mandatory clearing indicator",
  "Execution Timestamp",
  "Effective Date",
  "Expiration Date",
  "Maturity date of the underlier",
  "Non-standardized term indicator",
  "Platform identifier",
  "Prime brokerage transaction indicator",
  "Block trade election indicator",
  "Large notional off-facility swap election indicator",
  "Notional amount-Leg 1",
  "Notional amount-Leg 2",
  "Notional currency-Leg 1",
  "Notional currency-Leg 2",
  "Notional quantity-Leg 1",
  "Notional quantity-Leg 2",
  "Total notional quantity-Leg 1",
  "Total notional quantity-Leg 2",
  "Quantity frequency multiplier-Leg 1",
  "Quantity frequency multiplier-Leg 2",
  "Quantity unit of measure-Leg 1",
  "Quantity unit of measure-Leg 2",
  "Quantity frequency-Leg 1",
  "Quantity frequency-Leg 2",
  "Notional amount in effect on associated effective date-Leg 1",
  "Notional amount in effect on associated effective date-Leg 2",
  "Effective date of the notional amount-Leg 1",
  "Effective date of the notional amount-Leg 2",
  "End date of the notional amount-Leg 1",
  "End date of the notional amount-Leg 2",
  "Call amount",
  "Call currency",
  "Put amount",
  "Put currency",
  "Exchange rate",
  "Exchange rate basis",
  "First exercise date",
  "Fixed rate-Leg 1",
  "Fixed rate-Leg 2",
  "Option Premium Amount",
  "Option Premium Currency",
  "Price",
  "Price unit of measure",
  "Spread-Leg 1",
  "Spread-Leg 2",
  "Spread currency-Leg 1",
  "Spread currency-Leg 2",
  "Strike Price",
  "Strike price currency/currency pair",
  "Post-priced swap indicator",
  "Price currency",
  "Price notation",
  "Spread notation-Leg 1",
  "Spread notation-Leg 2",
  "Strike price notation",
  "Fixed rate day count convention-leg 1",
  "Fixed rate day count convention-leg 2",
  "Floating rate day count convention-leg 1",
  "Floating rate day count convention-leg 2",
  "Floating rate reset frequency period-leg 1",
  "Floating rate reset frequency period-leg 2",
  "Floating rate reset frequency period multiplier-leg 1",
  "Floating rate reset frequency period multiplier-leg 2",
  "Other payment amount",
  "Fixed rate payment frequency period-Leg 1",
  "Floating rate payment frequency period-Leg 1",
  "Fixed rate payment frequency period-Leg 2",
  "Floating rate payment frequency period-Leg 2",
  "Fixed rate payment frequency period multiplier-Leg 1",
  "Floating rate payment frequency period multiplier-Leg 1",
  "Fixed rate payment frequency period multiplier-Leg 2",
  "Floating rate payment frequency period multiplier-Leg 2",
  "Other payment type",
  "Other payment currency",
  "Settlement currency-Leg 1",
  "Settlement currency-Leg 2",
  "Settlement location",
  "Collateralisation category",
  "Custom basket indicator",
  "Index factor",
  "Underlier ID-Leg 1",
  "Underlier ID-Leg 2",
  "Underlier ID source-Leg 1",
  "Underlying Asset Name",
  "Underlying asset subtype or underlying contract subtype-Leg 1",
  "Underlying asset subtype or underlying contract subtype-Leg 2",
  "Embedded Option type",
  "Option Type",
  "Option Style",
  "Package indicator",
  "Package transaction price",
  "Package transaction price currency",
  "Package transaction price notation",
  "Package transaction spread",
  "Package transaction spread currency",
  "Package transaction spread notation",
  "Physical delivery location-Leg 1",
  "Delivery Type",
  "Unique Product Identifier",
  "UPI FISN",
  "UPI Underlier Name"
] as const
