import type { FC, MouseEvent } from 'react'
import clsx from 'clsx'
import { CloseIcon, PlusIcon } from './icons.js'

export type TabsProps = {
  items: { id: string; label: string }[]
  activeId?: string
  onSelect: (id: string) => void
  onClose?: (id: string) => void
  onNew?: () => void
  className?: string
}

/** Top workspace tab bar. Dense, 36px tall, active tab underlined with the accent. */
export const Tabs: FC<TabsProps> = ({ items, activeId, onSelect, onClose, onNew, className }) => (
  <div role="tablist" className={clsx('flex h-9 items-stretch border-b border-border bg-bg', className)}>
    <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto">
      {items.map((it) => {
        const active = it.id === activeId
        return (
          <div
            key={it.id}
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onSelect(it.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onSelect(it.id)
              }
            }}
            onAuxClick={(e: MouseEvent) => {
              if (e.button === 1 && onClose) onClose(it.id)
            }}
            className={clsx(
              'group relative flex max-w-[200px] min-w-[96px] cursor-default items-center gap-1 border-r border-border pr-1 pl-3 text-sm select-none',
              active ? 'bg-surface text-fg' : 'text-fg-2 hover:bg-surface hover:text-fg',
            )}
          >
            <span className="min-w-0 flex-1 truncate">{it.label}</span>
            {onClose ? (
              <button
                type="button"
                aria-label={`Close ${it.label}`}
                title="Close"
                onClick={(e) => {
                  e.stopPropagation()
                  onClose(it.id)
                }}
                className={clsx(
                  'flex size-5 shrink-0 items-center justify-center rounded-sm text-fg-3 hover:bg-surface-3 hover:text-fg',
                  active ? 'opacity-70' : 'opacity-0 group-hover:opacity-70 focus-visible:opacity-100',
                )}
              >
                <CloseIcon size={12} />
              </button>
            ) : (
              <span className="size-5 shrink-0" />
            )}
            {active && <span aria-hidden className="absolute inset-x-0 bottom-0 h-px bg-accent" />}
          </div>
        )
      })}
      {onNew && (
        <button
          type="button"
          aria-label="New workspace"
          title="New workspace"
          onClick={onNew}
          className="flex w-9 shrink-0 items-center justify-center text-fg-3 hover:bg-surface hover:text-fg"
        >
          <PlusIcon />
        </button>
      )}
    </div>
  </div>
)
