'use client'

/**
 * Sheet — an edge-anchored panel.
 *
 * Client component. Used by kernel.admin for entity detail and edit without
 * losing the list behind it, which is the interaction an admin actually wants
 * when working through a filtered set of rows.
 */

import { useEffect, useId, type ReactNode } from 'react'

import { cx } from './cx.js'

export interface SheetProps {
  readonly open: boolean
  readonly onClose: () => void
  readonly title: ReactNode
  readonly side?: 'start' | 'end'
  readonly footer?: ReactNode
  readonly className?: string
  readonly children?: ReactNode
}

export function Sheet({
  open,
  onClose,
  title,
  side = 'end',
  footer,
  className,
  children,
}: SheetProps) {
  const titleId = useId()

  useEffect(() => {
    if (!open) return
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose, open])

  if (!open) return null

  return (
    <div className={cx('fui-sheet', side === 'start' && 'fui-sheet--start', className)}>
      <button
        type="button"
        className="fui-sheet__scrim"
        aria-label="Close"
        onClick={onClose}
      />
      <div className="fui-sheet__panel" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="fui-sheet__header">
          <h2 className="fui-card__title" id={titleId}>
            {title}
          </h2>
          <button
            type="button"
            className="fui-button fui-button--ghost fui-button--sm"
            onClick={onClose}
          >
            <span className="fui-visually-hidden">Close</span>
            <span aria-hidden="true">×</span>
          </button>
        </header>
        <div className="fui-sheet__body">{children}</div>
        {footer === undefined ? null : <footer className="fui-card__footer">{footer}</footer>}
      </div>
    </div>
  )
}
