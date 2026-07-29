import { createHmac, timingSafeEqual } from 'node:crypto'
import type {
  StripeEvent,
  StripeLike,
  StripePaymentIntent,
  StripePaymentMethodObject,
  StripeRefundObject,
  StripeRequestOptions,
} from '../stripe.js'

/**
 * A stand-in for the Stripe SDK so the package can be tested with no network.
 *
 * `webhooks.constructEvent` implements Stripe's actual scheme — HMAC-SHA256 over
 * `${timestamp}.${rawBody}`, compared in constant time, with a tolerance window —
 * and, critically, VERIFIES BEFORE IT PARSES. Reproducing that ordering here is
 * what makes the "rejected before parsing" test meaningful rather than circular.
 */

export interface FakeStripeOptions {
  readonly webhookSecret: string
  readonly toleranceSeconds?: number
  readonly now?: () => number
}

export interface RecordedCall {
  readonly method: string
  readonly params: Record<string, unknown>
  readonly options?: StripeRequestOptions | undefined
}

export class FakeStripe implements StripeLike {
  readonly calls: RecordedCall[] = []
  /** Set by a test to make the next paymentIntents.create fail or decline. */
  nextIntentStatus: string | null = null
  nextIntentError: string | null = null
  /** Counts JSON.parse of a webhook body, so a test can prove parse order. */
  parsedBodies = 0

  private intentSeq = 0
  private refundSeq = 0
  private readonly intents = new Map<string, StripePaymentIntent>()
  private readonly idempotency = new Map<string, StripePaymentIntent>()
  private readonly detached: string[] = []
  private readonly attachedMethods = new Map<string, StripePaymentMethodObject>()

  constructor(private readonly options: FakeStripeOptions) {}

  get detachedPaymentMethods(): readonly string[] {
    return this.detached
  }

  readonly paymentIntents = {
    create: async (
      params: Record<string, unknown>,
      options?: StripeRequestOptions,
    ): Promise<StripePaymentIntent> => {
      this.calls.push({ method: 'paymentIntents.create', params, options })

      const key = options?.idempotencyKey
      if (key !== undefined) {
        const cached = this.idempotency.get(key)
        if (cached !== undefined) return cached
      }

      if (this.nextIntentError !== null) {
        const message = this.nextIntentError
        this.nextIntentError = null
        throw new Error(message)
      }

      this.intentSeq += 1
      const status = this.nextIntentStatus ?? 'succeeded'
      this.nextIntentStatus = null
      const intent: StripePaymentIntent = {
        id: `pi_test_${this.intentSeq}`,
        status,
        amount: Number(params['amount']),
        currency: String(params['currency']),
        customer: (params['customer'] as string | undefined) ?? null,
        payment_method: (params['payment_method'] as string | undefined) ?? null,
        metadata: (params['metadata'] as Record<string, string> | undefined) ?? {},
        last_payment_error:
          status === 'succeeded' || status === 'requires_capture'
            ? null
            : { message: 'Your card was declined.', decline_code: 'generic_decline' },
      }
      this.intents.set(intent.id, intent)
      if (key !== undefined) this.idempotency.set(key, intent)
      return intent
    },
    retrieve: async (id: string): Promise<StripePaymentIntent> => {
      const found = this.intents.get(id)
      if (found === undefined) throw new Error(`No such payment_intent: ${id}`)
      return found
    },
  }

  readonly refunds = {
    create: async (
      params: Record<string, unknown>,
      options?: StripeRequestOptions,
    ): Promise<StripeRefundObject> => {
      this.calls.push({ method: 'refunds.create', params, options })
      this.refundSeq += 1
      const intentId = String(params['payment_intent'])
      const intent = this.intents.get(intentId)
      return {
        id: `re_test_${this.refundSeq}`,
        status: 'succeeded',
        amount: Number(params['amount'] ?? intent?.amount ?? 0),
        currency: intent?.currency ?? 'usd',
        payment_intent: intentId,
        reason: (params['reason'] as string | undefined) ?? null,
      }
    },
  }

  readonly paymentMethods = {
    attach: async (
      id: string,
      params: Record<string, unknown>,
    ): Promise<StripePaymentMethodObject> => {
      this.calls.push({ method: 'paymentMethods.attach', params: { id, ...params } })
      const pm: StripePaymentMethodObject = {
        id,
        customer: String(params['customer']),
        card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 },
      }
      this.attachedMethods.set(id, pm)
      return pm
    },
    detach: async (id: string): Promise<StripePaymentMethodObject> => {
      this.calls.push({ method: 'paymentMethods.detach', params: { id } })
      this.detached.push(id)
      this.attachedMethods.delete(id)
      return { id, customer: null, card: null }
    },
    retrieve: async (id: string): Promise<StripePaymentMethodObject> => {
      this.calls.push({ method: 'paymentMethods.retrieve', params: { id } })
      return (
        this.attachedMethods.get(id) ?? {
          id,
          customer: null,
          card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 },
        }
      )
    },
  }

  readonly webhooks = {
    constructEvent: (payload: string | Buffer, header: string, secret: string): StripeEvent => {
      const raw = typeof payload === 'string' ? payload : payload.toString('utf8')

      // ---- verification: nothing below this block has looked at the body ----
      const parts = new Map<string, string>()
      for (const segment of header.split(',')) {
        const idx = segment.indexOf('=')
        if (idx === -1) continue
        const k = segment.slice(0, idx).trim()
        const v = segment.slice(idx + 1).trim()
        if (!parts.has(k)) parts.set(k, v)
      }
      const timestamp = parts.get('t')
      const provided = parts.get('v1')
      if (timestamp === undefined || provided === undefined) {
        throw new Error('Unable to extract timestamp and signatures from header')
      }
      const nowSeconds = Math.floor((this.options.now?.() ?? Date.now()) / 1000)
      const tolerance = this.options.toleranceSeconds ?? 300
      if (Math.abs(nowSeconds - Number(timestamp)) > tolerance) {
        throw new Error('Timestamp outside the tolerance zone')
      }
      const expected = createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex')
      const a = Buffer.from(expected, 'utf8')
      const b = Buffer.from(provided, 'utf8')
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        throw new Error('No signatures found matching the expected signature for payload')
      }
      // ---- verified; only now is the payload parsed ----

      this.parsedBodies += 1
      return JSON.parse(raw) as StripeEvent
    },
  }

  /** Builds the `stripe-signature` header for a body, as Stripe would. */
  sign(rawBody: string, atSeconds?: number): string {
    const t = atSeconds ?? Math.floor((this.options.now?.() ?? Date.now()) / 1000)
    const signature = createHmac('sha256', this.options.webhookSecret)
      .update(`${t}.${rawBody}`)
      .digest('hex')
    return `t=${t},v1=${signature}`
  }
}
