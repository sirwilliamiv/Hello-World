import { requireInvoicesRuntime } from './config.js'
import {
  milestoneDuePayload,
  orderPlacedPayload,
  paymentRefundedPayload,
  paymentSucceededPayload,
  publishInvoiceEvent,
} from './events.js'
import { invoiceFromRows, issue } from './invoice.js'
import { money } from './money.js'
import { renderReceipt } from './render.js'
import type {
  ApplyPaymentResult,
  EventEnvelope,
  Invoice,
  InvoiceLineInput,
  Receipt,
} from './types.js'

/**
 * Property 4: payment application is idempotent.
 *
 * Stripe retries webhooks, so `payment.succeeded` WILL arrive more than once for
 * one movement of money. Applying it twice would credit an invoice twice, which
 * is a silent, expensive, hard-to-detect corruption of a financial record.
 *
 * The guard is not a flag and not a "have I seen this before" lookup — both of
 * which race. It is a UNIQUE constraint on (invoice_id, charge_id) over the
 * `receipt` table, taken inside the same transaction that moves the balance:
 *
 *   1. `INSERT INTO receipt … ON CONFLICT (invoice_id, charge_id) DO NOTHING
 *      RETURNING *` — the receipt IS the record that this charge was applied;
 *   2. if it returns no row, the payment was already applied. Return without
 *      touching the balance and without publishing;
 *   3. otherwise update the balance in the same transaction and publish
 *      `invoice.paid` after it commits.
 *
 * Two concurrent deliveries take the same path: the second blocks on the unique
 * index until the first commits, then finds the conflict and does nothing.
 */

/** Resolves which invoice a payment belongs to, from the declared payload. */
function invoiceIdFrom(payload: {
  metadata?: Record<string, string> | undefined
}): string | null {
  return payload.metadata?.['invoice_id'] ?? null
}

export interface ApplyPaymentInput {
  readonly invoiceId: string
  readonly chargeId: string
  readonly amountMinor: number
  readonly currency: string
}

export async function applyPaymentToInvoice(
  input: ApplyPaymentInput,
): Promise<ApplyPaymentResult> {
  const rt = requireInvoicesRuntime()

  const outcome = await rt.store.transaction(async (tx) => {
    const row = await tx.findInvoiceById(input.invoiceId)
    if (row === null) return { applied: false as const, reason: 'no_matching_invoice' as const }
    if (row.status === 'void') return { applied: false as const, reason: 'invoice_void' as const }

    // ── the idempotency gate ──
    const receipt = await tx.insertReceiptIfAbsent({
      id: rt.newId('rcp'),
      invoiceId: row.id,
      chargeId: input.chargeId,
      amountMinor: input.amountMinor,
      currency: input.currency,
      issuedAt: rt.clock(),
      documentTemplateVersion: null,
    })
    if (receipt === null) {
      return { applied: false as const, reason: 'already_applied' as const }
    }

    // Relative, and the status is recomputed in the same statement, so two
    // different charges applied concurrently cannot lose an update.
    const updated = await tx.applyInvoiceDelta(row.id, input.amountMinor, 0)

    return {
      applied: true as const,
      invoice: invoiceFromRows(updated, await tx.listInvoiceLines(updated.id)),
      receipt: {
        id: receipt.id,
        invoiceId: receipt.invoiceId,
        chargeId: receipt.chargeId,
        amount: money(receipt.amountMinor, receipt.currency),
        issuedAt: receipt.issuedAt,
        documentTemplateVersion: receipt.documentTemplateVersion,
      } satisfies Receipt,
    }
  })

  if (!outcome.applied) return outcome

  await publishInvoiceEvent('invoice.paid', {
    invoice_id: outcome.invoice.id,
    paid_minor: input.amountMinor,
    currency: input.currency,
    charge_id: input.chargeId,
  })

  // The receipt document is rendered after commit; a render failure must not
  // unwind a payment that has already been recorded.
  try {
    await renderReceipt(outcome.receipt, outcome.invoice)
  } catch {
    /* the receipt row is durable; the PDF can be regenerated */
  }

  return outcome
}

