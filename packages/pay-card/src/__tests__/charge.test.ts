import { describe, expect, it } from 'vitest'
import { Money } from '@forge/kernel-money'
import { charge, refund } from '../charge.js'
import { ChargeFailedError, ChargeRejectedError, CurrencyNotAllowedError } from '../errors.js'
import { requiresApproval } from '../agent.js'
import { asUser, bus, setupPayments } from '../testing/harness.js'
import { loadCapability, publishedPayloadSchema, validateAgainstSchema } from '../testing/json-schema.js'

const spec = loadCapability('catalog/pay/pay.card.capability.json')

describe('smoke: test-mode charge succeeds', () => {
  it('charges a test card and publishes payment.succeeded', async () => {
    const h = setupPayments()

    const result = await asUser({ id: 'user_1', email: 'buyer@example.test' }, () =>
      charge(Money.of(4999, 'USD'), { id: 'user_1' }, { invoiceId: 'inv_1' }),
    )

    expect(result.status).toBe('succeeded')
    expect(result.amount.amountMinor).toBe(4999)
    expect(result.externalId).toMatch(/^pi_test_/)
    expect(h.store.state.charges).toHaveLength(1)

    const events = bus.published('payment.succeeded')
    expect(events).toHaveLength(1)
    expect(events[0]?.payload).toMatchObject({
      charge_id: result.id,
      customer_id: 'user_1',
      amount_minor: 4999,
      currency: 'USD',
    })
  })

  it('publishes a payload that satisfies the contract declared in the catalog', async () => {
    setupPayments()
    await charge(Money.of(1200, 'USD'), { id: 'user_1' })

    const schema = publishedPayloadSchema(spec, 'payment.succeeded')
    const payload = bus.published('payment.succeeded')[0]?.payload
    expect(validateAgainstSchema(schema, payload)).toEqual([])
  })

  it('sends an integer amount to the provider — never a float', async () => {
    const h = setupPayments()
    await charge(Money.of(1999, 'USD'), { id: 'user_1' })
    const call = h.stripe.calls.find((c) => c.method === 'paymentIntents.create')
    expect(Number.isInteger(call?.params['amount'])).toBe(true)
    expect(call?.params['amount']).toBe(1999)
  })

  it('passes an idempotency key so a retried request cannot double-charge', async () => {
    const h = setupPayments()
    await charge(Money.of(500, 'USD'), { id: 'user_1' }, { invoiceId: 'inv_9' })
    await charge(Money.of(500, 'USD'), { id: 'user_1' }, { invoiceId: 'inv_9' })

    // Stripe returns the same PaymentIntent for a repeated idempotency key, and
    // the unique index on (provider, external_id) collapses it to one row.
    expect(h.store.state.charges).toHaveLength(1)
    expect(bus.published('payment.succeeded')).toHaveLength(1)
  })
})

describe('beforeCharge slot', () => {
  it('prevents the charge when the slot rejects', async () => {
    const h = setupPayments({
      beforeCharge: (ctx) => ctx.reject('over the client spend limit', 'spend_limit'),
    })

    await expect(charge(Money.of(100_000, 'USD'), { id: 'user_1' })).rejects.toBeInstanceOf(
      ChargeRejectedError,
    )

    expect(h.stripe.calls.filter((c) => c.method === 'paymentIntents.create')).toHaveLength(0)
    expect(h.store.state.charges).toHaveLength(0)
    expect(bus.published('payment.succeeded')).toHaveLength(0)

    const failed = bus.published('payment.failed')
    expect(failed).toHaveLength(1)
    expect(failed[0]?.payload).toMatchObject({
      charge_id: null,
      reason: 'over the client spend limit',
      decline_code: 'spend_limit',
    })
    expect(
      validateAgainstSchema(publishedPayloadSchema(spec, 'payment.failed'), failed[0]?.payload),
    ).toEqual([])
  })

  it('proceeds when the slot proceeds', async () => {
    const h = setupPayments({ beforeCharge: (ctx) => ctx.proceed() })
    await charge(Money.of(250, 'USD'), { id: 'user_1' })
    expect(h.store.state.charges).toHaveLength(1)
  })
})

