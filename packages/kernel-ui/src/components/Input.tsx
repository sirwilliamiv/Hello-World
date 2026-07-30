/** Input and Textarea. Server components — an uncontrolled input needs no JS. */

import type { InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react'

import { Field, describedBy } from './Field.js'
import { cx } from './cx.js'

interface FieldChrome {
  readonly label?: ReactNode
  readonly hint?: ReactNode
  readonly error?: ReactNode
}

export interface InputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'>,
    FieldChrome {
  readonly id: string
}

export function Input({ id, label, hint, error, className, required, ...rest }: InputProps) {
  return (
    <Field
      id={id}
      {...(label === undefined ? {} : { label })}
      {...(hint === undefined ? {} : { hint })}
      {...(error === undefined ? {} : { error })}
      required={required === true}
    >
      <input
        {...rest}
        id={id}
        required={required}
        className={cx('fui-input', className)}
        aria-invalid={error === undefined ? undefined : true}
        aria-describedby={describedBy(id, { hint, error })}
      />
    </Field>
  )
}

export interface TextareaProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id'>,
    FieldChrome {
  readonly id: string
}

export function Textarea({
  id,
  label,
  hint,
  error,
  className,
  required,
  ...rest
}: TextareaProps) {
  return (
    <Field
      id={id}
      {...(label === undefined ? {} : { label })}
      {...(hint === undefined ? {} : { hint })}
      {...(error === undefined ? {} : { error })}
      required={required === true}
    >
      <textarea
        {...rest}
        id={id}
        required={required}
        className={cx('fui-textarea', className)}
        aria-invalid={error === undefined ? undefined : true}
        aria-describedby={describedBy(id, { hint, error })}
      />
    </Field>
  )
}
