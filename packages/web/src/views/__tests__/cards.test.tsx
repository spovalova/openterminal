// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { FieldGrid } from '../FieldGrid'
import { FactsCard } from '../FactsCard'
import { shortLabel } from '../labels'
import { fixture } from '../fixtures'

afterEach(cleanup)

describe('shortLabel (taste round 2, change 2: labels never wrap)', () => {
  it('gives the long labels the critic saw their short form', () => {
    expect(shortLabel('Median next-day move')).toBe('Median move')
    expect(shortLabel('Large-cap tech universe')).toBe('Universe')
    expect(shortLabel('Median P/E of passers')).toBe('Median P/E')
    expect(shortLabel('num estimates')).toBe('Estimates')
  })
  it('drops an "of" tail only after two words, then a parenthetical, and leaves short labels alone', () => {
    expect(shortLabel('Number of analysts')).toBe('Number of analysts') // one word before "of": the tail is the meaning
    expect(shortLabel('Realized vol (1 month)')).toBe('Realized vol')
    expect(shortLabel('EPS est. (q)')).toBe('EPS est. (q)')
    expect(shortLabel('IV30 high')).toBe('IV30 high')
  })
})

describe('FieldGrid (label beside value, pairs at most 180px)', () => {
  it('keeps every label on one line and gives a long label or value two columns rather than a wrap', () => {
    render(
      <FieldGrid
        fields={[
          { key: 'a', label: 'Start', text: '55.68' },
          { key: 'b', label: 'Average daily dollar volume', text: '1.2B' },
          { key: 'c', label: 'Session', text: 'After the close, Nov 3' },
          { key: 'd', label: 'Description', text: 'A provider of AI infrastructure and cloud compute' },
        ]}
      />,
    )
    const grid = document.querySelector('.field-grid')!
    expect(grid).toBeTruthy()
    const pair = (k: string) => grid.querySelector(`[data-fact="${k}"]`)!
    for (const k of ['a', 'b', 'c', 'd']) expect(pair(k).firstElementChild!.className).toContain('whitespace-nowrap')
    expect(pair('a').className).not.toContain('col-span')
    expect(pair('b').className).toContain('col-span-2')
    expect(pair('c').className).toContain('col-span-2')
    expect(pair('d').className).toContain('col-span-full') // prose wraps in the value, never in the label
  })
  it('the facts card draws its fields through it, under the hero', () => {
    const { widget, frames } = fixture('v2-facts')
    render(<FactsCard widget={widget} frames={frames} />)
    const card = document.querySelector('[data-view="facts"]')!
    expect(card.querySelector('[data-hero]')).toBeTruthy()
    expect(card.querySelector('.field-grid')).toBeTruthy()
    expect(card.className).not.toContain('h-full') // round 2: the card is as tall as its content
  })
})
