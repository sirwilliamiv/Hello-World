'use client'

/**
 * The generated create/edit form.
 *
 * The zod schema is derived from the entity's field declarations, so the
 * validation an admin sees is the validation the manifest declared — not a
 * second, hand-maintained copy of it.
 */

import { Button, Form, Input, Select, Textarea } from '@forge/kernel-ui'

import { formSchema } from '../schema.js'
import type { AdminField, AdminFormView } from '../resolve.js'
import type { Row } from '../ports/repository.js'

export interface EntityFormViewProps {
  readonly view: AdminFormView
  readonly initial?: Row
  readonly onSubmit: (values: Record<string, unknown>) => Promise<void> | void
  readonly onCancel?: () => void
}

const INPUT_TYPE: Partial<Record<AdminField['control'], string>> = {
  text: 'text',
  number: 'number',
  money: 'number',
  date: 'date',
  datetime: 'datetime-local',
  email: 'email',
  tel: 'tel',
  url: 'url',
  file: 'file',
  checkbox: 'checkbox',
  reference: 'text',
}

export function EntityFormView({ view, initial = {}, onSubmit, onCancel }: EntityFormViewProps) {
  const schema = formSchema(view)

  return (
    <Form
      schema={schema}
      onSubmit={(values) => onSubmit(values as Record<string, unknown>)}
      actions={(state) => (
        <>
          {onCancel === undefined ? null : (
            <Button type="button" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          )}
          <Button type="submit" variant="primary" loading={state.submitting}>
            {view.mode === 'create' ? `Create ${view.label}` : 'Save changes'}
          </Button>
        </>
      )}
    >
      {(state) => (
        <>
          {view.fields.map((field) => {
            const id = `${state.formId}-${field.name}`
            const error = state.errors[field.name]
            const defaultValue = initial[field.name]

            if (field.control === 'select' || field.control === 'references') {
              return (
                <Select
                  key={field.name}
                  id={id}
                  name={field.name}
                  label={field.label}
                  required={field.required}
                  {...(field.help === undefined ? {} : { hint: field.help })}
                  {...(error === undefined ? {} : { error })}
                  {...(field.required ? {} : { placeholder: '—' })}
                  defaultValue={defaultValue === undefined ? undefined : String(defaultValue)}
                  options={(field.options ?? []).map((value) => ({ value, label: value }))}
                />
              )
            }

            if (field.control === 'textarea' || field.control === 'json') {
              return (
                <Textarea
                  key={field.name}
                  id={id}
                  name={field.name}
                  label={field.label}
                  required={field.required}
                  {...(field.help === undefined ? {} : { hint: field.help })}
                  {...(error === undefined ? {} : { error })}
                  defaultValue={
                    defaultValue === undefined
                      ? undefined
                      : field.control === 'json'
                        ? JSON.stringify(defaultValue, null, 2)
                        : String(defaultValue)
                  }
                />
              )
            }

            return (
              <Input
                key={field.name}
                id={id}
                name={field.name}
                type={INPUT_TYPE[field.control] ?? 'text'}
                label={field.label}
                required={field.required}
                {...(field.help === undefined ? {} : { hint: field.help })}
                {...(error === undefined ? {} : { error })}
                {...(field.control === 'checkbox'
                  ? { defaultChecked: defaultValue === true }
                  : {
                      defaultValue:
                        defaultValue === undefined ? undefined : String(defaultValue),
                    })}
              />
            )
          })}
        </>
      )}
    </Form>
  )
}
