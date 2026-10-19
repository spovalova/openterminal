import { useEffect, useState } from 'react'
import { IconButton, PromptBox, Steps } from '@openterminal/ui'
import type { Message, Workspace } from '@openterminal/core'
import { useActions } from '../actions'
import { MOD } from '../platform'
import { useApp, type WorkspaceState } from '../state'
import { asOfLabel, workspaceHeldAt } from '../state/frames'
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

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 pt-3 pb-6">
        {messages.length === 0 && ws.status !== 'streaming' && !ws.sending && (
          <div className="text-fg-2">Ask a follow-up to rewrite the workspace. The agent sees the current widgets.</div>
        )}
        {messages.map((m, i) => (
          <MessageView key={i} message={m} workspace={workspace} latest={i === lastAgentIndex} durationMs={i === lastAgentIndex && ws.lastRunMs != null ? ws.lastRunMs : undefined} />
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

function MessageView({ message, workspace, durationMs, latest = false }: { message: Message; workspace: Workspace; durationMs?: number; latest?: boolean }) {
  if (message.role === 'user') return <UserMessage text={message.text} />
  const steps = message.steps ?? []
  const ms = durationMs ?? steps.reduce((sum, s) => sum + s.ms, 0)
  return (
    <div className="flex flex-col gap-2">
      {steps.length > 0 && <Steps steps={steps} durationMs={ms} />}
      <Reply text={message.text} widgets={workspace.widgets} unverified={message.verification?.unmatched.map((u) => u.text) ?? []} />
      {message.verification && <VerificationLine verification={message.verification} at={message.at} workspaceId={workspace.id} latest={latest} />}
    </div>
  )
}

/**
 * The server's reply verification (PLAN.md section 17, "Reply verification on the server"): every figure in the reply
 * matched against the run's previews. One quiet line when all matched; the unmatched figures named when not, so a
 * number the model wrote without a preview behind it is visible to the reader.
 *
 * Taste round 2 (one snapshot): the line says when the data was taken ("as of 14:29 ET"). Under the latest reply it
 * also says what the widgets show: the same data, held, with "Live data" to release them; or live data, so a verified
 * footer never sits silently under numbers the widgets beside it have moved past.
 */
function VerificationLine({ verification, at, workspaceId, latest }: { verification: NonNullable<Message['verification']>; at: number | undefined; workspaceId: string; latest: boolean }) {
  const { state } = useApp()
  const { goLive } = useActions()
  if (verification.checked === 0) return null
  const asOf = at !== undefined ? ` as of ${asOfLabel(at)}` : ''
  const held = latest ? workspaceHeldAt(state.frames, workspaceId) : undefined
  const tail = !latest ? null : held !== undefined ? (
    <>
      {' · the widgets show this data · '}
      <button type="button" data-go-live="" className="text-fg-2 underline decoration-dotted underline-offset-2 hover:text-fg" onClick={() => goLive(workspaceId)}>
        Live data
      </button>
    </>
  ) : (
    <> · the widgets show live data</>
  )
  if (verification.ok) {
    return (
      <div data-verification="ok" data-held={held !== undefined ? '' : undefined} className="text-xs text-fg-3">
        {verification.checked === 1 ? '1 figure' : `${verification.checked} figures`} verified against the data{asOf}
        {tail}
      </div>
    )
  }
  // Muted, never red (change 8): the count here, each unverified figure underlined in the reply with a hover; the list is the run log's.
  return (
    <div data-verification="unmatched" data-held={held !== undefined ? '' : undefined} className="text-xs text-fg-3" title={`Not in any frame: ${verification.unmatched.map((u) => u.text).join(', ')}`}>
      {verification.matched} of {verification.checked} figures verified{asOf} · unverified figures are underlined
      {tail}
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
