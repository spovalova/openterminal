import { useState, type FormEvent } from 'react'
import clsx from 'clsx'
import { Button } from '@openterminal/ui'
import { api } from '../api'
import { useApp } from '../state'

type Provider = 'anthropic' | 'openai'

const PROVIDERS: { id: Provider; label: string; placeholder: string; url: string }[] = [
  { id: 'anthropic', label: 'Anthropic', placeholder: 'sk-ant-…', url: 'https://console.anthropic.com/settings/keys' },
  { id: 'openai', label: 'OpenAI', placeholder: 'sk-…', url: 'https://platform.openai.com/api-keys' },
]

/**
 * The onboarding card, shown in the Empty state while /api/health reports llm: false: paste a key and the agent is on.
 * PUT /api/llm writes it to config.yml (mode 600) and switches the server's agent without a restart; the key is never
 * sent back. Until then prompts run against the stub agent, which builds a fixed sample workspace.
 */
export function NoKeys() {
  const { dispatch } = useApp()
  const [provider, setProvider] = useState<Provider>('anthropic')
  const [key, setKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const current = PROVIDERS.find((p) => p.id === provider)!

  const save = async (e: FormEvent) => {
    e.preventDefault()
    if (!key.trim() || saving) return
    setSaving(true)
    setMessage(null)
    try {
      const saved = await api.setLlm({ provider, apiKey: key.trim() })
      setKey('')
      if (saved.restart) setMessage('Saved. Restart Open Terminal to turn the agent on.')
      dispatch({ type: 'health', health: await api.health() })
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={save} data-onboarding="llm-key" className="flex flex-col gap-2 rounded border border-border bg-surface px-3 py-3 text-fg-2">
      <div className="text-fg">Turn on the agent</div>
      <div>
        Paste an API key. It stays on this machine, in <code className="font-mono text-fg">~/.openterminal/config.yml</code>, readable only by you, and is
        never shown again.
      </div>
      <div className="flex items-center gap-2">
        <div role="radiogroup" aria-label="Provider" className="flex shrink-0 overflow-hidden rounded border border-border">
          {PROVIDERS.map((p) => (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={provider === p.id}
              onClick={() => setProvider(p.id)}
              className={clsx('px-2 py-1', provider === p.id ? 'bg-surface-2 text-fg' : 'text-fg-2 hover:text-fg')}
            >
              {p.label}
            </button>
          ))}
        </div>
        <input
          aria-label={`${current.label} API key`}
          className="num min-w-0 flex-1 rounded border border-border bg-bg px-2 py-1 text-fg outline-none focus:border-accent"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={current.placeholder}
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
        <Button type="submit" variant="primary" disabled={!key.trim() || saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
      {message && <div className="text-fg">{message}</div>}
      <div>
        No key yet? Get one from{' '}
        <a className="text-accent hover:underline" href={current.url} target="_blank" rel="noreferrer">
          {current.label}
        </a>
        . Until then a prompt builds a sample workspace.
      </div>
    </form>
  )
}
