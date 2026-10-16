import { useState } from 'react'
import { Chip, Kbd, PromptBox } from '@terminal/ui'
import type { Workspace } from '@terminal/core'
import { useActions } from '../actions'
import { MOD } from '../platform'
import { useApp, type WorkspaceState } from '../state'
import { ErrorBanner } from './ErrorBanner'
import { NoKeys } from './NoKeys'

/** The three example prompts from PLAN.md section 5. */
export const EXAMPLE_PROMPTS = ["What's happening with memory?", "Is NVDA's drop today news or just the market?", 'Morning check on my watchlist']

export function EmptyView({ workspace, ws }: { workspace: Workspace; ws: WorkspaceState }) {
  const { state } = useApp()
  const { submitPrompt, retry, cancel } = useActions()
  const [value, setValue] = useState('')
  const busy = ws.sending || ws.status === 'streaming'
  const noKeys = state.health?.llm === false

  const submit = () => {
    if (!value.trim() || busy) return
    submitPrompt(workspace.id, value)
    setValue('')
  }

  return (
    <div className="shell-fade flex h-full items-center justify-center overflow-y-auto px-4">
      <div className="flex w-full max-w-[640px] flex-col gap-4 py-8">
        <div className="text-center">
          <h1 className="text-lg font-medium text-fg">What do you want to look at?</h1>
          <p className="mt-1 text-muted">A question becomes a workspace: live widgets plus a reply that points at them.</p>
        </div>
        {noKeys && <NoKeys />}
        {ws.status === 'error' && ws.lastError && <ErrorBanner error={ws.lastError} onRetry={() => retry(workspace.id)} />}
        <PromptBox
          value={value}
          onChange={setValue}
          onSubmit={submit}
          busy={busy}
          onCancel={() => cancel(workspace.id)}
          placeholder="Ask about a ticker, a theme, or a move. Type a ticker like MU for an overview."
          autoFocus
        />
        <div className="flex flex-wrap justify-center gap-2">
          {EXAMPLE_PROMPTS.map((p) => (
            <Chip key={p} onClick={() => submitPrompt(workspace.id, p)}>
              {p}
            </Chip>
          ))}
        </div>
        <div className="text-center text-muted">
          <Kbd>{MOD}</Kbd> <Kbd>K</Kbd> for the palette
        </div>
      </div>
    </div>
  )
}
