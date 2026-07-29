import { describe, expect, it } from 'vitest'
import { Money } from '@forge/kernel-money'
import { issue } from '../invoice.js'
import { applyPayment, creditOnRefund } from '../payments.js'
import { SQL } from '../db/postgres.js'
import {
  bus,
  paymentRefundedEvent,
  paymentSucceededEvent,
  setupInvoices,
} from '../testing/harness.js'
import { loadCapability, publishedPayloadSchema, validateAgainstSchema } from '../testing/json-schema.js'

/**
 * Contract test with pay.card, consumer side:
 * "a payment succeeds against an open invoice → the invoice is marked paid, a
 *  receipt is issued, and a redelivered payment.succeeded does not double-apply".
 *
 * pay.card is not imported here — it is not in pay.invoices' `requires`. The
 * fixtures are built to pay.card's DECLARED `payment.succeeded` contract, and the
 * first test asserts they satisfy the schema in the catalog, so the pair is
 * tested against the contract rather than against an implementation detail.
 */

const payCard = loadCapability('catalog/pay/pay.card.capability.json')
const payInvoices = loadCapability('catalog/pay/pay.invoices.capability.json')

const line = (minor: number) => ({ description: 'Consulting', unitAmount: Money.of(minor, 'USD') })

describe('contract: pay.invoices × pay.card (consumer side)', () => {
  it('consumes a payload that satisfies pay.card’s published contract', () => {
    const event = paymentSucceededEvent({ chargeId: 'chg_1', invoiceId: 'inv_1', amountMinor: 100 })
    const schema = publishedPayloadSchema(payCard, 'payment.succeeded')
    expect(validateAgainstSchema(schema, event.payload)).toEqual([])
  })

  it('marks the invoice paid and issues a receipt', async () => {
    const h = await setupInvoices()
    const invoice = await issue({ customerId: 'user_1', lines: [line(25_000)] })

    const result = await applyPayment(
      paymentSucceededEvent({ chargeId: 'chg_1', invoiceId: invoice.id, amountMinor: 25_000 }),
    )

    expect(result.applied).toBe(true)
    expect(result.invoice?.status).toBe('paid')
    expect(result.invoice?.paid.amountMinor).toBe(25_000)
    expect(result.invoice?.outstanding.amountMinor).toBe(0)
    expect(result.receipt?.chargeId).toBe('chg_1')
    expect(h.store.state.receipts).toHaveLength(1)

    const paid = bus.published('invoice.paid')
    expect(paid).toHaveLength(1)
    expect(
      validateAgainstSchema(publishedPayloadSchema(payInvoices, 'invoice.paid'), paid[0]?.payload),
    ).toEqual([])
  })

  it('does NOT double-apply a redelivered payment.succeeded', async () => {
    const h = await setupInvoices()
    const invoice = await issue({ customerId: 'user_1', lines: [line(25_000)] })
    const event = paymentSucceededEvent({
      chargeId: 'chg_1',
      invoiceId: invoice.id,
      amountMinor: 25_000,
    })

    const first = await applyPayment(event)
    const second = await applyPayment(event)
    const third = await applyPayment(event)

    expect(first.applied).toBe(true)
    expect(second).toEqual({ applied: false, reason: 'already_applied' })
    expect(third).toEqual({ applied: false, reason: 'already_applied' })

    const stored = h.store.state.invoices[0]
    expect(stored?.paidMinor).toBe(25_000)
    expect(stored?.status).toBe('paid')
    expect(h.store.state.receipts).toHaveLength(1)
    // Exactly one invoice.paid: a consumer downstream cannot double-count either.
    expect(bus.published('invoice.paid')).toHaveLength(1)
  })

  it('does not double-apply under CONCURRENT redelivery', async () => {
    const h = await setupInvoices()
    const invoice = await issue({ customerId: 'user_1', lines: [line(25_000)] })
    const event = paymentSucceededEvent({
      chargeId: 'chg_1',
      invoiceId: invoice.id,
      amountMinor: 25_000,
    })

    const results = await Promise.all(Array.from({ length: 20 }, () => applyPayment(event)))

    expect(results.filter((r) => r.applied)).toHaveLength(1)
    expect(h.store.state.receipts).toHaveLength(1)
    expect(h.store.state.invoices[0]?.paidMinor).toBe(25_000)
    expect(bus.published('invoice.paid')).toHaveLength(1)
  })

  it('applies two DIFFERENT charges against one invoice', async () => {
    const h = await setupInvoices()
    const invoice = await issue({ customerId: 'user_1', lines: [line(30_000)] })

    const a = await applyPayment(
      paymentSucceededEvent({ chargeId: 'chg_a', invoiceId: invoice.id, amountMinor: 10_000 }),
    )
    const b = await applyPayment(
      paymentSucceededEvent({ chargeId: 'chg_b', invoiceId: invoice.id, amountMinor: 20_000 }),
    )

    expect(a.invoice?.status).toBe('part_paid')
    expect(b.invoice?.status).toBe('paid')
    expect(h.store.state.receipts).toHaveLength(2)
    expect(h.store.state.invoices[0]?.paidMinor).toBe(30_000)
  })

  it('ignores a payment that is not against an invoice', async () => {
    const h = await setupInvoices()
    const result = await applyPayment(paymentSucceededEvent({ chargeId: 'chg_x', amountMinor: 500 }))
    expect(result).toEqual({ applied: false, reason: 'no_matching_invoice' })
    expect(h.store.state.receipts).toHaveLength(0)
  })

  it('ignores a payment against a void invoice', async () => {
    const h = await setupInvoices()
    const invoice = await issue({ customerId: 'user_1', lines: [line(5_000)] })
    const { voidInvoice } = await import('../invoice.js')
    await voidInvoice({ id: invoice.id }, 'issued in error')

    const result = await applyPayment(
      paymentSucceededEvent({ chargeId: 'chg_1', invoiceId: invoice.id, amountMinor: 5_000 }),
    )
    expect(result).toEqual({ applied: false, reason: 'invoice_void' })
    expect(h.store.state.receipts).toHaveLength(0)
  })
})

