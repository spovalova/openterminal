import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement> & { size?: number }

function base({ size = 14, ...rest }: IconProps) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    ...rest,
  }
}

export const PencilIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M11.5 2.5l2 2L5 13H3v-2z" />
  </svg>
)
export const RefreshIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M13 8a5 5 0 1 1-1.5-3.6" />
    <path d="M13 2.5v3h-3" />
  </svg>
)
export const ExpandIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M9 3h4v4M7 13H3V9M13 3L9 7M3 13l4-4" />
  </svg>
)
export const CloseIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </svg>
)
export const PlusIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M8 3v10M3 8h10" />
  </svg>
)
export const ChevronIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M6 3.5L10.5 8 6 12.5" />
  </svg>
)
export const ArrowUpIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" />
  </svg>
)
export const StopIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor" stroke="none" />
  </svg>
)
export const ExternalIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M7 3H3v10h10V9M9 3h4v4M13 3L7 9" />
  </svg>
)
export const AlertIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M8 2.5l6 11H2z" />
    <path d="M8 6.5v3M8 12h.01" />
  </svg>
)
