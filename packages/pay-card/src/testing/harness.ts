import * as kernelEvents from '@forge/kernel-events'
import * as kernelIdentity from '@forge/kernel-identity'
import { configurePayments, __resetPaymentsForTests } from '../config.js'
import type { PaymentSlots } from '../slots.js'
import { FakeStripe } from './fake-stripe.js'
import { MemoryPaymentStore } from './memory-store.js'

export const TEST_SECRET_KEY = 'sk_test_forge_phase1'
export const TEST_WEBHOOK_SECRET = 'whsec_forge_phase1'

interface BusHelpers {
  published(name?: string): { name: string; payload: unknown }[]
  resetEvents(): void
  subscribe(pattern: string, handler: (e: { name: string; payload: unknown }) => Promise<void>): void
}

/** Available when kernel.events is the in-process double; see vitest.config.ts. */
export const bus = kernelEvents as unknown as BusHelpers

interface IdentityHelpers {
  setCurrentUser(user: { id: string; email: string } | null): void
}
export const identity = kernelIdentity as unknown as IdentityHelpers

export interface Harness {
  readonly stripe: FakeStripe
  readonly store: MemoryPaymentStore
}

let ids = 0

export function setupPayments(slots: PaymentSlots = {}): Harness {
  __resetPaymentsForTests()
  bus.resetEvents()
  identity.setCurrentUser(null)
  ids = 0

  const stripe = new FakeStripe({ webhookSecret: TEST_WEBHOOK_SECRET })
  const store = new MemoryPaymentStore()

  configurePayments({
    secretKey: TEST_SECRET_KEY,
    webhookSecret: TEST_WEBHOOK_SECRET,
    captureMethod: 'automatic',
    statementDescriptor: 'FORGE TEST',
    slots,
    store,
    stripe,
    clock: () => new Date('2026-07-01T12:00:00.000Z'),
    idFactory: (prefix) => {
      ids += 1
      return `${prefix}_${String(ids).padStart(4, '0')}`
    },
  })

  return { stripe, store }
}

/** Builds a `Request` for the webhook route with a valid Stripe signature. */
export function signedWebhookRequest(stripe: FakeStripe, event: unknown): Request {
  const body = JSON.stringify(event)
  return new Request('https://example.test/api/webhooks/stripe', {
    method: 'POST',
    headers: { 'stripe-signature': stripe.sign(body), 'content-type': 'application/json' },
    body,
  })
}

export function unsignedWebhookRequest(event: unknown): Request {
  return new Request('https://example.test/api/webhooks/stripe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(event),
  })
}

export function misSignedWebhookRequest(event: unknown): Request {
  const body = JSON.stringify(event)
  const t = Math.floor(Date.now() / 1000)
  return new Request('https://example.test/api/webhooks/stripe', {
    method: 'POST',
    headers: {
      'stripe-signature': `t=${t},v1=${'0'.repeat(64)}`,
      'content-type': 'application/json',
    },
    body,
  })
}

export function paymentIntentSucceededEvent(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: 'evt_test_1',
    type: 'payment_intent.succeeded',
    data: {
      object: {
        id: 'pi_test_hook_1',
        status: 'succeeded',
        amount: 4999,
        currency: 'usd',
        customer: 'cus_test_1',
        metadata: { customer_id: 'user_1' },
        ...overrides,
      },
    },
  }
}
