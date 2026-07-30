import { requirePaymentsRuntime } from './config.js'
import { chargeFromRow, refundFromRow } from './charge.js'
import { paymentMethodFromRow } from './payment-methods.js'
import type { Charge, PaymentMethod, Refund } from './types.js'

/**
 * The export and deletion handlers named in the spec's `owns[].privacy` blocks.
 * Validation check 10 requires them to exist when `data.privacy` is enabled.
 *
 * The strategies differ on purpose:
 *  - PaymentMethod is deleted, because it is a live provider reference;
 *  - Charge and Refund are anonymised, not deleted, because they are financial
 *    records and the ledger has to stay intact.
 */

export async function exportPaymentMethods(customerId: string): Promise<PaymentMethod[]> {
  const rt = requirePaymentsRuntime()
  const rows = await rt.store.transaction((tx) => tx.listPaymentMethods(customerId))
  return rows.map(paymentMethodFromRow)
}

export async function exportCharges(customerId: string): Promise<Charge[]> {
  const rt = requirePaymentsRuntime()
  const rows = await rt.store.transaction((tx) => tx.listChargesForCustomer(customerId))
  return rows.map(chargeFromRow)
}

export async function exportRefunds(customerId: string): Promise<Refund[]> {
  const rt = requirePaymentsRuntime()
  const rows = await rt.store.transaction((tx) => tx.listRefundsForCustomer(customerId))
  return rows.map(refundFromRow)
}

/**
 * Deletion strategy `delete`, declared as `detachPaymentMethods`. Re-exported
 * here so every handler named in the spec's privacy blocks resolves from one
 * module.
 */
export { detachPaymentMethods } from './payment-methods.js'

/**
 * Deletion strategy `anonymize`. Rewrites the subject reference and drops
 * metadata; amounts, currencies, and provider references are untouched so the
 * ledger still reconciles.
 */
export async function anonymizeCharges(customerId: string): Promise<number> {
  const rt = requirePaymentsRuntime()
  const anonymousId = `anon_${rt.newId('sub')}`
  return rt.store.transaction((tx) => tx.anonymiseCustomerCharges(customerId, anonymousId))
}

/** Refunds hang off charges, so anonymising the charge anonymises the refund's subject. */
export async function anonymizeRefunds(customerId: string): Promise<number> {
  return anonymizeCharges(customerId)
}
