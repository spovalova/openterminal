import type { FC } from 'react'
import clsx from 'clsx'

/** Pulsing placeholder block. Size it with className (defaults to a full-width line). */
export const Skeleton: FC<{ className?: string }> = ({ className }) => (
  <div aria-hidden className={clsx('animate-pulse rounded-sm bg-surface-3', className ?? 'h-3 w-full')} />
)
