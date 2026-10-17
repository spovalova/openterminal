import { useEffect, useRef, type FC, type PropsWithChildren, type ReactNode } from 'react'
import clsx from 'clsx'
import { IconButton } from './IconButton.js'
import { CloseIcon } from './icons.js'

export type DialogProps = PropsWithChildren<{
  open: boolean
  onClose: () => void
  title: string
  /** Footer slot (buttons). */
  footer?: ReactNode
  /** md (default) is a 520px form; wide is for an expanded widget and takes most of the viewport. */
  size?: 'md' | 'wide'
  className?: string
}>

const widthClass: Record<NonNullable<DialogProps['size']>, string> = {
  md: 'w-[min(520px,calc(100vw-32px))]',
  wide: 'w-[min(1200px,calc(100vw-32px))]',
}

/** Native <dialog> shown modally. Escape and backdrop clicks call onClose. */
export const Dialog: FC<DialogProps> = ({ open, onClose, title, footer, size = 'md', className, children }) => {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (open && !el.open) el.showModal()
    else if (!open && el.open) el.close()
  }, [open])

  return (
    <dialog
      ref={ref}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose()
      }}
      className={clsx(
        'm-auto max-h-[calc(100vh-32px)] rounded-lg',
        widthClass[size],
        ' border border-border-strong bg-surface p-0 text-fg shadow-dialog',
        'backdrop:bg-black/60',
        className,
      )}
    >
      <div className="flex max-h-[calc(100vh-32px)] flex-col" onClick={(e) => e.stopPropagation()}>
        <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border pr-1 pl-3">
          <h2 className="min-w-0 flex-1 truncate text-sm font-medium">{title}</h2>
          <IconButton label="Close" onClick={onClose}>
            <CloseIcon />
          </IconButton>
        </header>
        <div className="min-h-0 flex-1 overflow-auto p-3">{children}</div>
        {footer && <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-3 py-2">{footer}</footer>}
      </div>
    </dialog>
  )
}
