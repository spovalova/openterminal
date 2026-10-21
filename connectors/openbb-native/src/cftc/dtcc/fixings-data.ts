// OpenBB's fixing-index tables (openbb_cftc/utils/fixings.py, OpenBB Platform 5.0.0, Apache-2.0), generated as data.

export const FIXING_SOURCES: Record<string, [string, string]> = {
  "SOFR": [
    "nyfed",
    "secured/sofr"
  ],
  "EFFR": [
    "nyfed",
    "unsecured/effr"
  ],
  "CORRA": [
    "boc",
    ""
  ],
  "ESTR": [
    "ecb",
    ""
  ],
  "SONIA": [
    "boe",
    "IUDSOIA"
  ],
  "TONA": [
    "boj",
    "FM01'STRDCLUCON"
  ],
  "TIIE": [
    "banxico",
    "SF331451"
  ],
  "CDI": [
    "bcb",
    "12"
  ],
  "SARON": [
    "snb",
    "{H0}"
  ],
  "SORA": [
    "mas",
    "13"
  ],
  "MIBOR": [
    "fbil",
    "12M"
  ],
  "IBR": [
    "banrep",
    "241"
  ],
  "ZARONIA": [
    "sarb",
    "ZARONIA"
  ],
  "ICP": [
    "bcch",
    "SERIE TIB"
  ],
  "THOR": [
    "thaibma",
    "O/N"
  ],
  "SHIR": [
    "boi",
    "MNT_SHIR_D"
  ],
  "NZIONA": [
    "rbnz",
    "INM.DN.NZK"
  ],
  "BKBM": [
    "rbnz",
    "INM.DB03.NZZV"
  ],
  "AONIA": [
    "rba",
    "FIRMMCRID"
  ],
  "EURIBOR": [
    "bbk",
    "BBIG1/D.D0.EUR.MMKT.EURIBOR.M03.BID._Z"
  ],
  "PRIBOR": [
    "cnb",
    "12"
  ],
  "MYOR": [
    "bnm",
    "data-download-myor?date_range=all_trade|2"
  ],
  "KLIBOR": [
    "bnm",
    "data-download-klibor?date_range=all_date&date_select=&date_end=|3"
  ],
  "BBSW": [
    "rba",
    "FIRMMBAB90D"
  ],
  "HIBOR": [
    "hkma",
    "hibor_fixing_1m"
  ],
  "JIBAR": [
    "sarb_series",
    "MMRD403A"
  ],
  "KRWCD": [
    "bok",
    "817Y002/010502000"
  ],
  "KOFR": [
    "bok",
    "817Y002/010901000"
  ],
  "BUBOR": [
    "mnb",
    "6"
  ],
  "POLSTR": [
    "gpw",
    "1"
  ],
  "WIBOR": [
    "finwire",
    "wibor-3m"
  ],
  "FR007": [
    "cfets",
    "7"
  ],
  "SHIBOR": [
    "shibor",
    "O/N"
  ],
  "SHIBOR3M": [
    "shibor",
    "3M"
  ],
  "TAIBOR": [
    "taibor",
    "5"
  ]
}

export const FIXING_BASES: Record<string, number> = {
  "SOFR": 360.0,
  "EFFR": 360.0,
  "CORRA": 365.0,
  "ESTR": 360.0,
  "SONIA": 365.0,
  "TONA": 365.0,
  "TIIE": 360.0,
  "CDI": 252.0,
  "SARON": 360.0,
  "SORA": 365.0,
  "MIBOR": 365.0,
  "IBR": 360.0,
  "ZARONIA": 365.0,
  "ICP": 360.0,
  "THOR": 365.0,
  "SHIR": 365.0,
  "NZIONA": 365.0,
  "BKBM": 365.0,
  "AONIA": 365.0,
  "EURIBOR": 360.0,
  "PRIBOR": 360.0,
  "MYOR": 365.0,
  "KLIBOR": 365.0,
  "BBSW": 365.0,
  "HIBOR": 365.0,
  "JIBAR": 365.0,
  "KRWCD": 365.0,
  "KOFR": 365.0,
  "BUBOR": 360.0,
  "POLSTR": 365.0,
  "WIBOR": 365.0,
  "FR007": 365.0,
  "SHIBOR": 360.0,
  "SHIBOR3M": 360.0,
  "TAIBOR": 365.0
}

