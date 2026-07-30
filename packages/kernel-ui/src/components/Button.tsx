/**
 * Button.
 *
 * A server component: it renders a `<button>` and nothing else. A button that
 * needs an `onClick` lives inside a client component, which makes this module
 * client too — that is a property of the importer, not a reason to put
 * `'use client'` here and pull the whole design system across the boundary.
 */

import type { ButtonHTMLAttributes, ReactNode } from 'react'

import { cx } from './cx.js'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md' | 'lg'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant
  readonly size?: ButtonSize
  readonly fullWidth?: boolean
  readonly loading?: boolean
  readonly children?: ReactNode
}

export function Button({
  variant = 'secondary',
  size = 'md',
  fullWidth = false,
  loading = false,
  className,
  disabled,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      className={cx(
        'fui-button',
        `fui-button--${variant}`,
        `fui-button--${size}`,
        fullWidth && 'fui-button--block',
        className,
      )}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
    >
      {children}
    </button>
  )
}
