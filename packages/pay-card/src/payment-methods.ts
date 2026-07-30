import { z } from 'zod'
import { assertDisplayLast4, assertNoCardData } from './card-data-guard.js'
import { requirePaymentsRuntime } from './config.js'
import type { PaymentMethodRow } from './db/port.js'
import { publishPayCardEvent } from './events.js'
import type { PaymentMethod } from './types.js'

/**
 * Stored payment methods are provider references. The only way a payment method
 * enters this system is by the client collecting card details directly with
 * Stripe Elements and handing us back the resulting `pm_…` handle — the card
 * number never transits our servers, let alone our database.
 */

export function paymentMethodFromRow(row: PaymentMethodRow): PaymentMethod {
  return {
    id: row.id,
    customerId: row.customerId,
    provider: 'stripe',
    providerRef: row.providerRef,
    brand: row.brand,
    last4: row.last4,
    expMonth: row.expMonth,
    expYear: row.expYear,
    isDefault: row.isDefault,
    createdAt: row.createdAt,
  }
}

/** The provider handle Stripe Elements returns. Anything else is rejected. */
const providerRefSchema = z
  .string()
  .regex(/^pm_[A-Za-z0-9]+$/, 'expected an opaque Stripe payment method id such as pm_1NxABC')

export interface AttachPaymentMethodInput {
  readonly customerId: string
  /** Opaque Stripe payment method id from Elements. Never a card number. */
  readonly providerRef: string
  readonly providerCustomerId?: string
  readonly makeDefault?: boolean
}

export async function attachPaymentMethod(
  input: AttachPaymentMethodInput,
): Promise<PaymentMethod> {
  const rt = requirePaymentsRuntime()
  const providerRef = providerRefSchema.parse(input.providerRef)

  const stripe = await rt.stripe()
  const attached =
    input.providerCustomerId === undefined
      ? await stripe.paymentMethods.retrieve(providerRef)
      : await stripe.paymentMethods.attach(providerRef, { customer: input.providerCustomerId })

  const last4 = attached.card?.last4 ?? null
  assertDisplayLast4(last4)

  const row: PaymentMethodRow = {
    id: rt.newId('pm'),
    customerId: input.customerId,
    provider: 'stripe',
    providerRef: attached.id,
    brand: attached.card?.brand ?? null,
    last4,
    expMonth: attached.card?.exp_month ?? null,
    expYear: attached.card?.exp_year ?? null,
    isDefault: input.makeDefault ?? false,
    createdAt: rt.clock(),
    detachedAt: null,
  }
  assertNoCardData(row as unknown as Record<string, unknown>, 'payment_method')

  const stored = await rt.store.transaction((tx) => tx.upsertPaymentMethod(row))

  await publishPayCardEvent('payment.method.added', {
    payment_method_id: stored.id,
    customer_id: stored.customerId,
    ...(stored.brand === null ? {} : { brand: stored.brand }),
    ...(stored.last4 === null ? {} : { last4: stored.last4 }),
  })

  return paymentMethodFromRow(stored)
}

export async function listPaymentMethods(customerId: string): Promise<PaymentMethod[]> {
  const rt = requirePaymentsRuntime()
  const rows = await rt.store.transaction((tx) => tx.listPaymentMethods(customerId))
  return rows.map(paymentMethodFromRow)
}

/**
 * Detaches every stored payment method for a customer at the provider and then
 * removes the local rows. Provider-first: if the provider call fails we still
 * hold the reference and can retry, whereas deleting locally first would strand
 * the method attached at Stripe with nothing pointing at it.
 */
export async function detachPaymentMethods(customerId: string): Promise<number> {
  const rt = requirePaymentsRuntime()
  const rows = await rt.store.transaction((tx) => tx.listPaymentMethods(customerId))
  if (rows.length === 0) return 0

  const stripe = await rt.stripe()
  for (const row of rows) {
    try {
      await stripe.paymentMethods.detach(row.providerRef)
    } catch (cause) {
      // A method already detached at the provider is not an error for us — the
      // desired end state has been reached.
      const message = cause instanceof Error ? cause.message : ''
      if (!/not attached|No such PaymentMethod/i.test(message)) throw cause
    }
  }

  const deleted = await rt.store.transaction((tx) => tx.deletePaymentMethods(customerId))
  return deleted.length
}

/** Envelope shape kernel.events hands a subscriber. */
export interface EventEnvelope<P = unknown> {
  readonly name: string
  readonly payload: P
  readonly id?: string
  readonly contractVersion?: number
}

const userDeletedPayload = z.object({ user_id: z.string(), reason: z.string().optional() })

/**
 * `consumes: identity.user.deleted` (required). Declared handler name
 * `detachOnUserDeleted`; the generated subscriptions file imports it by that name.
 */
export async function detachOnUserDeleted(event: EventEnvelope): Promise<void> {
  const payload = userDeletedPayload.parse(event.payload)
  await detachPaymentMethods(payload.user_id)
}
