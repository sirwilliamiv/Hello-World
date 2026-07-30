/**
 * zod schemas derived from an entity's declared fields.
 *
 * The manifest declares field types and constraints once; this turns them into
 * the validation the admin form and the admin API both use, so there is no
 * second copy to drift. A field type added to the manifest schema in
 * `schemas/manifest.schema.json` needs one case here and nothing else.
 */

import { z } from 'zod'

import type { AdminField, AdminFormView } from './resolve.js'

/** Coerce a FormData string into the field's type before validating. */
function base(field: AdminField): z.ZodTypeAny {
  switch (field.control) {
    case 'checkbox':
      // An unchecked box is absent from FormData; a checked one is "on".
      return z.preprocess(
        (v) => v === true || v === 'on' || v === 'true',
        z.boolean(),
      )
    case 'number':
      return z.preprocess(
        (v) => (v === '' || v === undefined ? undefined : Number(v)),
        field.type === 'integer' ? z.number().int() : z.number(),
      )
    case 'money':
      // Minor units. §14.1: floating point currency is a defect, so the value
      // must be an integer number of the smallest unit.
      return z.preprocess(
        (v) => (v === '' || v === undefined ? undefined : Number(v)),
        z.number().int(),
      )
    case 'date':
    case 'datetime':
      return z.preprocess(
        (v) => (v === '' || v === undefined ? undefined : new Date(String(v))),
        z.date(),
      )
    case 'email':
      return z.string().email()
    case 'url':
      return z.string().url()
    case 'json':
      return z.preprocess((v) => {
        if (typeof v !== 'string') return v
        try {
          return JSON.parse(v) as unknown
        } catch {
          return v
        }
      }, z.unknown())
    case 'select':
      return field.options === undefined || field.options.length === 0
        ? z.string()
        : z.enum(field.options as [string, ...string[]])
    case 'textarea':
    case 'tel':
    case 'file':
    case 'reference':
    case 'references':
    case 'text':
    default:
      return z.string()
  }
}

/** The schema for one field, with required/optional applied. */
export function fieldSchema(field: AdminField): z.ZodTypeAny {
  const schema = base(field)
  if (field.required) {
    // An empty string must fail a required text field; zod's `.min(1)` is the
    // only thing that distinguishes "" from "not provided" for FormData.
    return schema instanceof z.ZodString ? schema.min(1, 'Required') : schema
  }
  return schema.optional().or(z.literal('').transform(() => undefined))
}

/** The schema for a whole create/edit form. */
export function formSchema(view: AdminFormView): z.ZodType<Record<string, unknown>> {
  const shape: Record<string, z.ZodTypeAny> = {}
  for (const field of view.fields) shape[field.name] = fieldSchema(field)
  return z.object(shape).passthrough() as unknown as z.ZodType<Record<string, unknown>>
}