/**
 * `consumes: payment.succeeded` v1, handler `applyPayment`.
 * Redelivery-safe; see the note at the top of this file.
 */
export async function applyPayment(event: EventEnvelope): Promise<ApplyPaymentResult> {
  const payload = paymentSucceededPayload.parse(event.payload)
  const invoiceId = invoiceIdFrom(payload)
  if (invoiceId === null) {
    // A payment that is not against an invoice — an ad-hoc charge. Not an error.
    return { applied: false, reason: 'no_matching_invoice' }
  }
  return applyPaymentToInvoice({
    invoiceId,
    chargeId: payload.charge_id,
    amountMinor: payload.amount_minor,
    currency: payload.currency.toUpperCase(),
  })
}

export interface CreditOnRefundResult {
  readonly applied: boolean
  readonly reason?: 'already_applied' | 'no_matching_invoice'
  readonly creditNoteId?: string
}

/**
 * `consumes: payment.refunded` v1, handler `creditOnRefund`.
 *
 * Idempotent by the same mechanism, on (invoice_id, refund_id): a redelivered
 * refund cannot issue a second credit note.
 */
export async function creditOnRefund(event: EventEnvelope): Promise<CreditOnRefundResult> {
  const rt = requireInvoicesRuntime()
  const payload = paymentRefundedPayload.parse(event.payload)

  const outcome = await rt.store.transaction(async (tx) => {
    // The receipt written when the payment was applied is what links the refunded
    // charge back to its invoice.
    const row = await tx.findInvoiceByChargeId(payload.charge_id)
    if (row === null) return { applied: false as const, reason: 'no_matching_invoice' as const }

    const note = await tx.insertCreditNoteIfAbsent({
      id: rt.newId('cn'),
      invoiceId: row.id,
      amountMinor: payload.amount_minor,
      currency: payload.currency.toUpperCase(),
      reason: payload.reason ?? 'refund',
      refundId: payload.refund_id,
      issuedAt: rt.clock(),
    })
    if (note === null) return { applied: false as const, reason: 'already_applied' as const }

    await tx.applyInvoiceDelta(row.id, 0, payload.amount_minor)

    return { applied: true as const, creditNoteId: note.id, invoiceId: row.id }
  })

  return outcome.applied
    ? { applied: true, creditNoteId: outcome.creditNoteId }
    : { applied: false, reason: outcome.reason }
}

/**
 * `consumes: milestone.due` v1 (pay.deposits), handler `invoiceMilestone`.
 * Optional in the graph; a no-op when the publisher is absent.
 */
export async function invoiceMilestone(event: EventEnvelope): Promise<Invoice> {
  const payload = milestoneDuePayload.parse(event.payload)
  return issue({
    customerId: payload.customer_id,
    currency: payload.currency.toUpperCase(),
    metadata: { milestone_id: payload.milestone_id },
    lines: [
      {
        description: payload.description ?? `Milestone ${payload.milestone_id}`,
        unitAmount: money(payload.amount_minor, payload.currency.toUpperCase()),
      },
    ],
  })
}

/** `consumes: order.placed` v1 (commerce.catalog), handler `invoiceOrder`. */
export async function invoiceOrder(event: EventEnvelope): Promise<Invoice> {
  const payload = orderPlacedPayload.parse(event.payload)
  const currency = payload.currency.toUpperCase()
  const lines: InvoiceLineInput[] = payload.lines.map((line) => ({
    description: line.description,
    ...(line.quantity === undefined ? {} : { quantity: line.quantity }),
    unitAmount: money(line.unit_amount_minor, currency),
  }))
  return issue({
    customerId: payload.customer_id,
    currency,
    metadata: { order_id: payload.order_id },
    lines,
  })
}
