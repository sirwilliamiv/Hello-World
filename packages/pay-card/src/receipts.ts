import { requirePaymentsRuntime } from './config.js'
import { money } from './money.js'
import type { Charge, ChargeReceipt } from './types.js'

/**
 * The charge-level receipt, and the point at which the `receiptCustomization`
 * slot runs.
 *
 * Note the division of labour with pay.invoices: when both capabilities are
 * present, `pay.card enhances pay.invoices` and the invoice receipt (the
 * `Receipt` entity, owned by pay.invoices) is issued there in response to
 * `payment.succeeded`. What lives here is the receipt for a charge that is not
 * against an invoice — an ad-hoc payment — plus the customisation hook the spec
 * attaches to pay.card.
 */

export function defaultChargeReceipt(charge: Charge): ChargeReceipt {
  return {
    chargeId: charge.id,
    customerId: charge.customerId,
    amount: charge.amount,
    paidAt: charge.createdAt,
    reference: charge.externalId,
    lines: [
      {
        label: charge.metadata['description'] ?? 'Payment',
        amount: charge.amount,
      },
    ],
    footer: null,
    metadata: charge.metadata,
  }
}

export async function buildChargeReceipt(charge: Charge): Promise<ChargeReceipt> {
  const rt = requirePaymentsRuntime()
  const receipt = defaultChargeReceipt(charge)
  if (rt.slots.receiptCustomization === undefined) return receipt
  const customised = await rt.slots.receiptCustomization({ receipt, charge, proceed: () => receipt })
  return customised ?? receipt
}

/** Convenience for a slot that wants to append a line without rebuilding the object. */
export function withReceiptLine(
  receipt: ChargeReceipt,
  label: string,
  amountMinor: number,
  currency: string,
): ChargeReceipt {
  return {
    ...receipt,
    lines: [...receipt.lines, { label, amount: money(amountMinor, currency) }],
  }
}
