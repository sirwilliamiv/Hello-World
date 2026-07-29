/**
 * Select.
 *
 * A native `<select>`, deliberately. kernel.admin renders one of these per
 * enum field and per `ref:` field across every entity in the graph; a custom
 * listbox would multiply the client JavaScript by the size of the client's data
 * model, and would have to reimplement keyboard behaviour the platform already
 * gets right.
 */

import type { ReactNode, SelectHTMLAttributes } from 'react'

import { Field, describedBy } from './Field.js'
import { cx } from './cx.js'

export interface SelectOption {
  readonly value: string
  readonly label: string
  readonly disabled?: boolean
  /** Optional `<optgroup>` label. */
  readonly group?: string
}

export interface SelectProps
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id' | 'children'> {
  readonly id: string
  readonly options: readonly SelectOption[]
  readonly label?: ReactNode
  readonly hint?: ReactNode
  readonly error?: ReactNode
  /** Rendered as an empty-valued first option. */
  readonly placeholder?: string
}

function grouped(
  options: readonly SelectOption[],
): readonly (readonly [string | undefined, readonly SelectOption[]])[] {
  const groups = new Map<string | undefined, SelectOption[]>()
  for (const option of options) {
    const bucket = groups.get(option.group)
    if (bucket === undefined) groups.set(option.group, [option])
    else bucket.push(option)
  }
  return [...groups.entries()]
}

export function Select({
  id,
  options,
  label,
  hint,
  error,
  placeholder,
  className,
  required,
  ...rest
}: SelectProps) {
  return (
    <Field
      id={id}
      {...(label === undefined ? {} : { label })}
      {...(hint === undefined ? {} : { hint })}
      {...(error === undefined ? {} : { error })}
      required={required === true}
    >
      <select
        {...rest}
        id={id}
        required={required}
        className={cx('fui-select', className)}
        aria-invalid={error === undefined ? undefined : true}
        aria-describedby={describedBy(id, { hint, error })}
      >
        {placeholder === undefined ? null : <option value="">{placeholder}</option>}
        {grouped(options).map(([group, items]) =>
          group === undefined ? (
            items.map((option) => (
              <option key={option.value} value={option.value} disabled={option.disabled}>
                {option.label}
              </option>
            ))
          ) : (
            <optgroup key={group} label={group}>
              {items.map((option) => (
                <option key={option.value} value={option.value} disabled={option.disabled}>
                  {option.label}
                </option>
              ))}
            </optgroup>
          ),
        )}
      </select>
    </Field>
  )
}
