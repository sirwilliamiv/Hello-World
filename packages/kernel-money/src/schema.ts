/**
 * Drizzle table definitions for the entities kernel.money owns.
 *
 * The tables live in the package, not in the client repository, which is what
 * makes a kernel schema change a package version bump plus a shipped migration
 * rather than a merge. The migration SQL is hand-written and reviewed; drizzle-kit
 * is used to inspect and run, never to author (ARCHITECTURE.md 14.1).
 */

import { sql } from 'drizzle-orm'
import {
  boolean,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'

/** ISO 4217 currencies with their minor-unit exponent. Global, not tenant-scoped. */
export const currencies = pgTable('currencies', {
  code: varchar('code', { length: 3 }).primaryKey(),
  name: text('name').notNull(),
  symbol: text('symbol'),
  minorUnits: integer('minor_units').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * Append-only. A historical conversion must stay reproducible after the rate
 * changes, so a new rate is a new row and corrections are new rows too. The
 * repository layer refuses updates and deletes here — see @forge/kernel-data.
 */
export const exchangeRates = pgTable('exchange_rates', {
  id: uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  fromCurrency: varchar('from_currency', { length: 3 }).notNull(),
  toCurrency: varchar('to_currency', { length: 3 }).notNull(),
  /** Exact decimal. numeric, never float — a float rate is a defect. */
  rate: numeric('rate', { precision: 24, scale: 12 }).notNull(),
  asOf: timestamp('as_of', { withTimezone: true }).notNull(),
  source: text('source'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export type CurrencyRow = typeof currencies.$inferSelect
export type ExchangeRateRow = typeof exchangeRates.$inferSelect
