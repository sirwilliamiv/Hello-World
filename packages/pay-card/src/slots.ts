import type { Money } from '@forge/kernel-money'
import type { Charge, ChargeOptions, ChargeReceipt, CustomerRef } from './types.js'

/**
 * Slot types for pay.card, matching `slots` in catalog/pay/pay.card.capability.json.
 *
 * The types live in the package so they upgrade with it: a major version that
 * changes a slot signature makes the client's seeded stub fail to compile, which
 * is loud, local and fixable (ARCHITECTURE.md section 4).
 */

export interface BeforeChargeDecision {
  readonly kind: 'proceed' | 'reject'
  readonly reason?: string
  readonly declineCode?: string
}

export interface BeforeChargeContext {
  readonly amount: Money
  readonly customer: CustomerRef
  readonly options: ChargeOptions
  /** Id of the acting user, when the charge is initiated in a request context. */
  readonly actorUserId: string | null
  /** Allow the charge to be submitted to the provider. */
  proceed(): BeforeChargeDecision
  /** Prevent the charge. Nothing is submitted to the provider. */
  reject(reason: string, declineCode?: string): BeforeChargeDecision
}

/**
 * Runs before a charge is submitted to the provider. Returning `ctx.reject(...)`
 * prevents the charge: no provider call is made, a `payment.failed` event is
 * published, and `charge()` throws `ChargeRejectedError`.
 */
export type BeforeChargeSlot = (
  ctx: BeforeChargeContext,
) => BeforeChargeDecision | Promise<BeforeChargeDecision>

export interface AfterChargeContext {
  readonly charge: Charge
  readonly customer: CustomerRef
  readonly actorUserId: string | null
  /**
   * The default: do nothing further. Present so the seeded stub can be
   * `return ctx.proceed()` like every other slot in the catalog — a uniform
   * "carry on as you would have" verb is what makes a slot a slot.
   */
  proceed(): void
}

/**
 * Runs after a charge succeeds and before `payment.succeeded` is published.
 * A throw here does not unwind the charge — the money has already moved — it is
 * logged and the event is still published.
 */
export type AfterChargeSlot = (ctx: AfterChargeContext) => void | Promise<void>

export interface ReceiptCustomizationContext {
  readonly receipt: ChargeReceipt
  readonly charge: Charge
  /** The default: the receipt the capability rendered, unmodified. */
  proceed(): ChargeReceipt
}

/**
 * Runs when a charge receipt is rendered. Return a (possibly modified) receipt;
 * returning nothing keeps the default.
 */
export type ReceiptCustomizationSlot = (
  ctx: ReceiptCustomizationContext,
) => ChargeReceipt | void | Promise<ChargeReceipt | void>

/**
 * The shape of `import * as slots from '@/slots/pay.card'` as the generated
 * config passes it. Every slot is optional; an absent slot is the default path.
 */
export interface PaymentSlots {
  readonly beforeCharge?: BeforeChargeSlot
  readonly afterCharge?: AfterChargeSlot
  readonly receiptCustomization?: ReceiptCustomizationSlot
}
