import { describe, expect, it } from 'vitest'
import { Money } from '@forge/kernel-money'
import { charge } from '../charge.js'
import { stripeWebhookHandler } from '../webhook.js'
import {
  bus,
  paymentIntentSucceededEvent,
  setupPayments,
  signedWebhookRequest,
} from '../testing/harness.js'
import {
  loadCapability,
  publishedPayloadSchema,
  validateAgainstSchema,
} from '../testing/json-schema.js'

/**
 * Contract test with pay.invoices, publisher side.
 *
 * pay.invoices may not be imported here — it is not in pay.card's `requires`, and
 * the CI import rule forbids it. What pay.card owes the pair is therefore stated
 * in terms of the declared event contract:
 *
 *   1. a charge against an open invoice publishes exactly one `payment.succeeded`
 *      carrying the invoice reference the consumer keys off;
 *   2. the payload satisfies the contract declared in the catalog;
 *   3. a redelivered provider notification for the same movement of money
 *      publishes nothing further, so a consumer that applies every delivery it
 *      receives still cannot double-apply.
 *
 * The consumer side of the same pair lives in
 * packages/pay-invoices/src/__tests__/contract.card.test.ts.
 */

const spec = loadCapability('catalog/pay/pay.card.capability.json')

describe('contract: pay.card × pay.invoices (publisher side)', () => {
  it('carries the invoice reference in the event metadata', async () => {
    setupPayments()
    const result = await charge(Money.of(12_500, 'USD'), { id: 'user_1' }, { invoiceId: 'inv_42' })

    const events = bus.published('payment.succeeded')
    expect(events).toHaveLength(1)
    const payload = events[0]?.payload as { metadata?: Record<string, string> }
    expect(payload.metadata?.['invoice_id']).toBe('inv_42')
    expect(validateAgainstSchema(publishedPayloadSchema(spec, 'payment.succeeded'), payload)).toEqual(
      [],
    )
    expect(result.invoiceId).toBe('inv_42')
  })

  it('publishes payment.succeeded exactly once across provider redelivery', async () => {
    const h = setupPayments()
    const event = paymentIntentSucceededEvent({ metadata: { customer_id: 'user_1', invoice_id: 'inv_42' } })

    // Stripe retries a webhook until it sees a 2xx, and can retry after one.
    for (let i = 0; i < 5; i += 1) {
      const response = await stripeWebhookHandler(signedWebhookRequest(h.stripe, event))
      expect(response.status).toBe(200)
    }

    expect(bus.published('payment.succeeded')).toHaveLength(1)
    expect(h.store.state.charges).toHaveLength(1)
  })

  it('declares the pair in the capability specification', () => {
    const contract = (spec['tests'] as { contract: { with: string }[] }).contract
    expect(contract.map((c) => c.with)).toContain('pay.invoices')
  })
})
