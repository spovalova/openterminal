// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { Column } from '@terminal/core'
import { VirtualTable } from '../VirtualTable'

afterEach(cleanup)

const columns: Column[] = [{ name: 'symbol', type: 'string' }, { name: 'price', type: 'number' }, { name: 'change_pct', type: 'number' }]
const rows = (n: number) => Array.from({ length: n }, (_, i) => [`S${String(i).padStart(4, '0')}`, 100 + i, i % 2 ? 1.5 : -0.5])

describe('VirtualTable', () => {
  it('renders every row under the threshold, with the DataTable formats and ranks', () => {
    const { container } = render(<VirtualTable columns={columns} rows={rows(10)} formats={{ price: 'price', change_pct: 'change' }} priority={{ change_pct: 4 }} />)
    expect(container.querySelector('[data-virtual]')).toBeNull()
    expect(container.querySelectorAll('tbody tr:not([data-spacer])')).toHaveLength(10)
    expect(container.querySelector('th[data-rank="4"]')?.textContent).toMatch(/change pct/)
    const first = container.querySelector('tbody tr')!
    expect(first.children[1]!.textContent).toBe('100.00')
    expect(first.children[2]!.className).toMatch(/text-down/)
  })

  it('windows thousands of rows: a slice plus two spacers whose heights cover the rest, following the scroll', () => {
    const { container } = render(<VirtualTable columns={columns} rows={rows(5000)} rowHeight={28} overscan={4} viewportHeight={280} />)
    const root = container.querySelector('[data-virtual-table]') as HTMLDivElement
    expect(root.dataset.virtual).toBe('')
    const bodyRows = () => Array.from(container.querySelectorAll('tbody tr:not([data-spacer])'))
    const rendered = Number(root.dataset.rendered)
    expect(rendered).toBeGreaterThanOrEqual(10)
    expect(rendered).toBeLessThan(40)
    expect(bodyRows()[0]!.children[0]!.textContent).toBe('S0000')
    const bottom = container.querySelector('[data-spacer="bottom"] td') as HTMLTableCellElement
    expect(bottom.style.height).toBe(`${(5000 - rendered) * 28}px`)
    expect(container.querySelector('[data-spacer="top"]')).toBeNull()

    Object.defineProperty(root, 'scrollTop', { value: 28 * 2500, configurable: true })
    fireEvent.scroll(root)
    const top = container.querySelector('[data-spacer="top"] td') as HTMLTableCellElement
    expect(Number.parseInt(top.style.height)).toBe((2500 - 4) * 28)
    expect(bodyRows()[0]!.children[0]!.textContent).toBe('S2496')
  })

  it('sorts on header click like the DataTable (uncontrolled) and reports the click (controlled)', () => {
    const clicks: string[] = []
    const { container, rerender } = render(<VirtualTable columns={columns} rows={rows(5)} onSort={(c) => clicks.push(c)} />)
    fireEvent.click(container.querySelector('th button')!)
    expect(clicks).toEqual(['symbol'])
    fireEvent.click(container.querySelectorAll('th')[1]!.querySelector('button')!)
    fireEvent.click(container.querySelectorAll('th')[1]!.querySelector('button')!) // descending
    expect(container.querySelector('tbody tr')!.children[1]!.textContent).toBe('104.00')
    rerender(<VirtualTable columns={columns} rows={rows(5)} sort={{ column: 'price', dir: 'asc' }} onSort={(c) => clicks.push(c)} />)
    expect(container.querySelector('tbody tr')!.children[1]!.textContent).toBe('100.00')
    expect(container.querySelector('th[aria-sort="ascending"]')?.textContent).toMatch(/price/)
  })
})
