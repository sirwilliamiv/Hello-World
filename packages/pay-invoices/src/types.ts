import type { Money } from '@forge/kernel-money'

export type InvoiceStatus = 'open' | 'part_paid' | 'paid' | 'void'

export interface InvoiceRef {
  readonly id: string
}

export interface InvoiceLineInput {
  readonly description: string
  /** Whole units. Use `quantityMilli` for fractional quantities. */
  readonly quantity?: number
  /** Integer thousandths of a unit, so 2.5 hours is 2500 and no float exists. */
  readonly quantityMilli?: number
  readonly unitAmount: Money
  readonly taxAmount?: Money
  readonly metadata?: Readonly<Record<string, string>>
}

export interface InvoiceInput {
  readonly customerId: string
  readonly lines: readonly InvoiceLineInput[]
  /** Defaults to the configured legal entity. */
  readonly legalEntity?: string
  readonly issuedAt?: Date
  /** Overrides the computed due date entirely. */
  readonly dueAt?: Date
  /** Overrides the configured `payment_terms_days` for this invoice. */
  readonly paymentTermsDays?: number
  readonly currency?: string
  readonly metadata?: Readonly<Record<string, string>>
}

export interface InvoiceLine {
  readonly id: string
  readonly invoiceId: string
  readonly position: number
  readonly description: string
  readonly quantityMilli: number
  readonly unitAmount: Money
  readonly amount: Money
  readonly tax: Money
  readonly metadata: Readonly<Record<string, string>>
}

export interface Invoice {
  readonly id: string
  readonly legalEntity: string
  readonly period: string
  readonly sequence: number
  readonly number: string
  readonly customerId: string
  readonly subtotal: Money
  readonly tax: Money
  readonly total: Money
  readonly paid: Money
  readonly credited: Money
  readonly outstanding: Money
  readonly status: InvoiceStatus
  readonly issuedAt: Date
  readonly dueAt: Date
  readonly voidedAt: Date | null
  readonly documentTemplate: string | null
  readonly documentTemplateVersion: string | null
  readonly metadata: Readonly<Record<string, string>>
  readonly lines: readonly InvoiceLine[]
}

export interface Receipt {
  readonly id: string
  readonly invoiceId: string
  readonly chargeId: string
  readonly amount: Money
  readonly issuedAt: Date
  readonly documentTemplateVersion: string | null
}

export interface CreditNote {
  readonly id: string
  readonly invoiceId: string
  readonly amount: Money
  readonly reason: string
  readonly refundId: string | null
  readonly issuedAt: Date
}

/** What kernel.events hands a subscriber. */
export interface EventEnvelope<P = unknown> {
  readonly name: string
  readonly payload: P
  readonly id?: string
  readonly contractVersion?: number
}

export interface ApplyPaymentResult {
  readonly applied: boolean
  readonly reason?: 'already_applied' | 'no_matching_invoice' | 'invoice_void'
  readonly invoice?: Invoice
  readonly receipt?: Receipt
}
