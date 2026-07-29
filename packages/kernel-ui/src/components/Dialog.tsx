'use client'

/**
 * Dialog — a modal, built on the native `<dialog>` element.
 *
 * Client component: it needs `showModal()`/`close()` and focus restoration.
 * Using the platform element gets the top layer, the backdrop, focus trapping
 * and Escape handling without shipping a focus-trap library.
 */

import { useEffect, useId, useRef, type ReactNode } from 'react'

import { cx } from './cx.js'

export interface DialogProps {
  readonly open: boolean
  readonly onClose: () => void
  readonly title: ReactNode
  readonly description?: ReactNode
  readonly footer?: ReactNode
  /** Escape and backdrop clicks do not close. For destructive confirmations. */
  readonly dismissible?: boolean
  readonly className?: string
  readonly children?: ReactNode
}

export function Dialog({
  open,
  onClose,
  title,
  description,
  footer,
  dismissible = true,
  className,
  children,
}: DialogProps) {
  const ref = useRef<HTMLDialogElement | null>(null)
  const titleId = useId()
  const descriptionId = useId()

  useEffect(() => {
    const node = ref.current
    if (node === null) return
    if (open && !node.open) node.showModal()
    if (!open && node.open) node.close()
  }, [open])

  useEffect(() => {
    const node = ref.current
    if (node === null) return
    const handleCancel = (event: Event) => {
      event.preventDefault()
      if (dismissible) onClose()
    }
    const handleClose = () => {
      if (open) onClose()
    }
    node.addEventListener('cancel', handleCancel)
    node.addEventListener('close', handleClose)
    return () => {
      node.removeEventListener('cancel', handleCancel)
      node.removeEventListener('close', handleClose)
    }
  }, [dismissible, onClose, open])

  return (
    <dialog
      ref={ref}
      className={cx('fui-dialog', className)}
      aria-labelledby={titleId}
      aria-describedby={description === undefined ? undefined : descriptionId}
      onClick={(event) => {
        // A click on the backdrop lands on the dialog element itself.
        if (dismissible && event.target === ref.current) onClose()
      }}
    >
      <header className="fui-dialog__header">
        <div>
          <h2 className="fui-dialog__title" id={titleId}>
            {title}
          </h2>
          {description === undefined ? null : (
            <p className="fui-card__description" id={descriptionId}>
              {description}
            </p>
          )}
        </div>
        {dismissible ? (
          <button
            type="button"
            className="fui-button fui-button--ghost fui-button--sm"
            onClick={onClose}
          >
            <span className="fui-visually-hidden">Close</span>
            <span aria-hidden="true">×</span>
          </button>
        ) : null}
      </header>
      <div className="fui-dialog__body">{children}</div>
      {footer === undefined ? null : <footer className="fui-dialog__footer">{footer}</footer>}
    </dialog>
  )
}
