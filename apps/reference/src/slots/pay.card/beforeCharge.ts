import type { BeforeChargeSlot } from '@forge/pay-card'

// Seeded by Forge from pay.card@1.0.0. This file is yours —
// Forge will not modify it again.
//
// Called before a charge is submitted to the provider.
// Client-specific fraud screening, spend limits, or rejection. Returning a rejection prevents the charge.

export const beforeCharge: BeforeChargeSlot = async (ctx) => {
  return ctx.proceed()
}
