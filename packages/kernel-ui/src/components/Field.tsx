/**
 * Field — the label/hint/error wrapper Input and Select share.
 *
 * Kept separate so a capability building a bespoke control still gets the same
 * label, hint, error and aria wiring as the primitives, rather than
 * reimplementing it slightly differently.
 */

import type { ReactNode } from 'react'

import { cx } from './cx.js'

export interface FieldProps {
  readonly id: string
  readonly label?: ReactNode
  readonly hint?: ReactNode
  readonly error?: ReactNode
  readonly required?: boolean
  readonly className?: string
  readonly children: ReactNode
}

export function hintId(id: string): string {
  return `${id}-hint`
}

export function errorId(id: string): string {
  return `${id}-error`
}

/**
 * The `aria-describedby` value a control inside a Field should carry.
 * Exported so bespoke controls stay accessible without copying the logic.
 */
export function describedBy(
  id: string,
  options: { hint?: unknown; error?: unknown },
): string | undefined {
  const ids: string[] = []
  if (options.hint !== undefined && options.hint !== null) ids.push(hintId(id))
  if (options.error !== undefined && options.error !== null) ids.push(errorId(id))
  return ids.length === 0 ? undefined : ids.join(' ')
}

export function Field({
  id,
  label,
  hint,
  error,
  required = false,
  className,
  children,
}: FieldProps) {
  return (
    <div className={cx('fui-field', className)}>
      {label === undefined ? null : (
        <label className="fui-field__label" htmlFor={id}>
          {label}
          {required ? (
            <span className="fui-field__required" aria-hidden="true">
              *
            </span>
          ) : null}
        </label>
      )}
      {children}
      {hint === undefined || error !== undefined ? null : (
        <span className="fui-field__hint" id={hintId(id)}>
          {hint}
        </span>
      )}
      {error === undefined ? null : (
        <span className="fui-field__error" id={errorId(id)} role="alert">
          {error}
        </span>
      )}
    </div>
  )
}
