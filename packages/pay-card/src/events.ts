import { publish, registerEventSchema } from '@forge/kernel-events'
import { z } from 'zod'

/**
 * The four events pay.card publishes, exactly as declared in
 * catalog/pay/pay.card.capability.json. The Zod schemas mirror the declared JSON
 * Schemas so a payload that would fail the catalog's contract fails here first,
 * in our own CI, rather than at a consumer.
 *
 * No secret, no card data, and no provider credential appears in any payload —
 * `external_id` is an opaque provider reference and nothing more.
 */

export const PAY_CARD_EVENT_CONTRACT_VERSIONS = {
  'payment.succeeded': 1,
  'payment.failed': 1,
  'payment.refunded': 1,
  'payment.method.added': 1,
} as const

export const paymentSucceededPayload = z
  .object({
    charge_id: z.string(),
    customer_id: z.string(),
    amount_minor: z.number().int(),
    currency: z.string(),
    payment_method_id: z.string().optional(),
    external_id: z.string().optional(),
    metadata: z.record(z.string()).optional(),
  })
  .strict()

export const paymentFailedPayload = z
  .object({
    charge_id: z.string().nullable(),
    customer_id: z.string(),
    amount_minor: z.number().int(),
    currency: z.string(),
    reason: z.string(),
    decline_code: z.string().optional(),
  })
  .strict()

export const paymentRefundedPayload = z
  .object({
    refund_id: z.string(),
    charge_id: z.string(),
    amount_minor: z.number().int(),
    currency: z.string(),
    reason: z.string().optional(),
  })
  .strict()

export const paymentMethodAddedPayload = z
  .object({
    payment_method_id: z.string(),
    customer_id: z.string(),
    brand: z.string().optional(),
    last4: z.string().optional(),
  })
  .strict()

export type PaymentSucceededPayload = z.infer<typeof paymentSucceededPayload>
export type PaymentFailedPayload = z.infer<typeof paymentFailedPayload>
export type PaymentRefundedPayload = z.infer<typeof paymentRefundedPayload>
export type PaymentMethodAddedPayload = z.infer<typeof paymentMethodAddedPayload>

const schemas = {
  'payment.succeeded': paymentSucceededPayload,
  'payment.failed': paymentFailedPayload,
  'payment.refunded': paymentRefundedPayload,
  'payment.method.added': paymentMethodAddedPayload,
} as const

export type PayCardEventName = keyof typeof schemas

export type PayCardPayload<E extends PayCardEventName> = z.infer<(typeof schemas)[E]>

const SOURCE = 'pay.card'

/**
 * Register the four payload schemas with kernel.events.
 *
 * kernel.events refuses to publish an event whose schema it has not been told
 * about — that is the runtime backstop for "a capability may only publish what
 * its specification declares". Registration therefore happens at import time,
 * so a charge cannot reach `publish` before the contract is known; it is also
 * exported so a test that cleared the registry can put the schemas back.
 * Registration is idempotent for an identical schema object.
 */
export function registerPayCardEventSchemas(): void {
  for (const [name, schema] of Object.entries(schemas)) {
    registerEventSchema({
      name,
      contractVersion: PAY_CARD_EVENT_CONTRACT_VERSIONS[name as PayCardEventName],
      schema,
      publisher: SOURCE,
    })
  }
}

registerPayCardEventSchemas()

/**
 * Validates against the declared contract and then hands off to kernel.events.
 * Publishing is deliberately the last step of every operation, after the
 * database transaction has committed.
 */
export async function publishPayCardEvent<E extends PayCardEventName>(
  name: E,
  payload: PayCardPayload<E>,
): Promise<void> {
  const parsed = schemas[name].parse(payload)
  await publish(name, parsed as never, {
    source: SOURCE,
    contractVersion: PAY_CARD_EVENT_CONTRACT_VERSIONS[name],
  })
}
