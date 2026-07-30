import type { Money } from '@forge/kernel-money'

export type Provider = 'stripe'

export type CaptureMethod = 'automatic' | 'manual'

export type ChargeStatus = 'succeeded' | 'failed' | 'requires_capture'

/** A customer this product already knows about (kernel.identity `User.id`). */
export interface CustomerRef {
  readonly id: string
  readonly email?: string
  /** Stripe customer id, if one has already been created for this user. */
  readonly providerCustomerId?: string
}

export interface ChargeRef {
  readonly id: string
}

export interface ChargeOptions {
  /** A `PaymentMethod.id` owned by this capability, not a raw provider handle. */
  readonly paymentMethodId?: string
  readonly description?: string
  /**
   * Supplied to Stripe so a retried request cannot double-charge. Defaults to a
   * value derived from customer + amount + invoice.
   */
  readonly idempotencyKey?: string
  /** Links the charge to a pay.invoices invoice; travels in the event metadata. */
  readonly invoiceId?: string
  readonly metadata?: Readonly<Record<string, string>>
  readonly captureMethod?: CaptureMethod
  readonly statementDescriptor?: string
}

export interface Charge {
  readonly id: string
  readonly customerId: string
  readonly paymentMethodId: string | null
  readonly amount: Money
  readonly status: ChargeStatus
  readonly provider: Provider
  /** Opaque provider reference (Stripe PaymentIntent id). Never card data. */
  readonly externalId: string
  readonly invoiceId: string | null
  readonly statementDescriptor: string | null
  readonly failureReason: string | null
  readonly declineCode: string | null
  readonly metadata: Readonly<Record<string, string>>
  readonly createdAt: Date
}

export interface Refund {
  readonly id: string
  readonly chargeId: string
  readonly amount: Money
  readonly reason: string | null
  readonly provider: Provider
  readonly externalId: string
  readonly createdAt: Date
}

export interface PaymentMethod {
  readonly id: string
  readonly customerId: string
  readonly provider: Provider
  /** Opaque provider handle, e.g. `pm_1NxABC…`. Never a PAN. */
  readonly providerRef: string
  readonly brand: string | null
  /** Display-only last four digits. Never the full number. */
  readonly last4: string | null
  readonly expMonth: number | null
  readonly expYear: number | null
  readonly isDefault: boolean
  readonly createdAt: Date
}

/** Data handed to the receipt customisation slot when a charge receipt renders. */
export interface ChargeReceipt {
  readonly chargeId: string
  readonly customerId: string
  readonly amount: Money
  readonly paidAt: Date
  readonly reference: string
  readonly lines: readonly ChargeReceiptLine[]
  readonly footer: string | null
  readonly metadata: Readonly<Record<string, string>>
}

export interface ChargeReceiptLine {
  readonly label: string
  readonly amount: Money
}
