// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nyWallToUtc, type Frame } from '@terminal/core'

const api = vi.hoisted(() => ({ setting: vi.fn(), setSetting: vi.fn(), query: vi.fn() }))
vi.mock('../../api', () => ({ api }))

import { MarketStrip, marketLine } from '../MarketStrip'
import { TickerStrip, nextDelay, quoteFromFrame } from '../TickerStrip'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const frame = (columns: string[], row: unknown[], ttl = 10_000): Frame => ({
  columns: columns.map((name) => ({ name, type: typeof row[columns.indexOf(name)] === 'number' ? 'number' : 'string' })),
  rows: [row],
  meta: { connector: 'fake', fetchedAt: 1_000, ttl },
})

describe('ticker strip helpers', () => {
  it('reads the quote from the v1 kind columns, OpenBB yfinance columns, and computes the change from prev close', () => {
    expect(quoteFromFrame(frame(['symbol', 'price', 'change_pct'], ['^GSPC', 6700.5, -0.8]), '^GSPC')).toEqual({ symbol: '^GSPC', price: 6700.5, changePct: -0.8 })
    expect(quoteFromFrame(frame(['symbol', 'last_price', 'prev_close'], ['^VIX', 22, 20]), '^VIX')).toEqual({ symbol: '^VIX', price: 22, changePct: 10 })
    expect(quoteFromFrame(frame(['symbol', 'name'], ['GC=F', 'Gold']), 'GC=F')).toEqual({ symbol: 'GC=F', price: null, changePct: null })
    // picks the row of the symbol when the frame has several
    const multi: Frame = { ...frame(['symbol', 'price'], ['A', 1]), rows: [['A', 1], ['B', 2]] }
    expect(quoteFromFrame(multi, 'b').price).toBe(2)
  })

  it('refreshes on the frame TTL with a 15 s floor and backs off a minute on error', () => {
    expect(nextDelay(frame(['price'], [1], 10_000), 1_000)).toBe(15_000)
    expect(nextDelay(frame(['price'], [1], 60_000), 1_000)).toBe(60_000)
    expect(nextDelay(frame(['price'], [1], 60_000), 50_000)).toBe(15_000)
    expect(nextDelay(undefined, 0)).toBe(60_000)
  })

  it('renders one quote per configured symbol with its label, and saves an edited list', async () => {
    api.setting.mockResolvedValue(['^GSPC', 'CL=F'])
    api.setSetting.mockImplementation(async (_k: string, v: string[]) => v)
    api.query.mockImplementation(async (q: { params: { symbols: string[] } }) => frame(['symbol', 'price', 'change_pct'], [q.params.symbols[0], q.params.symbols[0] === '^GSPC' ? 6700 : 61.25, q.params.symbols[0] === '^GSPC' ? 0.4 : -1.1]))
    render(<TickerStrip />)
    await screen.findByText('SPX')
    expect(screen.getByText('Oil')).toBeTruthy()
    await screen.findByText('6,700.00')
    expect(screen.getByText('+0.40%').className).toMatch(/text-up/)
    expect(screen.getByText('-1.10%').className).toMatch(/text-down/)
    expect(api.query).toHaveBeenCalledWith({ recipe: 'quote', params: { symbols: ['^GSPC'] } })
    expect(api.query).toHaveBeenCalledWith({ recipe: 'quote', params: { symbols: ['CL=F'] } })

    fireEvent.click(screen.getByRole('button', { name: 'Edit ticker strip' }))
    const input = screen.getByLabelText('Ticker symbols') as HTMLInputElement
    expect(input.value).toBe('^GSPC, CL=F')
    fireEvent.change(input, { target: { value: '^ndx vix' } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => expect(api.setSetting).toHaveBeenCalledWith('ticker', ['^NDX', 'VIX']))
    await screen.findByText('NDX')
    expect(screen.getByText('VIX')).toBeTruthy()
    expect(screen.queryByText('SPX')).toBeNull()
  })
})

describe('market strip', () => {
  it('describes the session from the clock module and names the next trading day when closed', () => {
    const regular = nyWallToUtc(2026, 10, 16, 10, 30) // a Friday, 10:30 ET
    expect(marketLine(regular)).toEqual({ text: 'Friday 2026-10-16 10:30 ET, regular session', session: 'regular' })
    const saturday = nyWallToUtc(2026, 10, 17, 23, 40)
    expect(marketLine(saturday)).toEqual({ text: 'Saturday 2026-10-17 23:40 ET, market closed', session: 'closed', next: '2026-10-19' })
    const pre = nyWallToUtc(2026, 10, 19, 8, 0)
    expect(marketLine(pre).session).toBe('pre')
  })

  it('renders the line with the session label and dot', () => {
    render(<MarketStrip now={() => nyWallToUtc(2026, 10, 19, 17, 0)} />)
    const strip = document.querySelector('[data-market-strip]')!
    expect(strip.textContent).toMatch(/Monday 2026-10-19 17:00 ET, after-hours session/)
    expect(strip.textContent).toMatch(/after-hours/)
    cleanup()
    render(<MarketStrip now={() => nyWallToUtc(2026, 10, 17, 12, 0)} />)
    expect(document.querySelector('[data-market-strip]')!.textContent).toMatch(/closed.*next 2026-10-19/)
  })
})
