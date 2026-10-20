// GraphQL documents for TMX Money's API (app-money.tmx.com/graphql). Ported from openbb_tmx/utils/gql.py
// (OpenBB Platform 5.0.0, Apache-2.0); modified: exported as TypeScript constants, text unchanged.

export const QUOTE_BY_SYMBOL = `query getQuoteBySymbol($symbol: String, $locale: String) {
  getQuoteBySymbol(symbol: $symbol, locale: $locale) {
    symbol
    name
    price
    priceChange
    percentChange
    exchangeName
    exShortName
    exchangeCode
    marketPlace
    sector
    industry
    volume
    openPrice
    dayHigh
    dayLow
    MarketCap
    MarketCapAllClasses
    peRatio
    prevClose
    dividendFrequency
    dividendYield
    dividendAmount
    dividendCurrency
    beta
    eps
    exDividendDate
    longDescription
    fulldescription
    website
    email
    phoneNumber
    fullAddress
    employees
    shareOutStanding
    totalDebtToEquity
    totalSharesOutStanding
    sharesESCROW
    vwap
    dividendPayDate
    weeks52high
    weeks52low
    alpha
    averageVolume10D
    averageVolume20D
    averageVolume30D
    averageVolume50D
    priceToBook
    priceToCashFlow
    returnOnEquity
    returnOnAssets
    day21MovingAvg
    day50MovingAvg
    day200MovingAvg
    dividend3Years
    dividend5Years
    datatype
    issueType
    secType
    close
    qmdescription
    currency
  }
}`

export const QUOTE_FOR_SYMBOLS = `query getQuoteForSymbols($symbols: [String]) {
  getQuoteForSymbols(symbols: $symbols) {
    symbol
    longname
    shortName
    currency
    exchange
    price
    volume
    openPrice
    priceChange
    percentChange
    dayHigh
    dayLow
    prevClose
    bid
    ask
    weeks52high
    weeks52low
  }
}`

export const TIME_SERIES = `query getTimeSeriesData($symbol: String!, $freq: String, $interval: Int, $start: String, $end: String, $startDateTime: Int, $endDateTime: Int) {
  getTimeSeriesData(
    symbol: $symbol
    freq: $freq
    interval: $interval
    start: $start
    end: $end
    startDateTime: $startDateTime
    endDateTime: $endDateTime
  ) {
    dateTime
    open
    high
    low
    close
    volume
  }
}`

export const COMPANY_PRICE_HISTORY = `query getCompanyPriceHistory($symbol: String!, $start: String, $end: String, $adjusted: Boolean, $adjustmentType: String, $unadjusted: Boolean, $limit: Int) {
  getCompanyPriceHistory(
    symbol: $symbol
    start: $start
    end: $end
    adjusted: $adjusted
    adjustmentType: $adjustmentType
    unadjusted: $unadjusted
    limit: $limit
  ) {
    datetime
    openPrice
    closePrice
    high
    low
    volume
    tradeValue
    numberOfTrade
    change
    changePercent
    vwap
  }
}`

export const MOST_RECENT_TRADES = `query getCompanyMostRecentTrades($symbol: String, $limit: Int) {
  getCompanyMostRecentTrades(symbol: $symbol, limit: $limit) {
    price
    volume
    datetime
    sellerId
    sellerName
    buyerId
    buyerName
    exchangeCode
  }
}`

export const NEWS_AND_EVENTS = `query getNewsAndEvents($symbol: String!, $page: Int!, $limit: Int!, $locale: String!, $companyInNews: Boolean) {
  news: getNewsForSymbol(
    symbol: $symbol
    page: $page
    limit: $limit
    locale: $locale
    companyInNews: $companyInNews
  ) {
    headline
    datetime
    source
    newsid
    summary
  }
  events: getUpComingEventsForSymbol(symbol: $symbol, locale: $locale) {
    title
    date
    status
    type
  }
}`

export const NEWS_FOR_SYMBOLS = `query getNewsForSymbols($symbols: [String!], $page: Int!, $limit: Int!, $locale: String!) {
  news: getNewsForSymbols(symbols: $symbols, page: $page, limit: $limit, locale: $locale) {
    headline
    datetime
    source
    newsid
    summary
    topic
  }
}`

export const COMPANY_FILINGS = `query getCompanyFilings($symbol: String!, $fromDate: String, $toDate: String, $limit: Int) {
  filings: getCompanyFilings(
    symbol: $symbol
    fromDate: $fromDate
    toDate: $toDate
    limit: $limit
  ) {
    size
    filingDate
    description
    name
    urlToPdf
  }
}`

export const DIVIDENDS_FOR_SYMBOL = `query getDividendsForSymbol($symbol: String!, $page: Int, $batch: Int) {
  dividendHistory: getDividendsForSymbol(symbol: $symbol, page: $page, batch: $batch) {
    pageNumber
    hasNextPage
    dividends {
      exDate
      amount
      currency
      payableDate
      declarationDate
      recordDate
    }
  }
}`

export const SPLITS_FOR_SYMBOL = `query getSplitsForSymbol($symbol: String!) {
  getSplitsForSymbol(symbol: $symbol) {
    splitDate
    ratio
  }
}`

