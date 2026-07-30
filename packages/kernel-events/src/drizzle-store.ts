/**
 * The Postgres-backed event store.
 *
 * Wired at boot by the product: `configureEventBus({ store: new DrizzleEventStore(db) })`.
 * The bus semantics live in bus.ts and are identical whichever store is in use.
 */

import { and, desc, eq, gte, isNull, type SQL } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

import { deadLetters, events } from './schema.js'
import type { DeadLetterQuery, EventQuery, EventStore } from './store.js'
import type { DeadLetterRecord, EventEnvelope } from './types.js'

export type EventsDatabase = PostgresJsDatabase<Record<string, never>>

export class DrizzleEventStore implements EventStore {
  constructor(private readonly db: EventsDatabase) {}

  async append(event: EventEnvelope): Promise<void> {
    await this.db.insert(events).values({
      id: event.id,
      name: event.name,
      contractVersion: event.contractVersion,
      payload: event.payload,
      source: event.source ?? null,
      actor: event.actor ?? null,
      tenantId: event.tenantId ?? null,
      correlationId: event.correlationId ?? null,
      causationId: event.causationId ?? null,
      occurredAt: event.occurredAt,
    })
  }

  async list(query: EventQuery = {}): Promise<EventEnvelope[]> {
    const filters: SQL[] = []
    if (query.name !== undefined) filters.push(eq(events.name, query.name))
    if (query.since !== undefined) filters.push(gte(events.occurredAt, query.since))

    const rows = await this.db
      .select()
      .from(events)
      .where(filters.length === 0 ? undefined : and(...filters))
      .orderBy(desc(events.occurredAt))
      .limit(query.limit ?? 100)

    return rows.map(toEnvelope)
  }

  async get(id: string): Promise<EventEnvelope | undefined> {
    const rows = await this.db.select().from(events).where(eq(events.id, id)).limit(1)
    const row = rows[0]
    return row === undefined ? undefined : toEnvelope(row)
  }

  async recordDeadLetter(record: DeadLetterRecord): Promise<void> {
    await this.db.insert(deadLetters).values({
      id: record.id,
      eventId: record.eventId,
      eventName: record.eventName,
      contractVersion: record.contractVersion,
      consumer: record.consumer,
      subscriptionId: record.subscriptionId,
      payload: record.payload,
      error: record.error,
      stack: record.stack ?? null,
      attempts: record.attempts,
      failedAt: record.failedAt,
      replayedAt: record.replayedAt ?? null,
    })
  }

  async listDeadLetters(query: DeadLetterQuery = {}): Promise<DeadLetterRecord[]> {
    const filters: SQL[] = []
    if (query.eventName !== undefined) filters.push(eq(deadLetters.eventName, query.eventName))
    if (query.consumer !== undefined) filters.push(eq(deadLetters.consumer, query.consumer))
    if (query.unreplayedOnly !== false) filters.push(isNull(deadLetters.replayedAt))

    const rows = await this.db
      .select()
      .from(deadLetters)
      .where(filters.length === 0 ? undefined : and(...filters))
      .orderBy(desc(deadLetters.failedAt))
      .limit(query.limit ?? 100)

    return rows.map((row) => ({
      id: row.id,
      eventId: row.eventId,
      eventName: row.eventName,
      contractVersion: row.contractVersion,
      consumer: row.consumer,
      subscriptionId: row.subscriptionId,
      payload: row.payload,
      error: row.error,
      stack: row.stack ?? undefined,
      attempts: row.attempts,
      failedAt: row.failedAt,
      replayedAt: row.replayedAt,
    }))
  }

  async markDeadLetterReplayed(id: string, replayedAt: Date): Promise<void> {
    await this.db.update(deadLetters).set({ replayedAt }).where(eq(deadLetters.id, id))
  }
}

function toEnvelope(row: {
  id: string
  name: string
  contractVersion: number
  payload: unknown
  source: string | null
  actor: string | null
  tenantId: string | null
  correlationId: string | null
  causationId: string | null
  occurredAt: Date
}): EventEnvelope {
  return {
    id: row.id,
    name: row.name,
    contractVersion: row.contractVersion,
    payload: row.payload,
    occurredAt: row.occurredAt,
    ...(row.source === null ? {} : { source: row.source }),
    actor: row.actor,
    tenantId: row.tenantId,
    correlationId: row.correlationId,
    causationId: row.causationId,
  }
}
