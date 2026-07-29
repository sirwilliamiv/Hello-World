import type { Money } from '@forge/kernel-money'
import type { InvoiceInput, InvoiceLine } from './types.js'

/**
 * Slot types for pay.invoices, matching `slots` in
 * catalog/pay/pay.invoices.capability.json.
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
  /** The number the configured token scheme would produce. */
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
  /** The due date the configured terms would produce. */
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
