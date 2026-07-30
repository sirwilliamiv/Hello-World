import { describe, expect, it, vi } from 'vitest'
import { stripeWebhookHandler } from '../webhook.js'
import {
  bus,
  misSignedWebhookRequest,
  paymentIntentSucceededEvent,
  setupPayments,
  signedWebhookRequest,
  unsignedWebhookRequest,
} from '../testing/harness.js'

describe('smoke: webhook signature is verified', () => {
  it('rejects an unsigned payload with 400 without parsing it', async () => {
    const h = setupPayments()
    const parse = vi.spyOn(JSON, 'parse')

    const response = await stripeWebhookHandler(
      unsignedWebhookRequest(paymentIntentSucceededEvent()),
    )

    expect(response.status).toBe(400)
    // The body was never handed to a parser…
    expect(h.stripe.parsedBodies).toBe(0)
    expect(parse).not.toHaveBeenCalled()
    // …and nothing was written or published.
    expect(h.store.state.charges).toHaveLength(0)
    expect(bus.published()).toHaveLength(0)
    parse.mockRestore()
  })

  it('rejects a mis-signed payload with 400 without parsing it', async () => {
    const h = setupPayments()
    const parse = vi.spyOn(JSON, 'parse')

    const response = await stripeWebhookHandler(
      misSignedWebhookRequest(paymentIntentSucceededEvent()),
    )

    expect(response.status).toBe(400)
    expect(h.stripe.parsedBodies).toBe(0)
    expect(parse).not.toHaveBeenCalled()
    expect(h.store.state.charges).toHaveLength(0)
    parse.mockRestore()
  })

  it('rejects a payload signed with the wrong secret', async () => {
    const h = setupPayments()
    const { FakeStripe } = await import('../testing/fake-stripe.js')
    const attacker = new FakeStripe({ webhookSecret: 'whsec_not_ours' })

    const body = JSON.stringify(paymentIntentSucceededEvent())
    const request = new Request('https://example.test/api/webhooks/stripe', {
      method: 'POST',
      headers: { 'stripe-signature': attacker.sign(body) },
      body,
    })

    expect((await stripeWebhookHandler(request)).status).toBe(400)
    expect(h.stripe.parsedBodies).toBe(0)
  })

  it('rejects a replayed signature outside the tolerance window', async () => {
    const h = setupPayments()
    const body = JSON.stringify(paymentIntentSucceededEvent())
    const stale = Math.floor(Date.now() / 1000) - 60 * 60
    const request = new Request('https://example.test/api/webhooks/stripe', {
      method: 'POST',
      headers: { 'stripe-signature': h.stripe.sign(body, stale) },
      body,
    })

    expect((await stripeWebhookHandler(request)).status).toBe(400)
    expect(h.stripe.parsedBodies).toBe(0)
  })

  it('does not leak the verification failure reason', async () => {
    setupPayments()
    const response = await stripeWebhookHandler(
      misSignedWebhookRequest(paymentIntentSucceededEvent()),
    )
    const text = await response.text()
    expect(text).toBe('invalid webhook signature')
    expect(text).not.toMatch(/whsec/)
    expect(text).not.toMatch(/expected/i)
  })

  it('accepts a correctly signed payload and records the charge', async () => {
    const h = setupPayments()
    const response = await stripeWebhookHandler(
      signedWebhookRequest(h.stripe, paymentIntentSucceededEvent()),
    )

    expect(response.status).toBe(200)
    expect(h.stripe.parsedBodies).toBe(1)
    expect(h.store.state.charges).toHaveLength(1)
    expect(bus.published('payment.succeeded')).toHaveLength(1)
  })
})

describe('webhook redelivery is idempotent', () => {
  it('a redelivered payment_intent.succeeded neither re-inserts nor re-publishes', async () => {
    const h = setupPayments()
    const event = paymentIntentSucceededEvent()

    await stripeWebhookHandler(signedWebhookRequest(h.stripe, event))
    await stripeWebhookHandler(signedWebhookRequest(h.stripe, event))
    await stripeWebhookHandler(signedWebhookRequest(h.stripe, event))

    expect(h.store.state.charges).toHaveLength(1)
    expect(bus.published('payment.succeeded')).toHaveLength(1)
  })
})
