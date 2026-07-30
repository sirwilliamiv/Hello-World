import type { AfterChargeSlot } from '@forge/pay-card'

// Seeded by Forge from pay.card@1.0.0. This file is yours —
// Forge will not modify it again.
//
// Called after a charge succeeds, before payment.succeeded is published.
// Client-specific bookkeeping or external notification.

export const afterCharge: AfterChargeSlot = async (ctx) => {
  return ctx.proceed()
}
