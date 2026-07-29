'use client'

/**
 * Toast.
 *
 * Client component with a provider and a hook. Mounted once by AppShell, so a
 * capability calls `useToast()` and never has to place a region itself — which
 * is the whole point of a shell: a capability contributes content, not layout.
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

import { cx } from './cx.js'

export type ToastTone = 'info' | 'success' | 'warning' | 'danger'

export interface ToastOptions {
  readonly title: string
  readonly body?: string
  readonly tone?: ToastTone
  /** Milliseconds. 0 keeps it until dismissed. Default 5000. */
  readonly duration?: number
}

export interface ToastItem extends ToastOptions {
  readonly id: string
}

export interface ToastApi {
  show(options: ToastOptions): string
  dismiss(id: string): void
  readonly toasts: readonly ToastItem[]
}

const ToastContext = createContext<ToastApi | null>(null)

/**
 * Throws when used outside the provider rather than degrading silently: a
 * notification that never appears is a bug that survives to production.
 */
export function useToast(): ToastApi {
  const api = useContext(ToastContext)
  if (api === null) {
    throw new Error(
      'useToast() must be used inside <ToastProvider>. AppShell mounts one; ' +
        'a component rendered outside the shell must mount its own.',
    )
  }
  return api
}

let counter = 0

export function ToastProvider({ children }: { readonly children: ReactNode }) {
  const [toasts, setToasts] = useState<readonly ToastItem[]>([])

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])

  const show = useCallback(
    (options: ToastOptions): string => {
      counter += 1
      const id = `toast-${counter}`
      setToasts((current) => [...current, { ...options, id }])
      const duration = options.duration ?? 5000
      if (duration > 0) setTimeout(() => dismiss(id), duration)
      return id
    },
    [dismiss],
  )

  const api = useMemo<ToastApi>(() => ({ show, dismiss, toasts }), [show, dismiss, toasts])

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastRegion toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  )
}

export function ToastRegion({
  toasts,
  onDismiss,
}: {
  readonly toasts: readonly ToastItem[]
  readonly onDismiss: (id: string) => void
}) {
  return (
    <div className="fui-toast-region" role="region" aria-label="Notifications">
      {toasts.map((toast) => (
        <Toast key={toast.id} {...toast} onDismiss={() => onDismiss(toast.id)} />
      ))}
    </div>
  )
}

export interface ToastProps extends ToastOptions {
  readonly onDismiss?: () => void
}

export function Toast({ title, body, tone = 'info', onDismiss }: ToastProps) {
  return (
    <div
      className={cx('fui-toast', `fui-toast--${tone}`)}
      role={tone === 'danger' ? 'alert' : 'status'}
      aria-live={tone === 'danger' ? 'assertive' : 'polite'}
    >
      <div>
        <div className="fui-toast__title">{title}</div>
        {body === undefined ? null : <div className="fui-toast__body">{body}</div>}
      </div>
      {onDismiss === undefined ? null : (
        <button
          type="button"
          className="fui-button fui-button--ghost fui-button--sm"
          onClick={onDismiss}
        >
          <span className="fui-visually-hidden">Dismiss</span>
          <span aria-hidden="true">×</span>
        </button>
      )}
    </div>
  )
}
