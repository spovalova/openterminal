import type { FC, PropsWithChildren } from 'react'
import clsx from 'clsx'

export type ChipProps = PropsWithChildren<{ onClick?: () => void; active?: boolean; className?: string; title?: string }>

/** Small pill. Interactive when `onClick` is given (reply links to widgets, example prompts). */
export const Chip: FC<ChipProps> = ({ children, onClick, active, className, title }) => {
  const cls = clsx(
    'inline-flex h-5 max-w-full items-center gap-1 rounded-full border px-2 text-xs whitespace-nowrap',
    active ? 'border-accent/60 bg-accent/15 text-fg' : 'border-border-strong bg-surface-2 text-fg-2',
    onClick && 'cursor-pointer transition-colors duration-100 hover:border-accent/60 hover:text-fg',
    className,
  )
  if (!onClick) {
    return (
      <span className={cls} title={title}>
        <span className="truncate">{children}</span>
      </span>
    )
  }
  return (
    <button type="button" className={cls} onClick={onClick} title={title} aria-pressed={active}>
      <span className="truncate">{children}</span>
    </button>
  )
}
