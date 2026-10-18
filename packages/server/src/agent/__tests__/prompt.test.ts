import { describe, expect, it } from 'vitest'
import { KINDS, KIND_NAMES, type Message } from '@terminal/core'
import { buildSystemPrompt, renderParams, PROMPT_HISTORY } from '../prompt.js'
import { workspace } from './helpers.js'

const now = new Date('2026-10-16T14:00:00Z') // Friday 10:00 ET, regular session

describe('buildSystemPrompt', () => {
  it('lists answerable and unavailable kinds with params and columns generated from core', () => {
    const p = buildSystemPrompt({ kinds: ['search', 'quote', 'ohlcv'], workspace: workspace(), now, marketState: 'regular' })
    expect(p).toContain('Answerable now: search, quote, ohlcv.')
    expect(p).toContain('Not answerable now (no connector): news, earnings, profile,')
    expect(p).toContain('- news [unavailable]:')
    expect(p).toContain('- ohlcv: ' + KINDS.ohlcv.description)
    expect(p).toContain('params { symbols: string[] (1-50), interval: 1m|5m|15m|1h|1d|1w, range: 1d|5d|1mo|3mo|6mo|1y|2y|5y }')
    expect(p).toContain('params { symbol: string, expiration?: YYYY-MM-DD, strikes?: integer 1-30 = 10, type?: call|put|both = "both" }')
    expect(p).toContain('columns symbol:string, time:time, open:number, high:number, low:number, close:number, volume:number')
    expect(p).toContain('params { symbols: string[] (1-50), limit?: integer 1-100 = 20 }')
    expect(p).toContain('params { symbols: string[] (1-50), from: YYYY-MM-DD, to: YYYY-MM-DD }')
    expect(p).toContain('columns query:string, symbol:string, name:string, exchange:string')
  })

  it('carries the date, market state and the rules', () => {
    const p = buildSystemPrompt({ kinds: ['quote'], workspace: workspace(), now, marketState: 'regular' })
    expect(p).toContain('Date: 2026-10-16 (Friday), 10:00 America/New_York.')
    expect(p).toContain('US market: regular session')
    expect(p).toContain('+60d 2026-12-15')
    expect(p).toContain('Never write a figure that is not in a preview')
    expect(p).toContain('ONE `search` call')
    expect(p).toContain('at most 10 tool calls')
    expect(p).toContain('Four to six widgets by default')
    expect(p).toContain('A prompt overwrites the workspace')
    expect(p).toContain('[[widget:<id>]]')
    expect(p).toContain('A bare ticker ("MU") means "Overview of MU": ohlcv chart, quote, news, next earnings')
    expect(p).toContain('candle: exactly one symbol. normalize: rebases')
    expect(p).toContain('The first widget is the hero')
    // The three worked examples.
    expect(p).toContain('A. "What\'s happening with memory?"')
    expect(p).toContain('B. "Is NVDA\'s drop today news or just the market?"')
    expect(p).toContain('C. "Morning check on my watchlist"')
    expect(p).toContain('"symbols":["MU","SNDK","WDC","STX"],"interval":"1d","range":"3mo"')
  })

  it('teaches the views per kind and which kinds take symbol, symbols, or none', () => {
    const p = buildSystemPrompt({ kinds: [...KIND_NAMES], workspace: workspace(), now, marketState: 'regular' })
    expect(p).toContain('for ohlcv and macro; `{ type: "chain" }` for options; `{ type: "stat", column?: string }` for quote, metrics, volatility, estimates, profile and short_interest; `{ type: "table" }` for any kind')
    expect(p).toContain('stat shows one big number per symbol')
    expect(p).toContain('Use it, at sm size with one or a few symbols, when the question is about that headline number')
    expect(p).toContain('one line per symbol (ohlcv) or per series (macro)')
    expect(p).toContain('neither on macro')
    expect(p).toContain('options and holdings take one `symbol`')
    expect(p).toContain('search, calendar, ipos, movers, macro and yield_curve take no symbols')
    expect(p).toContain('macro carries `series` instead')
    // When to reach for the v1.2 kinds.
    expect(p).toContain('plus profile or metrics when room allows')
    expect(p).toContain('metrics (add peers so the multiples compare), estimates, financials, eps_history')
    expect(p).toContain('options (chain view, hero) plus volatility')
    expect(p).toContain('calendar, macro (series view), yield_curve')
    expect(p).toContain('insiders, institutions, short_interest')
    expect(p).toContain('movers (gainers, losers, active)')
    expect(p).toContain('holdings, then quote or ohlcv on the top constituents')
    // The three v1.2 worked examples, with their views.
    expect(p).toContain('D. "What do options say about NVDA into earnings?"')
    expect(p).toContain('"query":{"kind":"options","params":{"symbol":"NVDA","expiration":"<report date>","strikes":10,"type":"both"}},"view":{"type":"chain"}')
    expect(p).toContain('E. "Is MU expensive here?"')
    expect(p).toContain('"query":{"kind":"eps_history","params":{"symbols":["MU"],"limit":8}},"view":{"type":"table"}')
    expect(p).toContain('F. "What\'s the macro backdrop this week?"')
    expect(p).toContain('"query":{"kind":"macro","params":{"series":["treasury_10y","treasury_2y","fed_funds"],"range":"1y"}},"view":{"type":"series"}')
    expect(p).toContain('"query":{"kind":"yield_curve","params":{}},"view":{"type":"table"}')
  })

  it('states the reply begins with the answer and that no text precedes the first tool call (bench finding 1)', () => {
    const p = buildSystemPrompt({ kinds: ['quote'], workspace: workspace(), now, marketState: 'regular' })
    expect(p).toContain('The reply begins with the answer')
    expect(p).toContain('"Tickers are known; skip search." must never appear')
    expect(p).toContain('planning happens in tool calls, not in prose, and no text precedes the first tool call')
  })

  it('states that four to six widgets is a default, not a floor (bench finding 2)', () => {
    const p = buildSystemPrompt({ kinds: ['quote'], workspace: workspace(), now, marketState: 'regular' })
    expect(p).toContain('four to six by default, fewer when the user asks for fewer')
    expect(p).toContain('it is not a floor. When the user asks for one or two widgets, build one or two.')
    expect(p).toContain('means exactly the widgets left, however few')
  })

  it('states that a period change is measured from the last close before the period (TSMC baseline)', () => {
    const p = buildSystemPrompt({ kinds: ['ohlcv'], workspace: workspace(), now, marketState: 'regular' })
    expect(p).toContain('measured from the last close before the period, so fetch one range longer than the period (1mo daily for "this week") so the baseline bar is among the preview rows')
    expect(p).toContain('say which baseline you used')
    expect(p).toContain('Percent columns are already percent')
  })

  it('embeds the current workspace widgets and only the last few messages, trimmed', () => {
    const messages: Message[] = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? 'agent' : 'user', text: `message ${i} ${'x'.repeat(i === 9 ? 900 : 0)}` }))
    const ws = workspace({
      name: 'Morning',
      widgets: [{ id: 'w1', title: 'Watchlist pre-market', size: 'lg', query: { kind: 'quote', params: { symbols: ['MU', 'SPY'] } }, view: { type: 'table' } }],
      messages,
    })
    const p = buildSystemPrompt({ kinds: ['quote'], workspace: ws, now, marketState: 'pre' })
    expect(p).toContain('Name: "Morning". Widgets: 1. Earlier messages shown: ' + PROMPT_HISTORY + '.')
    expect(p).toContain('"id":"w1","title":"Watchlist pre-market","size":"lg","query":{"kind":"quote","params":{"symbols":["MU","SPY"]}},"view":{"type":"table"}')
    expect(p).toContain('message 4')
    expect(p).not.toContain('message 3 ')
    expect(p).toContain('…') // the long last message was trimmed
    expect(p).not.toContain('x'.repeat(600))
    expect(p).toContain('Re-emit any of these widgets you want to keep')
    expect(p).toContain('US market: pre-market')
  })

  it('tells the model when nothing is answerable, and when the workspace is empty', () => {
    const p = buildSystemPrompt({ kinds: [], workspace: workspace(), now, marketState: 'closed' })
    expect(p).toContain('Answerable now: none.')
    expect(p).toContain('The workspace is empty')
    expect(p).toContain('US market: closed')
  })
})

describe('renderParams', () => {
  it('renders every catalog kind on one line', () => {
    for (const def of Object.values(KINDS)) {
      const s = renderParams(def.params)
      expect(s.startsWith('{ ')).toBe(true)
      expect(s.endsWith(' }')).toBe(true)
      expect(s).not.toContain('\n')
    }
  })
})
