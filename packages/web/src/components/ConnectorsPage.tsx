import { useEffect, useState } from 'react'
import { Button, Dialog, Spinner } from '@terminal/ui'
import type { RegisteredConnector } from '@terminal/core'
import { api } from '../api'

const STATUS_LABEL: Record<RegisteredConnector['status'], string> = { ok: 'ok', missing_config: 'missing key', error: 'error' }
const STATUS_CLASS: Record<RegisteredConnector['status'], string> = { ok: 'text-up', missing_config: 'text-muted', error: 'text-down' }

/** Lists every connector with its status and a key field that PUTs the config. */
export function ConnectorsPage({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [connectors, setConnectors] = useState<RegisteredConnector[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = () => {
    setError(null)
    api
      .connectors()
      .then(setConnectors)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }

  useEffect(() => {
    if (open) load()
  }, [open])

  return (
    <Dialog open={open} onClose={onClose} title="Connectors">
      <div className="flex w-[min(90vw,560px)] flex-col gap-3">
        <p className="text-muted">
          Connectors answer kinds from an external source. Keys stay on this machine in <code className="font-mono">~/.terminal/config.yml</code>.
        </p>
        {error && <div className="text-down">{error}</div>}
        {!connectors && !error && <Spinner />}
        {connectors?.length === 0 && <div className="text-muted">No connectors configured.</div>}
        {connectors?.map((c) => (
          <ConnectorRow key={c.name} connector={c} onSaved={(saved) => setConnectors((cs) => cs?.map((x) => (x.name === saved.name ? saved : x)) ?? null)} />
        ))}
      </div>
    </Dialog>
  )
}

function ConnectorRow({ connector, onSaved }: { connector: RegisteredConnector; onSaved: (c: RegisteredConnector) => void }) {
  const [key, setKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setMessage(null)
    try {
      const saved = await api.setConnectorConfig(connector.name, { apiKey: key.trim() })
      onSaved(saved ?? connector)
      setKey('')
      setMessage('Saved.')
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-2 rounded border border-border bg-bg px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <div>
          <span className="font-medium text-fg">{connector.name}</span>
          <span className="ml-2 text-muted">{connector.kinds.join(', ')}</span>
        </div>
        <span className={STATUS_CLASS[connector.status]}>{STATUS_LABEL[connector.status]}</span>
      </div>
      {connector.error && <div className="text-muted">{connector.error}</div>}
      <div className="flex gap-2">
        <input
          className="flex-1 rounded border border-border bg-surface px-2 py-1 font-mono text-fg outline-none focus:border-accent"
          type="password"
          autoComplete="off"
          placeholder={connector.status === 'ok' ? 'API key (replace)' : 'API key'}
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
        <Button type="submit" size="sm" variant="primary" disabled={saving || !key.trim()}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
      {message && <div className="text-muted">{message}</div>}
    </form>
  )
}
