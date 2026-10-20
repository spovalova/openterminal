// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ setLlm: vi.fn(), health: vi.fn() }))
vi.mock('../../api', () => ({ api }))

import { AppContext, initialState } from '../../state'
import { NoKeys } from '../NoKeys'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function mount() {
  const dispatch = vi.fn()
  render(
    <AppContext.Provider value={{ state: initialState, dispatch }}>
      <NoKeys />
    </AppContext.Provider>,
  )
  return dispatch
}

describe('the LLM key onboarding card', () => {
  it('saves a pasted key for the chosen provider, clears the field, and refreshes health', async () => {
    api.setLlm.mockResolvedValue({ configured: true, provider: 'openai', model: 'gpt-6-luna' })
    api.health.mockResolvedValue({ ok: true, connectors: ['yahoo'], recipes: 24, llm: true })
    const dispatch = mount()
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.click(screen.getByRole('radio', { name: 'OpenAI' }))
    const input = screen.getByLabelText('OpenAI API key') as HTMLInputElement
    expect(input.type).toBe('password')
    fireEvent.change(input, { target: { value: '  sk-test-123 ' } })
    fireEvent.click(save)
    await waitFor(() => expect(dispatch).toHaveBeenCalledWith({ type: 'health', health: { ok: true, connectors: ['yahoo'], recipes: 24, llm: true } }))
    expect(api.setLlm).toHaveBeenCalledWith({ provider: 'openai', apiKey: 'sk-test-123' })
    expect(input.value).toBe('')
  })

  it('shows the server’s error and keeps the key', async () => {
    api.setLlm.mockRejectedValue(new Error('invalid key'))
    mount()
    const input = screen.getByLabelText('Anthropic API key') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'sk-ant-x' } })
    fireEvent.submit(input.closest('form')!)
    await screen.findByText('invalid key')
    expect(input.value).toBe('sk-ant-x')
  })
})
