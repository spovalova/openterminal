import { describe, expect, it } from 'vitest'
import { annotationsFor, annotationsForColumns, applyAnnotations, describeRule, globToRegExp, parseAnnotations, recipeDatasets, ruleMatches, type Frame } from '../src/index.js'
import { builtinAnnotations, builtinRecipes } from '../src/node.js'

const rules = parseAnnotations({
  '*:*:volume': { format: 'integer', priority: 3 },
  'openbb:*:volume': { label: 'Vol' },
  'openbb:equity/*:change_percent': { unit: 'fraction', label: 'Chg %' },
  'openbb:equity/price/quote:change_percent': { priority: 1 },
  'openbb:equity/price/quote:last_price': { unit: 'usd', key: true },
  '*:quote:price': { unit: 'usd' },
})

describe('parseAnnotations', () => {
  it('parses connector:route-glob:field keys with specificity and order', () => {
    expect(rules).toHaveLength(6)
    expect(rules[0]).toMatchObject({ connector: '*', route: '*', field: 'volume', specificity: 2, order: 0 })
    expect(rules[1]).toMatchObject({ connector: 'openbb', route: '*', field: 'volume', specificity: 6 })
    expect(rules[2]).toMatchObject({ connector: 'openbb', route: 'equity/*', field: 'change_percent', specificity: 10 })
    expect(rules[3]).toMatchObject({ connector: 'openbb', route: 'equity/price/quote', field: 'change_percent', specificity: 14 })
    expect(describeRule(rules[2]!)).toBe('openbb:equity/*:change_percent → unit="fraction" label="Chg %"')
  })
  it('accepts the list form and an `annotations:` wrapper, rejects bad keys and bad config', () => {
    expect(parseAnnotations([{ match: 'a:b:c', unit: 'usd' }])).toHaveLength(1)
    expect(parseAnnotations({ annotations: { 'a:b:c': { unit: 'usd' } } })).toHaveLength(1)
    expect(() => parseAnnotations({ 'no colons': { unit: 'usd' } })).toThrow(/not connector:route:field/)
    expect(() => parseAnnotations({ 'a:b:c': { unit: 'parsecs' } })).toThrow()
  })
  it('matches globs across slashes', () => {
    expect(globToRegExp('equity/*').test('equity/price/quote')).toBe(true)
    expect(globToRegExp('*/quote').test('equity/price/quote')).toBe(true)
    expect(globToRegExp('equity/*').test('etf/holdings')).toBe(false)
    expect(globToRegExp('iv?0').test('iv30')).toBe(true)
    expect(ruleMatches(rules[2]!, { connector: 'openbb', route: 'equity/screener' }, 'change_percent')).toBe(true)
    expect(ruleMatches(rules[2]!, { connector: 'yahoo', route: 'equity/screener' }, 'change_percent')).toBe(false)
  })
})

describe('annotationsFor (precedence)', () => {
  it('folds matching rules with the more specific winning field by field', () => {
    expect(annotationsFor(rules, { connector: 'openbb', route: 'equity/price/quote' }, 'volume')).toEqual({ format: 'integer', priority: 3, label: 'Vol' })
    expect(annotationsFor(rules, { connector: 'yahoo', route: 'quote' }, 'volume')).toEqual({ format: 'integer', priority: 3 })
    expect(annotationsFor(rules, { connector: 'openbb', route: 'equity/price/quote' }, 'change_percent')).toEqual({ unit: 'fraction', label: 'Chg %', priority: 1 })
    expect(annotationsFor(rules, { connector: 'openbb', route: 'equity/screener' }, 'change_percent')).toEqual({ unit: 'fraction', label: 'Chg %' })
    expect(annotationsFor(rules, { connector: 'openbb', route: 'equity/price/quote' }, 'nothing')).toEqual({})
  })
  it('later rules win ties', () => {
    const r = parseAnnotations({ 'a:b:c': { label: 'first' }, 'a:b:c ': { label: 'second' } })
    expect(annotationsFor(r, { connector: 'a', route: 'b' }, 'c')).toEqual({ label: 'second' })
  })
  it('returns configs for the columns that have any', () => {
    const cfg = annotationsForColumns(rules, { connector: 'openbb', route: 'equity/price/quote' }, ['symbol', 'last_price', 'change_percent', 'volume'])
    expect(Object.keys(cfg)).toEqual(['last_price', 'change_percent', 'volume'])
  })
})

