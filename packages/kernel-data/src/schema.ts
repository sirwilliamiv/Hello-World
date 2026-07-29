/**
 * Column helpers and the tables kernel.data owns.
 *
 * `managedColumns` and `tenantColumn` are what every other capability's Drizzle
 * schema is built from, so that "every entity has id, revision, timestamps and
 * soft delete" is a shared definition rather than a convention repeated in
 * fifteen packages:
 *
 *     export const charges = pgTable('charges', {
 *       ...managedColumns,
 *       ...tenantColumn,
 *       amountMinor: integer('amount_minor').notNull(),
 *       currency: varchar('currency', { length: 3 }).notNull(),
 *     })
 */

import { sql } from 'drizzle-orm'
import { boolean, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

/** The columns the repository manages on every entity. */
export const managedColumns = {
  id: uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  /** Optimistic-locking counter. Every successful update increments it. */
  revision: integer('revision').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  /** Non-null once soft-deleted. Reads exclude these rows by default. */
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}

/**
 * The organization reference every tenant-scoped entity carries once org.teams
 * is in the graph. The repository binds the predicate; this only holds the value.
 */
export const tenantColumn = {
  organizationId: uuid('organization_id'),
}

/**
 * The applied-migration ledger. Append-only: a row is written when a migration
 * is applied and removed only by an explicit rollback.
 */
export const forgeMigrations = pgTable('forge_migrations', {
  id: text('id').primaryKey(),
  capability: text('capability').notNull(),
  checksum: text('checksum').notNull(),
  rollbackAvailable: boolean('rollback_available').notNull().default(true),
  appliedSerial: integer('applied_serial').notNull(),
  appliedAt: timestamp('applied_at', { withTimezone: true }).notNull().defaultNow(),
})

export type ForgeMigrationRow = typeof forgeMigrations.$inferSelect
