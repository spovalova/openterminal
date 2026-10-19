// The twelve visual acceptance cases of PLAN.md section 17 as hand-built workspaces: for each case, the widget set
// the agent is expected to produce (recipes, routes and transforms as the prompt rules describe them). `node
// scripts/accept.mjs --build <dir>` creates them on a server and writes transcripts that the checklist then scores,
// so the rendering half of the acceptance loop (presets, packer, renderers, annotations, recipes) runs without the
// agent; the reply half (rubric, verification, chips) needs `pnpm bench -- --group v2-accept`.
//
// Dates are written for the week of 2026-10-19 (Monday): last week is Oct 12 to 16, next Friday Oct 23.

const LAST_WEEK = [Date.UTC(2026, 9, 12, 4), Date.UTC(2026, 9, 17, 4) - 1]
const r = (recipe, params) => ({ recipe, params })
const route = (connector, routePath, params) => ({ connector, route: routePath, params })
const t = (inputs, code, columns) => ({ inputs, code: code.trim(), ...(columns ? { columns } : {}) })
const w = (title, size, data, view, fields) => ({ title, size, data, view, ...(fields ? { fields } : {}) })

const NEOCLOUDS = ['CRWV', 'NBIS', 'IREN', 'APLD', 'WYFI']
const SECTORS = { XLK: 'Technology', XLF: 'Financials', XLV: 'Health care', XLY: 'Consumer disc.', XLP: 'Consumer staples', XLE: 'Energy', XLI: 'Industrials', XLB: 'Materials', XLU: 'Utilities', XLRE: 'Real estate', XLC: 'Communication' }
const MAG7 = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA']
const WATCHLIST = ['NVDA', 'AMD', 'MU', 'TSLA', 'AAPL']

const PE_CODE = `
e = eps.sort_values("date")
e["eps_ttm"] = e.groupby("symbol")["eps_actual"].transform(lambda s: s.rolling(4).sum())
e = e.dropna(subset=["eps_ttm"]).rename(columns={"date": "time"})
p = price.sort_values("time")
m = pd.merge_asof(p, e[["symbol", "time", "eps_ttm"]], on="time", by="symbol")
m = m[m.eps_ttm > 0]
m["pe"] = m.close / m.eps_ttm
result = m[["symbol", "time", "close", "eps_ttm", "pe"]]
`
const PE = t({ price: r('ohlcv', { symbols: ['NVDA'], interval: '1d', range: '2y' }), eps: r('eps_history', { symbols: ['NVDA'], limit: 12 }) }, PE_CODE, { pe: { unit: 'ratio', label: 'P/E (TTM)', key: true }, eps_ttm: { unit: 'usd', label: 'EPS (TTM)' } })

const KEY_EVENTS = t(
  { cal: r('calendar', { from: '2026-10-12', to: '2026-10-16', country: 'United States' }) },
  `
df = cal[cal["event"].astype(str).str.contains("CPI|PPI|Retail Sales|Jobless|Payroll|FOMC|Fed |Philly|Michigan|Housing|Industrial", case=False, regex=True)]
df = df[df["actual"].astype(str).str.strip().ne("-") & df["actual"].astype(str).str.strip().ne("")]
result = df[["date", "event", "actual", "consensus", "previous"]].sort_values("date")
`,
)

const SPY_BT_INPUT = { price: r('ohlcv', { symbols: ['SPY'], interval: '1d', range: '5y' }) }
const SPY_BT_PREP = `
df = ot.sma(ot.sma(price, 50), 200).sort_values("time").reset_index(drop=True)
df["signal"] = (df.sma_50 > df.sma_200).astype(int)
df["pos"] = df.signal.shift(1).fillna(0)
df["ret"] = df.close.pct_change().fillna(0)
df["strategy"] = (1 + df.ret * df.pos).cumprod() * 100
df["buy_hold"] = (1 + df.ret).cumprod() * 100
`

