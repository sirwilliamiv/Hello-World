import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * A validator for the subset of JSON Schema the catalog's event payload
 * declarations use: `type: object`, `required`, and `properties` whose `type` is
 * a string or a list of strings.
 *
 * The point is to test event payloads against the CATALOG rather than against a
 * copy of the catalog. A publisher whose payload drifts from its declaration
 * fails here, which is validation check 8 enforced at the runtime layer.
 */

export interface PayloadSchema {
  type?: string
  required?: string[]
  properties?: Record<string, { type?: string | string[] }>
}

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..', '..', '..')

export function loadCapability(relativePath: string): Record<string, unknown> {
  const file = path.join(repoRoot, relativePath)
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
}

export function publishedPayloadSchema(
  capability: Record<string, unknown>,
  eventName: string,
): PayloadSchema {
  const publishes = capability['publishes'] as { name: string; payload: PayloadSchema }[]
  const found = publishes.find((p) => p.name === eventName)
  if (found === undefined) {
    throw new Error(`${String(capability['id'])} does not declare an event ${eventName}`)
  }
  return found.payload
}

function typeOfValue(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (Number.isInteger(value)) return 'integer'
  return typeof value
}

function typeMatches(declared: string, actual: string): boolean {
  if (declared === actual) return true
  if (declared === 'number' && actual === 'integer') return true
  return false
}

/** Returns the list of violations; empty means the payload satisfies the schema. */
export function validateAgainstSchema(schema: PayloadSchema, payload: unknown): string[] {
  const problems: string[] = []
  if ((schema.type ?? 'object') !== 'object') return ['only object schemas are supported']
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return ['payload is not an object']
  }
  const record = payload as Record<string, unknown>

  for (const key of schema.required ?? []) {
    if (!(key in record)) problems.push(`missing required property '${key}'`)
  }

  for (const [key, value] of Object.entries(record)) {
    const declared = schema.properties?.[key]
    if (declared === undefined) {
      problems.push(`property '${key}' is not declared in the published contract`)
      continue
    }
    if (declared.type === undefined) continue
    const allowed = Array.isArray(declared.type) ? declared.type : [declared.type]
    const actual = typeOfValue(value)
    if (!allowed.some((t) => typeMatches(t, actual))) {
      problems.push(`property '${key}' is ${actual}, contract declares ${allowed.join('|')}`)
    }
  }

  return problems
}
