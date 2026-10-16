import type { FC, ReactNode } from 'react'
import clsx from 'clsx'

export const EmptyState: FC<{ title: string; hint?: ReactNode; icon?: ReactNode; className?: string }> = ({ title, hint, icon, className }) => (
  <div className={clsx('flex h-full min-h-16 w-full flex-col items-center justify-center gap-1 p-4 text-center', className)}>
    {icon && <div className="mb-1 text-fg-3">{icon}</div>}
    <div className="text-sm text-fg-2">{title}</div>
    {hint && <div className="max-w-[36ch] text-xs text-fg-3">{hint}</div>}
  </div>
)
