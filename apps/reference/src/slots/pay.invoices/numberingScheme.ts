import type { NumberingSchemeSlot } from '@forge/pay-invoices'

// Seeded by Forge from pay.invoices@1.0.0. This file is yours —
// Forge will not modify it again.
//
// Called when an invoice number is allocated.
// Client-specific numbering beyond the configured token scheme. Must remain gapless per legal entity; the generated contract test asserts it.

export const numberingScheme: NumberingSchemeSlot = async (ctx) => {
  return ctx.proceed()
}
