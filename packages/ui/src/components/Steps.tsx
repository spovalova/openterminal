import type { FC } from 'react'
import clsx from 'clsx'
import type { Step } from '@terminal/core'
import { formatDuration } from '../format.js'
import { ChevronIcon } from './icons.js'

export type StepsProps = { steps: Step[]; durationMs: number; defaultOpen?: boolean; className?: string; live?: boolean }

/**
 * Collapsible list of the agent's tool calls. Header reads
 * "Worked for 12s · 5 steps" (or "Working… · 2 steps" while live).
 */
export const Steps: FC<StepsProps> = ({ steps, durationMs, defaultOpen, className, live }) => {
  const n = steps.length
  const failed = steps.filter((s) => s.error).length
  return (
    <details open={defaultOpen} className={clsx('group/steps text-xs', className)}>
      <summary className="flex h-6 cursor-pointer list-none items-center gap-1 rounded-sm text-fg-3 select-none hover:text-fg-2 [&::-webkit-details-marker]:hidden">
        <ChevronIcon size={12} className="transition-transform group-open/steps:rotate-90" />
        <span>
          {live ? 'Working…' : `Worked for ${formatDuration(durationMs)}`}
          <span className="mx-1 text-border-strong">·</span>
          {n} {n === 1 ? 'step' : 'steps'}
          {failed > 0 && <span className="ml-1 text-down">({failed} failed)</span>}
        </span>
      </summary>
      <ol className="mt-1 ml-1 flex flex-col border-l border-border pl-2">
        {steps.map((s, i) => (
          <li key={i} className="flex min-w-0 items-start gap-2 py-0.5">
            <span className={clsx('w-[88px] shrink-0 truncate font-mono text-fg-3', s.tool === 'set_workspace' && 'text-accent')}>{s.tool}</span>
            <span className="min-w-0 flex-1">
              <span className={clsx('block truncate', s.error ? 'text-down' : 'text-fg-2')} title={s.summary}>
                {s.summary}
              </span>
              {s.error && (
                <span className="block truncate font-mono text-fg-3" title={s.error}>
                  {s.error}
                </span>
              )}
            </span>
            <span className="shrink-0 font-mono text-fg-3 tabular-nums">{Math.round(s.ms)}ms</span>
          </li>
        ))}
      </ol>
    </details>
  )
}
