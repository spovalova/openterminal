// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { WIDE_COLUMNS, WIDE_VALUE, type Frame, type WidgetV2 } from '@terminal/core'

import { FactsCard, factsControlOf, factsOf, heroFact } from '../FactsCard'
import { HeatmapView, buildHeatmap, cellColor, cellText } from '../HeatmapView'
import { StatView } from '../StatView'
import { viewFor } from '../view-for'
import { fixture } from '../fixtures'

afterEach(cleanup)

describe('FactsCard', () => {
  it('renders label over value in the control\'s order, with formats, units and signed changes coloured', () => {
    const { widget, frames } = fixture('v2-facts')
    render(<FactsCard widget={widget} frames={frames} />)
    const card = document.querySelector('[data-view="facts"]')!
    expect(card.getAttribute('data-count')).toBe('12')
    const facts = Array.from(card.querySelectorAll('[data-fact]')).map((el) => el.getAttribute('data-fact'))
    expect(facts.slice(0, 4)).toEqual(['last_price', 'change_percent', 'market_cap', 'pe'])
    expect(facts).toContain('symbol')
    const value = (c: string) => card.querySelector(`[data-fact="${c}"] [data-field="value"]`)!
    expect(value('last_price').textContent).toBe('438.90')
    expect(value('change_percent').textContent).toBe('+2.36%')
    expect(value('change_percent').className).toContain('text-up')
    expect(value('market_cap').textContent).toBe('1.41T')
    expect(value('dividend_yield').textContent).toBe('0.00%')
    expect(value('volume').textContent).toBe('96,500,000')
    expect(value('sector').textContent).toBe('Consumer Cyclical')
    expect(screen.getByText('Market cap')).toBeTruthy() // the field label
    expect(screen.getByText('Exchange')).toBeTruthy() // a column without one: the name in sentence case (change 11)
  })

  it('factsOf shows a dash for nulls and the first row of a longer frame; a table view yields the same control', () => {
    const { widget, frames } = fixture('v2-table-one-row')
    const control = factsControlOf(widget, frames)!
    expect(control.kind).toBe('facts')
    expect(control.columns[0]).toBe('last_price')
    const frame: Frame = { ...frames.main!, rows: [[...frames.main!.rows[0]!.slice(0, 4), null, ...frames.main!.rows[0]!.slice(5)], frames.main!.rows[0]!] }
    const facts = factsOf(frame, control)
    expect(facts.find((f) => f.column === 'pe')!.text).toBe('—')
    expect(facts.find((f) => f.column === 'symbol')!.text).toBe('TSLA')
  })

  it('is the view for the facts preset; a v1 stat still renders through StatView', () => {
    expect(viewFor({ preset: 'facts' })).toBe(FactsCard)
    expect(viewFor({ preset: 'stat' })).toBe(StatView)
  })
})

describe('StatView from a v2 control', () => {
  it('shows the key field with its label and the change column under it', () => {
    const { widget, frames } = fixture('v2-stat')
    render(<StatView widget={widget} frames={frames} />)
    const root = document.querySelector('[data-view="stat"]')!
    expect(root.getAttribute('data-column')).toBe('pe')
    expect(document.querySelector('[data-field="value"]')!.textContent).toBe('42.10')
    expect(screen.getByText('P/E (TTM)')).toBeTruthy()
    const secondary = document.querySelector('[data-field="secondary"]')!
    expect(secondary.textContent).toBe('-6.40%')
    expect(secondary.className).toContain('text-down')
  })
})

