import type { FC } from 'react'
import clsx from 'clsx'

export const Spinner: FC<{ size?: number; className?: string; label?: string }> = ({ size = 14, className, label = 'Loading' }) => (
  <svg
    role="status"
    aria-label={label}
    width={size}
    height={size}
    viewBox="0 0 16 16"
    className={clsx('animate-spin text-fg-2', className)}
  >
    <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" fill="none" />
    <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
  </svg>
)
