import type { PaymentTermsSlot } from '@forge/pay-invoices'

// Seeded by Forge from pay.invoices@1.0.0. This file is yours —
// Forge will not modify it again.
//
// Called when an invoice due date is computed.
// Client-specific terms, such as per-customer net days.

export const paymentTerms: PaymentTermsSlot = async (ctx) => {
  return ctx.proceed()
}