describe('applyAnnotations', () => {
  const frame: Frame = {
    columns: [{ name: 'symbol', type: 'string' }, { name: 'last_price', type: 'number' }, { name: 'change_percent', type: 'number' }, { name: 'volume', type: 'number' }],
    rows: [['NVDA', 180.5, -0.0563, 1_000_000], ['AMD', 150, null, 2_000_000]],
    meta: { connector: 'openbb', fetchedAt: 0, ttl: 0 },
  }
  const ref = { connector: 'openbb', route: 'equity/price/quote' }

  it('converts fractions to percent, stamps units and labels, and leaves the input untouched', () => {
    const out = applyAnnotations(frame, ref, rules)
    expect(out.rows[0]).toEqual(['NVDA', 180.5, -5.63, 1_000_000])
    expect(out.rows[1]![2]).toBeNull()
    expect(out.meta.fields).toEqual({
      last_price: { unit: 'usd', key: true },
      change_percent: { unit: 'percent', label: 'Chg %', priority: 1 },
      volume: { format: 'integer', priority: 3, label: 'Vol' },
    })
    expect(frame.rows[0]![2]).toBe(-0.0563)
    expect(frame.meta.fields).toBeUndefined()
  })
  it('is idempotent: a column already stamped percent is not multiplied again', () => {
    const once = applyAnnotations(frame, ref, rules)
    const twice = applyAnnotations(once, ref, rules)
    expect(twice.rows[0]![2]).toBe(-5.63)
  })
  it('returns the same frame when nothing matches', () => {
    const plain: Frame = { ...frame, columns: [{ name: 'foo', type: 'string' }, { name: 'bar', type: 'number' }], rows: [['a', 1]] }
    expect(applyAnnotations(plain, { connector: 'zzz', route: 'nothing' }, rules)).toBe(plain)
  })
  it('keeps field config the frame already carried and merges on top', () => {
    const withFields: Frame = { ...frame, meta: { ...frame.meta, fields: { symbol: { priority: 1 }, volume: { label: 'Shares traded' } } } }
    const out = applyAnnotations(withFields, ref, rules)
    expect(out.meta.fields!.symbol).toEqual({ priority: 1 })
    expect(out.meta.fields!.volume).toEqual({ label: 'Vol', format: 'integer', priority: 3 })
  })
})

