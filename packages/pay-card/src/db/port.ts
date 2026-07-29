import type { ChargeStatus } from '../types.js'

/**
 * The narrow persistence port for pay.card.
 *
 * Everything the capability needs from the database is expressed here in terms of
 * its own three tables. The production implementation (`./postgres.ts`) runs
 * parameterised SQL through @forge/kernel-data's transaction handle; the test
 * implementation (`../testing/memory-store.ts`) reproduces the same transaction
 * and unique-constraint semantics in memory.
 *
 * Keeping the port this narrow is what lets the idempotency guarantees be stated
 * as properties of two methods (`insertChargeIfAbsent`, `insertRefundIfAbsent`)
 * rather than as a convention spread across the package.
 */

export interface ChargeRow {
  id: string
  customerId: string
  paymentMethodId: string | null
  amountMinor: number
  currency: string
  status: ChargeStatus
  provider: string
  externalId: string
  invoiceId: string | null
  statementDescriptor: string | null
  failureReason: string | null
  declineCode: string | null
  metadata: Record<string, string>
  createdAt: Date
}

export interface RefundRow {
  id: string
  chargeId: string
  amountMinor: number
  currency: string
  reason: string | null
  provider: string
  externalId: string
  createdAt: Date
}

export interface PaymentMethodRow {
  id: string
  customerId: string
  provider: string
  providerRef: string
  brand: string | null
  last4: string | null
  expMonth: number | null
  expYear: number | null
  isDefault: boolean
  createdAt: Date
  detachedAt: Date | null
}

export interface PaymentTx {
  /**
   * `INSERT … ON CONFLICT (provider, external_id) DO NOTHING RETURNING *`.
   * Returns `null` when the row already existed — which is how a redelivered
   * Stripe webhook becomes a no-op instead of a second charge.
   */
  insertChargeIfAbsent(row: ChargeRow): Promise<ChargeRow | null>
  findChargeById(id: string): Promise<ChargeRow | null>
  findChargeByExternalId(provider: string, externalId: string): Promise<ChargeRow | null>
  listChargesForCustomer(customerId: string): Promise<ChargeRow[]>

  /** As `insertChargeIfAbsent`, keyed on (provider, external_id). */
  insertRefundIfAbsent(row: RefundRow): Promise<RefundRow | null>
  listRefundsForCharge(chargeId: string): Promise<RefundRow[]>
  listRefundsForCustomer(customerId: string): Promise<RefundRow[]>

  upsertPaymentMethod(row: PaymentMethodRow): Promise<PaymentMethodRow>
  findPaymentMethodById(id: string): Promise<PaymentMethodRow | null>
  listPaymentMethods(customerId: string): Promise<PaymentMethodRow[]>
  /** Hard delete: the privacy strategy for PaymentMethod is `delete`. */
  deletePaymentMethods(customerId: string): Promise<PaymentMethodRow[]>

  /**
   * Privacy strategy for Charge and Refund is `anonymize`, not `delete`, so the
   * ledger stays intact. Returns the number of rows affected.
   */
  anonymiseCustomerCharges(customerId: string, anonymousId: string): Promise<number>
}

export interface PaymentStore {
  /**
   * Runs `fn` inside one database transaction. A throw rolls the transaction
   * back; nothing `fn` wrote is visible to another transaction until it commits.
   */
  transaction<T>(fn: (tx: PaymentTx) => Promise<T>): Promise<T>
}
