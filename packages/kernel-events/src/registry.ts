/**
 * The event schema registry — the `eventSchemas` registry in the capability spec.
 *
 * Populated from the resolved graph's `publishes` declarations. Everything that
 * needs to know "what events exist in this product" reads it from here rather
 * than from a hardcoded list: the integrate.webhooks subscribable event catalog,
 * the automation.rules trigger list, and the admin event browser are all derived.
 *
 * Publishing an event with no entry here throws. That is the runtime backstop
 * for the CI rule that a capability may only publish what its spec declares.
 */

import { z } from 'zod'

import {
  DuplicateEventSchemaError,
  EventPayloadValidationError,
  UnregisteredEventSchemaError,
} from './errors.js'

export interface EventSchemaRegistration {
  /** Event name, e.g. 'entity.created'. */
  readonly name: string
  /** Integer contract version, versioned independently of the capability. */
  readonly contractVersion: number
  /** Payload validator. Compiled from the JSON Schema in the `publishes` block. */
  readonly schema: z.ZodTypeAny
  /** Capability that publishes it. Shown in the event catalog. */
  readonly publisher?: string
  readonly description?: string
  /** A prior contract version this replaces, emitted alongside for one major cycle. */
  readonly deprecates?: number
}

const byName = new Map<string, Map<number, EventSchemaRegistration>>()

function versionsOf(name: string): Map<number, EventSchemaRegistration> {
  const existing = byName.get(name)
  if (existing !== undefined) return existing
  const created = new Map<number, EventSchemaRegistration>()
  byName.set(name, created)
  return created
}

/**
 * Register a payload schema. Idempotent for an identical registration, so a
 * generated module can be evaluated more than once; a *different* schema at the
 * same contract version throws, because that is a silent contract break.
 */
export function registerEventSchema(registration: EventSchemaRegistration): void {
  const versions = versionsOf(registration.name)
  const existing = versions.get(registration.contractVersion)
  if (existing !== undefined && existing.schema !== registration.schema) {
    throw new DuplicateEventSchemaError(registration.name, registration.contractVersion)
  }
  versions.set(registration.contractVersion, registration)
}

/** The registration for an event, at a specific version or the latest one. */
export function getEventSchema(
  name: string,
  contractVersion?: number,
): EventSchemaRegistration | undefined {
  const versions = byName.get(name)
  if (versions === undefined || versions.size === 0) return undefined
  if (contractVersion !== undefined) return versions.get(contractVersion)
  const latest = Math.max(...versions.keys())
  return versions.get(latest)
}

/** Every contract version registered for an event, ascending. */
export function contractVersionsOf(name: string): number[] {
  return [...(byName.get(name)?.keys() ?? [])].sort((a, b) => a - b)
}

export function hasEventSchema(name: string, contractVersion?: number): boolean {
  return getEventSchema(name, contractVersion) !== undefined
}

/** The whole catalog, sorted by name then version. Drives derived event lists. */
export function listEventSchemas(): EventSchemaRegistration[] {
  return [...byName.values()]
    .flatMap((versions) => [...versions.values()])
    .sort((a, b) =>
      a.name === b.name ? a.contractVersion - b.contractVersion : a.name.localeCompare(b.name),
    )
}

/** Test and hot-reload helper. Not used by generated code. */
export function clearEventSchemas(): void {
  byName.clear()
}

/**
 * Resolve and validate a payload. Throws `UnregisteredEventSchemaError` when the
 * event is unknown and `EventPayloadValidationError` when the payload does not
 * satisfy the registered contract — never returns a partially valid payload.
 */
export function validatePayload(
  name: string,
  payload: unknown,
  contractVersion?: number,
): { registration: EventSchemaRegistration; payload: unknown } {
  const registration = getEventSchema(name, contractVersion)
  if (registration === undefined) {
    throw new UnregisteredEventSchemaError(name, contractVersion)
  }

  const result = registration.schema.safeParse(payload)
  if (!result.success) {
    const issues = result.error.issues.map(
      (issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`,
    )
    throw new EventPayloadValidationError(name, registration.contractVersion, issues)
  }

  return { registration, payload: result.data }
}

/**
 * The registry as a single object, which is the shape the `exposes` entry of
 * kind 'registry' names. Capabilities import `eventSchemas` and contribute to it.
 */
export const eventSchemas = {
  register: registerEventSchema,
  get: getEventSchema,
  has: hasEventSchema,
  list: listEventSchemas,
  versionsOf: contractVersionsOf,
  clear: clearEventSchemas,
} as const
