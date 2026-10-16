import type { ButtonHTMLAttributes, FC } from 'react'
import clsx from 'clsx'

export type ButtonProps = {
  variant?: 'primary' | 'ghost' | 'danger'
  size?: 'sm' | 'md'
} & ButtonHTMLAttributes<HTMLButtonElement>

const variants = {
  primary: 'bg-accent text-accent-fg border-transparent hover:brightness-110 active:brightness-95',
  ghost: 'bg-transparent text-fg-2 border-border hover:bg-surface-2 hover:text-fg hover:border-border-strong',
  danger: 'bg-transparent text-down border-border hover:bg-down/10 hover:border-down/50',
}

const sizes = {
  sm: 'h-6 px-2 text-xs gap-1',
  md: 'h-7 px-3 text-sm gap-1.5',
}

export const Button: FC<ButtonProps> = ({ variant = 'ghost', size = 'md', className, type = 'button', ...rest }) => (
  <button
    type={type}
    className={clsx(
      'inline-flex shrink-0 items-center justify-center rounded-md border font-medium whitespace-nowrap select-none',
      'transition-colors duration-100 disabled:pointer-events-none disabled:opacity-40',
      variants[variant],
      sizes[size],
      className,
    )}
    {...rest}
  />
)
