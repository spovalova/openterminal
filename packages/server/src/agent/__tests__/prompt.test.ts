import { describe, expect, it } from 'vitest'
import { TRANSFORM_EXAMPLE, parseRecipes, type Message, type Recipe } from '@terminal/core'
import { builtinRecipes } from '@terminal/core/node'
import { buildSystemPrompt, PROMPT_HISTORY } from '../prompt.js'
import { workspace } from './helpers.js'

const now = new Date('2026-10-16T14:00:00Z') // Friday 10:00 ET, regular session
const connectors = ['openbb', 'yahoo', 'finnhub']

/** A small fixed recipe list so the snapshot does not move with recipes.yml. */
const recipes: Recipe[] = parseRecipes([
  {
    name: 'quote',
    title: '{symbols} quote',
    summary: 'Latest price and day change per symbol.',
    params: { type: 'object', properties: { symbols: { type: 'array', items: { type: 'string' } } }, required: ['symbols'] },
    view: { preset: 'stat' },
    routes: [{ connector: 'yahoo', route: 'quote', params: { symbols: '{symbols}' } }],
  },
  {
    name: 'ohlcv',
    title: '{symbols} {interval} {range}',
    summary: 'Price bars per symbol.',
    params: { type: 'object', properties: { symbols: { type: 'array', items: { type: 'string' } }, interval: { type: 'string', enum: ['1d', '1w'], default: '1d' }, range: { type: 'string', enum: ['1mo', '1y'], default: '1mo' } }, required: ['symbols'] },
    view: { preset: 'price' },
    routes: [{ connector: 'yahoo', route: 'chart', params: { symbol: '{symbols}' } }],
  },
])

const build = (over: Partial<Parameters<typeof buildSystemPrompt>[0]> = {}) => buildSystemPrompt({ recipes, connectors, workspace: workspace(), now, ...over })