describe('contract: refunds credit the invoice, idempotently', () => {
  it('issues one credit note however often payment.refunded is redelivered', async () => {
    const h = await setupInvoices()
    const invoice = await issue({ customerId: 'user_1', lines: [line(25_000)] })
    await applyPayment(
      paymentSucceededEvent({ chargeId: 'chg_1', invoiceId: invoice.id, amountMinor: 25_000 }),
    )

    const refundEvent = paymentRefundedEvent({
      refundId: 'rfd_1',
      chargeId: 'chg_1',
      amountMinor: 10_000,
      reason: 'partial return',
    })

    const first = await creditOnRefund(refundEvent)
    const again = await Promise.all([
      creditOnRefund(refundEvent),
      creditOnRefund(refundEvent),
      creditOnRefund(refundEvent),
    ])

    expect(first.applied).toBe(true)
    expect(again.every((r) => !r.applied)).toBe(true)
    expect(again.every((r) => r.reason === 'already_applied')).toBe(true)
    expect(h.store.state.creditNotes).toHaveLength(1)
    expect(h.store.state.invoices[0]?.creditedMinor).toBe(10_000)
  })

  it('ignores a refund for a charge that never paid an invoice', async () => {
    await setupInvoices()
    const result = await creditOnRefund(
      paymentRefundedEvent({ refundId: 'rfd_9', chargeId: 'chg_unknown', amountMinor: 100 }),
    )
    expect(result).toEqual({ applied: false, reason: 'no_matching_invoice' })
  })
})

describe('the idempotency gate is a database constraint', () => {
  it('inserts the receipt with ON CONFLICT DO NOTHING on (invoice_id, charge_id)', () => {
    expect(SQL.insertReceipt).toMatch(/ON CONFLICT \(invoice_id, charge_id\) DO NOTHING/)
    expect(SQL.insertReceipt).toMatch(/RETURNING \*/)
    expect(SQL.insertReceipt).not.toMatch(/SELECT/i)
  })

  it('inserts the credit note with ON CONFLICT DO NOTHING on (invoice_id, refund_id)', () => {
    expect(SQL.insertCreditNote).toMatch(/ON CONFLICT \(invoice_id, refund_id\) DO NOTHING/)
  })

  it('declares the pair in both capability specifications', () => {
    const ours = (payInvoices['tests'] as { contract: { with: string }[] }).contract
    const theirs = (payCard['tests'] as { contract: { with: string }[] }).contract
    expect(ours.map((c) => c.with)).toContain('pay.card')
    expect(theirs.map((c) => c.with)).toContain('pay.invoices')
  })

  it('uses the handler names the specification declares', () => {
    const consumes = payInvoices['consumes'] as { name: string; handler: string }[]
    expect(consumes.find((c) => c.name === 'payment.succeeded')?.handler).toBe('applyPayment')
    expect(consumes.find((c) => c.name === 'payment.refunded')?.handler).toBe('creditOnRefund')
  })
})
