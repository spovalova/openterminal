import { useEffect, useRef, type CSSProperties, type FC, type KeyboardEvent } from 'react'
import clsx from 'clsx'
import { Kbd } from './Kbd.js'
import { Spinner } from './Spinner.js'
import { ArrowUpIcon, StopIcon } from './icons.js'

export type PromptBoxProps = {
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
  busy?: boolean
  onCancel?: () => void
  placeholder?: string
  autoFocus?: boolean
  className?: string
  /** Max visible rows before the textarea scrolls. */
  maxRows?: number
}

const MAX_ROWS_DEFAULT = 8
const LINE_PX = 20

/**
 * The prompt. Enter submits, Shift+Enter inserts a newline. The root carries
 * `view-transition-name: prompt-box` so the web app can animate it from the
 * centered Empty state to the sidebar.
 */
export const PromptBox: FC<PromptBoxProps> = ({
  value,
  onChange,
  onSubmit,
  busy = false,
  onCancel,
  placeholder = 'Ask about a ticker, a theme, or your watchlist…',
  autoFocus,
  className,
  maxRows = MAX_ROWS_DEFAULT,
}) => {
  const ref = useRef<HTMLTextAreaElement>(null)
  const canSubmit = !busy && value.trim().length > 0

  // Auto-grow up to maxRows.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = '0px'
    const max = LINE_PX * maxRows
    el.style.height = `${Math.min(el.scrollHeight, max)}px`
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden'
  }, [value, maxRows])

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      if (canSubmit) onSubmit()
    } else if (e.key === 'Escape' && busy && onCancel) {
      e.preventDefault()
      onCancel()
    }
  }

  return (
    <div
      style={{ viewTransitionName: 'prompt-box' } as CSSProperties}
      data-busy={busy || undefined}
      className={clsx(
        'flex flex-col rounded-lg border border-border-strong bg-surface',
        'transition-colors focus-within:border-accent/70',
        className,
      )}
    >
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        autoFocus={autoFocus}
        rows={1}
        spellCheck={false}
        aria-label="Prompt"
        className="w-full resize-none bg-transparent px-3 pt-2.5 pb-1 text-base leading-5 text-fg outline-none placeholder:text-fg-3"
      />
      <div className="flex h-8 items-center gap-2 px-2 pb-1">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-fg-3">
          {busy ? (
            <>
              <Spinner size={12} />
              <span>Working…</span>
            </>
          ) : (
            <>
              <Kbd>↵</Kbd>
              <span>send</span>
              <span className="mx-0.5 text-border-strong">·</span>
              <Kbd>⇧↵</Kbd>
              <span>newline</span>
            </>
          )}
        </div>
        {busy ? (
          <button
            type="button"
            onClick={onCancel}
            disabled={!onCancel}
            aria-label="Cancel"
            title="Cancel (Esc)"
            className="inline-flex h-6 items-center gap-1 rounded-md border border-border-strong px-2 text-xs text-fg-2 hover:border-down/60 hover:text-down disabled:opacity-40"
          >
            <StopIcon size={12} />
            Stop
          </button>
        ) : (
          <button
            type="button"
            onClick={onSubmit}
            disabled={!canSubmit}
            aria-label="Send"
            title="Send (Enter)"
            className={clsx(
              'inline-flex size-6 items-center justify-center rounded-md transition-colors',
              canSubmit ? 'bg-accent text-accent-fg hover:brightness-110' : 'bg-surface-3 text-fg-3',
            )}
          >
            <ArrowUpIcon size={14} />
          </button>
        )}
      </div>
    </div>
  )
}
