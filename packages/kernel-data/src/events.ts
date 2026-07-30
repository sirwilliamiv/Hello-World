/**
 * The universal entity events.
 *
 * `entity.created`, `entity.updated`, `entity.deleted` and `entity.restored` are
 * emitted by the repository for every registered entity — capability-owned and
 * client-declared alike. They are the backbone of the system: search indexing,
 * audit logging, webhooks, automation rules and reporting all subscribe to these
 * rather than coupling to individual capabilities, which is why a client entity
 * declared in a manifest gets all five for free.
 *
 * The schemas are registered here, at import time, so that a repository write
 * cannot publish an event the bus has not been told about.
 */

import { publish, registerEventSchema } from '@forge/kernel-events'
import { z } from 'zod'

import { getLogger } from './db.js'
import type { RepositoryContext } from './types.js'

export const ENTITY_EVENT_CONTRACT_VERSION = 1
const SOURCE = 'kernel.data'

const actor = z.string().nullable()

export const entityCreatedPayload = z.object({
  entity: z.string(),
  id: z.string(),
  actor,
  data: z.record(z.unknown()),
})

export const entityUpdatedPayload = z.object({
  entity: z.string(),
  id: z.string(),
  actor,
  before: z.record(z.unknown()),
  after: z.record(z.unknown()),
  changed: z.array(z.string()),
})

export const entityDeletedPayload = z.object({
  entity: z.string(),
  id: z.string(),
  actor,
  soft: z.boolean(),
})

export const entityRestoredPayload = z.object({
  entity: z.string(),
  id: z.string(),
  actor,
})

export type EntityCreatedPayload = z.infer<typeof entityCreatedPayload>
export type EntityUpdatedPayload = z.infer<typeof entityUpdatedPayload>
export type EntityDeletedPayload = z.infer<typeof entityDeletedPayload>
export type EntityRestoredPayload = z.infer<typeof entityRestoredPayload>

/**
 * Register the four schemas. Called at import time; exported so a test that
 * cleared the registry can put them back.
 */
export function registerEntityEventSchemas(): void {
  const common = {
    contractVersion: ENTITY_EVENT_CONTRACT_VERSION,
    publisher: SOURCE,
  } as const

  registerEventSchema({ ...common, name: 'entity.created', schema: entityCreatedPayload })
  registerEventSchema({ ...common, name: 'entity.updated', schema: entityUpdatedPayload })
  registerEventSchema({ ...common, name: 'entity.deleted', schema: entityDeletedPayload })
  registerEventSchema({ ...common, name: 'entity.restored', schema: entityRestoredPayload })
}

registerEntityEventSchemas()

/**
 * Publish an entity lifecycle event.
 *
 * Called after the write has committed. A failure here is logged rather than
 * thrown: the row is already durable, and turning a bus problem into a failed
 * user request would trade a recoverable inconsistency for an unrecoverable one.
 * Handler failures are the bus's problem and are dead-lettered there.
 */
export async function emitEntityEvent(
  name: 'entity.created' | 'entity.updated' | 'entity.deleted' | 'entity.restored',
  payload: EntityCreatedPayload | EntityUpdatedPayload | EntityDeletedPayload | EntityRestoredPayload,
  context: RepositoryContext,
): Promise<void> {
  try {
    await publish(name, payload, {
      source: SOURCE,
      contractVersion: ENTITY_EVENT_CONTRACT_VERSION,
      actor: context.actor ?? null,
      tenantId: context.tenantId ?? null,
      correlationId: context.correlationId ?? null,
    })
  } catch (error) {
    getLogger().error(`failed to publish ${name}`, {
      entity: payload.entity,
      id: payload.id,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/** Field names whose values differ between two rows. Drives `changed`. */
export function changedFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  const changed: string[] = []
  for (const key of keys) {
    if (!equalValues(before[key], after[key])) changed.push(key)
  }
  return changed.sort()
}

function equalValues(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime()
  if (a === b) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  return JSON.stringify(a) === JSON.stringify(b)
}
