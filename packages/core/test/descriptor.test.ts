import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DescriptorSchema, ParamError, describeDescriptor, descriptorKey, descriptorsFromOpenApi, fieldType, fieldsToColumns, parseParams, routeNamespace, validateParams, type Descriptor } from '../src/index.js'

const doc = JSON.parse(readFileSync(new URL('./fixtures/openbb-openapi.json', import.meta.url), 'utf8')) as unknown
const all = descriptorsFromOpenApi(doc, 'openbb')
const by = (route: string) => all.find((d) => d.route === route)!

const quote: Descriptor = {
  connector: 'demo',
  route: 'quote',
  summary: 'A quote',
  params: [
    { name: 'symbols', type: 'string[]', required: true },
    { name: 'limit', type: 'integer', required: false, default: 20 },
    { name: 'interval', type: 'string', required: false, enum: ['1d', '1w'], default: '1d' },
    { name: 'start', type: 'date', required: false },
    { name: 'extended', type: 'boolean', required: false },
    { name: 'ratio', type: 'number', required: false },
  ],
  providers: ['a', 'b'],
  fields: [
    { name: 'symbol', type: 'string' },
    { name: 'price', type: 'number' },
    { name: 'time', type: 'time' },
  ],
}

describe('descriptor schema and helpers', () => {
  it('validates a descriptor and derives key, namespace and columns', () => {
    expect(() => DescriptorSchema.parse(quote)).not.toThrow()
    expect(descriptorKey(quote)).toBe('demo:quote')
    expect(routeNamespace('equity/price/quote')).toBe('equity')
    expect(fieldsToColumns(quote)).toEqual([
      { name: 'symbol', type: 'string' },
      { name: 'price', type: 'number' },
      { name: 'time', type: 'time' },
    ])
    expect(describeDescriptor(quote)).toContain('required: symbols')
  })
  it('rejects routes with a leading slash and connectors that are not kebab-case', () => {
    expect(() => DescriptorSchema.parse({ ...quote, route: '/quote' })).toThrow()
    expect(() => DescriptorSchema.parse({ ...quote, connector: 'Open BB' })).toThrow()
  })
})

describe('validateParams', () => {
  it('coerces types, applies defaults and keeps the provider', () => {
    const r = validateParams(quote, { symbols: 'NVDA, amd', limit: '5', start: '2026-10-01T14:00:00Z', extended: 'true', ratio: '1.5', provider: 'b' })
    expect(r).toEqual({ ok: true, params: { symbols: ['NVDA', 'amd'], limit: 5, interval: '1d', start: '2026-10-01', extended: true, ratio: 1.5, provider: 'b' } })
  })
  it('accepts arrays, numbers and Dates where they fit', () => {
    const r = validateParams(quote, { symbols: ['MU'], start: new Date(Date.UTC(2026, 0, 2)), limit: 3 })
    expect(r.ok && r.params.start).toBe('2026-01-02')
    expect(r.ok && r.params.symbols).toEqual(['MU'])
  })
  it('reports every issue: required, enum, type, unknown, provider', () => {
    const r = validateParams(quote, { interval: '1h', limit: 'x', nope: 1, provider: 'zzz', ratio: 'abc' })
    expect(r.ok).toBe(false)
    const issues = r.ok ? [] : r.issues
    expect(issues.join('\n')).toMatch(/"symbols" is required/)
    expect(issues.join('\n')).toMatch(/"interval": "1h" not in 1d, 1w/)
    expect(issues.join('\n')).toMatch(/"limit": expected a number/)
    expect(issues.join('\n')).toMatch(/unknown param "nope"/)
    expect(issues.join('\n')).toMatch(/provider "zzz" is not one of a, b/)
    expect(issues.join('\n')).toMatch(/"ratio": expected a number/)
  })
  it('rejects non-integers for integer params and bad dates, and drops nulls', () => {
    expect(validateParams(quote, { symbols: 'MU', limit: 2.5 })).toMatchObject({ ok: false })
    expect(validateParams(quote, { symbols: 'MU', start: 'yesterday' })).toMatchObject({ ok: false })
    const r = validateParams(quote, { symbols: 'MU', start: null, extended: undefined })
    expect(r.ok && Object.keys(r.params).sort()).toEqual(['interval', 'limit', 'symbols'])
  })
  it('parseParams throws a ParamError naming the route', () => {
    expect(() => parseParams(quote, {})).toThrow(ParamError)
    expect(() => parseParams(quote, {})).toThrow(/demo:quote: "symbols" is required/)
  })
  it('refuses a provider on a route without providers', () => {
    const r = validateParams({ ...quote, providers: [] }, { symbols: 'MU', provider: 'a' })
    expect(r.ok).toBe(false)
  })
})

