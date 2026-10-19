// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { parseAnyWidget, type AnyWidget } from '@terminal/core'
import { builtinRecipes } from '@terminal/core/node'
import { parseRecipeText, recipeFromWidget, recipeNameFrom } from '../recipe-promote'

const builtin = builtinRecipes()

describe('promote a widget to a recipe', () => {
  it('names recipes from titles, avoiding clashes', () => {
    expect(recipeNameFrom('MU forward P/E', new Set())).toBe('mu_forward_p_e')
    expect(recipeNameFrom('quote', new Set(['quote']))).toBe('quote_2')
    expect(recipeNameFrom('123', new Set())).toBe('my_recipe')
  })

  it('a recipe dataset copies the base recipe\'s routes with the widget\'s params as defaults', () => {
    const w: AnyWidget = { id: 'w', title: 'Watchlist quotes', size: 'sm', data: { main: { recipe: 'quote', params: { symbols: ['MU', 'STX'] } } }, view: { preset: 'stat', column: 'price' } }
    const r = recipeFromWidget(w, builtin)
    expect(r.name).toBe('watchlist_quotes')
    expect(r.user).toBe(true)
    expect(r.view).toEqual({ preset: 'stat', column: 'price' })
    expect(r.params.properties?.symbols).toMatchObject({ type: 'array', default: ['MU', 'STX'] })
    expect(r.data?.main && 'routes' in r.data.main && r.data.main.routes.map((x) => `${x.connector} ${x.route}`)).toEqual(['yahoo quote', 'openbb equity/price/quote', 'finnhub quote'])
  })

  it('a widget stored in the v1 JSON shape promotes through the recipe of the same name once migrated', () => {
    const v1 = parseAnyWidget({ id: 'w1', title: 'MU daily', size: 'md', query: { kind: 'ohlcv', params: { symbols: ['MU'], interval: '1d', range: '6mo' } }, view: { type: 'series', candle: true } })
    const r = recipeFromWidget(v1, builtin)
    expect(r.params.properties?.range).toMatchObject({ default: '6mo' })
    expect(r.view).toEqual({ preset: 'price', candle: true, volume: true })
    expect(r.data?.main && 'routes' in r.data.main && r.data.main.routes[0]?.route).toBe('equity/price/historical')
  })

  it('a route dataset templates its symbol params and keeps the rest literal; a transform carries its inputs', () => {
    const w: AnyWidget = {
      id: 'w',
      title: 'NVDA P/E over time',
      size: 'lg',
      data: {
        price: { connector: 'openbb', route: 'equity/price/historical', params: { symbol: ['NVDA'], start_date: '2024-01-01', provider: 'yfinance' } },
        eps: { recipe: 'eps_history', params: { symbols: ['NVDA'], limit: 12 } },
        main: { inputs: { price: { connector: 'openbb', route: 'equity/price/historical', params: { symbol: ['NVDA'], start_date: '2024-01-01', provider: 'yfinance' } }, eps: { recipe: 'eps_history', params: { symbols: ['NVDA'], limit: 12 } } }, code: 'result = price', columns: { pe: { unit: 'ratio' } } },
      },
      view: { preset: 'price' },
    }
    const r = recipeFromWidget(w, builtin)
    expect(Object.keys(r.data ?? {})).toEqual(['price', 'eps', 'main'])
    const price = r.data!.price!
    expect('routes' in price && price.routes[0]).toEqual({ connector: 'openbb', route: 'equity/price/historical', provider: 'yfinance', params: { symbol: '{symbol}', start_date: '2024-01-01' } })
    expect(r.params.properties?.symbol).toMatchObject({ type: 'array', default: ['NVDA'] })
    expect(r.params.properties?.symbols).toMatchObject({ default: ['NVDA'] })
    expect(r.data!.main).toEqual({ inputs: ['price', 'eps'], code: 'result = price', columns: { pe: { unit: 'ratio' } } })
    expect(r.size).toBe('lg')
  })

  it('parseRecipeText reports schema problems in one line', () => {
    expect(parseRecipeText('{').ok).toBe(false)
    const bad = parseRecipeText(JSON.stringify({ name: 'Bad Name', title: 'x', params: { type: 'object' }, view: { preset: 'table' } }))
    expect(bad.ok).toBe(false)
    expect(!bad.ok && bad.error).toMatch(/name/)
    const ok = parseRecipeText(JSON.stringify({ name: 'good', title: 'x', params: { type: 'object' }, view: { preset: 'table' }, routes: [{ connector: 'yahoo', route: 'quote', params: {} }] }))
    expect(ok.ok).toBe(true)
  })
})
