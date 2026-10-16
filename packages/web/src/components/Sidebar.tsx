import { useEffect, useState } from 'react'
import { IconButton, PromptBox, Steps } from '@terminal/ui'
import type { Message, Workspace } from '@terminal/core'
import { useActions } from '../actions'
import { MOD } from '../platform'
import { useApp, type WorkspaceState } from '../state'
import { ErrorBanner } from './ErrorBanner'
import { Reply } from './Reply'

/** The right sidebar: the conversation that produced the workspace, with the PromptBox at the bottom. */
export function Sidebar({ workspace, ws }: { workspace: Workspace; ws: WorkspaceState }) {
  const { dispatch } = useApp()
  const { submitPrompt, retry, cancel } = useActions()
  const [value, setValue] = useState('')
  const busy = ws.sending || ws.status === 'streaming'
  const elapsed = useElapsed(ws.startedAt)

  const submit = () => {
    if (!value.trim() || busy) return
    submitPrompt(workspace.id, value)
    setValue('')
  }

  const messages = workspace.messages
  const lastAgentIndex = findLastIndex(messages, (m) => m.role === 'agent')

  return (
    <aside className="sidebar flex h-full flex-col border-l border-border bg-surface" aria-label="Conversation">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-[11px] uppercase tracking-wide text-fg-2">Conversation</span>
        <IconButton label={`Hide sidebar (${MOD}+\\)`} onClick={() => dispatch({ type: 'sidebar', open: false })}>
          ×
        </IconButton>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 py-3">
        {messages.length === 0 && ws.status !== 'streaming' && !ws.sending && (
          <div className="text-fg-2">Ask a follow-up to rewrite the workspace. The agent sees the current widgets.</div>
        )}
        {messages.map((m, i) => (
          <MessageView key={i} message={m} workspace={workspace} durationMs={i === lastAgentIndex && ws.lastRunMs != null ? ws.lastRunMs : undefined} />
        ))}

        {(ws.sending || ws.status === 'streaming' || ws.status === 'error') && ws.prompt && <UserMessage text={ws.prompt} />}
        {ws.status === 'streaming' && (
          <div className="flex flex-col gap-2">
            <Steps steps={ws.steps} durationMs={elapsed} defaultOpen={false} />
            {ws.streamingText ? <Reply text={ws.streamingText} widgets={workspace.widgets} streaming /> : <div className="text-fg-2">Working…</div>}
          </div>
        )}
        {ws.sending && ws.status !== 'streaming' && <div className="text-fg-2">Sending…</div>}
      </div>

      <div className="flex flex-col gap-2 border-t border-border p-3">
        {ws.status === 'error' && ws.lastError && <ErrorBanner error={ws.lastError} onRetry={() => retry(workspace.id)} />}
        <PromptBox value={value} onChange={setValue} onSubmit={submit} busy={busy} onCancel={() => cancel(workspace.id)} placeholder="Ask a follow-up…" />
      </div>
    </aside>
  )
}

function MessageView({ message, workspace, durationMs }: { message: Message; workspace: Workspace; durationMs?: number }) {
  if (message.role === 'user') return <UserMessage text={message.text} />
  const steps = message.steps ?? []
  const ms = durationMs ?? steps.reduce((sum, s) => sum + s.ms, 0)
  return (
    <div className="flex flex-col gap-2">
      {steps.length > 0 && <Steps steps={steps} durationMs={ms} />}
      <Reply text={message.text} widgets={workspace.widgets} />
    </div>
  )
}

function UserMessage({ text }: { text: string }) {
  return <div className="self-end rounded bg-surface-2 px-3 py-2 text-fg whitespace-pre-wrap max-w-[90%]">{text}</div>
}

function useElapsed(startedAt: number | null): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (startedAt == null) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [startedAt])
  return startedAt == null ? 0 : Math.max(0, now - startedAt)
}

function findLastIndex<T>(arr: T[], pred: (t: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i -= 1) if (pred(arr[i]!)) return i
  return -1
}