describe('HeatmapView', () => {
  it('melts a wide frame by the group column: one row per symbol, one column per numeric column, a diverging scale', () => {
    const { widget, frames } = fixture('v2-heatmap')
    const layer = { mark: 'cell' as const, data: 'main', x: 'symbol', y: WIDE_COLUMNS, value: WIDE_VALUE, palette: 'diverging' as const, text: true }
    const h = buildHeatmap(frames.main!, layer)
    expect(h.xs).toEqual(['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA'])
    expect(h.ys).toEqual(h.xs)
    expect(h.min).toBe(0.33)
    expect(h.max).toBe(1)
    expect(h.bound).toBe(1)
    expect(cellText(h, 0.72)).toBe('0.72')
    expect(cellColor(h, 0)).toBe('#23262b') // the neutral midpoint
    expect(cellColor(h, 1)).toBe('rgb(57, 135, 229)') // the positive pole (blue)
    expect(cellColor(h, -1)).toBe('rgb(240, 87, 90)') // the negative pole (red)
    expect(cellColor(h, null)).toBeUndefined()
    render(<HeatmapView widget={widget} frames={frames} />)
    const root = document.querySelector('[data-view="heatmap"]')!
    expect(root.getAttribute('data-x')).toBe('7')
    expect(root.getAttribute('data-y')).toBe('7')
    expect(root.getAttribute('data-palette')).toBe('diverging')
    expect(root.querySelectorAll('td[data-cell]')).toHaveLength(49)
    expect(root.querySelector('td[data-cell="AAPL:MSFT"]')!.textContent).toBe('0.72')
    expect(root.querySelector('[data-legend]')!.textContent).toContain('negative')
  })

  it('a long frame binds x, y and value; percent units format the cells; a sequential palette starts at the surface', () => {
    const frame: Frame = {
      columns: [
        { name: 'sector', type: 'string' },
        { name: 'week', type: 'string' },
        { name: 'ret', type: 'number' },
      ],
      rows: [
        ['Tech', 'W1', 2.5],
        ['Tech', 'W2', -1.5],
        ['Energy', 'W1', 0.5],
        ['Energy', 'W2', null],
      ],
      meta: { connector: 'x', fetchedAt: 0, ttl: 0, fields: { ret: { unit: 'percent' } } },
    }
    const h = buildHeatmap(frame, { mark: 'cell', data: 'main', x: 'sector', y: 'week', value: 'ret', palette: 'sequential', text: true }, 'percent')
    expect(h.xs).toEqual(['Tech', 'Energy'])
    expect(h.ys).toEqual(['W1', 'W2'])
    expect(cellText(h, 2.5)).toBe('+2.5%')
    expect(cellText(h, -1.5)).toBe('-1.5%')
    expect(cellText(h, null)).toBe('—')
    expect(cellColor(h, -1.5)).toBe('rgb(35, 38, 43)') // the low end of the sequential ramp is the surface
    expect(cellColor(h, 2.5)).toBe('rgb(57, 135, 229)')
    const widget: WidgetV2 = { id: 'h', title: 'h', size: 'sm', data: { main: { recipe: 'x', params: {} } }, view: { preset: 'heatmap', x: 'sector', y: 'week', value: 'ret', palette: 'sequential' } }
    render(<HeatmapView widget={widget} frames={{ main: frame }} />)
    expect(document.querySelector('td[data-cell="Tech:W1"]')!.textContent).toBe('+2.5%')
    expect(document.querySelector('td[data-cell="Energy:W2"]')!.textContent).toBe('—')
    expect(viewFor({ preset: 'heatmap' })).toBe(HeatmapView)
  })

  it('melts a wide frame without a group column by its first column (sector returns by month)', () => {
    const { widget, frames } = fixture('v2-heatmap-returns')
    render(<HeatmapView widget={widget} frames={frames} />)
    const root = document.querySelector('[data-view="heatmap"]')!
    expect(root.getAttribute('data-x')).toBe('6')
    expect(root.getAttribute('data-y')).toBe('4')
    expect(root.querySelector('td[data-cell="Energy:Oct"]')!.textContent).toBe('+6.2%')
  })
})

describe('FactsCard, the taste round (change 3)', () => {
  it('sets one hero (the key field) large and every other field as label : value in a grid, enums in sentence case', () => {
    const { widget, frames } = fixture('v2-facts')
    render(<FactsCard widget={widget} frames={frames} />)
    const card = document.querySelector('[data-view="facts"]')!
    const hero = card.querySelector('[data-hero]')!
    expect(hero.getAttribute('data-fact')).toBe('last_price')
    expect(hero.querySelector('[data-field="value"]')!.className).toContain('facts-hero')
    expect(card.querySelectorAll('[data-hero]')).toHaveLength(1)
    // the rest are body-size rows, numbers in the mono stack
    const pe = card.querySelector('[data-fact="pe"] [data-field="value"]')!
    expect(pe.className).toContain('num')
    expect(pe.className).not.toContain('facts-hero')
    // the first numeric fact is the hero when nothing is marked key; a card of strings has none
    const facts = factsOf(frames.main!, factsControlOf(widget, frames)!)
    expect(heroFact(facts)!.column).toBe('last_price')
    expect(heroFact(facts.filter((f) => f.format === 'text'))).toBeUndefined()
    expect(heroFact(facts, { pe: { key: true } })!.column).toBe('pe')
  })
})