describe('descriptorsFromOpenApi (OpenBB fixture)', () => {
  it('yields one descriptor per GET route with a results envelope, sorted by route', () => {
    // 40 GET paths in the fixture; coverage/providers (a bare dict) and eia/electricity_browser (text/html) have no results model and are skipped.
    expect(all).toHaveLength(38)
    expect(all.some((d) => d.route === 'eia/electricity_browser')).toBe(false)
    expect(all.map((d) => d.route)).toEqual([...all.map((d) => d.route)].sort())
    expect(all.every((d) => d.connector === 'openbb')).toBe(true)
    expect(all.some((d) => d.route === 'coverage/providers')).toBe(false)
    expect(all.every((d) => DescriptorSchema.safeParse(d).success)).toBe(true)
  })
  it('strips the /api/v1 prefix and lifts the provider param into providers', () => {
    const q = by('equity/price/quote')
    expect(q.providers).toEqual(['cboe', 'nasdaq', 'tmx', 'yfinance'])
    expect(q.params.some((p) => p.name === 'provider')).toBe(false)
    expect(q.params.some((p) => p.name === 'chart')).toBe(false)
    expect(q.summary).toBe('Quote')
    expect(q.description).toMatch(/latest quote/)
    const t = by('fixedincome/government/treasury_rates')
    expect(t.providers).toEqual(['federal_reserve'])
  })
  it('collapses a per-provider param union to one entry with a providers list', () => {
    const h = by('equity/price/historical')
    const interval = h.params.find((p) => p.name === 'interval')!
    expect(interval.type).toBe('string')
    expect(interval.enum).toBeUndefined() // a free string branch (and an integer one) means no enum
    expect(interval.providers).toEqual(['cboe', 'tmx', 'yfinance'])
    const adjustment = h.params.find((p) => p.name === 'adjustment')!
    expect(adjustment.enum).toEqual(['splits_only', 'splits_and_dividends', 'unadjusted'])
    expect(adjustment.providers).toEqual(['tmx', 'yfinance'])
    const extended = h.params.find((p) => p.name === 'extended_hours')!
    expect(extended.type).toBe('boolean')
    expect(extended.default).toBe(false)
    expect(extended.providers).toEqual(['yfinance'])
    expect(h.params.filter((p) => p.name === 'symbol')).toHaveLength(1)
  })
  it('types symbols as string[] when the route takes comma lists, and dates as date', () => {
    const h = by('equity/price/historical')
    expect(h.params.find((p) => p.name === 'symbol')).toMatchObject({ type: 'string[]', required: true })
    expect(h.params.find((p) => p.name === 'start_date')).toMatchObject({ type: 'date', required: false })
    expect(h.params.find((p) => p.name === 'start_date')!.providers).toBeUndefined()
    const limit = by('equity/fundamental/historical_eps').params.find((p) => p.name === 'limit')!
    expect(limit).toMatchObject({ type: 'integer', providers: ['yfinance'] })
  })
  it('keeps an enum only when every provider constrains the value', () => {
    const country = by('economy/cpi').params.find((p) => p.name === 'country')!
    expect(country.enum).toBeUndefined() // imf takes free text
    expect(country.type).toBe('string[]')
  })
  it('resolves the response model to fields with date fields typed time', () => {
    const h = by('equity/price/historical')
    const names = h.fields.map((f) => f.name)
    expect(names.slice(0, 6)).toEqual(['date', 'open', 'high', 'low', 'close', 'volume'])
    expect(h.fields.find((f) => f.name === 'date')).toMatchObject({ type: 'time' })
    expect(h.fields.find((f) => f.name === 'close')).toMatchObject({ type: 'number' })
    expect(h.fields.find((f) => f.name === 'close')!.description).toMatch(/close price/i)
    const q = by('equity/price/quote')
    expect(q.fields.map((f) => f.name)).toContain('last_price')
    expect(q.fields.map((f) => f.name)).toContain('iv30') // merged across provider models (cboe)
    expect(q.fields.find((f) => f.name === 'symbol')).toMatchObject({ type: 'string' })
    const cal = by('economy/calendar')
    expect(cal.fields.find((f) => f.name === 'date')!.type).toBe('time')
  })
  it('treats a datetime-or-date union as time and a number-or-string union as string', () => {
    expect(fieldType({ anyOf: [{ type: 'string', format: 'date-time' }, { type: 'string', format: 'date' }, { type: 'null' }] })).toBe('time')
    expect(fieldType({ anyOf: [{ type: 'number' }, { type: 'string' }] })).toBe('string')
    expect(fieldType({ anyOf: [{ type: 'integer' }, { type: 'null' }] })).toBe('number')
    expect(fieldType({ type: 'boolean' })).toBe('boolean')
  })
  it('is pure and configurable: another prefix and connector name', () => {
    const d = descriptorsFromOpenApi({ paths: { '/v2/things': { get: { summary: 'Things', responses: { '200': { content: { 'application/json': { schema: { properties: { results: { type: 'array', items: { properties: { id: { type: 'integer' }, when: { type: 'string', format: 'date' } } } } } } } } } } } } } }, 'acme', { prefix: '/v2' })
    expect(d).toEqual([{ connector: 'acme', route: 'things', summary: 'Things', params: [], providers: [], fields: [{ name: 'id', type: 'number' }, { name: 'when', type: 'time' }] }])
  })
})
