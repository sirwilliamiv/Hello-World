/**
 * The slice of the Stripe SDK pay.card uses, expressed structurally.
 *
 * Declaring the surface rather than importing `Stripe`'s own types keeps the unit
 * tests free of the SDK (and therefore of the network) while the production
 * client remains a real `new Stripe(...)`.
 */

export interface StripeEvent {
  readonly id: string
  readonly type: string
  readonly data: { readonly object: Record<string, unknown> }
  readonly created?: number
}

export interface StripePaymentIntent {
  readonly id: string
  readonly status: string
  readonly amount: number
  readonly currency: string
  readonly customer?: string | null
  readonly payment_method?: string | null
  readonly metadata?: Record<string, string>
  readonly last_payment_error?: { message?: string; decline_code?: string; code?: string } | null
}

export interface StripeRefundObject {
  readonly id: string
  readonly status: string
  readonly amount: number
  readonly currency: string
  readonly payment_intent?: string | null
  readonly reason?: string | null
}

export interface StripePaymentMethodObject {
  readonly id: string
  readonly customer?: string | null
  readonly card?: {
    readonly brand?: string
    readonly last4?: string
    readonly exp_month?: number
    readonly exp_year?: number
  } | null
}

export interface StripeRequestOptions {
  readonly idempotencyKey?: string
}

export interface StripeLike {
  readonly paymentIntents: {
    create(
      params: Record<string, unknown>,
      options?: StripeRequestOptions,
    ): Promise<StripePaymentIntent>
    retrieve(id: string): Promise<StripePaymentIntent>
  }
  readonly refunds: {
    create(params: Record<string, unknown>, options?: StripeRequestOptions): Promise<StripeRefundObject>
  }
  readonly paymentMethods: {
    attach(id: string, params: Record<string, unknown>): Promise<StripePaymentMethodObject>
    detach(id: string): Promise<StripePaymentMethodObject>
    retrieve(id: string): Promise<StripePaymentMethodObject>
  }
  readonly webhooks: {
    /**
     * Verifies the signature against the raw body and only then parses it.
     * Throws on a missing, malformed, stale, or mis-signed header.
     */
    constructEvent(payload: string | Buffer, header: string, secret: string): StripeEvent
  }
}

/** Pinned so a Stripe API upgrade is a deliberate, reviewable change. */
export const STRIPE_API_VERSION = '2025-04-30.basil'

/**
 * Builds the real client. The secret key is passed straight to the SDK and is not
 * retained anywhere else in this package (ARCHITECTURE.md section 9.4).
 */
export async function createStripeClient(secretKey: string): Promise<StripeLike> {
  const mod = (await import('stripe')) as unknown as {
    default: new (key: string, config: Record<string, unknown>) => unknown
  }
  const Ctor = mod.default
  return new Ctor(secretKey, {
    apiVersion: STRIPE_API_VERSION,
    typescript: true,
    appInfo: { name: 'forge/pay.card', version: '1.0.0' },
  }) as StripeLike
}
