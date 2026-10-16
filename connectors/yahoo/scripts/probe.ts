// Phase 0 probe: what does yahoo-finance2 actually return for the four kinds?
import YahooFinance from 'yahoo-finance2'

const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] })
const show = (label: string, v: unknown) => console.log(`\n### ${label}\n` + JSON.stringify(v, null, 1).slice(0, 3000))

async function main() {
  const s = await yf.search('micron', { quotesCount: 5, newsCount: 3 })
  show('search("micron")', { quotes: s.quotes, news: s.news?.slice(0, 2) })

  const q = await yf.quote(['MU', 'SNDK', 'SPY'])
  show('quote([MU,SNDK,SPY]) keys', Object.keys(q[0] ?? {}))
  show(
    'quote fields of interest',
    q.map((r: any) => ({
      symbol: r.symbol, regularMarketPrice: r.regularMarketPrice, regularMarketChangePercent: r.regularMarketChangePercent, regularMarketVolume: r.regularMarketVolume,
      marketState: r.marketState, preMarketPrice: r.preMarketPrice, preMarketChangePercent: r.preMarketChangePercent, postMarketPrice: r.postMarketPrice, postMarketChangePercent: r.postMarketChangePercent,
      regularMarketTime: r.regularMarketTime, exchange: r.exchange, fullExchangeName: r.fullExchangeName, shortName: r.shortName, quoteType: r.quoteType,
    })),
  )

  const c5 = await yf.chart('NVDA', { period1: new Date(Date.now() - 2 * 86400e3), interval: '5m' })
  show('chart NVDA 5m 2d: meta + first/last quotes', { meta: { ...c5.meta, currentTradingPeriod: undefined, tradingPeriods: undefined, validRanges: (c5.meta as any).validRanges }, count: c5.quotes.length, first: c5.quotes[0], last: c5.quotes[c5.quotes.length - 1] })

  const cw = await yf.chart('MU', { period1: '2026-04-01', interval: '1wk' })
  show('chart MU 1wk since 2026-04-01', { count: cw.quotes.length, first: cw.quotes[0], last: cw.quotes.at(-1) })

  const cd = await yf.chart('MU', { period1: '2026-07-16', interval: '1d' })
  show('chart MU 1d 3mo', { count: cd.quotes.length, first: cd.quotes[0], last: cd.quotes.at(-1) })

  const e = await yf.quoteSummary('MU', { modules: ['calendarEvents', 'earnings'] })
  show('quoteSummary MU calendarEvents', e.calendarEvents)
  show('quoteSummary MU earnings.earningsChart (partial)', { earningsDate: (e as any).earnings?.earningsChart?.earningsDate, currentQuarterEstimate: (e as any).earnings?.earningsChart?.currentQuarterEstimate })

  // Does chart accept a `range`-style call? Try the raw option.
  try {
    const cr = await yf.chart('SPY', { range: '5d', interval: '1d' } as any)
    show('chart SPY range=5d', { count: cr.quotes.length, first: cr.quotes[0] })
  } catch (err) {
    show('chart with range option failed', String(err))
  }
}
main().catch((e) => {
  console.error('PROBE FAILED', e)
  process.exit(1)
})
