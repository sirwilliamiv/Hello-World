import type { Money } from '@forge/kernel-money'
import type { InvoiceInput, InvoiceLine } from './types.js'

/**
 * Slot types for pay.invoices, matching `slots` in
 * catalog/pay/pay.invoices.capability.json.
 *
 * The types live in the package so they upgrade with it: a major version that
 * changes a slot signature makes the client's seeded stub fail to compile, which
 * is loud, local and fixable (ARCHITECTURE.md section 4).
 *
 * Every context carries `proceed()`, returning exactly what this capability does
 * with no slot implemented (schemas/capability.schema.json, `$defs.slot.signature`).
 * That is what lets Forge seed a stub that already compiles and already behaves:
 *
 *     export const paymentTerms: PaymentTermsSlot = async (ctx) => ctx.proceed()
 */

export interface NumberingSchemeContext {
  readonly legalEntity: string
  /**
   * The sequence value allocated by the transactional counter. A slot may format
   * it however the client needs, but it may not choose it: the counter is what
   * makes numbering gapless, and the slot never gets to skip or reuse a value.
   */
  readonly sequence: number
  readonly period: string
  readonly issuedAt: Date
  readonly scheme: string
  readonly customerId: string
  /**
   * The number the configured token scheme would produce — what the capability
   * numbers this invoice when no slot is implemented.
   *
   * Deliberately nullary. It closes over the sequence value that
   * `allocateInvoiceNumber` already returned in this transaction, so there is no
   * parameter through which a slot could ask for a different one: `proceed()` can
   * only render the allocated value, never re-allocate, skip, or reuse one.
   */
  proceed(): string
  /** @deprecated Pre-`proceed()` name for the same thing. Use `proceed()`. */
  defaultNumber(): string
}

/**
 * Runs when an invoice number is allocated, inside the insert transaction.
 * Return a string to override the formatted number. The uniqueness of
 * (legal_entity, number) is still a database constraint, so a slot that returns
 * a duplicate fails the insert rather than corrupting the ledger.
 */
export type NumberingSchemeSlot = (ctx: NumberingSchemeContext) => string | Promise<string>

export interface LineItemFormattingContext {
  readonly lines: readonly InvoiceLine[]
  readonly customerId: string
  readonly legalEntity: string
  /**
   * The lines exactly as stored, in position order — what is rendered when no
   * slot is implemented.
   */
  proceed(): readonly InvoiceLine[]
}

/** Runs when invoice lines are rendered. Return the lines to render. */
export type LineItemFormattingSlot = (
  ctx: LineItemFormattingContext,
) => readonly InvoiceLine[] | Promise<readonly InvoiceLine[]>

export interface PaymentTermsContext {
  readonly customerId: string
  readonly issuedAt: Date
  readonly total: Money
  readonly input: InvoiceInput
  /** The configured `payment_terms_days`. */
  readonly defaultDays: number
  /**
   * The due date the configured `payment_terms_days` produces — issuedAt plus
   * `defaultDays`, which is what the capability uses with no slot implemented.
   */
  proceed(): Date
  /** @deprecated Pre-`proceed()` name for the same thing. Use `proceed()`. */
  defaultDueAt(): Date
}

/**
 * Runs when an invoice due date is computed — per-customer net terms, for
 * instance. Return a `Date` or a number of days.
 */
export type PaymentTermsSlot = (
  ctx: PaymentTermsContext,
) => Date | number | Promise<Date | number>

export interface InvoiceSlots {
  readonly numberingScheme?: NumberingSchemeSlot
  readonly lineItemFormatting?: LineItemFormattingSlot
  readonly paymentTerms?: PaymentTermsSlot
}