describe('afterCharge slot', () => {
  it('runs after success and before payment.succeeded is published', async () => {
    const order: string[] = []
    setupPayments({
      afterCharge: () => {
        order.push(`afterCharge:${bus.published('payment.succeeded').length}`)
      },
    })
    await charge(Money.of(700, 'USD'), { id: 'user_1' })
    expect(order).toEqual(['afterCharge:0'])
    expect(bus.published('payment.succeeded')).toHaveLength(1)
  })
})

describe('charge validation', () => {
  it('rejects a currency outside allowed_currencies', async () => {
    setupPayments()
    await expect(charge(Money.of(100, 'EUR'), { id: 'user_1' })).rejects.toBeInstanceOf(
      CurrencyNotAllowedError,
    )
  })

  it('rejects a non-integer amount before the provider is called', async () => {
    const h = setupPayments()
    // Shaped like kernel.money's Money (`amountMinor` + `currency`) but carrying
    // a float, which is what a hand-rolled amount from client code looks like.
    // Money.of would refuse to build this; charge() must refuse to forward it.
    const bogus = { amountMinor: 19.99, currency: 'USD' } as unknown as Money
    await expect(charge(bogus, { id: 'user_1' })).rejects.toThrow(/integer/i)
    expect(h.stripe.calls).toHaveLength(0)
  })

  it('records a declined charge and throws', async () => {
    const h = setupPayments()
    h.stripe.nextIntentStatus = 'requires_payment_method'
    await expect(charge(Money.of(100, 'USD'), { id: 'user_1' })).rejects.toBeInstanceOf(
      ChargeFailedError,
    )
    expect(h.store.state.charges[0]?.status).toBe('failed')
    expect(bus.published('payment.failed')).toHaveLength(1)
    expect(bus.published('payment.succeeded')).toHaveLength(0)
  })
})

describe('refund', () => {
  it('refunds a charge and publishes payment.refunded', async () => {
    setupPayments()
    const c = await charge(Money.of(2000, 'USD'), { id: 'user_1' })
    const r = await refund({ id: c.id })

    expect(r.amount.amountMinor).toBe(2000)
    const events = bus.published('payment.refunded')
    expect(events).toHaveLength(1)
    expect(
      validateAgainstSchema(publishedPayloadSchema(spec, 'payment.refunded'), events[0]?.payload),
    ).toEqual([])
  })

  it('refuses to refund more than the charge total', async () => {
    setupPayments()
    const c = await charge(Money.of(2000, 'USD'), { id: 'user_1' })
    await refund({ id: c.id }, Money.of(1500, 'USD'))
    await expect(refund({ id: c.id }, Money.of(1000, 'USD'))).rejects.toThrow(/exceed/)
  })
})

describe('agent classification', () => {
  it('marks charge and refund as always requiring approval', () => {
    expect(charge.agent).toMatchObject({
      capability: 'pay.card',
      name: 'charge',
      agentCallable: true,
      consequence: 'moves_money',
      approval: 'always',
    })
    expect(refund.agent.approval).toBe('always')
    expect(requiresApproval(charge)).toBe(true)
    expect(requiresApproval(refund)).toBe(true)
  })

  it('matches what the capability specification declares', () => {
    const exposes = spec['exposes'] as { name: string; agent_callable?: boolean; consequence?: string }[]
    for (const fn of [charge, refund]) {
      const declared = exposes.find((e) => e.name === fn.agent.name)
      expect(declared?.agent_callable).toBe(fn.agent.agentCallable)
      expect(declared?.consequence).toBe(fn.agent.consequence)
    }
  })
})
