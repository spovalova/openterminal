import { describe, expect, it } from 'vitest'
import { KINDS, type Message } from '@terminal/core'
import { buildSystemPrompt, renderParams, PROMPT_HISTORY } from '../prompt.js'
import { workspace } from './helpers.js'

const now = new Date('2026-10-16T14:00:00Z') // Friday 10:00 ET, regular session

describe('buildSystemPrompt', () => {
  it('lists answerable and unavailable kinds with params and columns generated from core', () => {
    const p = buildSystemPrompt({ kinds: ['search', 'quote', 'ohlcv'], workspace: workspace(), now, marketState: 'regular' })
    expect(p).toContain('Answerable now: search, quote, ohlcv.')
    expect(p).toContain('Not answerable now (no connector): news, earnings.')
    expect(p).toContain('- news [unavailable]:')
    expect(p).toContain('- ohlcv: ' + KINDS.ohlcv.description)
    expect(p).toContain('params { symbols: string[] (1-50), interval: 1m|5m|15m|1h|1d|1w, range: 1d|5d|1mo|3mo|6mo|1y|5y }')
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
    expect(p).toContain('Four to six widgets')
    expect(p).toContain('A prompt overwrites the workspace')
    expect(p).toContain('[[widget:<id>]]')
    expect(p).toContain('"MU" means "Overview of MU"')
    expect(p).toContain('candle: exactly one symbol. normalize: rebases')
    expect(p).toContain('The first widget is the hero')
    // The three worked examples.
    expect(p).toContain('A. "What\'s happening with memory?"')
    expect(p).toContain('B. "Is NVDA\'s drop today news or just the market?"')
    expect(p).toContain('C. "Morning check on my watchlist"')
    expect(p).toContain('"symbols":["MU","SNDK","WDC","STX"],"interval":"1d","range":"3mo"')
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
