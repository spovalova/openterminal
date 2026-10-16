// Stub seam. Replaced by the ui workstream (PLAN.md section 11). Keep the exported names.
import type { ButtonHTMLAttributes, FC, PropsWithChildren, ReactNode } from 'react'
import type { Column, Size, Step } from '@terminal/core'

export type CellFormat = 'text' | 'price' | 'percent' | 'integer' | 'time' | 'date' | 'link'

export const Button: FC<{ variant?: 'primary' | 'ghost' | 'danger'; size?: 'sm' | 'md' } & ButtonHTMLAttributes<HTMLButtonElement>> = () => null
export const IconButton: FC<{ label: string } & ButtonHTMLAttributes<HTMLButtonElement>> = () => null
export const Kbd: FC<PropsWithChildren> = () => null
export const Chip: FC<PropsWithChildren<{ onClick?: () => void; active?: boolean }>> = () => null
export const Tabs: FC<{ items: { id: string; label: string }[]; activeId?: string; onSelect: (id: string) => void; onClose?: (id: string) => void; onNew?: () => void }> = () => null
export const PromptBox: FC<{ value: string; onChange: (v: string) => void; onSubmit: () => void; busy?: boolean; onCancel?: () => void; placeholder?: string; autoFocus?: boolean; className?: string }> = () => null
export const WidgetFrame: FC<PropsWithChildren<{ title: string; size: Size; loading?: boolean; error?: string; empty?: boolean; onEdit?: () => void; onRefresh?: () => void; onExpand?: () => void }>> = () => null
export const DataTable: FC<{ columns: Column[]; rows: unknown[][]; formats?: Record<string, CellFormat>; sort?: { column: string; dir: 'asc' | 'desc' }; onSort?: (column: string) => void }> = () => null
export const Steps: FC<{ steps: Step[]; durationMs: number; defaultOpen?: boolean }> = () => null
export const Skeleton: FC<{ className?: string }> = () => null
export const Spinner: FC = () => null
export const EmptyState: FC<{ title: string; hint?: ReactNode }> = () => null
export const Dialog: FC<PropsWithChildren<{ open: boolean; onClose: () => void; title: string }>> = () => null

export const tokens = {} as Record<string, unknown>
export const chartTheme = {} as Record<string, unknown>
export const seriesPalette: string[] = []
export const UP_COLOR = '#000'
export const DOWN_COLOR = '#000'
