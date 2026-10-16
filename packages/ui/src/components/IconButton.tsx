import type { ButtonHTMLAttributes, FC } from 'react'
import clsx from 'clsx'

export type IconButtonProps = { label: string; active?: boolean } & ButtonHTMLAttributes<HTMLButtonElement>

/** 24px square ghost button. `label` is the accessible name and tooltip; children is the icon. */
export const IconButton: FC<IconButtonProps> = ({ label, active, className, type = 'button', children, ...rest }) => (
  <button
    type={type}
    aria-label={label}
    title={label}
    aria-pressed={active}
    className={clsx(
      'inline-flex size-6 shrink-0 items-center justify-center rounded-sm border border-transparent',
      'text-fg-3 transition-colors duration-100 hover:bg-surface-3 hover:text-fg',
      'disabled:pointer-events-none disabled:opacity-40',
      active && 'bg-surface-3 text-accent',
      className,
    )}
    {...rest}
  >
    {children}
  </button>
)
