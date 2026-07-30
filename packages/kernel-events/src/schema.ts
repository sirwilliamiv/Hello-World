/**
 * Drizzle table definitions for the entities kernel.events owns.
 *
 * `events` and `dead_letters` are written by this capability alone. `events` is
 * append-only — replay and audit both depend on it — which the repository layer
 * in @forge/kernel-data enforces for anything that goes through it, and which
 * this capability upholds directly because it writes the log itself.
 */

import { sql } from 'drizzle-orm'
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'

export const events = pgTable(
  'events',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    name: varchar('name', { length: 200 }).notNull(),
    contractVersion: integer('contract_version').notNull(),
    payload: jsonb('payload').notNull(),
    source: varchar('source', { length: 100 }),
    actor: text('actor'),
    tenantId: uuid('tenant_id'),
    correlationId: uuid('correlation_id'),
    causationId: uuid('causation_id'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('events_name_occurred_at_idx').on(table.name, table.occurredAt),
    index('events_correlation_id_idx').on(table.correlationId),
  ],
)

/**
 * Resolved subscriptions, derived from the `consumes` declarations in the
 * resolved graph. Persisted so that the admin surface and `forge` can answer
 * "who is listening to this event" without re-resolving the catalog.
 */
export const subscriptions = pgTable('subscriptions', {
  id: uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  pattern: varchar('pattern', { length: 200 }).notNull(),
  consumer: varchar('consumer', { length: 100 }).notNull(),
  handler: varchar('handler', { length: 200 }).notNull(),
  contractVersions: jsonb('contract_versions').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

/** Handler failures retained for inspection and replay. */
export const deadLetters = pgTable(
  'dead_letters',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    eventId: uuid('event_id').notNull(),
    eventName: varchar('event_name', { length: 200 }).notNull(),
    contractVersion: integer('contract_version').notNull(),
    consumer: varchar('consumer', { length: 100 }).notNull(),
    subscriptionId: varchar('subscription_id', { length: 100 }).notNull(),
    payload: jsonb('payload').notNull(),
    error: text('error').notNull(),
    stack: text('stack'),
    attempts: integer('attempts').notNull().default(1),
    failedAt: timestamp('failed_at', { withTimezone: true }).notNull().defaultNow(),
    replayedAt: timestamp('replayed_at', { withTimezone: true }),
  },
  (table) => [index('dead_letters_event_name_idx').on(table.eventName, table.failedAt)],
)

export type EventRow = typeof events.$inferSelect
export type SubscriptionRow = typeof subscriptions.$inferSelect
export type DeadLetterRow = typeof deadLetters.$inferSelect
