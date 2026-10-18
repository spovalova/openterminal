// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { parseWidget } from '@terminal/core'

import { Reply, chipsToLinks } from '../Reply'

const w1 = parseWidget({ id: 'w1', title: 'Mag 7 price, 2 years', size: 'lg', query: { kind: 'ohlcv', params: { symbols: ['NVDA'], interval: '1d', range: '2y' } }, view: { type: 'series' } })

beforeAll(() => {
  // jsdom has no scrollIntoView
  Element.prototype.scrollIntoView = function () {}
})
afterEach(cleanup)

describe('chipsToLinks', () => {
  it('turns chip tokens into links on #widget:<id> and leaves the rest alone', () => {
    expect(chipsToLinks('MU is up. [[widget:w1]] and [[widget:w_ab-2]].')).toBe('MU is up. [w1](#widget:w1) and [w_ab-2](#widget:w_ab-2).')
    expect(chipsToLinks('[[widget:]] [[widget:a b]]')).toBe('[[widget:]] [[widget:a b]]')
  })
})

describe('Reply', () => {
  it('renders bold, a list, inline code and chips from one reply', () => {
    const text = ['**NVDA:** the stock is up 51.29% over two years.', '', '- trailing P/E `27.1x`', '- forward P/E `13.5x`', '', '[[widget:w1]] [[widget:w2]]'].join('\n')
    const { container } = render(<Reply text={text} widgets={[w1]} />)
    expect(container.querySelector('strong')!.textContent).toBe('NVDA:')
    expect(container.textContent).not.toContain('**')
    expect(Array.from(container.querySelectorAll('li')).map((li) => li.textContent)).toEqual(['trailing P/E 27.1x', 'forward P/E 13.5x'])
    expect(Array.from(container.querySelectorAll('code')).map((c) => c.textContent)).toEqual(['27.1x', '13.5x'])
    // chips: the widget's title when it exists, else the id; no markdown link is left behind
    expect(screen.getByRole('button', { name: 'Mag 7 price, 2 years' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'w2' })).toBeTruthy()
    expect(container.querySelector('a')).toBeNull()
    expect(container.textContent).not.toContain('#widget:')
  })

  it('a chip click scrolls to and flashes the widget', () => {
    const target = document.createElement('div')
    target.id = 'widget-w1'
    document.body.appendChild(target)
    render(<Reply text="See [[widget:w1]]." widgets={[w1]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Mag 7 price, 2 years' }))
    expect(target.classList.contains('flash')).toBe(true)
    target.remove()
  })

  it('renders GFM tables and headings, opens real links in a new tab, and never renders raw HTML', () => {
    const text = ['## Multiples', '', '| name | P/E |', '|---|---:|', '| NVDA | 27.1 |', '', '[source](https://example.com/x) <img src=x onerror="alert(1)"> <b>no</b>'].join('\n')
    const { container } = render(<Reply text={text} widgets={[]} />)
    expect(container.querySelector('h2')!.textContent).toBe('Multiples')
    expect(container.querySelectorAll('tbody tr').length).toBe(1)
    expect((container.querySelector('td:last-child') as HTMLElement).style.textAlign).toBe('right')
    const a = container.querySelector('a')!
    expect(a.getAttribute('href')).toBe('https://example.com/x')
    expect(a.getAttribute('target')).toBe('_blank')
    expect(a.getAttribute('rel')).toContain('noopener')
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('b')).toBeNull()
    expect(container.textContent).toContain('<b>no</b>')
  })

  it('shows the cursor while streaming and renders a partial reply as plain text', () => {
    const { container } = render(<Reply text="MU is up **12" widgets={[]} streaming />)
    expect(container.querySelector('[aria-hidden]')).toBeTruthy()
    expect(container.querySelector('p')!.textContent).toBe('MU is up **12')
  })
})
