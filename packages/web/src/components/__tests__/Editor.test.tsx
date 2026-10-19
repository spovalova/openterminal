// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { TRANSFORM_EXAMPLE, type AnyWidget, type Frame, type WidgetV2 } from '@openterminal/core'
import { RECIPES } from './recipes-fixture'

const actions = vi.hoisted(() => ({
  saveWidget: vi.fn(async (_workspaceId: string, _widget: unknown): Promise<void> => {}),
  removeWidget: vi.fn(async (_workspaceId: string, _widgetId: string): Promise<void> => {}),
}))
vi.mock('../../actions', () => ({ useActions: () => actions }))

const quoteFrame: Frame = {
  columns: [{ name: 'symbol', type: 'string' }, { name: 'price', type: 'number' }, { name: 'change_pct', type: 'number' }],
  rows: [['NVDA', 182.4, 1.2]],
  meta: { connector: 'fake', fetchedAt: 1, ttl: 10_000, lineage: { connector: 'fake', route: 'quote', recipe: 'quote' }, fields: { change_pct: { unit: 'percent' } } },
}
class FakeApiError extends Error {
  constructor(
    message: string,
    public detail: { traceback?: string } = {},
  ) {
    super(message)
  }
}
const api = vi.hoisted(() => ({
  recipes: vi.fn(),
  catalog: vi.fn(),
  connectorCatalog: vi.fn(),
  query: vi.fn(),
}))
vi.mock('../../api', () => ({ api, ApiError: Error }))
// CodeMirror needs layout APIs jsdom lacks; the editor is a textarea here.
vi.mock('../CodeEditor', () => ({
  CodeEditor: ({ value, onChange, label }: { value: string; onChange: (v: string) => void; label?: string }) => <textarea aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} />,
}))

import { Editor } from '../Editor'

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
  actions.saveWidget.mockClear()
  api.query.mockReset()
})

function setupApi() {
  const recipes = RECIPES
  api.recipes.mockResolvedValue({ builtin: recipes, user: [] })
  api.catalog.mockResolvedValue({ query: '', hits: [], stats: {}, connectors: ['fake'], recipes: recipes.length })
  api.connectorCatalog.mockResolvedValue({
    connector: 'fake',
    status: 'ok',
    stats: { routes: 1, alive: 0, dead: 0, unknown: 1 },
    descriptors: [{ connector: 'fake', route: 'quote', summary: 'A quote', params: [{ name: 'symbols', type: 'string[]', required: true }], providers: ['a', 'b'], fields: [{ name: 'price', type: 'number' }] }],
  })
  api.query.mockResolvedValue(quoteFrame)
}

const submit = () => fireEvent.submit(screen.getByRole('button', { name: 'Save' }).closest('form')!)
const saved = async (): Promise<WidgetV2> => {
  await waitFor(() => expect(actions.saveWidget).toHaveBeenCalledTimes(1))
  return actions.saveWidget.mock.calls[0]![1] as WidgetV2
}

