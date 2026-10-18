import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { DataTable, columnWidth } from '../src/index.js'

const columns = [
  { name: 'symbol', type: 'string' as const },
  { name: 'headline', type: 'string' as const },
  { name: 'price', type: 'number' as const },
  { name: 'change_pct', type: 'number' as const },
  { name: 'time', type: 'time' as const },
]
const rows = [['MU', 'A headline that is long enough to need a tooltip', 878.84, 5.63, 1_760_000_000_000]]

describe('DataTable never scrolls sideways', () => {
  it('clips horizontally, scrolls vertically, and lays the table out with fixed columns', () => {
    const html = renderToString(createElement(DataTable, { columns, rows, formats: { change_pct: 'change', price: 'price', time: 'time' } }))
    expect(html).toMatch(/<div class="[^"]*overflow-x-hidden[^"]*overflow-y-auto[^"]*"/)
    expect(html).not.toMatch(/class="[^"]*overflow-auto/)
    expect(html).toMatch(/<table class="[^"]*table-fixed[^"]*"/)
    expect(html).not.toContain('max-w-[32ch]')
  })

  it('gives numeric, date and time columns a fixed width and lets text share the rest', () => {
    expect(columnWidth('price', 'price')).toBe(76)
    expect(columnWidth('change_pct', 'change')).toBe(72)
    expect(columnWidth('time', 'time')).toBe(80)
    expect(columnWidth('symbol', 'text')).toBe(72)
    expect(columnWidth('headline', 'text')).toBeUndefined()
    const html = renderToString(createElement(DataTable, { columns, rows, formats: { price: 'price', time: 'time' } }))
    expect(html).toMatch(/<th[^>]*style="width:76px"[^>]*>/)
  })

  it('marks column priority with data-rank on header and body cells so container queries can hide them', () => {
    const html = renderToString(createElement(DataTable, { columns, rows, priority: { symbol: 0, headline: 0, price: 0, change_pct: 3, time: 4 } }))
    expect(html.match(/data-rank="3"/g)).toHaveLength(2) // th + td
    expect(html.match(/data-rank="4"/g)).toHaveLength(2)
    expect(html).not.toContain('data-rank="0"')
  })

  it('truncates long text with a tooltip', () => {
    const html = renderToString(createElement(DataTable, { columns, rows }))
    const td = html.match(/<td[^>]*title="A headline that is long enough to need a tooltip"[^>]*>/)?.[0]
    expect(td).toBeDefined()
    expect(td).toContain('truncate')
  })
})
