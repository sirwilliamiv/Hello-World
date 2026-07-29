import {
  bigint,
  boolean,
  index,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

/**
 * Drizzle schema for the three tables pay.card owns.
 *
 * The schema is TypeScript that composes across packages (ARCHITECTURE.md
 * section 14.1); the migrations under `migrations/` are hand-written SQL and are
 * the authority on the shipped DDL. `drizzle-kit` diffing is deliberately not
 * used to author them.
 *
 * Note what is absent: there is no column here for a card number, a CVC, or an
 * expiry paired with a number. `providerRef` and `externalId` are opaque handles.
 */

export const paymentMethod = pgTable(
  'payment_method',
  {
    id: text('id').primaryKey(),
    customerId: text('customer_id').notNull(),
    provider: text('provider').notNull().default('stripe'),
    /** Opaque provider handle, e.g. `pm_1NxABC…`. */
    providerRef: text('provider_ref').notNull(),
    brand: text('brand'),
    /** Display-only. The CHECK constraint in the migration bounds it to 4 digits. */
    last4: text('last4'),
    expMonth: smallint('exp_month'),
    expYear: smallint('exp_year'),
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    detachedAt: timestamp('detached_at', { withTimezone: true }),
  },
  (t) => ({
    providerRefKey: uniqueIndex('payment_method_provider_ref_key').on(t.provider, t.providerRef),
    customerIdx: index('payment_method_customer_id_idx').on(t.customerId),
  }),
)

/** Append-only. Corrections are refunds, never edits. */
export const charge = pgTable(
  'charge',
  {
    id: text('id').primaryKey(),
    customerId: text('customer_id').notNull(),
    paymentMethodId: text('payment_method_id'),
    /** Integer minor units. Never a float. */
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    currency: text('currency').notNull(),
    status: text('status').notNull(),
    provider: text('provider').notNull().default('stripe'),
    /** Stripe PaymentIntent id — opaque, and the webhook idempotency key. */
    externalId: text('external_id').notNull(),
    invoiceId: text('invoice_id'),
    statementDescriptor: text('statement_descriptor'),
    failureReason: text('failure_reason'),
    declineCode: text('decline_code'),
    metadata: jsonb('metadata').$type<Record<string, string>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    externalIdKey: uniqueIndex('charge_external_id_key').on(t.provider, t.externalId),
    customerIdx: index('charge_customer_id_idx').on(t.customerId),
    invoiceIdx: index('charge_invoice_id_idx').on(t.invoiceId),
  }),
)

/** Append-only. */
export const refund = pgTable(
  'refund',
  {
    id: text('id').primaryKey(),
    chargeId: text('charge_id').notNull(),
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    currency: text('currency').notNull(),
    reason: text('reason'),
    provider: text('provider').notNull().default('stripe'),
    externalId: text('external_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    externalIdKey: uniqueIndex('refund_external_id_key').on(t.provider, t.externalId),
    chargeIdx: index('refund_charge_id_idx').on(t.chargeId),
  }),
)

export const tables = { paymentMethod, charge, refund } as const
