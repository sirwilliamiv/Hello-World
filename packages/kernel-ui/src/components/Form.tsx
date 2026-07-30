'use client'

/**
 * Form.
 *
 * Client component. Validation is a zod schema, because zod is already the
 * boundary type for manifest config and the generated environment schema — one
 * validation vocabulary across the whole product, rather than one per layer.
 *
 * Uses a render prop rather than a field-registration API: the caller keeps
 * ordinary `<Input>`s and reads `errors[name]` off the state it is handed, so a
 * generated form (kernel.admin builds one per entity from the registry) is a
 * plain map over fields with no per-field wiring.
 */

import { useCallback, useId, useState, type FormEvent, type ReactNode } from 'react'

import type { z } from 'zod'

import { cx } from './cx.js'

export interface FormState {
  /** Keyed by field path, e.g. `name` or `address.city`. */
  readonly errors: Readonly<Record<string, string>>
  /** An error that belongs to the form as a whole, not to one field. */
  readonly formError: string | undefined
  readonly submitting: boolean
  readonly formId: string
}

export interface FormProps<Schema extends z.ZodTypeAny> {
  readonly schema: Schema
  readonly onSubmit: (values: z.output<Schema>) => Promise<void> | void
  readonly children: (state: FormState) => ReactNode
  readonly actions?: (state: FormState) => ReactNode
  readonly className?: string
  /** Reset the fields after a successful submit. */
  readonly resetOnSuccess?: boolean
}

/**
 * FormData → a plain object, with repeated keys collected into arrays.
 * Exported because server actions need the same coercion on the other side.
 */
export function formDataToObject(data: FormData): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of data.entries()) {
    const existing = out[key]
    if (existing === undefined) out[key] = value
    else if (Array.isArray(existing)) existing.push(value)
    else out[key] = [existing, value]
  }
  return out
}

/** zod issues → a flat `{ path: message }` map. First message per path wins. */
export function issuesToErrors(error: z.ZodError): Record<string, string> {
  const errors: Record<string, string> = {}
  for (const issue of error.issues) {
    const path = issue.path.join('.')
    if (errors[path] === undefined) errors[path] = issue.message
  }
  return errors
}

export function Form<Schema extends z.ZodTypeAny>({
  schema,
  onSubmit,
  children,
  actions,
  className,
  resetOnSuccess = false,
}: FormProps<Schema>) {
  const formId = useId()
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({})
  const [formError, setFormError] = useState<string | undefined>(undefined)
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      const form = event.currentTarget
      const parsed = schema.safeParse(formDataToObject(new FormData(form)))

      if (!parsed.success) {
        setErrors(issuesToErrors(parsed.error))
        setFormError(undefined)
        return
      }

      setErrors({})
      setFormError(undefined)
      setSubmitting(true)
      try {
        await onSubmit(parsed.data as z.output<Schema>)
        if (resetOnSuccess) form.reset()
      } catch (err) {
        setFormError(err instanceof Error ? err.message : 'Something went wrong.')
      } finally {
        setSubmitting(false)
      }
    },
    [onSubmit, resetOnSuccess, schema],
  )

  const state: FormState = { errors, formError, submitting, formId }

  return (
    <form className={cx('fui-form', className)} onSubmit={handleSubmit} noValidate>
      {formError === undefined ? null : (
        <div className="fui-form__error-summary" role="alert">
          {formError}
        </div>
      )}
      {children(state)}
      {actions === undefined ? null : (
        <div className="fui-form__actions">{actions(state)}</div>
      )}
    </form>
  )
}
