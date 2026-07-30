import { assertNoCardData } from './card-data-guard.js'
import { requirePaymentsRuntime, type PaymentsRuntime } from './config.js'
import type { ChargeRow, RefundRow } from './db/port.js'
import { publishPayCardEvent } from './events.js'
import type {
  StripeEvent,
  StripePaymentIntent,
  StripePaymentMethodObject,
  StripeRefundObject,
} from './stripe.js'

/**
 * Property 2: the signature is verified BEFORE the payload is parsed.
 *
 * The order below is the whole point of this file and must not be rearranged:
 *
 *   1. read the `stripe-signature` header;
 *   2. read the body as an opaque string — `request.text()`, never
 *      `request.json()`, because the signature is over the exact bytes and
 *      because parsing attacker-controlled JSON before authenticating it is the
 *      bug this guards against;
 *   3. hand the raw string, the header, and the signing secret to Stripe's
 *      `constructEvent`, which HMACs and compares in constant time and only then
 *      parses;
 *   4. touch the payload only after step 3 has returned.
 *
 * Anything that fails steps 1–3 returns 400 with a fixed body. The failure reason
 * is deliberately not echoed: a verifier's error text is a signature oracle.
 */

const BAD_REQUEST_BODY = 'invalid webhook signature'

function badRequest(): Response {
  return new Response(BAD_REQUEST_BODY, {
    status: 400,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  })
}

function ok(body: Record<string, unknown> = { received: true }): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

export const stripeWebhookHandler = async (request: Request): Promise<Response> => {
  const rt = requirePaymentsRuntime()

  const signature = request.headers.get('stripe-signature')
  if (signature === null || signature.length === 0) {
    return badRequest()
  }

  // Raw bytes. Nothing has been parsed at this point and nothing may be.
  const rawBody = await request.text()

  let event: StripeEvent
  try {
    const stripe = await rt.stripe()
    event = stripe.webhooks.constructEvent(rawBody, signature, rt.webhookSecret())
  } catch {
    return badRequest()
  }

  // Past this line the payload is authenticated and may be inspected.
  await handleVerifiedEvent(rt, event)
  return ok({ received: true, type: event.type })
}

export async function handleVerifiedEvent(rt: PaymentsRuntime, event: StripeEvent): Promise<void> {
  switch (event.type) {
    case 'payment_intent.succeeded':
      await onPaymentIntentSucceeded(rt, event.data.object as unknown as StripePaymentIntent)
      return
    case 'payment_intent.payment_failed':
      await onPaymentIntentFailed(rt, event.data.object as unknown as StripePaymentIntent)
      return
    case 'charge.refunded':
    case 'refund.created':
      await onRefund(rt, event.data.object as unknown as StripeRefundObject)
      return
    case 'payment_method.attached':
      await onPaymentMethodAttached(rt, event.data.object as unknown as StripePaymentMethodObject)
      return
    default:
      // Unhandled event types are acknowledged, not errored: Stripe retries a
      // non-2xx, and retrying something we will never handle is noise.
      return
  }
}

function customerIdOf(intent: StripePaymentIntent): string {
  return intent.metadata?.['customer_id'] ?? intent.customer ?? 'unknown'
}

/**
 * Idempotent by construction. `insertChargeIfAbsent` is
 * `ON CONFLICT (provider, external_id) DO NOTHING RETURNING *`, so a redelivered
 * `payment_intent.succeeded` inserts nothing, returns null, and publishes
 * nothing. Stripe retries webhooks; this is the reason a retry is harmless.
 */