export const CASES = [
  {
    name: 'crwv',
    prompt: 'Why is CRWV down?',
    workspace: 'CRWV: why down',
    widgets: [
      w('CRWV, three months', 'lg', { main: r('ohlcv', { symbols: ['CRWV'], interval: '1d', range: '3mo' }), events: r('news', { symbols: ['CRWV'], limit: 20 }) }, { preset: 'price', candle: true, volume: true, events: 'events', band: LAST_WEEK }),
      w('9.25% 2030 notes, yield', 'md', { main: route('openbb', 'finra/fixedincome/bond_historical', { cusip: '21873SAB4' }) }, { preset: 'price' }, { price: { hidden: true } }),
      w('CRWV vs peers and SPY', 'md', { main: r('ohlcv', { symbols: ['CRWV', 'NBIS', 'IREN', 'SMH', 'SPY'], interval: '1d', range: '3mo' }) }, { preset: 'compare', normalize: true }),
      w('CRWV today', 'sm', { main: r('quote', { symbols: ['CRWV'] }) }, { preset: 'stat' }),
      w('CoreWeave bonds (FINRA)', 'md', { main: route('openbb', 'fixedincome/corporate/bond_prices', { provider: 'finra', issuer_name: 'coreweave' }) }, { preset: 'table', columns: ['cusip', 'coupon_rate', 'maturity_date', 'price', 'last_sale_yield', 'price_change_percent', 'moodys_rating', 'sp_rating'], sort: { column: 'last_sale_yield', dir: 'desc' } }),
      w('CRWV news', 'md', { main: r('news', { symbols: ['CRWV'], limit: 20 }) }, { preset: 'table', columns: ['date', 'title', 'publisher'] }),
    ],
  },
  {
    name: 'neoclouds',
    prompt: 'Compare the neoclouds',
    workspace: 'Neoclouds compared',
    widgets: [
      w('Neoclouds, six months', 'lg', { main: r('ohlcv', { symbols: NEOCLOUDS, interval: '1d', range: '6mo' }) }, { preset: 'compare', normalize: true }),
      w(
        'Metrics by symbol',
        'md',
        {
          main: t(
            { metrics: r('metrics', { symbols: NEOCLOUDS }) },
            `
m = metrics.set_index("symbol")
labels = {"market_cap": "Market cap ($)", "pe_ratio": "P/E", "forward_pe": "Forward P/E", "enterprise_to_revenue": "EV / revenue", "revenue_growth": "Revenue growth %", "gross_margin": "Gross margin %", "operating_margin": "Operating margin %", "profit_margin": "Profit margin %", "debt_to_equity": "Debt / equity %", "return_on_equity": "ROE %", "price_return_1y": "1y return %", "beta": "Beta"}
keep = [c for c in labels if c in m.columns]
if "market_cap" in m.columns:
    m["market_cap"] = m["market_cap"] / 1e9
    labels["market_cap"] = "Market cap ($bn)"
tbl = m[keep].T.reset_index().rename(columns={"index": "metric"})
tbl["metric"] = tbl["metric"].map(labels)
for c in tbl.columns[1:]:
    tbl[c] = tbl[c].astype(float).round(2)
result = tbl
`,
          ),
        },
        { preset: 'table' },
      ),
      w(
        'Balance sheet and cash flow, last quarter',
        'md',
        {
          main: t(
            Object.fromEntries(NEOCLOUDS.map((s) => [s.toLowerCase(), r('financials', { symbols: [s], period: 'quarter', limit: 2 })])),
            `
rows = []
for name, df in [("CRWV", crwv), ("NBIS", nbis), ("IREN", iren), ("APLD", apld), ("WYFI", wyfi)]:
    if len(df):
        x = df.sort_values("period_ending").iloc[-1]
        rows.append({"symbol": name, "period_ending": x.get("period_ending"), "revenue": x.get("revenue"), "operating_cash_flow": x.get("operating_cash_flow"), "capex": x.get("capex"), "free_cash_flow": x.get("free_cash_flow"), "cash": x.get("cash"), "debt": x.get("debt")})
result = pd.DataFrame(rows)
`,
            { revenue: { unit: 'usd', format: 'compact', label: 'Revenue' }, operating_cash_flow: { unit: 'usd', format: 'compact', label: 'Op cash flow' }, capex: { unit: 'usd', format: 'compact', label: 'Capex' }, free_cash_flow: { unit: 'usd', format: 'compact', label: 'FCF' }, cash: { unit: 'usd', format: 'compact', label: 'Cash' }, debt: { unit: 'usd', format: 'compact', label: 'Debt' } },
          ),
        },
        { preset: 'table', extremes: true },
      ),
      w('Street targets', 'md', { main: r('estimates', { symbols: NEOCLOUDS }) }, { preset: 'table', columns: ['symbol', 'recommendation', 'number_of_analysts', 'target_consensus', 'current_price', 'target_high', 'target_low'], extremes: true }),
      w('Today', 'sm', { main: r('quote', { symbols: NEOCLOUDS }) }, { preset: 'stat' }),
      w('Neocloud news', 'md', { main: r('news', { symbols: NEOCLOUDS, limit: 20 }) }, { preset: 'table', columns: ['date', 'symbols', 'title', 'publisher'] }),
    ],
  },
  {
    name: 'spx',
    prompt: "What's happening to the S&P last week?",
    workspace: 'S&P 500, last week',
    widgets: [
      w('S&P 500, last week', 'lg', { main: r('index', { symbol: '^GSPC', interval: '1d', range: '1mo' }), events: KEY_EVENTS }, { preset: 'price', candle: true, events: 'events', band: LAST_WEEK }),
      w(
        'Sectors, week of Oct 12',
        'md',
        {
          main: t(
            { bars: r('ohlcv', { symbols: Object.keys(SECTORS), interval: '1d', range: '1mo' }) },
            `
names = ${JSON.stringify(SECTORS)}
df = bars.sort_values("time")
base = df[df.time <= "2026-10-09 23:59"].groupby("symbol").close.last()
last = df[df.time <= "2026-10-16 23:59"].groupby("symbol").close.last()
out = pd.DataFrame({"symbol": base.index, "sector": [names.get(s, s) for s in base.index], "close_oct9": base.values, "close_oct16": last.reindex(base.index).values})
out["week_pct"] = (out.close_oct16 / out.close_oct9 - 1) * 100
result = out.sort_values("week_pct", ascending=False)
`,
            { week_pct: { unit: 'percent', format: 'change', label: 'Week %', priority: 1, key: true }, close_oct9: { unit: 'usd', format: 'price', label: 'Oct 9', priority: 4 }, close_oct16: { unit: 'usd', format: 'price', label: 'Oct 16', priority: 3 }, sector: { label: 'Sector', priority: 1 } },
          ),
        },
        { preset: 'table', sort: { column: 'week_pct', dir: 'desc' }, colorize: ['week_pct'] },
      ),
      w('Leaders today', 'sm', { main: r('movers', { list: 'gainers', limit: 10 }) }, { preset: 'table', columns: ['symbol', 'price', 'percent_change'] }),
      w('Laggards today', 'sm', { main: r('movers', { list: 'losers', limit: 10 }) }, { preset: 'table', columns: ['symbol', 'price', 'percent_change'] }),
      w('Releases, Oct 12 to 16', 'md', { main: KEY_EVENTS }, { preset: 'table', columns: ['date', 'event', 'actual', 'consensus', 'previous'] }),
      w('Index ETFs today', 'sm', { main: r('quote', { symbols: ['SPY', 'QQQ', 'IWM', 'DIA'] }) }, { preset: 'stat' }),
    ],
  },
  {
    name: 'tsla-puts',
    prompt: 'TSLA puts for next Friday',
    workspace: 'TSLA puts, Oct 23',
    widgets: [
      w('TSLA puts, Oct 23', 'lg', { main: r('options', { symbol: 'TSLA', expiration: '2026-10-23', strikes: 10, type: 'put' }) }, { preset: 'chain' }),
      w('Put IV by strike', 'md', { main: r('options', { symbol: 'TSLA', expiration: '2026-10-23', strikes: 10, type: 'put' }) }, { preset: 'curve', x: 'strike', y: 'implied_volatility' }),
      w('TSLA volatility', 'sm', { main: r('volatility', { symbols: ['TSLA'] }) }, { preset: 'stat', column: 'iv30' }),
      w('TSLA, three months', 'md', { main: r('ohlcv', { symbols: ['TSLA'], interval: '1d', range: '3mo' }), events: r('earnings', { symbols: ['TSLA'], from: '2026-07-21', to: '2026-12-18' }) }, { preset: 'price', candle: true, events: 'events' }),
      w('TSLA news', 'md', { main: r('news', { symbols: ['TSLA'], limit: 20 }) }, { preset: 'table', columns: ['date', 'title', 'publisher'] }),
    ],
  },
  {
    name: 'tsla-earnings',
    prompt: 'TSLA earnings reactions',
    workspace: 'TSLA earnings reactions',
    widgets: [
      w('TSLA, two years, reports marked', 'lg', { main: r('ohlcv', { symbols: ['TSLA'], interval: '1d', range: '2y' }), events: r('eps_history', { symbols: ['TSLA'], limit: 8 }) }, { preset: 'price', candle: true, events: 'events' }),
      w(
        'Reaction to each report',
        'md',
        {
          main: t(
            { eps: r('eps_history', { symbols: ['TSLA'], limit: 8 }), price: r('ohlcv', { symbols: ['TSLA'], interval: '1d', range: '2y' }) },
            `
e = eps.dropna(subset=["eps_actual"]).sort_values("date")
p = price.sort_values("time")[["time", "close"]].reset_index(drop=True)
rows = []
for _, x in e.iterrows():
    d = x["date"]
    before = p[p.time < d].tail(1)
    after = p[p.time >= d].head(2)
    if len(before) and len(after) >= 2:
        c0 = float(before.close.iloc[0]); c1 = float(after.close.iloc[1])
        rows.append({"date": d, "eps_actual": x["eps_actual"], "eps_estimated": x["eps_estimated"], "surprise_percent": x["surprise_percent"], "close_before": c0, "close_after": c1, "reaction_pct": (c1 / c0 - 1) * 100})
result = pd.DataFrame(rows).sort_values("date", ascending=False)
`,
            { reaction_pct: { unit: 'percent', format: 'change', label: 'Reaction', priority: 1, key: true }, close_before: { unit: 'usd', format: 'price', label: 'Close before', priority: 3 }, close_after: { unit: 'usd', format: 'price', label: 'Close after', priority: 3 }, surprise_percent: { unit: 'percent', format: 'change', label: 'Surprise %', priority: 2 } },
          ),
        },
        { preset: 'table', sort: { column: 'date', dir: 'desc' }, colorize: ['reaction_pct', 'surprise_percent'] },
      ),
      w('Street consensus', 'sm', { main: r('estimates', { symbols: ['TSLA'] }) }, { preset: 'facts' }),
      w('TSLA today', 'sm', { main: r('quote', { symbols: ['TSLA'] }) }, { preset: 'stat' }),
      w('TSLA news', 'md', { main: r('news', { symbols: ['TSLA'], limit: 20 }) }, { preset: 'table', columns: ['date', 'title', 'publisher'] }),
    ],
  },
  {
    name: 'cheap-tech',
    prompt: 'Large-cap tech under 20x',
    workspace: 'Large-cap tech under 20x',
    widgets: [
      w(
        'Tech over $10B under 20x trailing',
        'lg',
        {
          main: t(
            { scr: route('openbb', 'equity/screener', { provider: 'yfinance', sector: 'technology', mktcap_min: 10000000000, limit: 250 }) },
            `
df = scr[(scr.trailingPE > 0) & (scr.trailingPE < 20)]
keep = [c for c in ["symbol", "name", "price", "percent_change", "market_cap", "trailingPE", "pe_forward", "eps_ttm", "year_high", "year_low"] if c in df.columns]
result = df[keep].sort_values("trailingPE")
`,
            { trailingPE: { unit: 'ratio', format: 'ratio', label: 'P/E', priority: 1, key: true }, pe_forward: { unit: 'ratio', format: 'ratio', label: 'Fwd P/E', priority: 2 } },
          ),
        },
        { preset: 'table', sort: { column: 'trailingPE', dir: 'asc' } },
      ),
      w(
        'Names under 20x',
        'sm',
        {
          main: t(
            { scr: route('openbb', 'equity/screener', { provider: 'yfinance', sector: 'technology', mktcap_min: 10000000000, limit: 250 }) },
            `
df = scr[(scr.trailingPE > 0) & (scr.trailingPE < 20)]
result = pd.DataFrame([{"count": int(len(df)), "median_pe": float(df.trailingPE.median()) if len(df) else None, "universe": int(len(scr))}])
`,
            { count: { unit: 'count', label: 'Under 20x', key: true }, median_pe: { unit: 'ratio', format: 'ratio', label: 'Median P/E' }, universe: { unit: 'count', label: 'Universe' } },
          ),
        },
        { preset: 'stat', column: 'count' },
      ),
      w(
        'P/E by sector, large caps',
        'md',
        {
          main: t(
            { all: route('openbb', 'equity/screener', { provider: 'yfinance', mktcap_min: 10000000000, limit: 250 }) },
            `
df = all[all.trailingPE > 0]
sec = "sector" if "sector" in df.columns else None
if sec:
    g = df.groupby(sec).trailingPE
    result = pd.DataFrame({"sector": g.median().index, "median_pe": g.median().values, "min_pe": g.min().values, "max_pe": g.max().values, "names": g.size().values}).sort_values("median_pe")
else:
    result = pd.DataFrame({"symbol": df.symbol, "trailing_pe": df.trailingPE, "forward_pe": df.pe_forward, "price_to_book": df.price_to_book}).sort_values("trailing_pe").head(20)
`,
          ),
        },
        { preset: 'heatmap', palette: 'sequential' },
      ),
    ],
  },
  {
    name: 'nvda-pe',
    prompt: 'P/E over time for NVDA',
    workspace: 'NVDA P/E over time',
    widgets: [
      w('NVDA P/E (TTM), two years', 'lg', { main: PE, events: r('eps_history', { symbols: ['NVDA'], limit: 12 }) }, { preset: 'price', events: 'events' }),
      w('P/E now', 'sm', { main: PE }, { preset: 'stat', column: 'pe' }),
      w('NVDA, two years', 'md', { main: r('ohlcv', { symbols: ['NVDA'], interval: '1d', range: '2y' }) }, { preset: 'price', candle: true }),
      w('Reported EPS', 'sm', { main: r('eps_history', { symbols: ['NVDA'], limit: 12 }) }, { preset: 'table', columns: ['date', 'eps_actual', 'eps_estimated', 'surprise_percent'] }),
    ],
  },
  {
    name: 'amd-rsi',
    prompt: 'RSI and MACD on AMD',
    workspace: 'AMD: RSI and MACD',
    widgets: [
      w(
        'AMD with RSI 14 and MACD',
        'lg',
        { main: t({ price: r('ohlcv', { symbols: ['AMD'], interval: '1d', range: '6mo' }) }, 'result = ot.sma(ot.macd(ot.rsi(price, 14)), 50)') },
        { preset: 'indicator', candle: true, volume: true, rsi: 14, macd: true, overlays: ['sma_50'] },
      ),
    ],
  },
  {
    name: 'curve',
    prompt: '10y minus 2y and the curve today',
    workspace: '10y-2y and the curve',
    widgets: [
      w(
        '10y minus 2y, five years',
        'lg',
        {
          main: t(
            { ten: r('macro', { series: 'treasury_10y', range: '5y' }), two: r('macro', { series: 'treasury_2y', range: '5y' }) },
            `
m = ten[["time", "year_10"]].merge(two[["time", "year_2"]], on="time").sort_values("time")
m["spread"] = m.year_10 - m.year_2
m["inverted"] = m.spread < 0
result = m[["time", "spread", "inverted"]]
`,
            { spread: { unit: 'percent', label: '10Y-2Y', key: true } },
          ),
        },
        { preset: 'price', band: { data: 'main', when: 'inverted' } },
      ),
      w('Yield curve today', 'md', { main: r('yield_curve', {}) }, { preset: 'curve' }),
      w('10y and 2y, five years', 'md', { ten: r('macro', { series: 'treasury_10y', range: '5y' }), two: r('macro', { series: 'treasury_2y', range: '5y' }) }, { preset: 'compare', normalize: false }),
      w('Fed funds', 'sm', { main: r('macro', { series: 'fed_funds', range: '1y' }) }, { preset: 'stat' }),
    ],
  },
  {
    name: 'morning',
    prompt: `Morning check on my watchlist: ${WATCHLIST.join(', ')}`,
    workspace: 'Morning check',
    widgets: [
      w('Watchlist pre-market', 'lg', { main: r('quote', { symbols: [...WATCHLIST, 'SPY', 'QQQ'] }) }, { preset: 'stat' }),
      // Three columns, two rows, no scroll: the stat row (2x1), the chart with the reporting markers (1x2), the news (2x1).
      w('TSLA into the report', 'md', { main: r('ohlcv', { symbols: ['TSLA'], interval: '1d', range: '1mo' }), events: r('earnings', { symbols: WATCHLIST, from: '2026-10-19', to: '2026-11-02' }) }, { preset: 'price', candle: true, events: 'events' }),
      w('Overnight news', 'md', { main: r('news', { symbols: WATCHLIST, limit: 20 }) }, { preset: 'table', columns: ['date', 'symbols', 'title', 'publisher'] }),
    ],
  },
  {
    name: 'mag7-corr',
    prompt: 'Correlation of the Mag 7 over 6 months',
    workspace: 'Mag 7 correlation',
    widgets: [
      w('Mag 7 correlation, six months', 'lg', { main: t({ price: r('ohlcv', { symbols: MAG7, interval: '1d', range: '6mo' }) }, 'result = ot.corr(price)') }, { preset: 'heatmap' }),
      w('Mag 7, six months', 'md', { main: r('ohlcv', { symbols: MAG7, interval: '1d', range: '6mo' }) }, { preset: 'compare', normalize: true }),
      w(
        'Pairs, most to least correlated',
        'md',
        {
          main: t(
            { price: r('ohlcv', { symbols: MAG7, interval: '1d', range: '6mo' }) },
            `
c = ot.corr(price).set_index("symbol")
rows = []
cols = list(c.columns)
for i, a in enumerate(cols):
    for b in cols[i + 1:]:
        rows.append({"pair": f"{a} / {b}", "a": a, "b": b, "correlation": float(c.loc[a, b])})
result = pd.DataFrame(rows).sort_values("correlation", ascending=False)
`,
            { correlation: { unit: 'ratio', format: 'ratio', label: 'Correlation', priority: 1, key: true }, pair: { label: 'Pair', priority: 1 }, a: { hidden: true }, b: { hidden: true } },
          ),
        },
        { preset: 'table', columns: ['pair', 'correlation'], sort: { column: 'correlation', dir: 'desc' } },
      ),
    ],
  },
  {
    name: 'spy-backtest',
    prompt: 'Backtest a 50/200 SMA cross on SPY since 2020',
    workspace: 'SPY 50/200 cross',
    widgets: [
      w(
        'SMA 50/200 cross vs buy and hold',
        'lg',
        {
          main: t(SPY_BT_INPUT, SPY_BT_PREP + `
a = df[["time"]].assign(series="SMA 50/200", value=df.strategy)
b = df[["time"]].assign(series="Buy and hold", value=df.buy_hold)
result = pd.concat([a, b]).dropna(subset=["value"])
`, { value: { unit: 'ratio', format: 'ratio', label: 'Equity (100 = start)', key: true } }),
          trades: t(SPY_BT_INPUT, SPY_BT_PREP + `
ch = df[df.signal != df.signal.shift(1)].dropna(subset=["sma_200"])
result = pd.DataFrame({"time": ch.time, "label": ["Buy" if s else "Sell" for s in ch.signal], "kind": ["buy" if s else "sell" for s in ch.signal], "close": ch.close})
`),
        },
        { preset: 'price', events: 'trades' },
      ),
      w(
        'Backtest summary',
        'sm',
        {
          main: t(SPY_BT_INPUT, SPY_BT_PREP + `
years = max((df.time.iloc[-1] - df.time.iloc[0]).days / 365.25, 0.01)
dd = (df.strategy / df.strategy.cummax() - 1).min() * 100
bh_dd = (df.buy_hold / df.buy_hold.cummax() - 1).min() * 100
trades = int((df.signal != df.signal.shift(1)).sum()) - 1
result = pd.DataFrame([{"strategy_return_pct": float(df.strategy.iloc[-1] - 100), "buy_hold_return_pct": float(df.buy_hold.iloc[-1] - 100), "strategy_cagr_pct": float((df.strategy.iloc[-1] / 100) ** (1 / years) * 100 - 100), "max_drawdown_pct": float(dd), "buy_hold_drawdown_pct": float(bh_dd), "trades": trades, "years": round(years, 1), "time_in_market_pct": float(df.pos.mean() * 100)}])
`, { strategy_return_pct: { unit: 'percent', format: 'change', label: 'Strategy return', priority: 1, key: true }, buy_hold_return_pct: { unit: 'percent', format: 'change', label: 'Buy and hold', priority: 1 }, strategy_cagr_pct: { unit: 'percent', label: 'CAGR', priority: 2 }, max_drawdown_pct: { unit: 'percent', format: 'change', label: 'Max drawdown', priority: 2 }, buy_hold_drawdown_pct: { unit: 'percent', format: 'change', label: 'B&H drawdown', priority: 3 }, trades: { unit: 'count', label: 'Trades', priority: 2 }, years: { unit: 'years', format: 'ratio', label: 'Years', priority: 4 }, time_in_market_pct: { unit: 'percent', label: 'Time in market', priority: 3 } }),
        },
        { preset: 'facts' },
      ),
      w('SPY with the 50 and 200-day averages', 'md', { main: t(SPY_BT_INPUT, 'result = ot.sma(ot.sma(price, 50), 200)') }, { preset: 'indicator', overlays: ['sma_50', 'sma_200'] }),
    ],
  },
]