describe('Editor: three tabs', () => {
  it('data tab: the graph with a recipe form and a per-dataset preview; adds a transform; saves a v2 widget', async () => {
    setupApi()
    render(<Editor open onClose={() => {}} workspaceId="ws1" />)
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Data1', 'Transform', 'View'])
    const graph = screen.getByRole('list').closest('[data-graph]')!
    expect(within(graph as HTMLElement).getByText('main')).toBeTruthy()
    expect(within(graph as HTMLElement).getByText('recipe')).toBeTruthy()
    await waitFor(() => expect((screen.getByLabelText('Recipe') as HTMLSelectElement).options.length).toBe(3))
    expect((screen.getByLabelText('Recipe') as HTMLSelectElement).value).toBe('quote')
    expect((screen.getByLabelText(/^symbols/) as HTMLInputElement).value).toBe('NVDA')

    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    await waitFor(() => expect(api.query).toHaveBeenCalledWith({ recipe: 'quote', params: { symbols: ['NVDA'] } }, { refresh: false }))
    await screen.findByText(/1 rows · 3 columns · fake quote/)
    expect(screen.getByText(/change_pct: percent/)).toBeTruthy()
    expect(document.querySelector('[data-virtual-table]')).toBeTruthy()

    // a changed param drops the stale preview
    fireEvent.change(screen.getByLabelText(/^symbols/), { target: { value: 'nvda, amd' } })
    expect(screen.queryByText(/1 rows · 3 columns/)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '+ transform' }))
    expect(within(graph as HTMLElement).getByText('derived')).toBeTruthy()
    expect(within(graph as HTMLElement).getByText('← main')).toBeTruthy()
    expect(screen.getByText(/edit its inputs and code on the Transform tab/)).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'NVDA derived' } })
    submit()
    const w = await saved()
    expect(w.title).toBe('NVDA derived')
    expect(w.data.main).toEqual({ recipe: 'quote', params: { symbols: ['NVDA', 'AMD'] } })
    expect(w.data.derived).toMatchObject({ code: TRANSFORM_EXAMPLE.code, inputs: { main: { recipe: 'quote', params: { symbols: ['NVDA', 'AMD'] } } } })
    expect(w.view).toEqual({ preset: 'stat' })
  })

  it('transform tab: CodeMirror (a textarea here) with the inputs, Run shows the traceback inline', async () => {
    setupApi()
    render(<Editor open onClose={() => {}} workspaceId="ws1" initialTab="transform" />)
    expect(screen.getByText(/A transform is Python over the widget's other datasets/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '+ Add a transform' }))
    const code = screen.getByLabelText('Transform code') as HTMLTextAreaElement
    expect(code.value).toBe(TRANSFORM_EXAMPLE.code)
    expect((screen.getByRole('checkbox', { name: 'main' }) as HTMLInputElement).checked).toBe(true)
    fireEvent.change(code, { target: { value: 'result = main.head(1)' } })
    api.query.mockRejectedValueOnce(new FakeApiError('transform failed: NameError', { traceback: 'Traceback (most recent call last):\n  File "<transform>", line 1\nNameError: name "x" is not defined' }))
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    await screen.findByText('transform failed: NameError')
    expect(screen.getByText(/NameError: name "x" is not defined/)).toBeTruthy()
    expect(api.query).toHaveBeenCalledWith({ inputs: { main: { recipe: 'quote', params: { symbols: ['NVDA'] } } }, code: 'result = main.head(1)' }, { refresh: false })
    // a successful run shows the frame
    api.query.mockResolvedValueOnce(quoteFrame)
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    await screen.findByText(/1 rows · 3 columns/)
    // the columns block validates
    fireEvent.change(screen.getByLabelText(/^Columns/), { target: { value: '{"pe": {"unit": "ratio"}}' } })
    fireEvent.change(screen.getByLabelText(/^Columns/), { target: { value: '{"pe": {"unit": "parsecs"}}' } })
    expect(screen.getByText(/parsecs|expected|invalid/i)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'T' } })
    fireEvent.change(screen.getByLabelText(/^Columns/), { target: { value: '{"pe": {"unit": "ratio", "label": "P/E"}}' } })
    submit()
    const w = await saved()
    expect(w.data.derived).toMatchObject({ code: 'result = main.head(1)', columns: { pe: { unit: 'ratio', label: 'P/E' } } })
  })

  it('view tab: presets from ViewV2Schema, narrowed by the previewed frame, options as a form, the expanded control read-only', async () => {
    setupApi()
    render(<Editor open onClose={() => {}} workspaceId="ws1" initialTab="view" />)
    const preset = screen.getByLabelText('Preset') as HTMLSelectElement
    expect(Array.from(preset.options).map((o) => o.value)).toHaveLength(9)
    expect(preset.value).toBe('stat')
    expect(screen.getByText(/No frame for/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Preview it' }))
    await waitFor(() => expect(Array.from((screen.getByLabelText('Preset') as HTMLSelectElement).options).map((o) => o.value)).toEqual(['table', 'stat', 'facts', 'heatmap']))
    const expanded = document.querySelector('[data-expanded]')!
    expect(expanded.textContent).toMatch(/"kind": "stat"/)
    expect(expanded.textContent).toMatch(/"column": "price"/)

    fireEvent.change(screen.getByLabelText('Preset'), { target: { value: 'table' } })
    expect(screen.getByLabelText('extremes')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('extremes'))
    fireEvent.change(screen.getByLabelText(/^columns/), { target: { value: 'symbol, price' } })
    fireEvent.change(screen.getByLabelText('limit'), { target: { value: '50' } })
    expect(document.querySelector('[data-expanded]')!.textContent).toMatch(/"extremes": true/)
    expect(document.querySelector('[data-expanded]')!.textContent).toMatch(/"columns": \[\s*"symbol",\s*"price"\s*\]/)

    fireEvent.change(screen.getByLabelText(/^Field overrides/), { target: { value: '{"price": {"label": "Last"}}' } })
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'NVDA table' } })
    submit()
    const w = await saved()
    expect(w.view).toEqual({ preset: 'table', extremes: true, columns: ['symbol', 'price'], limit: 50 })
    expect(w.fields).toEqual({ price: { label: 'Last' } })
  })

  it('route datasets: connector and route with the descriptor\'s params and a provider select; validation errors block the save', async () => {
    setupApi()
    render(<Editor open onClose={() => {}} workspaceId="ws1" />)
    await waitFor(() => expect(api.catalog).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: '+ route' }))
    expect(screen.getAllByText('route').length).toBeGreaterThan(0)
    await waitFor(() => expect(api.connectorCatalog).toHaveBeenCalledWith('fake'))
    fireEvent.change(screen.getByLabelText('Route'), { target: { value: 'quote' } })
    await screen.findAllByText('A quote')
    fireEvent.change(screen.getByLabelText(/^symbols/), { target: { value: 'amd' } })
    fireEvent.change(screen.getByLabelText(/^provider/), { target: { value: 'b' } })
    submit() // no title
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(actions.saveWidget).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Two' } })
    submit()
    const w = await saved()
    expect(w.data.data2).toEqual({ connector: 'fake', route: 'quote', params: { symbols: ['AMD'], provider: 'b' } })
    const v2: AnyWidget = w
    expect(Object.keys(v2.data)).toEqual(['main', 'data2'])
  })
})