describe('the seed file (packages/core/annotations.yml)', () => {
  const seed = builtinAnnotations()
  it('parses and covers every unit the v1 handlers converted', () => {
    expect(seed.length).toBeGreaterThan(200)
    const unit = (connector: string, route: string, field: string) => annotationsFor(seed, { connector, route }, field).unit
    // fractions the handlers multiplied by 100
    expect(unit('openbb', 'equity/price/quote', 'change_percent')).toBe('fraction')
    expect(unit('openbb', 'equity/fundamental/metrics', 'gross_margin')).toBe('fraction')
    expect(unit('openbb', 'derivatives/options/chains', 'implied_volatility')).toBe('fraction')
    expect(unit('openbb', 'equity/price/quote', 'iv30')).toBe('fraction')
    expect(unit('openbb', 'etf/holdings', 'weight')).toBe('fraction')
    expect(unit('openbb', 'fixedincome/government/treasury_rates', 'year_10')).toBe('fraction')
    expect(unit('openbb', 'fixedincome/government/yield_curve', 'rate')).toBe('fraction')
    expect(unit('openbb', 'economy/cpi', 'value')).toBe('fraction')
    expect(unit('yahoo', 'quoteSummary', 'financialData.grossMargins')).toBe('fraction')
    expect(unit('yahoo', 'options', 'impliedVolatility')).toBe('fraction')
    // things the handlers passed through
    expect(unit('openbb', 'equity/fundamental/historical_eps', 'surprise_percent')).toBe('percent')
    expect(unit('openbb', 'equity/fundamental/metrics', 'dividend_yield')).toBe('percent')
    expect(unit('openbb', 'equity/fundamental/metrics', 'debt_to_equity')).toBe('percent')
    expect(unit('yahoo', 'quote', 'regularMarketChangePercent')).toBe('percent')
    expect(unit('finnhub', 'quote', 'dp')).toBe('percent')
    expect(unit('openbb', 'equity/shorts/short_interest', 'change_pct')).toBe('percent')
    // dollars and shares
    expect(unit('openbb', 'equity/price/quote', 'last_price')).toBe('usd')
    expect(unit('openbb', 'equity/fundamental/income', 'total_revenue')).toBe('usd')
    expect(unit('openbb', 'equity/ownership/insider_trading', 'securities_transacted')).toBe('shares')
    expect(unit('openbb', 'equity/shorts/short_interest', 'current_short_position')).toBe('shares')
    expect(unit('yahoo', 'chart', 'volume')).toBe('shares')
  })
  it('keeps the FINRA bond percents as sent (coupon 9.25, yield 13.63, change 1.15; phase 2 correction, the seed said fraction)', () => {
    const rules = builtinAnnotations()
    const ref = { connector: 'openbb', route: 'fixedincome/corporate/bond_prices' }
    const frame: Frame = {
      columns: [{ name: 'cusip', type: 'string' }, { name: 'coupon_rate', type: 'number' }, { name: 'price', type: 'number' }, { name: 'last_sale_yield', type: 'number' }, { name: 'price_change_percent', type: 'number' }],
      rows: [['21873SAB4', 9.25, 87.75, 13.63, 1.15]],
      meta: { connector: 'openbb', fetchedAt: 0, ttl: 0 },
    }
    const out = applyAnnotations(frame, ref, rules)
    expect(out.rows[0]).toEqual(['21873SAB4', 9.25, 87.75, 13.63, 1.15])
    expect(out.meta.fields?.coupon_rate).toMatchObject({ unit: 'percent' })
    expect(out.meta.fields?.last_sale_yield).toMatchObject({ unit: 'percent', key: true })
    expect(out.meta.fields?.price_change_percent).toMatchObject({ unit: 'percent', format: 'change' })
    const hist = applyAnnotations(
      { columns: [{ name: 'date', type: 'time' }, { name: 'price', type: 'number' }, { name: 'last_sale_yield', type: 'number' }], rows: [[1, 100.06, 9.22]], meta: { connector: 'openbb', fetchedAt: 0, ttl: 0 } },
      { connector: 'openbb', route: 'finra/fixedincome/bond_historical' },
      rules,
    )
    expect(hist.rows[0]).toEqual([1, 100.06, 9.22])
    expect(hist.meta.fields?.last_sale_yield).toMatchObject({ unit: 'percent', key: true })
  })
  it('labels the ugly names', () => {
    const label = (connector: string, route: string, field: string) => annotationsFor(seed, { connector, route }, field).label
    expect(label('openbb', 'equity/price/quote', 'iv30_annual_high')).toBe('IV30 high')
    expect(label('openbb', 'equity/price/quote', 'change_percent')).toBe('Chg %')
    expect(label('openbb', 'equity/calendar/earnings', 'eps_consensus')).toBe('EPS est.')
    expect(label('yahoo', 'quote', 'change_pct')).toBe('Chg %')
    expect(label('openbb', 'equity/fundamental/metrics', 'enterprise_to_ebitda')).toBe('EV/EBITDA')
    expect(label('openbb', 'volatility', 'iv30_high')).toBe('IV30 high')
  })
  it('covers every field the 22 recipes name in their view columns', () => {
    for (const r of builtinRecipes()) {
      const cols = r.view.preset === 'table' || r.view.preset === 'facts' ? (r.view.columns ?? []) : r.view.preset === 'stat' && r.view.column ? [r.view.column] : []
      for (const [, ds] of Object.entries(recipeDatasets(r))) {
        if (!('routes' in ds)) continue
        const first = ds.routes[0]!
        for (const c of cols) {
          const cfg = annotationsFor(seed, { connector: first.connector, route: first.route }, c)
          expect(Object.keys(cfg).length, `${r.name}: ${first.connector}:${first.route}:${c} has no annotation`).toBeGreaterThan(0)
        }
      }
    }
  })
  it('marks exactly one key field on the stat recipes’ routes', () => {
    const quote = annotationsForColumns(seed, { connector: 'openbb', route: 'equity/price/quote' }, ['symbol', 'last_price', 'change_percent', 'volume'])
    expect(Object.entries(quote).filter(([, c]) => c.key).map(([n]) => n)).toEqual(['last_price'])
    const metrics = annotationsForColumns(seed, { connector: 'openbb', route: 'equity/fundamental/metrics' }, ['pe_ratio', 'forward_pe', 'market_cap'])
    expect(Object.entries(metrics).filter(([, c]) => c.key).map(([n]) => n)).toEqual(['pe_ratio'])
  })
})
