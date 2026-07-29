/** Card. Server component. */

import type { ReactNode } from 'react'

import { cx } from './cx.js'

export interface CardProps {
  readonly title?: ReactNode
  readonly description?: ReactNode
  /** Rendered on the right of the header — usually a Button or a link. */
  readonly actions?: ReactNode
  readonly footer?: ReactNode
  readonly className?: string
  /** Skip the body padding, for a Table that should meet the card edges. */
  readonly flush?: boolean
  readonly children?: ReactNode
}

export function Card({
  title,
  description,
  actions,
  footer,
  className,
  flush = false,
  children,
}: CardProps) {
  const hasHeader = title !== undefined || description !== undefined || actions !== undefined

  return (
    <section className={cx('fui-card', className)}>
      {hasHeader ? (
        <header className="fui-card__header">
          <div>
            {title === undefined ? null : <h2 className="fui-card__title">{title}</h2>}
            {description === undefined ? null : (
              <p className="fui-card__description">{description}</p>
            )}
          </div>
          {actions === undefined ? null : <div>{actions}</div>}
        </header>
      ) : null}
      <div className={flush ? undefined : 'fui-card__body'}>{children}</div>
      {footer === undefined ? null : <footer className="fui-card__footer">{footer}</footer>}
    </section>
  )
}