describe('buildSystemPrompt (v2)', () => {
  it('matches the snapshot for a fixed date, recipe list and empty workspace', () => {
    expect(build()).toMatchSnapshot()
  })

  it('lists the recipes from recipeSummaryLines with the connectors and the catalog size', () => {
    const p = build({ catalogRoutes: 1012 })
    expect(p).toContain('Connectors, in routing order: openbb, yahoo, finnhub (1012 routes in the catalog).')
    expect(p).toContain('- quote(symbols[]) · Latest price and day change per symbol. · view stat')
    expect(p).toContain('- ohlcv(symbols[], interval?=1d|1w, range?=1mo|1y) · Price bars per symbol. · view price')
    expect(p).toContain('`query({ recipe: "<name>", params: { … } })`')
  })

  it('lists every built-in recipe by name', () => {
    const p = build({ recipes: builtinRecipes() })
    for (const r of builtinRecipes()) expect(p).toContain(`- ${r.name}(`)
    expect(p).toContain('- index(symbol?')
    expect(p).toContain('- screener(')
  })

  it('carries the market time from the clock, the useful dates and the baselines', () => {
    const p = build()
    expect(p).toContain('Friday 2026-10-16 10:00 ET, regular session.')
    expect(p).toContain('today 2026-10-16, +7d 2026-10-23, +30d 2026-11-15, +60d 2026-12-15, -7d 2026-10-09')
    expect(p).toContain('Last week was 2026-10-05 (Mon) to 2026-10-09 (Fri)')
    expect(p).toContain('The last session is 2026-10-16 (Fri)')
    expect(p).toContain('Baselines (the close a period change is measured from): 5d → 2026-10-08, 1mo → 2026-09-15')
    expect(p).toContain('never name a weekday for a date that is not in a preview')
  })

  it('states the section 17 rules: recipe first, search when none fits, no figure outside a preview, no unit without an annotation', () => {
    const p = build()
    expect(p).toContain('Use a recipe when one fits; search the catalog with `find_route` when none does; derive with `transform` when no route returns the frame.')
    expect(p).toContain('Never write a figure that is not in a preview you received this turn; the server checks every number in the reply against the previews')
    expect(p).toContain('A column not listed carries no unit guarantee')
    expect(p).toContain('Percent columns are already percent (5.63 means 5.63%)')
    expect(p).toContain('at most 10 tool calls per prompt, including `find_route`, `transform` and `set_workspace`')
    expect(p).toContain('Do not invent a route or a param')
  })

  it('puts charts before tables, states rule 8 and that four to six widgets is not a floor', () => {
    const p = build()
    expect(p).toContain('Charts before tables. Anything with a time column is a chart')
    expect(p).toContain('A table over a one-row frame is refused (product rule 8)')
    expect(p).toContain('use stat for one or two headline numbers, facts for a snapshot with several, the reply or a chart marker for a single date or fact, a pivot through a transform')
    expect(p).toContain('four to six by default, fewer when the user asks for fewer')
    expect(p).toContain('it is not a floor. When the user asks for one or two widgets, build one or two.')
    expect(p).toContain('the grid has three equal columns and sizes by content: the lg hero is 2x2, every other chart is one cell (never taller than wide), tables with six rows or fewer, stats and facts cards are one row tall and never full width')
    expect(p).toContain('The first widget is the hero and should be lg')
  })

  it('states the baseline rule: a period change is measured from the close before the period', () => {
    const p = build()
    expect(p).toContain('measured from the last close before the period (the baselines above), so fetch one range longer than the period (1mo daily for "this week") so the baseline bar is among the preview rows')
    expect(p).toContain('say which baseline you used')
  })

  it('describes the presets and their options', () => {
    const p = build()
    for (const preset of ['price {', 'compare {', 'curve {', 'indicator {', 'table {', 'stat {', 'facts {', 'chain:', 'heatmap {']) expect(p).toContain(preset)
    expect(p).toContain('`events` draws a dataset with a time column (earnings, news, insiders, dividends) as markers')
    expect(p).toContain('`extremes` marks best and worst per column')
    expect(p).toContain('A widget is `{ id?, title, size, data, view, fields? }`')
  })

  it('carries the transform rule, the ot helpers and the P/E worked example', () => {
    const p = build()
    expect(p).toContain('# Transforms')
    expect(p).toContain('ot.rebase(df, value="close", by="symbol", base=100.0)')
    expect(p).toContain('ot.prev_close(df, value="close", group="symbol")')
    expect(p).toContain('m = pd.merge_asof(p, e[["symbol", "time", "eps_ttm"]], on="time", by="symbol")')
    expect(p).toContain(JSON.stringify(TRANSFORM_EXAMPLE.inputs))
    expect(p).toContain('"pe":{"unit":"ratio","label":"P/E (TTM)"}')
    expect(p).toContain('E. "P/E over time for NVDA" (derived)')
    expect(p).toContain('"view":{"preset":"stat","column":"pe"}')
  })

  it('rewrites the worked examples with recipes and presets', () => {
    const p = build()
    expect(p).toContain('A. "What\'s happening with memory?"')
    expect(p).toContain('"data":{"main":{"recipe":"ohlcv","params":{"symbols":["MU","SNDK","WDC","STX"],"interval":"1d","range":"3mo"}}},"view":{"preset":"compare","normalize":true}')
    expect(p).toContain('"events":{"recipe":"earnings"')
    expect(p).toContain('"view":{"preset":"price","candle":true,"events":"events"}')
    // Five examples since the prompt-caching PR: the event-diagnosis and valuation examples went (their lessons are the
    // "why is X down" and comparison rules), which took 2.3k characters off every request.
    expect(p).not.toContain('Is NVDA\'s drop today news or just the market?')
    expect(p).not.toContain('Is MU expensive here?')
    expect(p).toContain('B. "Morning check on my watchlist"')
    expect(p).toContain('C. "What do options say about NVDA into earnings?"')
    expect(p).toContain('"data":{"main":{"recipe":"options","params":{"symbol":"NVDA","expiration":"<report date>","strikes":10,"type":"both"}}},"view":{"preset":"chain"}')
    expect(p).toContain('D. "What\'s the macro backdrop this week?"')
    expect(p).toContain('"data":{"ten":{"recipe":"macro","params":{"series":"treasury_10y","range":"1y"}},"two":{"recipe":"macro","params":{"series":"treasury_2y","range":"1y"}}')
    expect(p).toContain('"data":{"main":{"recipe":"yield_curve","params":{}}},"view":{"preset":"curve"}')
    expect(p).toContain('"data":{"main":{"recipe":"index","params":{"symbol":"^GSPC"')
    expect(p).not.toContain('"query":{"kind":')
    expect(p).not.toContain('"type":"series"')
  })

  it('states the reply begins with the answer and that no text precedes the first tool call', () => {
    const p = build()
    expect(p).toContain('The reply begins with the answer')
    expect(p).toContain('"Tickers are known; skip search." must never appear')
    expect(p).toContain('planning happens in tool calls, not in prose, and no text precedes the first tool call')
    expect(p).toContain('No markdown headings, no bullet lists, no bold, no tables in the reply.')
  })

  it('embeds the current workspace widgets and only the last few messages, trimmed', () => {
    const messages: Message[] = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? 'agent' : 'user', text: `message ${i} ${'x'.repeat(i === 9 ? 900 : 0)}` }))
    const ws = workspace({
      name: 'Morning',
      widgets: [
        { id: 'w1', title: 'Watchlist pre-market', size: 'lg', data: { main: { recipe: 'quote', params: { symbols: ['MU', 'SPY'] } } }, view: { preset: 'table' } },
        { id: 'w2', title: 'MU daily', size: 'md', data: { main: { recipe: 'ohlcv', params: { symbols: ['MU'] } } }, view: { preset: 'price' } } as never,
      ],
      messages,
    })
    const p = build({ workspace: ws })
    expect(p).toContain('Name: "Morning". Widgets: 2. Earlier messages shown: ' + PROMPT_HISTORY + '.')
    expect(p).toContain('"id":"w1","title":"Watchlist pre-market","size":"lg","data":{"main":{"recipe":"quote","params":{"symbols":["MU","SPY"]}}},"view":{"preset":"table"}')
    expect(p).toContain('"id":"w2","title":"MU daily","size":"md","data":{"main":{"recipe":"ohlcv","params":{"symbols":["MU"]}}},"view":{"preset":"price"}')
    expect(p).toContain('message 4')
    expect(p).not.toContain('message 3 ')
    expect(p).toContain('…') // the long last message was trimmed
    expect(p).not.toContain('x'.repeat(600))
    expect(p).toContain('Re-emit any of these widgets you want to keep')
  })

  it('tells the model when no connector is configured, and when the workspace is empty', () => {
    const p = build({ connectors: [], recipes: [] })
    expect(p).toContain('Connectors: none is configured. Explain that and do not call tools.')
    expect(p).toContain('(no recipes are loaded; use find_route and routes)')
    expect(p).toContain('The workspace is empty')
  })
})