export const COMPANY_ANALYSTS = `query getCompanyAnalysts($symbol: String!, $datatype: String) {
  getCompanyAnalysts(symbol: $symbol, datatype: $datatype) {
    totalAnalysts
    priceTarget {
      lowPriceTarget
      highPriceTarget
      priceTarget
      priceTargetUpside
    }
    consensusAnalysts {
      consensus
      buy
      sell
      hold
    }
  }
}`

export const EARNINGS_FOR_DATE = `query getEnhancedEarningsForDate($date: String!) {
  getEnhancedEarningsForDate(date: $date) {
    symbol
    companyName
    announceTime
    estimatedEps
    actualEps
    epsSurprisePercent
    epsSurpriseDollar
  }
}`

export const INDEX_CONSTITUENTS = `query getIndexConstituents($symbol: String!) {
  constituents: getIndexConstituents(symbol: $symbol) {
    symbol
    quotedMarketValue
    longName
    shortName
    weight
    exShortName
    exchange
    exLongName
  }
  keyData: getIndexKeyData(symbol: $symbol) {
    adjMarketCap
    avgConstituentMarketCap
    numConstituents
    top10HoldingsAdjMarketCap
    ytdPriceReturn
    prevDayPriceReturn
    prevMonthPriceReturn
    prevQuarterPriceReturn
    percentWeightLargestConstituent
    peRatio
    pbRatio
    priceToSales
    divYield
    pcfRatio
  }
}`

export const INDEX_KEY_DATA = `query getIndexKeyData($symbol: String!) {
  getIndexKeyData(symbol: $symbol) {
    adjMarketCap
    avgConstituentMarketCap
    numConstituents
    top10HoldingsAdjMarketCap
    ytdPriceReturn
    prevDayPriceReturn
    prevMonthPriceReturn
    prevQuarterPriceReturn
    percentWeightLargestConstituent
    peRatio
    pbRatio
    priceToSales
    divYield
    pcfRatio
  }
}`

export const STOCK_LIST = `query getStockListSymbolsWithQuote($stockListId: String!, $locale: String) {
  stockList: getStockListSymbolsWithQuote(stockListId: $stockListId, locale: $locale) {
    stockListId
    name
    description
    longDescription
    metricTitle
    listItems {
      symbol
      longName
      rank
      metric
      price
      priceChange
      percentChange
      volume
    }
    totalPriceChange
    totalPercentChange
    createdAt
    updatedAt
  }
}`

export const COMPANY_INSIDERS = `query getCompanyInsidersActivities($symbol: String) {
  getCompanyInsidersActivities(symbol: $symbol) {
    insiderActivities {
      periodkey
      buy {
        name
        trades
        shares
        sharesHeld
        tradeValue
      }
      sell {
        name
        trades
        shares
        sharesHeld
        tradeValue
      }
    }
    activitySummary {
      periodkey
      buyShares
      soldShares
      netActivity
      totalShares
      buyTrades
      sellTrades
      totalTrades
    }
  }
}`

export const INSIDER_TRANSACTIONS = `query getInsiderTransactions($symbol: String!, $monthDuration: Int) {
  getInsiderTransactions(symbol: $symbol, monthDuration: $monthDuration)
}`

export const SHORT_INTEREST = `query GetCompanyShortInterest($symbol: String!) {
  getCompanyShortInterest(symbol: $symbol) {
    QM_TICKER
    BUSINESS_DATE
    TICKER
    SHORT_INTEREST
    SHORTINTERESTPCT
    DAYSTOCOVER10DAY
    DAYSTOCOVER30DAY
    DAYSTOCOVER90DAY
  }
}`

export const MARKET_MOVERS = `query getMarketMovers($sortOrder: String!, $statExchange: String!, $marketId: Int, $limit: Int, $statCountry: String) {
  getMarketMovers(
    sortOrder: $sortOrder
    statExchange: $statExchange
    marketId: $marketId
    limit: $limit
    statCountry: $statCountry
  ) {
    symbol
    name
    exchangeName
    exchangeCode
    price
    priceChange
    percentChange
    volume
    tradeVolume
    open
    high
    low
    weeks52low
    weeks52high
  }
}`

export const TSX30 = `query GetTsx30Companies {
  getTsx30Companies {
    rank
    ticker
    sharePrice {
      en
    }
    name {
      en
    }
    industry {
      en
    }
    location {
      en
    }
    desc {
      en
    }
    website
    logoUrl
  }
}`

export const VENTURE50 = `query getVenture50Companies {
  getVenture50Companies {
    rank
    ticker
    sharePriceAppreciation
    marketCapChange
    url
    name {
      en
    }
    sector {
      en
    }
    location {
      en
    }
    desc {
      en
    }
    logoUrl
  }
}`

export const NEWS_FOR_SYMBOL = `query getNewsForSymbol($symbol: String!, $page: Int!, $limit: Int!, $locale: String!) {
  getNewsForSymbol(symbol: $symbol, page: $page, limit: $limit, locale: $locale) {
    newsid
    headline
    datetime
    source
    summary
  }
}`
