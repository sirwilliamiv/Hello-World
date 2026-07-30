import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

/**
 * Drizzle schema for the five tables pay.invoices owns. The hand-written SQL in
 * `migrations/` is the authority on the shipped DDL (ARCHITECTURE.md section 14.1).
 */

/**
 * The per-legal-entity counter. Not a Postgres SEQUENCE, on purpose: `nextval`
 * does not roll back, so a failed invoice insert would burn a number.
 */
export const invoiceSequence = pgTable('invoice_sequence', {
  legalEntity: text('legal_entity').notNull(),
  period: text('period').notNull(),
  lastValue: bigint('last_value', { mode: 'number' }).notNull().default(0),
})

export const invoice = pgTable(
  'invoice',
  {
    id: text('id').primaryKey(),
    legalEntity: text('legal_entity').notNull(),
    period: text('period').notNull(),
    sequenceValue: bigint('sequence_value', { mode: 'number' }).notNull(),
    number: text('number').notNull(),
    customerId: text('customer_id').notNull(),
    currency: text('currency').notNull(),
    subtotalMinor: bigint('subtotal_minor', { mode: 'number' }).notNull(),
    taxMinor: bigint('tax_minor', { mode: 'number' }).notNull().default(0),
    totalMinor: bigint('total_minor', { mode: 'number' }).notNull(),
    paidMinor: bigint('paid_minor', { mode: 'number' }).notNull().default(0),
    creditedMinor: bigint('credited_minor', { mode: 'number' }).notNull().default(0),
    status: text('status').notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    documentTemplate: text('document_template'),
    documentTemplateVersion: text('document_template_version'),
    metadata: jsonb('metadata').$type<Record<string, string>>().notNull().default({}),
  },
  (t) => ({
    numberKey: uniqueIndex('invoice_number_key').on(t.legalEntity, t.number),
    sequenceKey: uniqueIndex('invoice_sequence_key').on(t.legalEntity, t.period, t.sequenceValue),
    customerIdx: index('invoice_customer_id_idx').on(t.customerId),
    dueIdx: index('invoice_status_due_at_idx').on(t.status, t.dueAt),
  }),
)

export const invoiceLine = pgTable(
  'invoice_line',
  {
    id: text('id').primaryKey(),
    invoiceId: text('invoice_id').notNull(),
    position: integer('position').notNull(),
    description: text('description').notNull(),
    /** Integer thousandths of a unit, so 2.5 hours is 2500 and no float exists. */
    quantityMilli: bigint('quantity_milli', { mode: 'number' }).notNull().default(1000),
    unitAmountMinor: bigint('unit_amount_minor', { mode: 'number' }).notNull(),
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    taxMinor: bigint('tax_minor', { mode: 'number' }).notNull().default(0),
    metadata: jsonb('metadata').$type<Record<string, string>>().notNull().default({}),
  },
  (t) => ({
    positionKey: uniqueIndex('invoice_line_position_key').on(t.invoiceId, t.position),
  }),
)

/**
 * Append-only. The unique index on (invoice_id, charge_id) is the idempotency key
 * for payment application: a redelivered `payment.succeeded` conflicts with it and
 * applies nothing.
 */
export const receipt = pgTable(
  'receipt',
  {
    id: text('id').primaryKey(),
    invoiceId: text('invoice_id').notNull(),
    chargeId: text('charge_id').notNull(),
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    currency: text('currency').notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    documentTemplateVersion: text('document_template_version'),
  },
  (t) => ({
    appliedOnce: uniqueIndex('receipt_payment_applied_once').on(t.invoiceId, t.chargeId),
    invoiceIdx: index('receipt_invoice_id_idx').on(t.invoiceId),
  }),
)

/** Append-only. Corrections are credit notes, never edits to an issued invoice. */
export const creditNote = pgTable(
  'credit_note',
  {
    id: text('id').primaryKey(),
    invoiceId: text('invoice_id').notNull(),
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    currency: text('currency').notNull(),
    reason: text('reason').notNull(),
    refundId: text('refund_id'),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    refundOnce: uniqueIndex('credit_note_refund_applied_once').on(t.invoiceId, t.refundId),
    invoiceIdx: index('credit_note_invoice_id_idx').on(t.invoiceId),
  }),
)

export const tables = { invoiceSequence, invoice, invoiceLine, receipt, creditNote } as const
