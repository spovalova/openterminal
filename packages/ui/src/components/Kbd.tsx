import type { FC, PropsWithChildren } from 'react'
import clsx from 'clsx'

export const Kbd: FC<PropsWithChildren<{ className?: string }>> = ({ children, className }) => (
  <kbd
    className={clsx(
      'inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-sm border border-border-strong bg-surface-2 px-1',
      'font-mono text-[10px] leading-none text-fg-2',
      className,
    )}
  >
    {children}
  </kbd>
)
