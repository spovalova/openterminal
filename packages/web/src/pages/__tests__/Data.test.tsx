// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createWorkspace, type Recipe, type Workspace } from '@openterminal/core'
import { RECIPES } from '../../components/__tests__/recipes-fixture'

const api = vi.hoisted(() => ({
  connectors: vi.fn(),
  catalog: vi.fn(),
  connectorCatalog: vi.fn(),
  recipes: vi.fn(),
  setRecipes: vi.fn(),
  storeInfo: vi.fn(),
  setting: vi.fn(),
  setSetting: vi.fn(),
  probe: vi.fn(),
  setConnectorConfig: vi.fn(),
}))
vi.mock('../../api', () => ({ api }))

import { DataPage } from '../Data'

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '')
  }
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open')
  }
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const builtin = RECIPES
const userRecipe: Recipe = { name: 'my_quote', title: '{symbols} quote', summary: 'Mine', params: { type: 'object', properties: { symbols: { type: 'array', items: { type: 'string' } } } }, view: { preset: 'stat' }, routes: [{ connector: 'yahoo', route: 'quote', params: { symbols: '{symbols}' } }], user: true }
const quoteDescriptor = { connector: 'openbb', route: 'equity/price/quote', summary: 'Latest quote', params: [{ name: 'symbol', type: 'string[]' as const, required: true }], providers: ['yfinance', 'fmp'], fields: [{ name: 'last_price', type: 'number' as const }], liveness: { checkedAt: 1, ok: true, rows: 1, ms: 40 } }
const newsDescriptor = { connector: 'openbb', route: 'news/company', summary: 'Company news', params: [], providers: [], fields: [], liveness: { checkedAt: 1, ok: false, error: 'HTTP 500' } }

function setup() {
  api.connectors.mockResolvedValue([
    { name: 'openbb', kinds: ['quote', 'ohlcv'], status: 'ok', needsKey: false, configured: true, detail: 'OpenBB Platform 4.4 at http://127.0.0.1:6900', mode: 'both' },
    { name: 'finnhub', kinds: ['quote', 'news'], status: 'missing_config', needsKey: true, configured: false },
  ])
  api.catalog.mockImplementation(async (q?: string) => ({
    query: q ?? '',
    hits: q ? [{ connector: 'openbb', route: 'equity/price/quote', summary: 'Latest quote', score: 3, providers: ['yfinance', 'fmp'], requiredParams: ['symbol'], fields: ['last_price'], liveness: quoteDescriptor.liveness }] : [],
    stats: { openbb: { routes: 38, alive: 30, dead: 2, unknown: 6, probedAt: Date.now() - 120_000 } },
    connectors: ['openbb'],
    recipes: builtin.length + 1,
  }))
  api.connectorCatalog.mockResolvedValue({ connector: 'openbb', status: 'ok', mode: 'both', descriptors: [quoteDescriptor, newsDescriptor], stats: { routes: 2, alive: 1, dead: 1, unknown: 0 } })
  api.recipes.mockResolvedValue({ builtin, user: [userRecipe] })
  api.setRecipes.mockImplementation(async (recipes: Recipe[]) => ({ user: recipes }))
  api.storeInfo.mockResolvedValue({ location: '/tmp/home/terminal.db', frames: 12, kind: 'sqlite', migration: { workspaces: 8, widgets: 31, v1Widgets: 31, backup: '/tmp/home/workspaces.json-backup', alreadyDone: false, at: 1 } })
  api.setting.mockResolvedValue({})
  api.setSetting.mockImplementation(async (_k: string, v: unknown) => v)
}

const workspace: Workspace = {
  ...createWorkspace({ id: 'ws1', name: 'Memory', now: 1 }),
  widgets: [{ id: 'w1', title: 'Memory quotes', size: 'sm', data: { main: { recipe: 'quote', params: { symbols: ['MU', 'STX'] } } }, view: { preset: 'stat' } }],
}

