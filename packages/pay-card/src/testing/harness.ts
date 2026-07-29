import {
  InMemoryEventStore,
  clearEventSchemas,
  configureEventBus,
  resetEventBus,
  type EventEnvelope,
} from '@forge/kernel-events'
import {
  resetIdentityConfig,
  runWithIdentityContext,
  type Authentication,
  type Session,
  type User,
} from '@forge/kernel-identity'
import { configurePayments, __resetPaymentsForTests } from '../config.js'
import { registerPayCardEventSchemas } from '../events.js'
import type { PaymentSlots } from '../slots.js'
import { FakeStripe } from './fake-stripe.js'
import { MemoryPaymentStore } from './memory-store.js'

/**
 * The test harness runs pay.card against the REAL kernel packages.
 *
 * Only two things are stood in for, and neither is a capability we could use for
 * real in a unit test: Stripe (no network, and the signature scheme has to be
 * reproduced faithfully — see fake-stripe.ts) and Postgres (see memory-store.ts).
 *
 * kernel.events is the real bus, configured through the real `EventStore` port so
 * that "what was published" is read out of the event log rather than out of a
 * recorder invented for the tests — which also means an event whose payload does
 * not satisfy its registered contract never appears there at all.
 *
 * kernel.identity is the real context: `asUser` establishes an authenticated
 * request the way `AuthGuard` does.
 */

export const TEST_SECRET_KEY = 'sk_test_forge_phase1'
export const TEST_WEBHOOK_SECRET = 'whsec_forge_phase1'

/**
 * The real in-memory event store, plus a synchronous view of the log. `append`
 * is what the bus calls before delivery, so this is exactly the set of events
 * kernel.events accepted, schema-validated and in publication order.
 */
class EventLogStore extends InMemoryEventStore {
  readonly log: EventEnvelope[] = []

  override async append(event: EventEnvelope): Promise<void> {
    this.log.push(event)
    await super.append(event)
  }
}

let eventLog = new EventLogStore()

export const bus = {
  /** Events kernel.events accepted, in order, optionally filtered by name. */
  published(name?: string): EventEnvelope[] {
    return name === undefined ? [...eventLog.log] : eventLog.log.filter((e) => e.name === name)
  },
}

export interface Harness {
  readonly stripe: FakeStripe
  readonly store: MemoryPaymentStore
}

let ids = 0

export function setupPayments(slots: PaymentSlots = {}): Harness {
  __resetPaymentsForTests()

  // A fresh bus: no subscriptions carried over, a fresh event log, and the four
  // pay.card contracts registered as the generated wiring registers them.
  resetEventBus()
  clearEventSchemas()
  registerPayCardEventSchemas()
  eventLog = new EventLogStore()
  configureEventBus({ store: eventLog })

  // No ambient identity unless a test establishes one with `asUser`.
  resetIdentityConfig()

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

const IDENTITY_EPOCH = new Date('2026-06-01T00:00:00.000Z')

function testUser(id: string, email: string): User {
  return {
    id,
    email,
    name: null,
    emailVerifiedAt: IDENTITY_EPOCH,
    disabledAt: null,
    anonymizedAt: null,
    createdAt: IDENTITY_EPOCH,
    updatedAt: IDENTITY_EPOCH,
    deletedAt: null,
  }
}

function testSession(user: User): Session {
  return {
    id: `ses_${user.id}`,
    userId: user.id,
    tokenHash: `hash_${user.id}`,
    expiresAt: new Date('2099-01-01T00:00:00.000Z'),
    revokedAt: null,
    revokedReason: null,
    ip: null,
    userAgent: null,
    lastSeenAt: IDENTITY_EPOCH,
    createdAt: IDENTITY_EPOCH,
    updatedAt: IDENTITY_EPOCH,
    deletedAt: null,
  }
}

/**
 * Run `fn` as an authenticated caller, through kernel.identity's own request
 * context. The authentication is pre-resolved on the context exactly as
 * `currentAuthentication()` memoises it after the first lookup in a request, so
 * `currentUser()` inside `fn` is the real implementation reading the real
 * AsyncLocalStorage — no session store and no identity stand-in involved.
 */
export function asUser<T>(
  user: { readonly id: string; readonly email: string },
  fn: () => Promise<T>,
): Promise<T> {
  const authenticated = testUser(user.id, user.email)
  const resolved: Authentication = {
    user: authenticated,
    session: testSession(authenticated),
  }

  return runWithIdentityContext(
    { sessionToken: null, request: null, resolved, didResolve: true },
    fn,
  )
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