export const FIXING_PROFILES: Record<string, [string, string]> = {
  "SOFR": [
    "Secured Overnight Financing Rate",
    "USA"
  ],
  "EFFR": [
    "Effective Federal Funds Rate",
    "USA"
  ],
  "CORRA": [
    "Canadian Overnight Repo Rate Average",
    "CAN"
  ],
  "ESTR": [
    "Euro Short-Term Rate",
    "EMU"
  ],
  "EURIBOR": [
    "Euro Interbank Offered Rate (3M)",
    "EMU"
  ],
  "SONIA": [
    "Sterling Overnight Index Average",
    "GBR"
  ],
  "TONA": [
    "Tokyo Overnight Average Rate",
    "JPN"
  ],
  "SARON": [
    "Swiss Average Rate Overnight",
    "CHE"
  ],
  "PRIBOR": [
    "Prague Interbank Offered Rate (3M)",
    "CZE"
  ],
  "BUBOR": [
    "Budapest Interbank Offered Rate (3M)",
    "HUN"
  ],
  "WIBOR": [
    "Warsaw Interbank Offered Rate (3M)",
    "POL"
  ],
  "POLSTR": [
    "Polish Short-Term Rate",
    "POL"
  ],
  "TIIE": [
    "Interbank Equilibrium Interest Rate",
    "MEX"
  ],
  "CDI": [
    "Interbank Deposit Certificate Rate",
    "BRA"
  ],
  "ICP": [
    "Indice Camara Promedio",
    "CHL"
  ],
  "IBR": [
    "Indicador Bancario de Referencia",
    "COL"
  ],
  "AONIA": [
    "AUD Overnight Index Average",
    "AUS"
  ],
  "BBSW": [
    "Bank Bill Swap Rate (3M)",
    "AUS"
  ],
  "NZIONA": [
    "New Zealand Overnight Interbank Average",
    "NZL"
  ],
  "BKBM": [
    "Bank Bill Benchmark Rate (3M)",
    "NZL"
  ],
  "SORA": [
    "Singapore Overnight Rate Average",
    "SGP"
  ],
  "MYOR": [
    "Malaysia Overnight Rate",
    "MYS"
  ],
  "KLIBOR": [
    "Kuala Lumpur Interbank Offered Rate (3M)",
    "MYS"
  ],
  "THOR": [
    "Thai Overnight Repurchase Rate",
    "THA"
  ],
  "HIBOR": [
    "Hong Kong Interbank Offered Rate (1M)",
    "HKG"
  ],
  "FR007": [
    "7-Day Fixing Repo Rate",
    "CHN"
  ],
  "SHIBOR": [
    "Shanghai Interbank Offered Rate (O/N)",
    "CHN"
  ],
  "SHIBOR3M": [
    "Shanghai Interbank Offered Rate (3M)",
    "CHN"
  ],
  "TAIBOR": [
    "Taipei Interbank Offered Rate (3M)",
    "TWN"
  ],
  "KOFR": [
    "Korea Overnight Financing Repo Rate",
    "KOR"
  ],
  "KRWCD": [
    "Certificate of Deposit Rate (91-day)",
    "KOR"
  ],
  "MIBOR": [
    "Mumbai Interbank Outright Rate",
    "IND"
  ],
  "SHIR": [
    "Shekel Interbank Rate",
    "ISR"
  ],
  "ZARONIA": [
    "South African Rand Overnight Index Average",
    "ZAF"
  ],
  "JIBAR": [
    "Johannesburg Interbank Average Rate (3M)",
    "ZAF"
  ]
}

export const OIS_CURRENCY_INDICES: Record<string, string> = {
  "USD": "SOFR",
  "GBP": "SONIA",
  "JPY": "TONA",
  "EUR": "ESTR",
  "CHF": "SARON",
  "CAD": "CORRA",
  "SGD": "SORA",
  "ZAR": "ZARONIA",
  "ILS": "SHIR",
  "AUD": "AONIA",
  "NZD": "NZIONA",
  "BRL": "CDI",
  "INR": "MIBOR",
  "COP": "IBR",
  "CLP": "ICP",
  "THB": "THOR",
  "MXN": "TIIE",
  "MYR": "MYOR",
  "KRW": "KOFR",
  "PLN": "POLSTR",
  "CNY": "FR007"
}

export const FIXED_FLOAT_CURRENCY_INDICES: Record<string, string> = {
  "EUR": "EURIBOR",
  "CZK": "PRIBOR",
  "USD": "SOFR",
  "GBP": "SONIA",
  "JPY": "TONA",
  "CHF": "SARON",
  "CAD": "CORRA",
  "NZD": "BKBM",
  "SGD": "SORA",
  "BRL": "CDI",
  "COP": "IBR",
  "CLP": "ICP",
  "THB": "THOR",
  "INR": "MIBOR",
  "MXN": "TIIE",
  "MYR": "KLIBOR",
  "AUD": "BBSW",
  "HKD": "HIBOR",
  "ZAR": "JIBAR",
  "KRW": "KRWCD",
  "HUF": "BUBOR",
  "PLN": "WIBOR",
  "CNY": "FR007",
  "TWD": "TAIBOR"
}
