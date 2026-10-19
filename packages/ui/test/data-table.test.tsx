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
    // A YYYY-MM-DD in the mono stack needs 84px plus padding: date and time are 104 (phase 2, the "2026-10…" defect).
    expect(columnWidth('price', 'price')).toBe(84)
    expect(columnWidth('change_pct', 'change')).toBe(96)
    expect(columnWidth('time', 'time')).toBe(104)
    expect(columnWidth('date', 'date')).toBe(104)
    expect(columnWidth('symbol', 'text')).toBe(72)
    expect(columnWidth('headline', 'text')).toBeUndefined()
    const html = renderToString(createElement(DataTable, { columns, rows, formats: { price: 'price', time: 'time' } }))
    // The rendered header is at least its longest word at 11px a character plus the arrow and padding: "price" is 87.
    expect(html).toMatch(/<th[^>]*style="width:87px"[^>]*>/)
    expect(columnWidth('peak_weekly_close', 'price', 'Peak weekly close')).toBe(98)
  })

  it('marks column priority with data-rank on header and body cells so container queries can hide them', () => {
    const html = renderToString(createElement(DataTable, { columns, rows, priority: { symbol: 0, headline: 0, price: 0, change_pct: 3, time: 4 } }))
    expect(html.match(/data-rank="3"/g)).toHaveLength(2) // th + td
    expect(html.match(/data-rank="4"/g)).toHaveLength(2)
    expect(html).not.toContain('data-rank="0"')
  })

  it('wraps prose to two lines at word boundaries with a tooltip, never cutting mid-word (section 17 checklist)', () => {
    const html = renderToString(createElement(DataTable, { columns, rows }))
    const td = html.match(/<td[^>]*title="A headline that is long enough to need a tooltip"[^>]*>/)?.[0]
    expect(td).toBeDefined()
    expect(td).toContain('whitespace-normal')
    expect(td).not.toContain('truncate')
    expect(html).toMatch(/<span class="line-clamp-2 break-words whitespace-normal" title="A headline that is long enough to need a tooltip">/)
    // Numbers, dates and tickers stay one line.
    expect(html).toMatch(/<td class="border-b border-border\/60 px-2 h-7 truncate whitespace-nowrap text-right num/)
  })
})
