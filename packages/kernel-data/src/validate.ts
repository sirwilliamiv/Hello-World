/**
 * Field validation, derived from the entity's declared fields.
 *
 * Declared constraints only. Anything client-specific belongs in the
 * customValidator slot, which runs alongside this.
 */

import { z } from 'zod'

import type { EntityDefinition, FieldDefinition, WritableValues } from './types.js'

/**
 * A money value: integer minor units plus a currency, matching @forge/kernel-money's
 * wire form.
 *
 * This is the check the money capability's summary asks for — "the repository
 * layer rejects a float bound to a money column". A bare number is refused too:
 * a money column holding 10.5 is ambiguous between $10.50 and 10.5 cents, and
 * every real incident of this kind started with someone assuming one of them.
 */
const moneyValue = z.object({
  amountMinor: z.number().int({ message: 'money amounts are integer minor units, not a decimal' }),
  currency: z.string().regex(/^[A-Z]{3}$/, 'currency must be an ISO 4217 alphabetic code'),
})

function schemaForField(field: FieldDefinition): z.ZodTypeAny {
  switch (field.type) {
    case 'string':
    case 'text':
      return z.string()
    case 'number':
      return z.number().finite()
    case 'integer':
      return z.number().int()
    case 'boolean':
      return z.boolean()
    case 'date':
      return z.union([z.date(), z.string().datetime()])
    case 'uuid':
    case 'reference':
      return z.string().uuid()
    case 'money':
      return moneyValue
    case 'json':
      return z.unknown()
    default:
      // An unrecognised declared type is stored opaquely rather than rejected:
      // the manifest may name a type this kernel version does not know yet.
      return z.unknown()
  }
}

const cache = new Map<string, z.ZodTypeAny>()

function schemaForEntity(entity: EntityDefinition, partial: boolean): z.ZodTypeAny {
  const key = `${entity.name}:${partial ? 'partial' : 'full'}`
  const cached = cache.get(key)
  if (cached !== undefined) return cached

  const shape: Record<string, z.ZodTypeAny> = {}
  for (const field of entity.fields) {
    const base = schemaForField(field)
    const required = field.required === true && !partial
    shape[field.name] = required ? base : base.optional().nullable()
  }

  // Undeclared keys pass through: capability-owned entities define their columns
  // in their own Drizzle schema rather than in the registry's `fields`, which is
  // only populated for manifest-declared client entities.
  const schema = z.object(shape).passthrough()
  cache.set(key, schema)
  return schema
}

export interface ValidationOutcome {
  readonly values: WritableValues
  readonly issues: readonly string[]
}

export function validateValues(
  entity: EntityDefinition,
  values: WritableValues,
  operation: 'create' | 'update',
): ValidationOutcome {
  const result = schemaForEntity(entity, operation === 'update').safeParse(values)
  if (result.success) return { values: result.data as WritableValues, issues: [] }

  return {
    values,
    issues: result.error.issues.map(
      (issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`,
    ),
  }
}

/** Test and hot-reload helper: the schema cache keys on entity name. */
export function clearValidationCache(): void {
  cache.clear()
}
