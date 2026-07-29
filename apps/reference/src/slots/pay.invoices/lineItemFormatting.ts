import type { LineItemFormattingSlot } from '@forge/pay-invoices'

// Seeded by Forge from pay.invoices@1.0.0. This file is yours —
// Forge will not modify it again.
//
// Called when invoice lines are rendered.
// Client-specific line descriptions, grouping, and ordering.

export const lineItemFormatting: LineItemFormattingSlot = async (ctx) => {
  return ctx.proceed()
}
