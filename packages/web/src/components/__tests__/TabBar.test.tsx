// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createWorkspace, type Workspace } from '@terminal/core'
import { AppContext, initialState, reducer, type Action, type AppState } from '../../state'
import { SocketContext } from '../../socketContext'
import { useReducer } from 'react'

const api = vi.hoisted(() => ({
  exportWorkspace: vi.fn(),
  importWorkspace: vi.fn(),
  createWorkspace: vi.fn(),
  deleteWorkspace: vi.fn(),
  patchWorkspace: vi.fn(),
}))
vi.mock('../../api', () => ({ api }))

import { TabBar } from '../TabBar'

const ws: Workspace = { ...createWorkspace({ id: 'ws1', name: 'Memory', now: 1 }), widgets: [{ id: 'w1', title: 'Quote', size: 'sm', data: { main: { recipe: 'quote', params: { symbols: ['MU'] } } }, view: { preset: 'stat' } }] }
const doc = { format: 'openterminal-workspace', version: 1, name: 'Memory', widgets: ws.widgets, recipes: [] }

function Harness({ onState }: { onState?: (s: AppState) => void }) {
  const [state, dispatch] = useReducer(reducer, { ...initialState, loaded: true, workspaces: [ws], activeId: 'ws1', ws: {} })
  onState?.(state)
  const socket = { prompt() {}, cancel() {}, refresh() {}, focus() {} } as never
  return (
    <AppContext.Provider value={{ state, dispatch: dispatch as React.Dispatch<Action> }}>
      <SocketContext.Provider value={socket}>
        <TabBar />
      </SocketContext.Provider>
    </AppContext.Provider>
  )
}

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '')
  }
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open')
  }
  ;(URL as unknown as { createObjectURL: () => string }).createObjectURL = () => 'blob:x'
  ;(URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {}
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('workspace menu: export and import', () => {
  it('exports the active workspace as a download and imports a file as a new active tab', async () => {
    api.exportWorkspace.mockResolvedValue(doc)
    const imported: Workspace = { ...createWorkspace({ id: 'ws2', name: 'Memory', now: 2 }), widgets: ws.widgets }
    api.importWorkspace.mockResolvedValue({ workspace: imported, recipesAdded: [] })
    let latest: AppState | undefined
    render(<Harness onState={(s) => (latest = s)} />)

    const clicks: string[] = []
    const origClick = HTMLAnchorElement.prototype.click
    HTMLAnchorElement.prototype.click = function () {
      clicks.push(this.download)
    }
    fireEvent.click(screen.getByRole('button', { name: 'Workspace menu' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Export workspace as JSON' }))
    await waitFor(() => expect(api.exportWorkspace).toHaveBeenCalledWith('ws1'))
    await waitFor(() => expect(clicks).toEqual(['Memory.openterminal.json']))
    await screen.findByText('Exported Memory')
    HTMLAnchorElement.prototype.click = origClick

    fireEvent.click(screen.getByRole('button', { name: 'Workspace menu' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Import workspace from JSON…' }))
    const input = screen.getByLabelText('Import workspace file') as HTMLInputElement
    const file = new File([JSON.stringify(doc)], 'memory.openterminal.json', { type: 'application/json' })
    Object.defineProperty(file, 'text', { value: async () => JSON.stringify(doc) })
    fireEvent.change(input, { target: { files: [file] } })
    await waitFor(() => expect(api.importWorkspace).toHaveBeenCalledWith(doc))
    await waitFor(() => expect(latest?.workspaces.map((w) => w.id)).toEqual(['ws1', 'ws2']))
    expect(latest?.activeId).toBe('ws2')
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Memory', 'Memory'])
  })

  it('reports an import that is not a workspace export', async () => {
    api.importWorkspace.mockRejectedValue(new Error('not a workspace export'))
    render(<Harness />)
    const input = screen.getByLabelText('Import workspace file') as HTMLInputElement
    const file = new File(['{"format":"other"}'], 'x.json', { type: 'application/json' })
    Object.defineProperty(file, 'text', { value: async () => '{"format":"other"}' })
    fireEvent.change(input, { target: { files: [file] } })
    await screen.findByText('Import failed: not a workspace export')
  })
})
