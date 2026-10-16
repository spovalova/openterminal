import { Button } from '@terminal/ui'

export function ErrorBanner({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex items-start gap-3 rounded border border-down/40 bg-down/10 px-3 py-2 text-fg">
      <div className="min-w-0 flex-1">
        <div className="text-[11px] uppercase tracking-wide text-down">Prompt failed</div>
        <div className="break-words">{error}</div>
      </div>
      {onRetry && (
        <Button size="sm" variant="ghost" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  )
}