describe('Data page', () => {
  it('lists connectors with keys, catalog stats and a probe button; the probe reports 501 when not wired', async () => {
    setup()
    api.probe.mockRejectedValue(new Error('the probe is not wired in yet'))
    render(<DataPage onClose={() => {}} workspace={workspace} />)
    await screen.findByText('OpenBB Platform 4.4 at http://127.0.0.1:6900')
    const openbb = document.querySelector('[data-connector="openbb"]')!
    expect(openbb.textContent).toMatch(/38 routes/)
    expect(openbb.textContent).toMatch(/30/)
    expect(openbb.textContent).toMatch(/probed 2 min ago/)
    expect(within(openbb as HTMLElement).queryByPlaceholderText(/API key/)).toBeNull()
    const finnhub = document.querySelector('[data-connector="finnhub"]')!
    expect(within(finnhub as HTMLElement).getByPlaceholderText('API key')).toBeTruthy()
    expect(finnhub.textContent).toMatch(/missing key/)
    fireEvent.click(screen.getByRole('button', { name: 'Probe routes' }))
    await screen.findByText('the probe is not wired in yet')
    api.probe.mockResolvedValue({ probed: 38, alive: 31, dead: 1, ms: 42_000 })
    fireEvent.click(within(openbb as HTMLElement).getByRole('button', { name: 'Probe' }))
    await screen.findByText('31 alive, 1 dead of 38 routes in 42 s')
    expect(api.probe).toHaveBeenLastCalledWith('openbb')
  })

  it('searches the catalog, shows liveness, expands a route and saves a provider override', async () => {
    setup()
    render(<DataPage onClose={() => {}} workspace={workspace} />)
    await screen.findByText('OpenBB Platform 4.4 at http://127.0.0.1:6900')
    fireEvent.change(screen.getByLabelText('Search the catalog'), { target: { value: 'quote' } })
    await screen.findByText('equity/price/quote')
    expect(api.catalog).toHaveBeenLastCalledWith('quote', { limit: 25, includeDead: true })
    fireEvent.click(screen.getByText('equity/price/quote'))
    await screen.findByText(/fields:/)
    expect(screen.getByText('last_price')).toBeTruthy()
    const select = screen.getByDisplayValue('route default') as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'fmp' } })
    await waitFor(() => expect(api.setSetting).toHaveBeenCalledWith('providers', { 'openbb:equity/price/quote': 'fmp' }))
    // browsing a connector lists every route with its liveness, dead ones marked
    fireEvent.change(screen.getByLabelText('Search the catalog'), { target: { value: '' } })
    fireEvent.change(screen.getByLabelText('Connector'), { target: { value: 'openbb' } })
    await screen.findByText('news/company')
    expect(screen.getByLabelText('dead')).toBeTruthy()
    expect(screen.getByLabelText('alive')).toBeTruthy()
  })

  it('shows the recipe library, promotes a widget into an editable recipe and saves it; edits and deletes user recipes', async () => {
    setup()
    render(<DataPage onClose={() => {}} workspace={workspace} />)
    await screen.findByText('my_quote')
    expect(screen.getByText(`${builtin.length} built in · 1 yours`)).toBeTruthy()
    const rows = document.querySelector('[data-recipe-rows]')!
    expect(within(rows as HTMLElement).getByText('ohlcv')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Promote a widget…' }))
    fireEvent.click(screen.getByRole('button', { name: /Memory quotes/ }))
    const textarea = screen.getByLabelText('Recipe JSON') as HTMLTextAreaElement
    const draft = JSON.parse(textarea.value) as Recipe
    expect(draft.name).toBe('memory_quotes')
    expect(draft.params.properties?.symbols).toMatchObject({ default: ['MU', 'STX'] })
    fireEvent.click(screen.getByRole('button', { name: 'Save recipe' }))
    await waitFor(() => expect(api.setRecipes).toHaveBeenCalledTimes(1))
    expect((api.setRecipes.mock.calls[0]![0] as Recipe[]).map((r) => r.name)).toEqual(['my_quote', 'memory_quotes'])
    await screen.findByText('memory_quotes')

    // an invalid edit is refused with the reason
    fireEvent.click(within(document.querySelector('[data-recipe-rows]') as HTMLElement).getAllByRole('button', { name: 'Edit' })[0]!)
    fireEvent.change(screen.getByLabelText('Recipe JSON'), { target: { value: '{"name": "Bad"}' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save recipe' }))
    await waitFor(() => expect(document.querySelector('[data-recipe-error]')?.textContent).toMatch(/title|name/))
    expect(api.setRecipes).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    fireEvent.click(within(document.querySelector('[data-recipe-rows]') as HTMLElement).getAllByRole('button', { name: 'Delete' })[0]!)
    await waitFor(() => expect(api.setRecipes).toHaveBeenCalledTimes(2))
    expect((api.setRecipes.mock.calls[1]![0] as Recipe[]).map((r) => r.name)).toEqual(['memory_quotes'])
    confirm.mockRestore()
  })

  it('reports the store and the migration', async () => {
    setup()
    render(<DataPage onClose={() => {}} />)
    await screen.findByText('/tmp/home/terminal.db')
    const store = document.querySelector('[data-section="store"]')!
    expect(store.textContent).toMatch(/12 cached frames/)
    expect(store.textContent).toMatch(/8 workspaces, 31 widgets \(31 v1 rewritten as recipes\)/)
    expect(store.textContent).toMatch(/workspaces.json-backup/)
  })
})
