import type { ReceiptCustomizationSlot } from '@forge/pay-card'

// Seeded by Forge from pay.card@1.0.0. This file is yours —
// Forge will not modify it again.
//
// Called when a receipt is rendered.
// Client-specific receipt content beyond branding tokens.

export const receiptCustomization: ReceiptCustomizationSlot = async (ctx) => {
  return ctx.proceed()
}