async function onPaymentIntentSucceeded(
  rt: PaymentsRuntime,
  intent: StripePaymentIntent,
): Promise<void> {
  const metadata: Record<string, string> = { ...(intent.metadata ?? {}) }
  const row: ChargeRow = {
    id: rt.newId('chg'),
    customerId: customerIdOf(intent),
    paymentMethodId: null,
    amountMinor: intent.amount,
    currency: intent.currency.toUpperCase(),
    status: 'succeeded',
    provider: 'stripe',
    externalId: intent.id,
    invoiceId: metadata['invoice_id'] ?? null,
    statementDescriptor: rt.statementDescriptor,
    failureReason: null,
    declineCode: null,
    metadata,
    createdAt: rt.clock(),
  }
  assertNoCardData(row as unknown as Record<string, unknown>, 'charge')

  const inserted = await rt.store.transaction((tx) => tx.insertChargeIfAbsent(row))
  if (inserted === null) return // already applied — redelivery

  await publishPayCardEvent('payment.succeeded', {
    charge_id: inserted.id,
    customer_id: inserted.customerId,
    amount_minor: inserted.amountMinor,
    currency: inserted.currency,
    external_id: inserted.externalId,
    metadata: inserted.metadata,
  })
}

async function onPaymentIntentFailed(
  rt: PaymentsRuntime,
  intent: StripePaymentIntent,
): Promise<void> {
  const reason = intent.last_payment_error?.message ?? 'declined'
  const declineCode = intent.last_payment_error?.decline_code
  const row: ChargeRow = {
    id: rt.newId('chg'),
    customerId: customerIdOf(intent),
    paymentMethodId: null,
    amountMinor: intent.amount,
    currency: intent.currency.toUpperCase(),
    status: 'failed',
    provider: 'stripe',
    externalId: intent.id,
    invoiceId: intent.metadata?.['invoice_id'] ?? null,
    statementDescriptor: rt.statementDescriptor,
    failureReason: reason,
    declineCode: declineCode ?? null,
    metadata: { ...(intent.metadata ?? {}) },
    createdAt: rt.clock(),
  }

  const inserted = await rt.store.transaction((tx) => tx.insertChargeIfAbsent(row))
  if (inserted === null) return

  await publishPayCardEvent('payment.failed', {
    charge_id: inserted.id,
    customer_id: inserted.customerId,
    amount_minor: inserted.amountMinor,
    currency: inserted.currency,
    reason,
    ...(declineCode === undefined ? {} : { decline_code: declineCode }),
  })
}

async function onRefund(rt: PaymentsRuntime, refundObject: StripeRefundObject): Promise<void> {
  const paymentIntentId = refundObject.payment_intent
  if (paymentIntentId === null || paymentIntentId === undefined) return

  const applied = await rt.store.transaction(async (tx) => {
    const charge = await tx.findChargeByExternalId('stripe', paymentIntentId)
    if (charge === null) return null
    const row: RefundRow = {
      id: rt.newId('rfd'),
      chargeId: charge.id,
      amountMinor: refundObject.amount,
      currency: refundObject.currency.toUpperCase(),
      reason: refundObject.reason ?? null,
      provider: 'stripe',
      externalId: refundObject.id,
      createdAt: rt.clock(),
    }
    return tx.insertRefundIfAbsent(row)
  })
  if (applied === null) return

  await publishPayCardEvent('payment.refunded', {
    refund_id: applied.id,
    charge_id: applied.chargeId,
    amount_minor: applied.amountMinor,
    currency: applied.currency,
    ...(applied.reason === null ? {} : { reason: applied.reason }),
  })
}

async function onPaymentMethodAttached(
  rt: PaymentsRuntime,
  pm: StripePaymentMethodObject,
): Promise<void> {
  const customerId = pm.customer
  if (customerId === null || customerId === undefined) return

  const stored = await rt.store.transaction((tx) =>
    tx.upsertPaymentMethod({
      id: rt.newId('pm'),
      customerId,
      provider: 'stripe',
      providerRef: pm.id,
      brand: pm.card?.brand ?? null,
      last4: pm.card?.last4 ?? null,
      expMonth: pm.card?.exp_month ?? null,
      expYear: pm.card?.exp_year ?? null,
      isDefault: false,
      createdAt: rt.clock(),
      detachedAt: null,
    }),
  )

  await publishPayCardEvent('payment.method.added', {
    payment_method_id: stored.id,
    customer_id: stored.customerId,
    ...(stored.brand === null ? {} : { brand: stored.brand }),
    ...(stored.last4 === null ? {} : { last4: stored.last4 }),
  })
}
