import type { PaymentStore } from './db/port.js'
import { createPostgresStore } from './db/postgres.js'
import type { PaymentSlots } from './slots.js'
import { createStripeClient, type StripeLike } from './stripe.js'
import type { CaptureMethod } from './types.js'

/**
 * Configuration binding for pay.card.
 *
 * `templates/pay.card/config.ts.tmpl` calls this once at module load with values
 * read from the generated Zod environment schema. Secrets arrive here and go no
 * further: they are held in a module-private closure, are never exported, never
 * logged, never persisted, and never placed in an event payload
 * (ARCHITECTURE.md section 9.4).
 */

export interface PaymentsConfig {
  /** `STRIPE_SECRET_KEY`. Never read back out of this module. */
  readonly secretKey: string
  /** `STRIPE_WEBHOOK_SECRET`. Used only by `webhooks.constructEvent`. */
  readonly webhookSecret: string
  readonly captureMethod?: CaptureMethod
  readonly statementDescriptor?: string
  readonly allowedCurrencies?: readonly string[]
  readonly slots?: PaymentSlots
  /**
   * Dependency injection seams. The generated config never passes these; they
   * exist so the package can be tested without a database or the network.
   */
  readonly store?: PaymentStore
  readonly stripe?: StripeLike
  readonly clock?: () => Date
  readonly idFactory?: (prefix: string) => string
}

export interface PaymentsRuntime {
  readonly captureMethod: CaptureMethod
  readonly statementDescriptor: string | null
  readonly allowedCurrencies: readonly string[]
  readonly slots: PaymentSlots
  readonly store: PaymentStore
  readonly clock: () => Date
  readonly newId: (prefix: string) => string
  stripe(): Promise<StripeLike>
  /** Module-private. Not reachable from the package's public exports. */
  webhookSecret(): string
}

let runtime: PaymentsRuntime | null = null

const STATEMENT_DESCRIPTOR_MAX = 22

function defaultId(prefix: string): string {
  return `${prefix}_${globalThis.crypto.randomUUID()}`
}

export function configurePayments(config: PaymentsConfig): void {
  // Credentials are NOT validated here.
  //
  // The generated config module runs at import time, and a bundler that imports
  // route modules to collect metadata — Next does exactly this during `next
  // build` — has no real environment. Validating eagerly would make building
  // require production secrets, and building is not running.
  //
  // Fail-fast is preserved where it belongs: the key is checked when the Stripe
  // client is first constructed (see `stripe()` below), so a real request fails
  // immediately with a message naming the missing variable rather than getting
  // an opaque error from the provider.
  if (
    config.statementDescriptor !== undefined &&
    config.statementDescriptor.length > STATEMENT_DESCRIPTOR_MAX
  ) {
    throw new Error(
      `configurePayments: statementDescriptor may be at most ${STATEMENT_DESCRIPTOR_MAX} characters`,
    )
  }

  // Closed over, not stored on the runtime object, so that neither a debugger
  // dump of the runtime nor an accidental JSON.stringify can reach them.
  const secretKey = config.secretKey
  const webhookSecret = config.webhookSecret

  let injected: StripeLike | null = config.stripe ?? null
  let pending: Promise<StripeLike> | null = null

  runtime = {
    captureMethod: config.captureMethod ?? 'automatic',
    statementDescriptor: config.statementDescriptor ?? null,
    allowedCurrencies: config.allowedCurrencies ?? ['USD'],
    slots: config.slots ?? {},
    store: config.store ?? createPostgresStore(),
    clock: config.clock ?? (() => new Date()),
    newId: config.idFactory ?? defaultId,
    stripe(): Promise<StripeLike> {
      if (injected !== null) return Promise.resolve(injected)
      if (secretKey === undefined || secretKey.length === 0) {
        return Promise.reject(
          new Error('pay.card: STRIPE_SECRET_KEY is not set. Charges cannot be taken.'),
        )
      }
      pending ??= createStripeClient(secretKey).then((client) => {
        injected = client
        return client
      })
      return pending
    },
    webhookSecret: () => webhookSecret,
  }
}

export function isPaymentsConfigured(): boolean {
  return runtime !== null
}

export function requirePaymentsRuntime(): PaymentsRuntime {
  if (runtime === null) {
    throw new Error(
      'pay.card is not configured. The generated src/generated/pay.card/config.ts calls ' +
        'configurePayments() at boot; import it before using this capability.',
    )
  }
  return runtime
}

/** @internal Test seam. Not part of the capability's exposed interface. */
export function __resetPaymentsForTests(): void {
  runtime = null
}
